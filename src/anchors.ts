// Line anchors. `read` shows every line as `12:a3|text`: the line number plus a 2-character hash of
// the line. Edits name lines by those anchors, so the model never has to retype old text exactly,
// and an edit made against a stale view is rejected because the hash no longer matches.

/** FNV-1a over the line, as two hex characters. The line number does the locating; this only detects change. */
export function hashLine(line: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < line.length; i++) {
    h ^= line.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) & 0xff).toString(16).padStart(2, "0");
}

export type FileText = { lines: string[]; eol: "\n" | "\r\n"; finalNewline: boolean };

export function splitLines(text: string): FileText {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = text.endsWith("\n");
  const body = finalNewline ? text.slice(0, text.endsWith("\r\n") ? -2 : -1) : text;
  return { lines: body === "" && !finalNewline ? [] : body.split(/\r?\n/), eol, finalNewline };
}

export function joinLines(f: FileText): string {
  return f.lines.join(f.eol) + (f.finalNewline && f.lines.length ? f.eol : "");
}

/** Lines `from`..`to` (1-based, inclusive) in anchored form. */
export function anchored(lines: string[], from = 1, to = lines.length): string {
  const out: string[] = [];
  for (let n = Math.max(1, from); n <= Math.min(to, lines.length); n++) out.push(`${n}:${hashLine(lines[n - 1])}|${lines[n - 1]}`);
  return out.join("\n");
}

/** Accepts `12:a3`, `12:a3|the line text` (a copied prefix) or `0` (before the first line, for `after`). */
export function parseAnchor(s: string): { line: number; hash?: string } | undefined {
  const m = /^\s*(\d+)(?::([0-9a-f]{2}))?/i.exec(String(s));
  if (!m) return undefined;
  return { line: Number(m[1]), hash: m[2]?.toLowerCase() };
}

export type Edit = { start?: string; end?: string; after?: string; text: string };

/**
 * Applies one edit. Replace lines `start`..`end` with `text` (empty text deletes them), or insert
 * `text` after the `after` line. Returns the new file and the 1-based range that now holds `text`,
 * or an error the model can act on.
 */
export function applyEdit(f: FileText, e: Edit): { ok: true; file: FileText; from: number; to: number } | { ok: false; error: string } {
  const newLines = e.text === "" ? [] : splitLines(e.text).lines;
  const check = (s: string, allowZero: boolean): number | string => {
    const a = parseAnchor(s);
    if (!a) return `"${s}" is not an anchor. Use the "12:a3" prefix that read shows.`;
    if (a.line === 0 && allowZero) return 0;
    if (a.line < 1 || a.line > f.lines.length) return `line ${a.line} does not exist; the file has ${f.lines.length} lines.`;
    if (!a.hash) return `anchor "${s}" has no hash. Use the full "${a.line}:${hashLine(f.lines[a.line - 1])}" form from read.`;
    const actual = hashLine(f.lines[a.line - 1]);
    if (a.hash !== actual) return `line ${a.line} changed since you read it. Current lines:\n${anchored(f.lines, a.line - 3, a.line + 3)}`;
    return a.line;
  };

  let from: number;
  let removeCount: number;
  if (e.after !== undefined) {
    const at = check(e.after, true);
    if (typeof at === "string") return { ok: false, error: at };
    from = at + 1;
    removeCount = 0;
  } else if (e.start !== undefined) {
    const s = check(e.start, false);
    if (typeof s === "string") return { ok: false, error: s };
    const t = e.end === undefined ? s : check(e.end, false);
    if (typeof t === "string") return { ok: false, error: t };
    if (t < s) return { ok: false, error: `end line ${t} is before start line ${s}.` };
    from = s;
    removeCount = t - s + 1;
  } else {
    return { ok: false, error: "give start (and optionally end) to replace lines, or after to insert." };
  }
  const lines = [...f.lines];
  lines.splice(from - 1, removeCount, ...newLines);
  const finalNewline = f.finalNewline || f.lines.length === 0;
  return { ok: true, file: { ...f, lines, finalNewline }, from, to: from + newLines.length - 1 };
}
