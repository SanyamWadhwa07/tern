// The CLI's guard rails, run as a real process. None of these reach a network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const cli = (args: string[], env: Record<string, string> = {}) => {
  const clean: Record<string, string | undefined> = { ...process.env, TERN_API_KEY: "", OPENROUTER_API_KEY: "", TERN_MODEL: "", TERN_BASE_URL: "", ...env };
  for (const k of Object.keys(clean)) if (clean[k] === "") delete clean[k];
  return spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/cli.ts", ...args], { encoding: "utf8", env: clean });
};

test("--help prints usage", () => {
  const r = cli(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Usage: npm run tern -- --model <id>/);
});

test("refuses to start without a task, a model, or a key for a remote endpoint", () => {
  assert.match(cli([]).stderr, /^No task given/);
  assert.match(cli(["fix it"]).stderr, /^No model given/);
  const noKey = cli(["--model", "some/model", "fix it"]);
  assert.equal(noKey.status, 2);
  assert.match(noKey.stderr, /^No API key: set TERN_API_KEY or OPENROUTER_API_KEY for https:\/\/openrouter.ai\/api\/v1/);
  const badLimit = cli(["--model", "m", "--base-url", "http://localhost:9/v1", "--time-limit", "ten", "fix it"]);
  assert.equal(badLimit.status, 2);
  assert.match(badLimit.stderr, /^--time-limit must be a positive number, got "ten"/);
});
