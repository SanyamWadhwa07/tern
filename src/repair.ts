// Tool-call repair. Small models often get the intent right and the format wrong: JSON inside a
// markdown fence, a trailing comma, a call written as XML in the text instead of as a tool call, or
// `cmd` where the schema says `command`. Each of those is fixed here, and every fix is named in
// `repairs` so the run log can count them. A call that cannot be read becomes an error the model sees.
import { randomUUID } from "node:crypto";

export type ToolName = "read" | "edit" | "bash" | "done";
export type RawCall = { id?: string; name: string; arguments: string };
export type Call = { id: string; name: ToolName; args: Record<string, unknown> };
export type BadCall = { id: string; name: string; error: string };
export type Repaired = { calls: Call[]; bad: BadCall[]; repairs: string[]; fromText: boolean };

const required: Record<ToolName, string[]> = { read: ["path"], edit: ["path", "text"], bash: ["command"], done: [] };
const known: Record<ToolName, string[]> = {
  read: ["path", "offset", "limit"],
  edit: ["path", "text", "start", "end", "after"],
  bash: ["command", "timeout"],
  done: ["summary"],
};

const nameAliases: Record<string, ToolName> = {};
for (const [tool, names] of Object.entries({
  read: ["read", "read_file", "readfile", "view", "view_file", "cat", "open", "open_file"],
  edit: ["edit", "edit_file", "write", "write_file", "create_file", "replace_lines", "apply_edit", "str_replace"],
  bash: ["bash", "shell", "sh", "run", "run_bash", "execute_bash", "run_command", "execute_command", "run_shell_command", "terminal", "run_terminal_cmd", "exec"],
  done: ["done", "finish", "submit", "complete", "task_complete", "attempt_completion", "final_answer"],
}))
  for (const n of names) nameAliases[n] = tool as ToolName;

const argAliases: Record<ToolName, Record<string, string>> = {
  read: { file_path: "path", filepath: "path", file: "path", filename: "path", start_line: "offset", line: "offset", lines: "limit", max_lines: "limit" },
  edit: {
    file_path: "path", filepath: "path", file: "path", filename: "path",
    content: "text", contents: "text", new_text: "text", new_content: "text", new_string: "text", replacement: "text", code: "text",
    start_line: "start", from: "start", line: "start", anchor: "start", end_line: "end", to: "end", insert_after: "after", after_line: "after",
  },
  bash: { cmd: "command", script: "command", command_line: "command", shell_command: "command", code: "command", timeout_sec: "timeout", timeout_seconds: "timeout" },
  done: { message: "summary", result: "summary", answer: "summary", text: "summary", reason: "summary", explanation: "summary" },
};

// ------------------------------------------------------------------ loose JSON

/** Index just past the balanced {...} or [...] that starts at `from`, string-aware; -1 if unbalanced. */
function balancedEnd(s: string, from: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") if (--depth === 0) return i + 1;
  }
  return -1;
}

function dropTrailingCommas(s: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += s[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    if (c === ",") {
      const next = /^\s*([}\]])/.exec(s.slice(i + 1));
      if (next) continue;
    }
    out += c;
  }
  return out;
}

/** Parses JSON the way a small model writes it. Returns undefined when there is nothing to read. */
export function parseLoose(input: string, repairs: string[] = []): unknown {
  let s = input.trim();
  if (s === "") return {};
  try {
    const v = JSON.parse(s);
    if (typeof v === "string" && /^\s*[{[]/.test(v)) {
      repairs.push("double-encoded-json");
      return parseLoose(v, repairs);
    }
    return v;
  } catch {}
  // Before looking for fences: a fence inside a string value (an edit's text) is content, not a wrapper.
  try {
    const v = JSON.parse(dropTrailingCommas(s));
    repairs.push("trailing-comma");
    return v;
  } catch {}
  const fence = /```[a-zA-Z]*\s*\n?([\s\S]*?)```/.exec(s);
  if (fence) {
    repairs.push("markdown-fence");
    s = fence[1].trim();
  }
  const start = s.search(/[{[]/);
  if (start < 0) return undefined;
  const end = balancedEnd(s, start);
  let body = end < 0 ? s.slice(start) : s.slice(start, end);
  if (start > 0 || (end > 0 && end < s.length)) repairs.push("text-around-json");
  for (const attempt of [body, dropTrailingCommas(body)]) {
    try {
      const v = JSON.parse(attempt);
      if (attempt !== body) repairs.push("trailing-comma");
      return v;
    } catch {}
  }
  return undefined;
}

// ------------------------------------------------------------------ calls

function toolName(name: string, repairs: string[]): ToolName | undefined {
  const key = name.trim().toLowerCase().replace(/^functions?[.:]/, "").replace(/[\s-]+/g, "_");
  const tool = nameAliases[key];
  if (tool && tool !== name) repairs.push(`tool-name:${name}->${tool}`);
  return tool;
}

/** Renames, coerces and checks arguments. Returns the fixed args or an error message. */
function fixArgs(tool: ToolName, raw: unknown, repairs: string[]): Record<string, unknown> | string {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) return `arguments must be a JSON object, like {"${required[tool][0] ?? "summary"}": "..."}.`;
  let args = { ...(raw as Record<string, unknown>) };
  // A call wrapped twice: {"name": "bash", "arguments": {...}} inside the arguments.
  const inner = args.arguments ?? args.parameters;
  if (typeof args.name === "string" && inner && typeof inner === "object") {
    repairs.push("nested-call");
    args = { ...(inner as Record<string, unknown>) };
  }
  for (const [from, to] of Object.entries(argAliases[tool])) {
    if (from in args && !(to in args)) {
      args[to] = args[from];
      delete args[from];
      repairs.push(`arg-name:${from}->${to}`);
    }
  }
  // One required string missing and one unknown string given: that is the one the model meant.
  const missing = required[tool].filter((k) => !(k in args));
  const unknown = Object.keys(args).filter((k) => !known[tool].includes(k));
  if (missing.length === 1 && unknown.length === 1 && typeof args[unknown[0]] === "string") {
    repairs.push(`arg-name:${unknown[0]}->${missing[0]}`);
    args[missing[0]] = args[unknown[0]];
    delete args[unknown[0]];
  }
  for (const k of ["offset", "limit", "timeout"]) {
    if (typeof args[k] === "string" && /^\s*\d+\s*$/.test(args[k] as string)) {
      args[k] = Number(args[k]);
      repairs.push(`arg-type:${k}`);
    }
  }
  for (const k of ["start", "end", "after"]) if (typeof args[k] === "number") args[k] = String(args[k]);
  if (Array.isArray(args.text) && args.text.every((x) => typeof x === "string")) {
    args.text = args.text.join("\n");
    repairs.push("arg-type:text");
  }
  const stillMissing = required[tool].filter((k) => args[k] === undefined);
  if (stillMissing.length) return `missing ${stillMissing.map((k) => `"${k}"`).join(", ")}. ${tool} takes ${known[tool].join(", ")}.`;
  for (const k of ["path", "text", "command", "start", "end", "after", "summary"])
    if (args[k] !== undefined && typeof args[k] !== "string") return `"${k}" must be a string.`;
  return args;
}

function oneCall(id: string, name: string, rawArgs: unknown, repairs: string[]): Call | BadCall {
  const tool = toolName(name, repairs);
  if (!tool) return { id, name, error: `unknown tool "${name}". The tools are read, edit, bash and done.` };
  const args = fixArgs(tool, rawArgs, repairs);
  return typeof args === "string" ? { id, name, error: args } : { id, name: tool, args };
}

const newId = () => `call_${randomUUID().slice(0, 8)}`;

/** Calls written into the message text, in the shapes open-weight models actually emit. */
function callsInText(text: string, repairs: string[]): { name: string; args: unknown }[] {
  const out: { name: string; args: unknown }[] = [];
  // Qwen3-Coder: <function=bash><parameter=command>ls</parameter></function>
  for (const m of text.matchAll(/<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)/g)) {
    const args: Record<string, string> = {};
    for (const p of m[2].matchAll(/<parameter=([\w.-]+)>\n?([\s\S]*?)\n?<\/parameter>/g)) args[p[1]] = p[2];
    out.push({ name: m[1], args });
  }
  if (out.length) return repairs.push("xml-function"), out;
  // Claude-style transcripts: <invoke name="bash"><parameter name="command">ls</parameter></invoke>
  for (const m of text.matchAll(/<invoke name="([\w.-]+)">([\s\S]*?)<\/invoke>/g)) {
    const args: Record<string, string> = {};
    for (const p of m[2].matchAll(/<parameter name="([\w.-]+)">([\s\S]*?)<\/parameter>/g)) args[p[1]] = p[2];
    out.push({ name: m[1], args });
  }
  if (out.length) return repairs.push("xml-invoke"), out;
  // Hermes / Qwen chat templates: <tool_call>{"name": ..., "arguments": {...}}</tool_call>
  const tagged = [...text.matchAll(/<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g)].map((m) => m[1]);
  if (tagged.length) repairs.push("tool-call-tag");
  // Otherwise a JSON object (or a list of them) in the text, fenced or bare.
  for (const chunk of tagged.length ? tagged : [text]) {
    const v = parseLoose(chunk, repairs);
    for (const item of Array.isArray(v) ? v : [v]) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const name = o.name ?? o.tool ?? o.function ?? o.tool_name;
      if (typeof name !== "string") continue;
      const given = o.arguments ?? o.parameters ?? o.args ?? o.input;
      // Outside <tool_call> tags, JSON in prose is a call only if it looks like one: it has arguments,
      // or names one of the four tools exactly. {"name": "my-app", "version": "1.0"} is just JSON.
      if (!tagged.length && given === undefined && !["read", "edit", "bash", "done"].includes(name)) continue;
      let args: unknown = given ?? {};
      if (typeof args === "string") args = parseLoose(args, repairs);
      out.push({ name, args });
    }
  }
  if (out.length && !tagged.length) repairs.push("json-in-text");
  return out;
}

/**
 * Turns one model reply into calls the harness can run. Native tool calls win; when there are none,
 * calls written into the text are used. `bad` holds calls that could not be repaired, with the
 * message to send back as their tool result.
 */
export function repairCalls(raw: RawCall[], text: string): Repaired {
  const repairs: string[] = [];
  const calls: Call[] = [];
  const bad: BadCall[] = [];
  const add = (c: Call | BadCall) => ("error" in c ? bad.push(c) : calls.push(c));
  if (raw.length) {
    for (const r of raw) {
      const args = parseLoose(r.arguments ?? "", repairs);
      if (args === undefined) add({ id: r.id || newId(), name: r.name, error: `could not read the arguments as JSON: ${r.arguments.slice(0, 200)}` });
      else add(oneCall(r.id || newId(), r.name, args, repairs));
    }
    return { calls, bad, repairs, fromText: false };
  }
  const found = callsInText(text, repairs);
  for (const f of found) add(oneCall(newId(), f.name, f.args, repairs));
  // Text that only mentions JSON is a normal reply, not a failed call: report nothing.
  if (!calls.length && !bad.length) repairs.length = 0;
  return { calls, bad, repairs, fromText: found.length > 0 };
}
