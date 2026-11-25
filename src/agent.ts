// The agent loop. Each turn: ask the model, repair its calls, run them, and send back the results.
// The run ends when a done claim is accepted by the gate, or when the turn limit is reached.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Budget, LoopDetector } from "./budget.ts";
import { Guard, judgeClaim, type Claim } from "./gate.ts";
import type { Llm, Message, ToolCall, Usage } from "./llm.ts";
import { systemPrompt, TOOLS } from "./prompt.ts";
import { repairCalls, type RawCall } from "./repair.ts";
import { runTool } from "./tools.ts";

// Every event carries what a training set needs: the model's raw output next to its repaired form,
// each tool call with its id, arguments and result, and every done claim with its checks.
export type RunEvent =
  | { type: "start"; system: string; tools: object[]; task: string }
  | {
      type: "reply";
      turn: number;
      raw: { text: string; calls: RawCall[]; finish?: string }; // as the model sent it
      calls: { id: string; name: string; args: unknown }[]; // after repair
      bad: { id: string; name: string; error: string }[];
      repairs: string[];
      usage: Usage;
    }
  | { type: "tool"; turn: number; id: string; name: string; args: unknown; result: string }
  | { type: "claim"; claim: Claim }
  | { type: "guard"; turn: number; notes: string[]; stop?: string } // budget and loop notes shown to the model
  | { type: "end"; status: RunResult["status"]; turns: number };

export type RunOptions = {
  llm: Pick<Llm, "chat">;
  task: string;
  cwd: string;
  checks?: string[]; // commands that must exit 0 before done is accepted
  protect?: string[]; // files or directories the agent may not change
  maxTurns?: number;
  timeLimitMs?: number; // wall clock for the whole run: notes at 75% and 90%, stop at 100%
  tokenLimit?: number; // prompt + completion tokens summed over all requests, same notes and stop
  now?: () => number; // clock, for tests
  claimsFile?: string; // JSONL, one line per done claim
  onEvent?: (e: RunEvent) => void;
  signal?: AbortSignal;
};

export type RunResult = {
  status: "done" | "max_turns" | "time_limit" | "token_limit" | "loop" | "error";
  turns: number;
  claims: Claim[];
  usage: Usage;
  repairs: number; // fixes applied to calls
  badCalls: number; // calls that could not be repaired
  error?: string;
  messages: Message[]; // the whole conversation in OpenAI chat format, as last sent to the model
};

const NUDGE = "No tool call found. Call a tool to make progress, or call done if the task is finished.";

export async function run(o: RunOptions): Promise<RunResult> {
  const guard = new Guard(o.cwd, o.protect);
  const maxTurns = o.maxTurns ?? 50;
  const emit = o.onEvent ?? (() => {});
  const budget = new Budget({ timeLimitMs: o.timeLimitMs, tokenLimit: o.tokenLimit }, o.now);
  const loops = new LoopDetector();
  let loopNotes: string[] = [];
  const messages: Message[] = [
    { role: "system", content: systemPrompt(o.cwd) },
    { role: "user", content: o.task },
  ];
  const result: RunResult = { status: "max_turns", turns: 0, claims: [], usage: { prompt: 0, completion: 0 }, repairs: 0, badCalls: 0, messages };
  emit({ type: "start", system: messages[0].content as string, tools: TOOLS, task: o.task });
  const end = (status: RunResult["status"]) => {
    result.status = status;
    emit({ type: "end", status, turns: result.turns });
    return result;
  };

  for (let turn = 1; turn <= maxTurns; turn++) {
    // Budget and loop notes ride on the last tool result (or nudge), so the conversation keeps its shape.
    const verdict = budget.check();
    const notes = [...loopNotes, ...verdict.notes];
    loopNotes = [];
    if (notes.length || verdict.stop) emit({ type: "guard", turn, notes, stop: verdict.stop });
    if (verdict.stop) return end(verdict.stop);
    const last = messages.at(-1)!;
    if (notes.length && (last.role === "tool" || last.role === "user")) last.content += `\n\n${notes.join("\n")}`;

    result.turns = turn;
    let reply;
    try {
      reply = await o.llm.chat(messages, TOOLS, o.signal);
    } catch (e) {
      result.error = (e as Error).message;
      return end("error");
    }
    result.usage.prompt += reply.usage.prompt;
    result.usage.completion += reply.usage.completion;
    if (reply.usage.cost !== undefined) result.usage.cost = (result.usage.cost ?? 0) + reply.usage.cost;
    budget.addTokens(reply.usage.prompt + reply.usage.completion);

    const r = repairCalls(reply.calls, reply.text);
    result.repairs += r.repairs.length;
    result.badCalls += r.bad.length;
    emit({
      type: "reply",
      turn,
      raw: { text: reply.text, calls: reply.calls, finish: reply.finish },
      calls: r.calls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
      bad: r.bad,
      repairs: r.repairs,
      usage: reply.usage,
    });

    if (!r.calls.length && !r.bad.length) {
      messages.push({ role: "assistant", content: reply.text }, { role: "user", content: NUDGE });
      continue;
    }
    // The history keeps the repaired form of each call, so the model sees well-formed examples.
    const toolCalls: ToolCall[] = [
      ...r.calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.args) } })),
      ...r.bad.map((b) => ({ id: b.id, type: "function" as const, function: { name: b.name, arguments: "{}" } })),
    ];
    messages.push({ role: "assistant", content: reply.text || null, tool_calls: toolCalls });
    let looping = false;
    const watch = (name: string, args: unknown, out: string) => {
      const l = loops.record(name, args, out);
      if (l.note) loopNotes.push(l.note);
      if (l.stop) looping = true;
    };
    for (const b of r.bad) {
      messages.push({ role: "tool", tool_call_id: b.id, content: `error: ${b.error}` });
      watch(b.name, "unrepairable", b.error);
    }

    for (const call of r.calls) {
      if (call.name !== "done") {
        const out = await runTool(call, { cwd: o.cwd, guard });
        emit({ type: "tool", turn, id: call.id, name: call.name, args: call.args, result: out });
        messages.push({ role: "tool", tool_call_id: call.id, content: out });
        watch(call.name, call.args, out);
        continue;
      }
      const { claim, reply: verdict } = await judgeClaim({ cwd: o.cwd, guard, checks: o.checks ?? [], summary: String(call.args.summary ?? ""), turn });
      result.claims.push(claim);
      if (o.claimsFile) {
        mkdirSync(dirname(o.claimsFile), { recursive: true });
        appendFileSync(o.claimsFile, JSON.stringify(claim) + "\n");
      }
      emit({ type: "claim", claim });
      messages.push({ role: "tool", tool_call_id: call.id, content: verdict });
      if (claim.accepted) return end("done");
    }
    if (looping) {
      emit({ type: "guard", turn, notes: [], stop: "loop" });
      return end("loop");
    }
  }
  return end("max_turns");
}
