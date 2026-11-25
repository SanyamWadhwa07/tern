// A scripted model for tests. It stands in for fetch and answers each request with the next step of
// a script, streamed in the real OpenAI-compatible SSE shape: tool-call arguments split into small
// fragments across chunks, usage in the last chunk. A step can be a function of the conversation so
// far, so a scripted reply can copy an anchor out of the last read, the way a real model does.
// No network, no keys, no cost, deterministic.
import type { Message } from "../src/llm.ts";

export type FakeCall = { name: string; args: object | string };
export type Turn = { text?: string; calls?: FakeCall[]; usage?: { prompt: number; completion: number; cost?: number } };
export type Step = Turn | { status: number; body?: string } | { networkError: true } | ((messages: Message[]) => Turn);

export type Recorded = { url: string; headers: Record<string, string>; body: any };

const sse = (events: object[]) => {
  const enc = new TextEncoder();
  const lines = [...events.map((e) => `data: ${JSON.stringify(e)}\n\n`), "data: [DONE]\n\n"];
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      const next = lines.shift();
      if (next === undefined) return ctrl.close();
      // Split each event across two reads, as a real socket does.
      const cut = Math.floor(next.length / 2);
      ctrl.enqueue(enc.encode(next.slice(0, cut)));
      ctrl.enqueue(enc.encode(next.slice(cut)));
    },
  });
};

function events(turn: Turn): object[] {
  const out: object[] = [];
  if (turn.text) for (const piece of turn.text.match(/[\s\S]{1,12}/g) ?? []) out.push({ choices: [{ delta: { content: piece } }] });
  (turn.calls ?? []).forEach((call, index) => {
    const args = typeof call.args === "string" ? call.args : JSON.stringify(call.args);
    out.push({ choices: [{ delta: { tool_calls: [{ index, id: `fake_${index}`, type: "function", function: { name: call.name, arguments: "" } }] } }] });
    for (const piece of args.match(/[\s\S]{1,8}/g) ?? []) out.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: piece } }] } }] });
  });
  out.push({ choices: [{ delta: {}, finish_reason: turn.calls?.length ? "tool_calls" : "stop" }] });
  out.push({ choices: [], usage: { prompt_tokens: turn.usage?.prompt ?? 100, completion_tokens: turn.usage?.completion ?? 20, cost: turn.usage?.cost } });
  return out;
}

/** Returns a fetch that plays `steps` in order (the last one repeats) and records every request. */
export function scriptedModel(steps: Step[]) {
  const requests: Recorded[] = [];
  const fakeFetch = async (url: string | URL, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body));
    requests.push({ url: String(url), headers: init.headers as Record<string, string>, body });
    const step = steps[Math.min(requests.length - 1, steps.length - 1)];
    if ("networkError" in step) throw new TypeError("fetch failed");
    if ("status" in step) return new Response(step.body ?? "", { status: step.status });
    const turn = typeof step === "function" ? step(body.messages) : step;
    return new Response(sse(events(turn)), { headers: { "Content-Type": "text/event-stream" } });
  };
  return { fetch: fakeFetch as typeof fetch, requests };
}

/** The anchor for the first line containing `needle` in the most recent tool result that shows it. */
export function anchorOf(messages: Message[], needle: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "tool") continue;
    const line = m.content.split("\n").find((l) => /^\d+:[0-9a-f]{2}\|/.test(l) && l.includes(needle));
    if (line) return line.slice(0, line.indexOf("|"));
  }
  throw new Error(`no anchored line contains ${JSON.stringify(needle)}`);
}
