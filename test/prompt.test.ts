// Tern's budget before the task: system prompt plus tool schemas, under 1,000 tokens. Counted with
// o200k_base, a close stand-in for Qwen's tokenizer on English text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Tiktoken } from "js-tiktoken/lite";
import o200k_base from "js-tiktoken/ranks/o200k_base";
import { systemPrompt, TOOLS } from "../src/prompt.ts";

const enc = new Tiktoken(o200k_base);

test("system prompt and tool schemas together stay under 1,000 tokens", (t) => {
  const prompt = enc.encode(systemPrompt("/app", "/logs/agent/tern/notes.md")).length; // with the notes line
  const tools = enc.encode(JSON.stringify(TOOLS)).length;
  t.diagnostic(`system prompt ${prompt} tokens, tool schemas ${tools} tokens, total ${prompt + tools}`);
  assert.ok(prompt + tools < 1000, `${prompt + tools} tokens`);
});

test("the four tools are read, edit, bash and done", () => {
  assert.deepEqual(TOOLS.map((t) => t.function.name), ["read", "edit", "bash", "done"]);
});
