// Command line: npm run tern -- --model <id> [options] "task"
// Writes the run's trajectory, claims and result under --log-dir, prints progress to stderr, and
// exits 0 only when a done claim was accepted.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { run, type RunEvent } from "./agent.ts";
import { Llm, OPENROUTER } from "./llm.ts";

const USAGE = `Usage: npm run tern -- --model <id> [options] "task"

  --model <id>       model id at the endpoint, e.g. an OpenRouter slug (or TERN_MODEL)
  --base-url <url>   OpenAI-compatible endpoint (default ${OPENROUTER}, or TERN_BASE_URL)
  --check <cmd>      command that must exit 0 before done is accepted (repeatable)
  --protect <path>   file or directory the agent may not change (repeatable)
  --max-turns <n>    default 50
  --task-file <path> read the task from a file
  --cwd <dir>        working directory (default: current)
  --log-dir <dir>    where to write trajectory.jsonl, claims.jsonl, result.json
                     (default ~/.tern/runs/<time>)

The API key comes from TERN_API_KEY or OPENROUTER_API_KEY. A local server needs none.`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const { values: v, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string" },
    "base-url": { type: "string" },
    check: { type: "string", multiple: true },
    protect: { type: "string", multiple: true },
    "max-turns": { type: "string" },
    "task-file": { type: "string" },
    cwd: { type: "string" },
    "log-dir": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (v.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const task = v["task-file"] ? readFileSync(v["task-file"], "utf8") : positionals.join(" ");
const model = v.model ?? process.env.TERN_MODEL;
const baseUrl = v["base-url"] ?? process.env.TERN_BASE_URL ?? OPENROUTER;
const apiKey = process.env.TERN_API_KEY ?? process.env.OPENROUTER_API_KEY;
const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(baseUrl);
if (!task.trim()) fail(`No task given.\n\n${USAGE}`);
if (!model) fail(`No model given: pass --model or set TERN_MODEL.\n\n${USAGE}`);
if (!apiKey && !local) fail(`No API key: set TERN_API_KEY or OPENROUTER_API_KEY for ${baseUrl}.`);

const logDir = resolve(v["log-dir"] ?? join(homedir(), ".tern", "runs", new Date().toISOString().replace(/[:.]/g, "-")));
mkdirSync(logDir, { recursive: true });
const trajectory = join(logDir, "trajectory.jsonl");

const say = (e: RunEvent) => {
  appendFileSync(trajectory, JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n");
  if (e.type === "reply") {
    const calls = e.calls.map((c) => `${c.name} ${JSON.stringify(c.args).slice(0, 100)}`).join("; ");
    process.stderr.write(`[${e.turn}] ${calls || e.text.slice(0, 120).replace(/\s+/g, " ") || "(empty reply)"}${e.repairs.length ? `  (repaired: ${e.repairs.join(", ")})` : ""}\n`);
  } else if (e.type === "claim") {
    process.stderr.write(`    done ${e.claim.accepted ? "accepted" : "rejected"}${e.claim.verified ? "" : " (no checks)"}\n`);
  }
};

const ac = new AbortController();
process.on("SIGINT", () => ac.abort(new Error("interrupted")));
const result = await run({
  llm: new Llm({ baseUrl, model, apiKey }),
  task,
  cwd: resolve(v.cwd ?? "."),
  checks: v.check ?? [],
  protect: v.protect ?? [],
  maxTurns: v["max-turns"] ? Number(v["max-turns"]) : undefined,
  claimsFile: join(logDir, "claims.jsonl"),
  onEvent: say,
  signal: ac.signal,
});
writeFileSync(join(logDir, "result.json"), JSON.stringify({ model, baseUrl, ...result }, null, 2));
const cost = result.usage.cost !== undefined ? `, $${result.usage.cost.toFixed(4)}` : "";
process.stderr.write(`${result.status} after ${result.turns} turns, ${result.usage.prompt} + ${result.usage.completion} tokens${cost}. Log: ${logDir}\n`);
if (result.error) process.stderr.write(`error: ${result.error}\n`);
process.exit(result.status === "done" ? 0 : 1);
