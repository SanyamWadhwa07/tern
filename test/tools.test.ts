import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Guard, judgeClaim } from "../src/gate.ts";
import { runTool } from "../src/tools.ts";
import type { Call } from "../src/repair.ts";

function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), "tern-tools-"));
  writeFileSync(join(cwd, "app.txt"), "one\ntwo\nthree\n");
  mkdirSync(join(cwd, "tests"));
  writeFileSync(join(cwd, "tests", "check.cjs"), "process.exit(0)\n");
  return { cwd, guard: new Guard(cwd, ["tests"]) };
}
const call = (name: Call["name"], args: Record<string, unknown>): Call => ({ id: "t", name, args });

test("read shows anchored lines, pages long files and lists directories", async () => {
  const ctx = workspace();
  assert.match(await runTool(call("read", { path: "app.txt" }), ctx), /^1:[0-9a-f]{2}\|one\n2:[0-9a-f]{2}\|two\n3:[0-9a-f]{2}\|three$/);
  assert.match(await runTool(call("read", { path: "app.txt", offset: 2, limit: 1 }), ctx), /^2:..\|two\n\(lines 2-2 of 3; read with offset 3 for more\)$/);
  assert.equal(await runTool(call("read", { path: "." }), ctx), "app.txt\ntests/");
  assert.match(await runTool(call("read", { path: "nope.txt" }), ctx), /^error: no such file/);
});

test("edit writes new files, edits by anchor, and refuses protected paths", async () => {
  const ctx = workspace();
  assert.match(await runTool(call("edit", { path: "src/new.py", text: "print(1)" }), ctx), /^wrote 1 lines to src\/new.py/);
  assert.equal(readFileSync(join(ctx.cwd, "src", "new.py"), "utf8"), "print(1)\n");

  const shown = await runTool(call("read", { path: "app.txt" }), ctx);
  const two = shown.split("\n")[1].split("|")[0];
  assert.match(await runTool(call("edit", { path: "app.txt", start: two, text: "TWO" }), ctx), /^edited app.txt, lines 2-2 now read/);
  assert.equal(readFileSync(join(ctx.cwd, "app.txt"), "utf8"), "one\nTWO\nthree\n");
  // The same anchor is now stale.
  assert.match(await runTool(call("edit", { path: "app.txt", start: two, text: "x" }), ctx), /^error: line 2 changed since you read it/);

  assert.match(await runTool(call("edit", { path: "tests/check.cjs", text: "" }), ctx), /^error: tests\/check.cjs is protected/);
  assert.equal(readFileSync(join(ctx.cwd, "tests", "check.cjs"), "utf8"), "process.exit(0)\n");
});

test("bash returns exit code and output, and undoes changes to protected files", async () => {
  const ctx = workspace();
  assert.equal(await runTool(call("bash", { command: 'node -e "console.log(6*7)"' }), ctx), "exit 0\n42");
  assert.match(await runTool(call("bash", { command: 'node -e "process.exit(3)"' }), ctx), /^exit 3/);
  const out = await runTool(call("bash", { command: `node -e "require('fs').writeFileSync('tests/check.cjs','')"` }), ctx);
  assert.match(out, /note: this command changed protected files, so they were restored: tests\/check.cjs/);
  assert.equal(readFileSync(join(ctx.cwd, "tests", "check.cjs"), "utf8"), "process.exit(0)\n");
});

test("bash kills a command that runs past its timeout", async () => {
  const ctx = workspace();
  const t0 = Date.now();
  const out = await runTool(call("bash", { command: 'node -e "setTimeout(()=>{}, 60000)"', timeout: 1 }), ctx);
  assert.match(out, /^timed out after 1 s/);
  assert.ok(Date.now() - t0 < 10_000);
});

test("the guard removes new files planted in a protected directory", () => {
  const ctx = workspace();
  writeFileSync(join(ctx.cwd, "tests", "extra.cjs"), "x");
  assert.deepEqual(ctx.guard.restore(), ["tests/extra.cjs"]);
  assert.equal(existsSync(join(ctx.cwd, "tests", "extra.cjs")), false);
});

test("a done claim is accepted only when every check passes", async () => {
  const ctx = workspace();
  const pass = await judgeClaim({ ...ctx, checks: ["node tests/check.cjs"], summary: "s", turn: 1 });
  assert.equal(pass.claim.accepted, true);
  assert.equal(pass.claim.verified, true);
  assert.equal(pass.reply, "Accepted: 1 of 1 checks passed.");

  const fail = await judgeClaim({ ...ctx, checks: ['node -e "console.error(\'2 tests failed\'); process.exit(1)"'], summary: "s", turn: 2 });
  assert.equal(fail.claim.accepted, false);
  assert.equal(fail.claim.checks[0].exit, 1);
  assert.match(fail.reply, /failed with exit 1:\n2 tests failed/);

  const none = await judgeClaim({ ...ctx, checks: [], summary: "s", turn: 3 });
  assert.deepEqual([none.claim.accepted, none.claim.verified], [true, false]);
});
