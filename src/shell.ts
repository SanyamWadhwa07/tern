// Runs one shell command with a time limit and returns its exit code and combined output. A command
// that runs too long, or a run that is interrupted, kills the whole process tree, so a stuck server
// cannot hold the run.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export type Ran = { exit: number | null; output: string; timedOut: boolean; ms: number };

const shell = process.platform === "win32" ? true : existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
const PIPE_GRACE_MS = 300; // after the shell exits, how long to wait for output still in the pipes

export function runCommand(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<Ran> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    let timedOut = false;
    let done = false;
    // setEncoding keeps a decoder per stream, so a character split across two chunks stays whole.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const add = (s: string) => {
      if (output.length < 2_000_000) output += s; // enough for any tail we show
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const kill = () => {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    const finish = (exit: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      resolve({ exit, output, timedOut, ms: Math.round(performance.now() - t0) });
    };
    child.on("error", (e) => {
      output += String(e);
      finish(null);
    });
    child.on("close", (code) => finish(code));
    // A background process started by the command (a server with `&`) inherits the pipes and keeps
    // them open, so "close" may never come. The shell's own exit is the end of the command.
    child.on("exit", (code) =>
      setTimeout(() => {
        if (done) return;
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code);
      }, PIPE_GRACE_MS),
    );
    if (signal?.aborted) kill();
  });
}

/** Keeps the start and, mostly, the end of long output: errors and test summaries come last. */
export function clip(text: string, max = 12_000): string {
  if (text.length <= max) return text;
  const head = Math.floor(max / 3);
  return `${text.slice(0, head)}\n[... ${text.length - max} characters cut ...]\n${text.slice(text.length - (max - head))}`;
}
