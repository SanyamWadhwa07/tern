// The verify gate. Two rules: protected paths (tests, checks) are read-only, and "done" is only
// accepted after the task's checks pass. Every done claim is recorded, accepted or not, so a run can
// later be scored for false-done: claims the agent made that the hidden tests did not support.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { clip, runCommand } from "./shell.ts";

const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));

// Caches that test runners write by themselves. Not test content, so never guarded or restored.
const CACHES = new Set(["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".cache", "node_modules"]);

function walk(root: string, out: Map<string, Buffer>) {
  if (!existsSync(root)) return;
  if (statSync(root).isFile()) return void out.set(root, readFileSync(root));
  for (const name of readdirSync(root)) if (!CACHES.has(name)) walk(join(root, name), out);
}

/** Snapshots protected files at the start, and puts them back whenever they change. */
export class Guard {
  readonly cwd: string;
  readonly roots: string[];
  private snapshot = new Map<string, Buffer>();

  constructor(cwd: string, paths: string[] = []) {
    this.cwd = cwd;
    this.roots = paths.map((p) => resolve(cwd, p));
    for (const r of this.roots) walk(r, this.snapshot);
  }

  isProtected(path: string): boolean {
    const p = norm(path);
    return this.roots.some((r) => p === norm(r) || p.startsWith(norm(r) + sep));
  }

  /** Restores changed or deleted protected files and removes new ones. Returns what it fixed. */
  restore(): string[] {
    const now = new Map<string, Buffer>();
    for (const r of this.roots) walk(r, now);
    const fixed: string[] = [];
    for (const [file, bytes] of this.snapshot) {
      const cur = now.get(file);
      if (cur && cur.equals(bytes)) continue;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
      fixed.push(file);
    }
    for (const file of now.keys()) {
      if (this.snapshot.has(file)) continue;
      rmSync(file, { force: true });
      fixed.push(file);
    }
    return fixed.map((f) => relative(this.cwd, f).split(sep).join("/")).sort();
  }
}

export type CheckResult = { command: string; exit: number | null; timedOut: boolean; ms: number; tail: string };
export type Claim = {
  at: string;
  turn: number;
  summary: string;
  accepted: boolean;
  verified: boolean; // false when the task has no checks: accepted on the agent's word alone
  tampered: string[];
  checks: CheckResult[];
};

/** Judges one done claim: restores protected files, runs every check, and says what to tell the model. */
export async function judgeClaim(o: { cwd: string; guard: Guard; checks: string[]; summary: string; turn: number; timeoutMs?: number; signal?: AbortSignal }): Promise<{ claim: Claim; reply: string }> {
  const tampered = o.guard.restore();
  const checks: CheckResult[] = [];
  for (const command of o.checks) {
    const r = await runCommand(command, o.cwd, o.timeoutMs ?? 600_000, o.signal);
    checks.push({ command, exit: r.exit, timedOut: r.timedOut, ms: r.ms, tail: clip(r.output, 3000) });
  }
  o.guard.restore(); // whatever the checks themselves wrote there is undone, and not blamed on the agent
  const failed = checks.filter((c) => c.exit !== 0);
  const accepted = tampered.length === 0 && failed.length === 0;
  const claim: Claim = { at: new Date().toISOString(), turn: o.turn, summary: o.summary, accepted, verified: checks.length > 0, tampered, checks };

  if (accepted) return { claim, reply: checks.length ? `Accepted: ${checks.length} of ${checks.length} checks passed.` : "Accepted. This task has no checks configured." };
  const parts = ["Not done yet. Keep working, then call done again."];
  if (tampered.length) parts.push(`Protected files were changed, so they were restored: ${tampered.join(", ")}. Fix the code, not the tests.`);
  for (const c of failed) parts.push(`Check \`${c.command}\` ${c.timedOut ? "timed out" : `failed with exit ${c.exit}`}:\n${c.tail}`);
  return { claim, reply: parts.join("\n\n") };
}
