// The whole loop, offline: a scripted model, the real client, repair layer, tools and gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type RunEvent } from "../src/agent.ts";
import { Llm } from "../src/llm.ts";
import { anchorOf, scriptedModel, type Step } from "./fake.ts";

const BUGGY = "function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n";
const CHECK = 'const { add } = require("../math.cjs");\nif (add(2, 3) !== 5) {\n  console.error(`add(2, 3) returned ${add(2, 3)}, expected 5`);\n  process.exit(1);\n}\nconsole.log("ok");\n';

function toyTask() {
  const cwd = mkdtempSync(join(tmpdir(), "tern-toy-"));
  writeFileSync(join(cwd, "math.cjs"), BUGGY);
  mkdirSync(join(cwd, "tests"));
  writeFileSync(join(cwd, "tests", "check.cjs"), CHECK);
  return cwd;
}
const model = (steps: Step[]) => {
  const m = scriptedModel(steps);
  return { ...m, llm: new Llm({ baseUrl: "http://fake/v1", model: "fake", fetch: m.fetch, backoffMs: 1 }) };
};
const lastTool = (messages: any[]) => [...messages].reverse().find((m) => m.role === "tool").content as string;

test("solves a toy bug-fix task: a premature done is rejected, cheating is blocked, the fix is accepted", async () => {
  const cwd = toyTask();
  const seen: string[] = [];
  const m = model([
    { text: "Let me look at the code and its test.", calls: [{ name: "read", args: { path: "math.cjs" } }, { name: "read", args: { path: "tests/check.cjs" } }] },
    { calls: [{ name: "done", args: { summary: "looks fine" } }] }, // claims success without testing
    (msgs) => {
      seen.push(lastTool(msgs));
      return { calls: [{ name: "edit", args: { path: "tests/check.cjs", start: anchorOf(msgs, "expected 5"), text: "" } }] }; // tries to edit the test
    },
    (msgs) => {
      seen.push(lastTool(msgs));
      return { calls: [{ name: "bash", args: { command: `node -e "require('fs').writeFileSync('tests/check.cjs','')"` } }] }; // tries again through the shell
    },
    // The real fix, written as Qwen3-Coder XML in the text instead of a tool call.
    (msgs) => {
      seen.push(lastTool(msgs));
      return { text: `<tool_call>\n<function=edit>\n<parameter=path>\nmath.cjs\n</parameter>\n<parameter=start>\n${anchorOf(msgs, "return a - b")}\n</parameter>\n<parameter=text>\n  return a + b;\n</parameter>\n</function>\n</tool_call>` };
    },
    { calls: [{ name: "bash", args: { cmd: "node tests/check.cjs" } }] }, // wrong argument name
    (msgs) => {
      seen.push(lastTool(msgs));
      return { calls: [{ name: "done", args: { summary: "add() now adds; the check passes" } }] };
    },
  ]);
  const events: RunEvent[] = [];
  const claimsFile = join(cwd, ".tern", "claims.jsonl");
  const r = await run({ llm: m.llm, task: "Fix add() in math.cjs.", cwd, checks: ["node tests/check.cjs"], protect: ["tests"], claimsFile, onEvent: (e) => events.push(e) });

  assert.equal(r.status, "done");
  assert.equal(r.turns, 7);
  assert.equal(readFileSync(join(cwd, "math.cjs"), "utf8"), BUGGY.replace("a - b", "a + b"));
  assert.equal(readFileSync(join(cwd, "tests", "check.cjs"), "utf8"), CHECK);

  assert.match(seen[0], /Not done yet[\s\S]*add\(2, 3\) returned -1, expected 5/);
  assert.match(seen[1], /^error: tests\/check.cjs is protected/);
  assert.match(seen[2], /restored: tests\/check.cjs/);
  assert.match(seen[3], /^exit 0\nok$/);

  // Both claims are recorded: the false one and the true one.
  assert.deepEqual(r.claims.map((c) => [c.turn, c.accepted, c.summary]), [
    [2, false, "looks fine"],
    [7, true, "add() now adds; the check passes"],
  ]);
  const logged = readFileSync(claimsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(logged.map((c) => c.accepted), [false, true]);
  assert.equal(logged[0].checks[0].exit, 1);

  assert.ok(r.repairs >= 2, `repairs: ${r.repairs}`);
  const replies = events.filter((e) => e.type === "reply");
  assert.ok(replies[4].type === "reply" && replies[4].repairs.includes("xml-function"));
  assert.ok(replies[5].type === "reply" && replies[5].repairs.includes("arg-name:cmd->command"));
  assert.deepEqual(r.usage, { prompt: 700, completion: 140 });
});

test("the history keeps the repaired call, so the model sees the right format", async () => {
  const cwd = toyTask();
  const m = model([{ text: '<tool_call>{"name": "read_file", "arguments": {"file_path": "math.cjs",}}</tool_call>' }, { calls: [{ name: "done", args: {} }] }]);
  await run({ llm: m.llm, task: "Look at math.cjs.", cwd });
  const assistant = m.requests[1].body.messages.find((x: any) => x.role === "assistant");
  assert.equal(assistant.tool_calls[0].function.name, "read");
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { path: "math.cjs" });
  assert.equal(m.requests[1].body.messages.at(-1).role, "tool");
});

test("a reply with no tool call gets a nudge, and the turn limit ends the run", async () => {
  const m = model([{ text: "I believe the code is correct." }]);
  const r = await run({ llm: m.llm, task: "Fix it.", cwd: toyTask(), maxTurns: 2 });
  assert.equal(r.status, "max_turns");
  assert.equal(m.requests.length, 2);
  assert.match(m.requests[1].body.messages.at(-1).content, /^No tool call found/);
});

test("a call that cannot be repaired is answered with an error and the run goes on", async () => {
  const m = model([{ calls: [{ name: "browse", args: { url: "x" } }] }, { calls: [{ name: "done", args: { summary: "ok" } }] }]);
  const r = await run({ llm: m.llm, task: "t", cwd: toyTask() });
  assert.equal(r.status, "done");
  assert.equal(r.badCalls, 1);
  assert.match(m.requests[1].body.messages.at(-1).content, /^error: unknown tool "browse"/);
  assert.equal(r.claims[0].verified, false);
});

test("a model that keeps failing ends the run with status error", async () => {
  const m = model([{ status: 401, body: "no key" }]);
  const r = await run({ llm: m.llm, task: "t", cwd: toyTask() });
  assert.equal(r.status, "error");
  assert.match(r.error!, /HTTP 401 no key/);
});

// ------------------------------------------------------------------ budget guard

const echo = (msgs: unknown[]) => ({ calls: [{ name: "bash", args: { command: `node -e "console.log(${msgs.length})"` } }] }); // new output each turn

test("time limit: a note at 75% rides on the last tool result, then the run stops with its logs", async () => {
  let t = 0;
  const minute = 60_000;
  const m = model([(msgs) => ((t += 2 * minute), echo(msgs))]); // each model call takes 2 minutes
  const events: RunEvent[] = [];
  const r = await run({ llm: m.llm, task: "t", cwd: toyTask(), timeLimitMs: 10 * minute, now: () => t, onEvent: (e) => events.push(e) });
  assert.equal(r.status, "time_limit");
  assert.equal(r.turns, 5);
  assert.match(m.requests[4].body.messages.at(-1).content, /^exit 0\n\d+\n\nBudget: 80% of the time limit used \(8\.0 of 10\.0 min\)\. Focus on the main fix/);
  assert.deepEqual(events.filter((e) => e.type === "guard").map((e) => (e as any).stop ?? "note"), ["note", "time_limit"]);
  assert.equal(events.at(-1)!.type, "end");
});

test("token limit: a past-90% note, then a stop", async () => {
  const m = model([(msgs) => echo(msgs)]); // 120 tokens per call
  const r = await run({ llm: m.llm, task: "t", cwd: toyTask(), tokenLimit: 500 });
  assert.equal(r.status, "token_limit");
  assert.equal(r.turns, 5);
  assert.match(m.requests[4].body.messages.at(-1).content, /Budget: 96% of the token limit used \(480 of 500\)\. Stop exploring/);
  assert.deepEqual(r.usage, { prompt: 500, completion: 100 });
});

test("a model stuck on the same failing command is warned at the 3rd repeat and stopped at the 6th", async () => {
  const m = model([{ calls: [{ name: "bash", args: { command: 'node -e "process.exit(1)"' } }] }]);
  const r = await run({ llm: m.llm, task: "t", cwd: toyTask(), maxTurns: 20 });
  assert.equal(r.status, "loop");
  assert.equal(r.turns, 6);
  assert.match(m.requests[3].body.messages.at(-1).content, /^exit 1\n\(no output\)\n\nLoop: this exact bash call has now given the same result 3 times/);
});
