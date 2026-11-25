// The tools behind read, edit and bash (done is judged by the gate). Each returns plain text for the
// model; a result that starts with "error:" tells it what to do differently.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { anchored, applyEdit, joinLines, splitLines } from "./anchors.ts";
import type { Guard } from "./gate.ts";
import type { Call } from "./repair.ts";
import { clip, runCommand } from "./shell.ts";

export type ToolContext = { cwd: string; guard: Guard; signal?: AbortSignal };

const around = (lines: string[], from: number, to: number) => anchored(lines, from - 2, Math.min(to + 2, from + 40));

function read(ctx: ToolContext, a: { path: string; offset?: number; limit?: number }): string {
  const file = resolve(ctx.cwd, a.path);
  if (!existsSync(file)) return `error: no such file or directory: ${a.path}`;
  if (statSync(file).isDirectory()) {
    const names = readdirSync(file, { withFileTypes: true }).map((d) => (d.isDirectory() ? `${d.name}/` : d.name)).sort();
    return names.length > 300 ? `${names.slice(0, 300).join("\n")}\n(${names.length - 300} more entries)` : names.join("\n") || "(empty directory)";
  }
  const bytes = readFileSync(file);
  if (bytes.subarray(0, 8000).includes(0)) return `error: ${a.path} is a binary file (${bytes.length} bytes). Inspect it with bash.`;
  const { lines } = splitLines(bytes.toString("utf8"));
  if (!lines.length) return `(${a.path} is empty)`;
  const from = Math.max(1, a.offset ?? 1);
  const to = Math.min(lines.length, from + (a.limit ?? 400) - 1);
  const shown = anchored(lines, from, to).replace(/^(\d+:[0-9a-f]{2}\|.{2000}).+$/gm, "$1 [line cut]");
  return to < lines.length ? `${shown}\n(lines ${from}-${to} of ${lines.length}; read with offset ${to + 1} for more)` : shown;
}

function edit(ctx: ToolContext, a: { path: string; text: string; start?: string; end?: string; after?: string }): string {
  const file = resolve(ctx.cwd, a.path);
  if (ctx.guard.isProtected(file)) return `error: ${a.path} is protected and read-only. Fix the code, not the tests or checks.`;
  if (a.start === undefined && a.after === undefined) {
    mkdirSync(dirname(file), { recursive: true });
    const f = splitLines(a.text);
    writeFileSync(file, a.text.endsWith("\n") || a.text === "" ? a.text : a.text + "\n");
    return `wrote ${f.lines.length} lines to ${a.path}:\n${around(f.lines, 1, f.lines.length)}`;
  }
  if (!existsSync(file)) return `error: ${a.path} does not exist. To create it, call edit with only path and text.`;
  const r = applyEdit(splitLines(readFileSync(file, "utf8")), a);
  if (!r.ok) return `error: ${r.error}`;
  writeFileSync(file, joinLines(r.file));
  const what = r.to < r.from ? `removed lines at ${r.from}` : `lines ${r.from}-${r.to} now read`;
  return `edited ${a.path}, ${what}:\n${around(r.file.lines, r.from, Math.max(r.from, r.to))}`;
}

async function bash(ctx: ToolContext, a: { command: string; timeout?: number }): Promise<string> {
  const seconds = Math.min(Math.max(a.timeout ?? 120, 1), 600);
  const r = await runCommand(a.command, ctx.cwd, seconds * 1000, ctx.signal);
  const restored = ctx.guard.restore();
  const head = r.timedOut ? `timed out after ${seconds} s (killed)` : `exit ${r.exit}`;
  const note = restored.length ? `\nnote: this command changed protected files, so they were restored: ${restored.join(", ")}` : "";
  return `${head}\n${clip(r.output.trimEnd()) || "(no output)"}${note}`;
}

export async function runTool(call: Call, ctx: ToolContext): Promise<string> {
  try {
    if (call.name === "read") return read(ctx, call.args as any);
    if (call.name === "edit") return edit(ctx, call.args as any);
    if (call.name === "bash") return await bash(ctx, call.args as any);
    return `error: ${call.name} is handled by the harness`;
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}
