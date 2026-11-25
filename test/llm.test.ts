import { test } from "node:test";
import assert from "node:assert/strict";
import { Llm, OPENROUTER, sseData } from "../src/llm.ts";
import { scriptedModel } from "./fake.ts";

const llm = (f: typeof fetch, extra = {}) => new Llm({ baseUrl: OPENROUTER, model: "qwen/qwen3.6-35b-a3b", apiKey: "test-key", backoffMs: 1, fetch: f, ...extra });

test("streams text and tool calls whose arguments arrive in fragments", async () => {
  const m = scriptedModel([{ text: "Reading the file first.", calls: [{ name: "read", args: { path: "src/main.ts" } }, { name: "bash", args: { command: "ls" } }], usage: { prompt: 812, completion: 31, cost: 0.00012 } }]);
  const r = await llm(m.fetch).chat([{ role: "user", content: "hi" }], []);
  assert.equal(r.text, "Reading the file first.");
  assert.deepEqual(r.calls, [
    { id: "fake_0", name: "read", arguments: '{"path":"src/main.ts"}' },
    { id: "fake_1", name: "bash", arguments: '{"command":"ls"}' },
  ]);
  assert.deepEqual(r.usage, { prompt: 812, completion: 31, cost: 0.00012 });
  assert.equal(r.finish, "tool_calls");
});

test("sends an OpenAI-compatible request that OpenRouter accepts", async () => {
  const m = scriptedModel([{ text: "ok" }]);
  await llm(m.fetch, { temperature: 0.2, maxTokens: 4096 }).chat([{ role: "user", content: "hi" }], [{ type: "function" }]);
  const req = m.requests[0];
  assert.equal(req.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(req.headers.Authorization, "Bearer test-key");
  assert.equal(req.body.model, "qwen/qwen3.6-35b-a3b");
  assert.equal(req.body.stream, true);
  assert.deepEqual(req.body.stream_options, { include_usage: true });
  assert.equal(req.body.temperature, 0.2);
  assert.equal(req.body.max_tokens, 4096);
});

test("retries a 429, a 503 and a dropped connection, then succeeds", async () => {
  const m = scriptedModel([{ status: 429 }, { status: 503 }, { text: "ok" }]);
  const r = await llm(m.fetch, { retries: 2 }).chat([], []);
  assert.equal(r.text, "ok");
  assert.equal(m.requests.length, 3);
  const n = scriptedModel([{ networkError: true }, { text: "back" }]);
  assert.equal((await llm(n.fetch, { retries: 1 }).chat([], [])).text, "back");
});

test("a 400 fails at once with the server's message", async () => {
  const m = scriptedModel([{ status: 400, body: '{"error":"bad tools"}' }]);
  await assert.rejects(llm(m.fetch).chat([], []), /HTTP 400 \{"error":"bad tools"\}/);
  assert.equal(m.requests.length, 1);
});

test("an error event inside the stream is raised", async () => {
  const body = new Response('data: {"error":{"message":"context too long"}}\n\n').body!;
  const f = (async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } })) as unknown as typeof fetch;
  await assert.rejects(llm(f).chat([], []), /context too long/);
});

test("a stalled stream is aborted after the idle limit", async () => {
  const stalled = (async (_u: unknown, init: RequestInit) =>
    new Response(
      new ReadableStream({
        start(ctrl) {
          init.signal!.addEventListener("abort", () => ctrl.error(init.signal!.reason));
        },
      }),
    )) as unknown as typeof fetch;
  await assert.rejects(llm(stalled, { idleMs: 50, retries: 0 }).chat([], []), /sent nothing for 50 ms/);
});

test("SSE lines split across reads are joined before parsing", async () => {
  async function* bytes() {
    const enc = new TextEncoder();
    yield enc.encode('data: {"a"');
    yield enc.encode(":1}\n\ndata: [DO");
    yield enc.encode("NE]\n\n");
  }
  const got = [];
  for await (const d of sseData(bytes())) got.push(d);
  assert.deepEqual(got, [{ a: 1 }]);
});
