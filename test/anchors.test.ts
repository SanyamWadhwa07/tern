import { test } from "node:test";
import assert from "node:assert/strict";
import { anchored, applyEdit, hashLine, joinLines, parseAnchor, splitLines } from "../src/anchors.ts";

const src = "function add(a, b) {\n  return a - b;\n}\n";
const a = (f: ReturnType<typeof splitLines>, n: number) => `${n}:${hashLine(f.lines[n - 1])}`;

test("read output tags each line with its number and a 2-character hash", () => {
  const out = anchored(splitLines(src).lines);
  assert.match(out, /^1:[0-9a-f]{2}\|function add\(a, b\) \{\n2:[0-9a-f]{2}\|  return a - b;\n3:[0-9a-f]{2}\|\}$/);
});

test("anchors parse from the bare form, a copied line prefix, and 0", () => {
  assert.deepEqual(parseAnchor("2:Ab"), { line: 2, hash: "ab" });
  assert.deepEqual(parseAnchor("2:ab|  return a - b;"), { line: 2, hash: "ab" });
  assert.deepEqual(parseAnchor("0"), { line: 0, hash: undefined });
  assert.equal(parseAnchor("line two"), undefined);
});

test("replacing one line keeps the rest and the final newline", () => {
  const f = splitLines(src);
  const r = applyEdit(f, { start: a(f, 2), text: "  return a + b;" });
  assert.ok(r.ok);
  assert.equal(joinLines(r.file), "function add(a, b) {\n  return a + b;\n}\n");
  assert.deepEqual([r.from, r.to], [2, 2]);
});

test("a range can be replaced by more lines, or deleted with empty text", () => {
  const f = splitLines("a\nb\nc\nd\n");
  const grown = applyEdit(f, { start: a(f, 2), end: a(f, 3), text: "x\ny\nz" });
  assert.ok(grown.ok);
  assert.equal(joinLines(grown.file), "a\nx\ny\nz\nd\n");
  const gone = applyEdit(f, { start: a(f, 2), end: a(f, 3), text: "" });
  assert.ok(gone.ok);
  assert.equal(joinLines(gone.file), "a\nd\n");
});

test("insert after a line, or after 0 for the top of the file", () => {
  const f = splitLines("b\n");
  const top = applyEdit(f, { after: "0", text: "a" });
  assert.ok(top.ok);
  assert.equal(joinLines(top.file), "a\nb\n");
  const end = applyEdit(f, { after: a(f, 1), text: "c" });
  assert.ok(end.ok);
  assert.equal(joinLines(end.file), "b\nc\n");
});

test("a stale anchor is rejected and the error shows the current lines", () => {
  const f = splitLines(src);
  const stale = `2:${hashLine("  return a * b;")}`;
  assert.notEqual(stale, a(f, 2));
  const r = applyEdit(f, { start: stale, text: "x" });
  assert.ok(!r.ok);
  assert.match(r.error, /changed since you read it/);
  assert.match(r.error, /2:[0-9a-f]{2}\|  return a - b;/);
});

test("missing hashes, missing lines and reversed ranges explain themselves", () => {
  const f = splitLines(src);
  const noHash = applyEdit(f, { start: "2", text: "x" });
  assert.ok(!noHash.ok && /has no hash/.test(noHash.error));
  const past = applyEdit(f, { start: "9:00", text: "x" });
  assert.ok(!past.ok && /does not exist; the file has 3 lines/.test(past.error));
  const reversed = applyEdit(f, { start: a(f, 3), end: a(f, 1), text: "x" });
  assert.ok(!reversed.ok && /before start/.test(reversed.error));
});

test("Windows line endings survive an edit", () => {
  const f = splitLines("a\r\nb\r\n");
  const r = applyEdit(f, { start: a(f, 2), text: "B" });
  assert.ok(r.ok);
  assert.equal(joinLines(r.file), "a\r\nB\r\n");
});
