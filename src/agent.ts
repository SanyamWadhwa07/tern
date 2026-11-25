// The agent loop. Each turn: ask the model, repair its calls, run them, and send back the results.
// The run ends when a done claim is accepted by the gate, or when the turn limit is reached.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Guard, judgeClaim, type Claim } from "./gate.ts";
import type { Llm, Message, ToolCall, Usage } from "./llm.ts";
import { systemPrompt, TOOLS } from "./prompt.ts";
import { repairCalls } from "./repair.ts";
import { runTool } from "./tools.ts";

export type RunEvent =
  | { type: "reply"; turn: number; text: string; calls: { name: string; args: unknown }[]; bad: string[]; repairs: string[]; usage: Usage }
  | { type: "tool"; turn: number; name: string; result: string }
  | { type: "claim"; claim: Claim }
  | { type: "end"; status: RunResult["status"]; turns: number };

export type RunOptions = {
  llm: Pick<Llm, "chat">;
  task: string;
  cwd: string;
  checks?: string[]; // commands that must exit 0 before done is accepted
  protect?: string[]; // files or directories the agent may not change
  maxTurns?: number;
  claimsFile?: string; // JSONL, one line per done claim
  onEvent?: (e: RunEvent) => void;
  signal?: AbortSignal;
};

export type RunResult = {
  status: "done" | "max_turns" | "error";
  turns: number;
  claims: Claim[];
  usage: Usage;
  repairs: number; // fixes applied to calls
  badCalls: number; // calls that could not be repaired
  error?: string;
};

const NUDGE = "No tool call found. Call a tool to make progress, or call done if the task is finished.";

export async function run(o: RunOptions): Promise<RunResult> {
  const guard = new Guard(o.cwd, o.protect);
  const maxTurns = o.maxTurns ?? 50;
  const emit = o.onEvent ?? (() => {});
  const messages: Message[] = [
    { role: "system", content: systemPrompt(o.cwd) },
    { role: "user", content: o.task },
  ];
  const result: RunResult = { status: "max_turns", turns: 0, claims: [], usage: { prompt: 0, completion: 0 }, repairs: 0, badCalls: 0 };
  const end = (status: RunResult["status"]) => {
    result.status = status;
    emit({ type: "end", status, turns: result.turns });
    return result;
  };

  for (let turn = 1; turn <= maxTurns; turn++) {
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

    const r = repairCalls(reply.calls, reply.text);
    result.repairs += r.repairs.length;
    result.badCalls += r.bad.length;
    emit({ type: "reply", turn, text: reply.text, calls: r.calls.map((c) => ({ name: c.name, args: c.args })), bad: r.bad.map((b) => b.error), repairs: r.repairs, usage: reply.usage });

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
    for (const b of r.bad) messages.push({ role: "tool", tool_call_id: b.id, content: `error: ${b.error}` });

    for (const call of r.calls) {
      if (call.name !== "done") {
        const out = await runTool(call, { cwd: o.cwd, guard });
        emit({ type: "tool", turn, name: call.name, result: out });
        messages.push({ role: "tool", tool_call_id: call.id, content: out });
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
  }
  return end("max_turns");
}
