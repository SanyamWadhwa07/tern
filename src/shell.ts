// Runs one shell command with a time limit and returns its exit code and combined output. A command
// that runs too long is killed with its whole process tree, so a stuck server cannot hold the run.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export type Ran = { exit: number | null; output: string; timedOut: boolean; ms: number };

const shell = process.platform === "win32" ? true : existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";

export function runCommand(command: string, cwd: string, timeoutMs: number): Promise<Ran> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    let timedOut = false;
    const add = (b: Buffer) => {
      if (output.length < 2_000_000) output += b.toString("utf8"); // enough for any tail we show
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
      }
    }, timeoutMs);
    const finish = (exit: number | null) => {
      clearTimeout(timer);
      resolve({ exit, output, timedOut, ms: Math.round(performance.now() - t0) });
    };
    child.on("error", (e) => {
      output += String(e);
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

/** Keeps the start and, mostly, the end of long output: errors and test summaries come last. */
export function clip(text: string, max = 12_000): string {
  if (text.length <= max) return text;
  const head = Math.floor(max / 3);
  return `${text.slice(0, head)}\n[... ${text.length - max} characters cut ...]\n${text.slice(text.length - (max - head))}`;
}
