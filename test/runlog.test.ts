// The files a run leaves behind, produced by the real CLI against a scripted model served over
// local HTTP, then labelled with a final grade. These files are the training data for later work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scriptedModel, type Step } from "./fake.ts";

async function serve(steps: Step[]) {
  const m = scriptedModel(steps);
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const r = await m.fetch(`http://fake${req.url}`, { method: "POST", body });
    res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") ?? "text/plain" });
    if (r.body) for await (const chunk of r.body) res.write(chunk);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, close: () => server.close() };
}

const node = (script: string, args: string[]) =>
  new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", script, ...args], { env: { ...process.env, TERN_API_KEY: "", OPENROUTER_API_KEY: "" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

const jsonl = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("a run writes a training-ready trajectory, transcript and result, and takes a final label", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tern-run-"));
  writeFileSync(join(cwd, "notes.txt"), "draft\n");
  const logDir = join(cwd, ".tern-log");
  const server = await serve([
    { text: '```json\n{"name": "bash", "arguments": {"cmd": "node -e \\"console.log(7)\\""},}\n```' }, // needs repair
    { calls: [{ name: "done", args: { summary: "printed 7" } }] },
  ]);
  try {
    const r = await node("src/cli.ts", ["--model", "fake/model", "--base-url", server.url, "--cwd", cwd, "--log-dir", logDir, "--check", 'node -e "process.exit(0)"', "Print 7."]);
    assert.equal(r.code, 0, r.stderr);
  } finally {
    server.close();
  }

  // trajectory.jsonl: every record carries the format and run id; the model's raw text sits next to the repaired call.
  const records = jsonl(join(logDir, "trajectory.jsonl"));
  assert.deepEqual(records.map((x) => x.type), ["start", "reply", "tool", "reply", "claim", "end"]);
  const runId = records[0].runId;
  assert.ok(records.every((x) => x.format === "tern-trajectory/1" && x.runId === runId && x.at));
  assert.equal(records[0].meta.model, "fake/model");
  assert.equal(records[0].tools.length, 4);
  assert.match(records[0].system, /^You are Tern/);
  assert.match(records[1].raw.text, /```json/);
  assert.deepEqual(records[1].raw.calls, []);
  assert.deepEqual(records[1].calls[0].args, { command: 'node -e "console.log(7)"' });
  assert.ok(records[1].repairs.includes("arg-name:cmd->command"));
  assert.deepEqual(records[1].usage, { prompt: 100, completion: 20 });
  assert.equal(records[2].id, records[1].calls[0].id);
  assert.equal(records[2].result, "exit 0\n7");
  assert.equal(records[4].claim.accepted, true);
  assert.equal(records[4].claim.checks[0].exit, 0);
  assert.deepEqual([records[5].status, records[5].claimedDone, records[5].usage], ["done", true, { prompt: 200, completion: 40 }]);

  // messages.json: the conversation in OpenAI chat format, with the repaired call, ready for fine-tuning.
  const transcript = JSON.parse(readFileSync(join(logDir, "messages.json"), "utf8"));
  assert.equal(transcript.runId, runId);
  assert.deepEqual(transcript.messages.map((m: any) => m.role), ["system", "user", "assistant", "tool", "assistant", "tool"]);
  assert.equal(transcript.messages[2].tool_calls[0].function.name, "bash");
  assert.equal(transcript.messages[3].tool_call_id, transcript.messages[2].tool_calls[0].id);

  // result.json has an empty label until the final grade arrives.
  assert.equal(JSON.parse(readFileSync(join(logDir, "result.json"), "utf8")).label, null);

  // The hidden tests fail although the agent's claim was accepted: a false done.
  const l = await node("src/label.ts", [logDir, "--failed", "--reward", "0", "--source", "harbor"]);
  assert.equal(l.code, 0, l.stderr);
  const result = JSON.parse(readFileSync(join(logDir, "result.json"), "utf8"));
  assert.deepEqual([result.label.passed, result.label.reward, result.label.source, result.label.falseDone], [false, 0, "harbor", true]);
  const last = jsonl(join(logDir, "trajectory.jsonl")).at(-1);
  assert.deepEqual([last.type, last.runId, last.falseDone], ["label", runId, true]);
});

test("label refuses unclear input", async () => {
  const r = await node("src/label.ts", ["some-dir", "--passed", "--failed"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^Usage: npm run label/);
});
