import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, KEEP_RECENT, trimContext } from "../src/context.ts";
import type { Message } from "../src/llm.ts";

function conversation(results: number, size: number): Message[] {
  const m: Message[] = [{ role: "system", content: "s" }, { role: "user", content: "task" }];
  for (let i = 0; i < results; i++) {
    m.push({ role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "bash", arguments: "{}" } }] });
    m.push({ role: "tool", tool_call_id: `c${i}`, content: `result ${i} `.padEnd(size, "x") });
  }
  return m;
}
const toolContents = (m: Message[]) => m.filter((x) => x.role === "tool").map((x) => (x as { content: string }).content);

test("trims the oldest outputs first and stops once under the target", () => {
  const m = conversation(12, 4000); // about 12,000 tokens
  const n = trimContext(m, 9000);
  assert.ok(n > 0 && n <= 12 - KEEP_RECENT);
  assert.ok(estimateTokens(m) <= 9000);
  const contents = toolContents(m);
  assert.match(contents[0], /^\[trimmed: 4000 characters of old output removed/);
  assert.match(contents[n], /^result /); // the first one not needed stays whole
});

test("never trims the newest results, even when still over the target", () => {
  const m = conversation(10, 4000);
  assert.equal(trimContext(m, 10), 10 - KEEP_RECENT);
  assert.deepEqual(toolContents(m).slice(-KEEP_RECENT).map((c) => c.slice(0, 7)), ["result ", "result ", "result ", "result ", "result ", "result "]);
});

test("small outputs and already trimmed ones are left alone", () => {
  const m = conversation(10, 100);
  assert.equal(trimContext(m, 10), 0);
  const big = conversation(10, 4000);
  trimContext(big, 10);
  const again = JSON.stringify(big);
  assert.equal(trimContext(big, 10), 0);
  assert.equal(JSON.stringify(big), again);
});
