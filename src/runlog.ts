// What a run leaves on disk, in a form a training pipeline can read without the harness:
//   trajectory.jsonl  one record per event, each with the format, the run id and a timestamp
//   messages.json     the whole conversation in OpenAI chat format, with the tool schemas (SFT-ready)
//   claims.jsonl      every done claim and its checks (written by the loop)
//   result.json       the summary, with a `label` slot for the final grade
// The final grade (for Terminal-Bench, the hidden tests) arrives after the run; labelRun() adds it.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunEvent, RunResult } from "./agent.ts";
import { TOOLS } from "./prompt.ts";

export const FORMAT = "tern-trajectory/1";

export type RunMeta = {
  runId: string;
  ternVersion: string;
  model: string;
  baseUrl: string;
  cwd: string;
  checks: string[];
  protect: string[];
  maxTurns?: number;
  timeLimitMs?: number;
  tokenLimit?: number;
  contextLimit?: number;
  startedAt: string;
};

export type Label = {
  passed: boolean; // the final grade: did the hidden tests pass?
  reward?: number; // the grader's raw score, when it gives one
  source: string; // who graded, e.g. "harbor"
};

export function runLog(dir: string, meta: RunMeta) {
  mkdirSync(dir, { recursive: true });
  const write = (record: object) =>
    appendFileSync(join(dir, "trajectory.jsonl"), JSON.stringify({ format: FORMAT, runId: meta.runId, at: new Date().toISOString(), ...record }) + "\n");
  return {
    event(e: RunEvent) {
      if (e.type === "end") return; // finish() writes the full end record
      write(e.type === "start" ? { ...e, meta } : e);
    },
    finish(r: RunResult) {
      const { messages, ...summary } = r;
      const claimed = r.claims.filter((c) => c.accepted).length > 0;
      write({ type: "end", status: r.status, turns: r.turns, usage: r.usage, repairs: r.repairs, badCalls: r.badCalls, claimedDone: claimed, error: r.error });
      writeFileSync(join(dir, "messages.json"), JSON.stringify({ format: FORMAT, runId: meta.runId, model: meta.model, tools: TOOLS, messages }, null, 2));
      writeFileSync(join(dir, "result.json"), JSON.stringify({ format: FORMAT, ...meta, ...summary, claimedDone: claimed, label: null }, null, 2));
    },
  };
}

/** Records the final grade for a finished run. A run is false-done when a claim was accepted but the grade failed. */
export function labelRun(dir: string, label: Label) {
  const file = join(dir, "result.json");
  const result = JSON.parse(readFileSync(file, "utf8"));
  const full = { ...label, falseDone: Boolean(result.claimedDone) && !label.passed, labeledAt: new Date().toISOString() };
  writeFileSync(file, JSON.stringify({ ...result, label: full }, null, 2));
  appendFileSync(join(dir, "trajectory.jsonl"), JSON.stringify({ format: FORMAT, runId: result.runId, at: full.labeledAt, type: "label", ...full }) + "\n");
  return full;
}
