// The budget guard. Small models lose track of time and spend: they explore until the task times
// out with nothing verified, or repeat the same failing step. Two parts:
//   Budget        warns the model at 75% and 90% of the time or token limit, and stops the run at 100%
//                 so the logs are still written (a run killed from outside leaves no result).
//   LoopDetector  notices the same call giving the same result again and again: warns at the 3rd
//                 repeat, stops at the 6th.

export type BudgetLimits = { timeLimitMs?: number; tokenLimit?: number };
export type Verdict = { notes: string[]; stop?: "time_limit" | "token_limit" };

const THRESHOLDS = [0.75, 0.9];

const advice = (level: number) =>
  level >= 0.9
    ? "Stop exploring. Make sure the work so far is saved and checked, then call done."
    : "Focus on the main fix, run the checks, and call done when they pass.";

export class Budget {
  private readonly limits: BudgetLimits;
  private readonly now: () => number;
  private readonly start: number;
  private tokens = 0;
  private warned = { time: 0, tokens: 0 }; // highest threshold already warned about

  constructor(limits: BudgetLimits, now: () => number = Date.now) {
    this.limits = limits;
    this.now = now;
    this.start = now();
  }

  addTokens(n: number) {
    this.tokens += n;
  }

  /** Called before each model request: notes for thresholds newly crossed, or a stop. */
  check(): Verdict {
    const notes: string[] = [];
    const { timeLimitMs, tokenLimit } = this.limits;
    if (timeLimitMs) {
      const used = this.now() - this.start;
      if (used >= timeLimitMs) return { notes, stop: "time_limit" };
      const note = this.crossed("time", used / timeLimitMs);
      if (note) notes.push(`Budget: ${note} of the time limit used (${min(used)} of ${min(timeLimitMs)} min). ${advice(used / timeLimitMs)}`);
    }
    if (tokenLimit) {
      if (this.tokens >= tokenLimit) return { notes, stop: "token_limit" };
      const note = this.crossed("tokens", this.tokens / tokenLimit);
      if (note) notes.push(`Budget: ${note} of the token limit used (${this.tokens.toLocaleString("en")} of ${tokenLimit.toLocaleString("en")}). ${advice(this.tokens / tokenLimit)}`);
    }
    return { notes };
  }

  private crossed(kind: "time" | "tokens", share: number): string | undefined {
    const level = THRESHOLDS.filter((t) => share >= t).at(-1);
    if (level === undefined || level <= this.warned[kind]) return undefined;
    this.warned[kind] = level;
    return `${Math.floor(share * 100)}%`;
  }
}

const min = (ms: number) => (ms / 60_000).toFixed(1);

export const LOOP_WARN = 3;
export const LOOP_STOP = 6;
const WINDOW = 20;

/** Counts identical (call, result) pairs among the last 20 tool results. */
export class LoopDetector {
  private recent: string[] = [];

  /** Returns a note when this pair reaches the warning count, and stop when it reaches the stop count. */
  record(name: string, args: unknown, result: string): { note?: string; stop?: boolean } {
    const key = `${name}\u0000${JSON.stringify(args)}\u0000${result}`;
    this.recent.push(key);
    if (this.recent.length > WINDOW) this.recent.shift();
    const count = this.recent.filter((k) => k === key).length;
    if (count >= LOOP_STOP) return { stop: true };
    if (count === LOOP_WARN)
      return { note: `Loop: this exact ${name} call has now given the same result ${count} times. Repeating it will not change the outcome. Try a different approach.` };
    return {};
  }
}
