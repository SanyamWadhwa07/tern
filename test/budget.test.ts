import { test } from "node:test";
import assert from "node:assert/strict";
import { Budget, LoopDetector } from "../src/budget.ts";

const clock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

test("time: one note at 75%, one at 90%, then a stop at the limit", () => {
  const c = clock();
  const b = new Budget({ timeLimitMs: 600_000 }, c.now);
  assert.deepEqual(b.check(), { notes: [] });
  c.advance(450_000);
  const at75 = b.check();
  assert.equal(at75.notes.length, 1);
  assert.match(at75.notes[0], /^Budget: 75% of the time limit used \(7\.5 of 10\.0 min\)\. Focus on the main fix/);
  assert.deepEqual(b.check(), { notes: [] }); // not repeated
  c.advance(100_000);
  assert.match(b.check().notes[0], /^Budget: 91% of the time limit used .*Stop exploring/);
  c.advance(50_000);
  assert.deepEqual(b.check(), { notes: [], stop: "time_limit" });
});

test("a jump past both thresholds gives one note, for the higher one", () => {
  const c = clock();
  const b = new Budget({ timeLimitMs: 100 }, c.now);
  c.advance(95);
  const v = b.check();
  assert.equal(v.notes.length, 1);
  assert.match(v.notes[0], /95% .*Stop exploring/);
  assert.deepEqual(b.check(), { notes: [] });
});

test("tokens: notes with counts, then a stop", () => {
  const b = new Budget({ tokenLimit: 100_000 });
  b.addTokens(80_000);
  assert.match(b.check().notes[0], /^Budget: 80% of the token limit used \(80,000 of 100,000\)/);
  b.addTokens(20_000);
  assert.deepEqual(b.check(), { notes: [], stop: "token_limit" });
});

test("no limits, no notes", () => {
  const b = new Budget({});
  b.addTokens(10 ** 9);
  assert.deepEqual(b.check(), { notes: [] });
});

test("loops: the same call and result warns at the 3rd time and stops at the 6th", () => {
  const d = new LoopDetector();
  assert.deepEqual(d.record("bash", { command: "make" }, "exit 2\nerror"), {});
  assert.deepEqual(d.record("bash", { command: "make" }, "exit 2\nerror"), {});
  assert.match(d.record("bash", { command: "make" }, "exit 2\nerror").note!, /^Loop: this exact bash call has now given the same result 3 times/);
  assert.deepEqual(d.record("bash", { command: "make" }, "exit 2\nerror"), {});
  assert.deepEqual(d.record("bash", { command: "make" }, "exit 2\nerror"), {});
  assert.deepEqual(d.record("bash", { command: "make" }, "exit 2\nerror"), { stop: true });
});

test("the same command with a new result is progress, not a loop", () => {
  const d = new LoopDetector();
  for (let i = 0; i < 10; i++) assert.deepEqual(d.record("bash", { command: "npm test" }, `exit 1\n${10 - i} failing`), {});
});

test("alternating between two stuck calls is caught too", () => {
  const d = new LoopDetector();
  const out: object[] = [];
  for (let i = 0; i < 3; i++) {
    out.push(d.record("read", { path: "a" }, "same"));
    out.push(d.record("bash", { command: "ls" }, "same"));
  }
  assert.equal(out.filter((r) => "note" in r).length, 2);
});

test("repeats spread out beyond the last 20 results are forgotten", () => {
  const d = new LoopDetector();
  for (let i = 0; i < 5; i++) {
    d.record("bash", { command: "ls" }, "x");
    for (let j = 0; j < 20; j++) d.record("bash", { command: `echo ${i}-${j}` }, `${i}-${j}`);
  }
  assert.deepEqual(d.record("bash", { command: "ls" }, "x"), {});
});
