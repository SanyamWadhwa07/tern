// One test per bug found in the first independent review (26 Nov 2026), so none can come back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/agent.ts";
import { trimContext } from "../src/context.ts";
import { Guard, judgeClaim } from "../src/gate.ts";
import { Llm, type Message } from "../src/llm.ts";
import { parseLoose, repairCalls } from "../src/repair.ts";
import { runCommand } from "../src/shell.ts";
import { scriptedModel } from "./fake.ts";

const ws = () => {
  const cwd = mkdtempSync(join(tmpdir(), "tern-reg-"));
  mkdirSync(join(cwd, "tests"));
  writeFileSync(join(cwd, "tests", "t.cjs"), "process.exit(0)\n");
  return cwd;
};
const llm = (f: typeof fetch) => new Llm({ baseUrl: "http://fake/v1", model: "m", fetch: f, backoffMs: 200 });

test("1. an interrupt stops the client before a request and during a retry wait", async () => {
  const m = scriptedModel([{ status: 503 }, { text: "late" }]);
  await assert.rejects(llm(m.fetch).chat([], [], AbortSignal.abort(new Error("stop"))), /stop/);
  assert.equal(m.requests.length, 0);
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error("stop")), 50);
  await assert.rejects(llm(m.fetch).chat([], [], ac.signal), /stop/);
  assert.equal(m.requests.length, 1, "the retry after the 503 was never sent");
});

test("1. an interrupt between turns ends the run, and kills a running command", async () => {
  const ac = new AbortController();
  const m = scriptedModel([(msgs) => (msgs.length > 2 && ac.abort(new Error("Ctrl-C")), { calls: [{ name: "bash", args: { command: `node -e "console.log(${msgs.length})"` } }] })]);
  const r = await run({ llm: llm(m.fetch), task: "t", cwd: ws(), signal: ac.signal, maxTurns: 10 });
  assert.equal(r.status, "error");
  assert.match(r.error!, /^interrupted: Ctrl-C/);
  assert.ok(m.requests.length <= 2);

  const killer = new AbortController();
  setTimeout(() => killer.abort(), 300);
  const t0 = Date.now();
  const ran = await runCommand('node -e "setTimeout(()=>{}, 60000)"', ws(), 60_000, killer.signal);
  assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0} ms`);
  assert.notEqual(ran.exit, 0);
});

test("2. caches and files the checks write in a protected directory are not blamed on the agent", async () => {
  const cwd = ws();
  const guard = new Guard(cwd, ["tests"]);
  const pycache = `node -e "require('fs').mkdirSync('tests/__pycache__',{recursive:true}); require('fs').writeFileSync('tests/__pycache__/t.pyc','x'); require('fs').writeFileSync('tests/report.log','x')"`;
  const first = await judgeClaim({ cwd, guard, checks: [pycache, 'node -e "process.exit(1)"'], summary: "s", turn: 1 });
  assert.equal(first.claim.accepted, false);
  assert.deepEqual(first.claim.tampered, []);
  const second = await judgeClaim({ cwd, guard, checks: [pycache], summary: "s", turn: 2 });
  assert.equal(second.claim.accepted, true);
  assert.deepEqual(second.claim.tampered, []);
});

test("3. a command that leaves a background process holding the pipes still returns", async () => {
  const t0 = Date.now();
  const r = await runCommand(`node -e "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 4000)'], {stdio: 'inherit'}).unref(); console.log('started')"`, ws(), 30_000);
  assert.equal(r.exit, 0);
  assert.match(r.output, /started/);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});

test("4. calls after an accepted done still get an answer", async () => {
  const m = scriptedModel([{ calls: [{ name: "done", args: { summary: "ok" } }, { name: "bash", args: { command: "echo" } }] }]);
  const r = await run({ llm: llm(m.fetch), task: "t", cwd: ws() });
  assert.equal(r.status, "done");
  const answered = r.messages.filter((x) => x.role === "tool").map((x) => (x as { tool_call_id: string }).tool_call_id);
  const asked = (r.messages.find((x) => x.role === "assistant") as { tool_calls: { id: string }[] }).tool_calls.map((c) => c.id);
  assert.deepEqual(answered, asked);
  assert.equal((r.messages.at(-1) as { content: string }).content, "not run: done was accepted");
});

test("5. whole calls with empty ids and no index stay separate", async () => {
  const call = (name: string, args: string) => ({ choices: [{ delta: { tool_calls: [{ id: "", type: "function", function: { name, arguments: args } }] } }] });
  const body = [call("read", '{"path":"a"}'), call("bash", '{"command":"ls"}')].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
  const f = (async () => new Response(body)) as unknown as typeof fetch;
  const r = await llm(f).chat([], []);
  assert.deepEqual(r.calls.map((c) => [c.name, c.arguments]), [["read", '{"path":"a"}'], ["bash", '{"command":"ls"}']]);
});

test("6. JSON in prose is not a call unless it looks like one", () => {
  assert.deepEqual(repairCalls([], 'The form config:\n```json\n{"name": "submit", "label": "Send"}\n```').calls, []);
  const pkg = repairCalls([], 'Your package.json:\n{"name": "my-app", "version": "1.0.0"}');
  assert.deepEqual([pkg.calls, pkg.bad], [[], []]);
  assert.equal(repairCalls([], '{"name": "done"}').calls[0].name, "done"); // an exact tool name still counts
});

test("6. a fence inside a string value is content, even with a trailing comma", () => {
  const args = '{"path": "README.md", "text": "```\\n[1, 2]\\n```\\n",}';
  assert.deepEqual(parseLoose(args), { path: "README.md", text: "```\n[1, 2]\n```\n" });
  assert.deepEqual(repairCalls([{ id: "c", name: "edit", arguments: args }], "").calls[0].args, { path: "README.md", text: "```\n[1, 2]\n```\n" });
});

test("7. a character split across two output chunks is decoded whole", async () => {
  const r = await runCommand(`node -e "process.stdout.write(Buffer.from([0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9, 0xc3, 0xa9])), 100)"`, ws(), 10_000);
  assert.equal(r.output, "éé");
});

test("8. trimming counts escaped characters, so it trims no more than needed", () => {
  const messages: Message[] = [{ role: "system", content: "s" }];
  for (let i = 0; i < 12; i++) {
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read", arguments: "{}" } }] });
    messages.push({ role: "tool", tool_call_id: `c${i}`, content: '"'.repeat(4000) }); // 8,000 characters once escaped
  }
  const before = Math.ceil(JSON.stringify(messages).length / 4);
  assert.equal(trimContext(messages, before - 3000), 2); // each trim saves about 1,970 tokens
});
