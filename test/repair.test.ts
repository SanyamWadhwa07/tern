// Malformed calls in the shapes open-weight models produce. Each case is a reply as it arrives from
// an OpenAI-compatible server: native tool calls with broken arguments, or a call written into the text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLoose, repairCalls } from "../src/repair.ts";

const native = (name: string, args: string) => repairCalls([{ id: "c1", name, arguments: args }], "");

test("well-formed calls pass through with no repairs", () => {
  const r = native("bash", '{"command": "ls -la"}');
  assert.deepEqual(r.calls, [{ id: "c1", name: "bash", args: { command: "ls -la" } }]);
  assert.deepEqual(r.repairs, []);
});

test("arguments inside a markdown fence", () => {
  const r = native("read", '```json\n{"path": "src/app.py"}\n```');
  assert.deepEqual(r.calls[0].args, { path: "src/app.py" });
  assert.ok(r.repairs.includes("markdown-fence"));
});

test("trailing commas in objects and arrays", () => {
  const r = native("edit", '{"path": "a.txt", "text": "x, y,", "start": "2:ab",}');
  assert.deepEqual(r.calls[0].args, { path: "a.txt", text: "x, y,", start: "2:ab" });
  assert.ok(r.repairs.includes("trailing-comma"));
  assert.deepEqual(parseLoose('[1, 2, ]'), [1, 2]);
});

test("JSON encoded twice, as a string", () => {
  const r = native("bash", JSON.stringify(JSON.stringify({ command: "pwd" })));
  assert.deepEqual(r.calls[0].args, { command: "pwd" });
  assert.ok(r.repairs.includes("double-encoded-json"));
});

test("prose before and after the JSON", () => {
  const r = native("bash", 'Sure, running it now: {"command": "make test"} hope that works');
  assert.deepEqual(r.calls[0].args, { command: "make test" });
});

test("wrong argument names: aliases and the one-unknown-string rule", () => {
  assert.deepEqual(native("bash", '{"cmd": "ls"}').calls[0].args, { command: "ls" });
  assert.deepEqual(native("read", '{"file_path": "x.py"}').calls[0].args, { path: "x.py" });
  assert.deepEqual(native("edit", '{"filename": "x.py", "new_string": "pass", "start_line": "3:0f"}').calls[0].args, {
    path: "x.py",
    text: "pass",
    start: "3:0f",
  });
  assert.deepEqual(native("bash", '{"shell_cmd_to_run": "echo hi"}').calls[0].args, { command: "echo hi" });
  assert.deepEqual(native("done", '{"message": "fixed the bug"}').calls[0].args, { summary: "fixed the bug" });
});

test("wrong tool names map to the four tools", () => {
  assert.equal(native("run_terminal_cmd", '{"command": "ls"}').calls[0].name, "bash");
  assert.equal(native("functions.read_file", '{"path": "a"}').calls[0].name, "read");
  assert.equal(native("write_file", '{"path": "a", "content": "x"}').calls[0].name, "edit");
  assert.equal(native("attempt_completion", "{}").calls[0].name, "done");
});

test("types a model gets wrong: numbers as strings, anchors as numbers, text as a list", () => {
  assert.deepEqual(native("read", '{"path": "a", "offset": "40", "limit": "20"}').calls[0].args, { path: "a", offset: 40, limit: 20 });
  assert.deepEqual(native("edit", '{"path": "a", "after": 0, "text": ["x", "y"]}').calls[0].args, { path: "a", after: "0", text: "x\ny" });
});

test("a call wrapped inside its own arguments", () => {
  const r = native("bash", '{"name": "bash", "arguments": {"command": "ls"}}');
  assert.deepEqual(r.calls[0].args, { command: "ls" });
  assert.ok(r.repairs.includes("nested-call"));
});

test("calls that cannot be repaired become errors the model can read", () => {
  const unknown = native("browse", '{"url": "x"}');
  assert.equal(unknown.calls.length, 0);
  assert.match(unknown.bad[0].error, /unknown tool "browse".*read, edit, bash and done/);
  const missing = native("edit", '{"path": "a"}');
  assert.match(missing.bad[0].error, /missing "text"/);
  const garbage = native("bash", "ls -la");
  assert.match(garbage.bad[0].error, /could not read the arguments/);
});

test("Hermes / Qwen <tool_call> JSON in the text", () => {
  const text = 'I will look first.\n<tool_call>\n{"name": "read", "arguments": {"path": "main.go"}}\n</tool_call>';
  const r = repairCalls([], text);
  assert.equal(r.fromText, true);
  assert.deepEqual(r.calls.map((c) => [c.name, c.args]), [["read", { path: "main.go" }]]);
  assert.ok(r.repairs.includes("tool-call-tag"));
});

test("Qwen3-Coder XML calls, one or several, with multi-line values", () => {
  const text = [
    "<tool_call>",
    "<function=edit>",
    "<parameter=path>\nhello.py\n</parameter>",
    "<parameter=text>\ndef hello():\n    return 1\n</parameter>",
    "</function>",
    "</tool_call>",
    "<tool_call><function=bash><parameter=command>python hello.py</parameter></function></tool_call>",
  ].join("\n");
  const r = repairCalls([], text);
  assert.deepEqual(r.calls.map((c) => [c.name, c.args]), [
    ["edit", { path: "hello.py", text: "def hello():\n    return 1" }],
    ["bash", { command: "python hello.py" }],
  ]);
  assert.ok(r.repairs.includes("xml-function"));
});

test("Claude-style <invoke> XML in the text", () => {
  const text = '<function_calls><invoke name="bash"><parameter name="command">git status</parameter></invoke></function_calls>';
  assert.deepEqual(repairCalls([], text).calls[0].args, { command: "git status" });
});

test("a bare or fenced JSON call in the text, alone or as a list", () => {
  const fenced = repairCalls([], 'Next step:\n```json\n{"name": "bash", "arguments": {"command": "npm test"},}\n```');
  assert.deepEqual(fenced.calls[0].args, { command: "npm test" });
  assert.ok(fenced.repairs.includes("json-in-text"));
  const list = repairCalls([], '[{"tool": "read", "args": {"path": "a"}}, {"tool": "done", "args": {}}]');
  assert.deepEqual(list.calls.map((c) => c.name), ["read", "done"]);
  const argsAsString = repairCalls([], '{"name": "bash", "arguments": "{\\"command\\": \\"ls\\"}"}');
  assert.deepEqual(argsAsString.calls[0].args, { command: "ls" });
});

test("ordinary text, even with braces in it, is not a call", () => {
  const r = repairCalls([], "The fix is in `function f() { return 1; }` and the config {\"debug\": true}.");
  assert.deepEqual(r, { calls: [], bad: [], repairs: [], fromText: false });
});
