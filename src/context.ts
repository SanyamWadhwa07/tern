// Context without lossy compaction. When the conversation nears the context limit, the oldest tool
// outputs are replaced by one-line placeholders; nothing is summarised by a model, so nothing is
// silently rewritten. The newest results stay whole, the model's own notes file carries the plan
// and findings across the trim, and the full outputs stay in trajectory.jsonl.
import type { Message } from "./llm.ts";

export const KEEP_RECENT = 6; // newest tool results are never trimmed
const MARK = "[trimmed:";

/** A rough token count: JSON characters / 4. Deterministic, and errs high for code and JSON. */
export function estimateTokens(messages: Message[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

/** Trims the oldest tool outputs until the estimate is at or under `target`. Returns how many were trimmed. */
export function trimContext(messages: Message[], target: number): number {
  let tokens = estimateTokens(messages);
  const tools = messages.filter((m): m is Extract<Message, { role: "tool" }> => m.role === "tool");
  let trimmed = 0;
  for (const m of tools.slice(0, Math.max(0, tools.length - KEEP_RECENT))) {
    if (tokens <= target) break;
    if (m.content.startsWith(MARK) || m.content.length < 400) continue;
    const before = m.content.length;
    m.content = `${MARK} ${before} characters of old output removed to save context. Run the command or read the file again if you need it.]`;
    tokens -= Math.floor((before - m.content.length) / 4);
    trimmed++;
  }
  return trimmed;
}
