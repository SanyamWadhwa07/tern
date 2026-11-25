// OpenAI-compatible streaming client: one fetch, no SDK. Works with OpenRouter, llama.cpp, vLLM,
// Ollama and anything else that serves /chat/completions with server-sent events. It returns the
// reply's text, its raw tool calls (the repair layer reads them next) and the token usage.
import type { RawCall } from "./repair.ts";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type Usage = { prompt: number; completion: number; cost?: number };
export type Reply = { text: string; calls: RawCall[]; usage: Usage; finish?: string };

export type LlmConfig = {
  baseUrl: string; // e.g. https://openrouter.ai/api/v1
  model: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  idleMs?: number; // abort when the stream sends nothing for this long
  retries?: number; // for 429, 5xx and network errors before any byte arrives
  backoffMs?: number; // first retry wait; each next one is 4 times longer
  fetch?: typeof fetch; // tests pass a scripted model here
};

export const OPENROUTER = "https://openrouter.ai/api/v1";

/** Splits an SSE byte stream into the JSON payloads of its `data:` lines. */
export async function* sseData(body: AsyncIterable<Uint8Array>): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      yield JSON.parse(data);
    }
  }
}


export class Llm {
  readonly config: LlmConfig;
  constructor(config: LlmConfig) {
    this.config = config;
  }

  async chat(messages: Message[], tools: object[], signal?: AbortSignal): Promise<Reply> {
    const c = this.config;
    const body = JSON.stringify({
      model: c.model,
      messages,
      tools,
      tool_choice: "auto",
      stream: true,
      stream_options: { include_usage: true },
      usage: { include: true }, // OpenRouter: put the cost in the last chunk
      ...(c.temperature !== undefined ? { temperature: c.temperature } : {}),
      ...(c.maxTokens !== undefined ? { max_tokens: c.maxTokens } : {}),
    });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (c.apiKey) headers.Authorization = `Bearer ${c.apiKey}`;
    const doFetch = c.fetch ?? fetch;
    const retries = c.retries ?? 2;

    const backoff = (attempt: number) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => (signal?.removeEventListener("abort", stop), resolve()), (c.backoffMs ?? 1000) * 4 ** attempt);
        const stop = () => (clearTimeout(t), reject(signal!.reason));
        signal?.addEventListener("abort", stop, { once: true });
      });

    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted(); // a listener added to an already aborted signal never fires
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort);
      let idle: NodeJS.Timeout | undefined;
      const touch = () => {
        clearTimeout(idle);
        idle = setTimeout(() => ctrl.abort(new Error(`model sent nothing for ${c.idleMs ?? 120_000} ms`)), c.idleMs ?? 120_000);
      };
      try {
        touch();
        let res: Response;
        try {
          res = await doFetch(`${c.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers, body, signal: ctrl.signal });
        } catch (e) {
          if (signal?.aborted || attempt >= retries) throw e;
          await backoff(attempt);
          continue;
        }
        if (!res.ok) {
          const detail = (await res.text().catch(() => "")).slice(0, 500);
          if ((res.status === 429 || res.status >= 500) && attempt < retries) {
            await backoff(attempt);
            continue;
          }
          throw new Error(`model request failed: HTTP ${res.status} ${detail}`);
        }
        return await readStream(res, touch);
      } finally {
        clearTimeout(idle);
        signal?.removeEventListener("abort", onAbort);
      }
    }
  }
}

async function readStream(res: Response, touch: () => void): Promise<Reply> {
  let text = "";
  let finish: string | undefined;
  const usage: Usage = { prompt: 0, completion: 0 };
  // Fragments arrive keyed by index (OpenAI, vLLM, llama.cpp) or as whole calls with no index (Gemini).
  const parts = new Map<number | string, { id: string; name: string; arguments: string }>();
  for await (const chunk of sseData(res.body!)) {
    touch();
    if (chunk.error) throw new Error(`model error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
    if (chunk.usage) {
      usage.prompt = chunk.usage.prompt_tokens ?? usage.prompt;
      usage.completion = chunk.usage.completion_tokens ?? usage.completion;
      if (typeof chunk.usage.cost === "number") usage.cost = chunk.usage.cost;
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    const d = choice.delta ?? {};
    if (typeof d.content === "string") text += d.content;
    for (const tc of d.tool_calls ?? []) {
      const key = tc.index ?? (tc.id || parts.size); // an empty id is no key: each whole call gets its own entry
      const p = parts.get(key) ?? { id: "", name: "", arguments: "" };
      if (tc.id) p.id = tc.id;
      if (tc.function?.name && tc.function.name !== p.name) p.name += tc.function.name; // some servers repeat it
      if (tc.function?.arguments) p.arguments += tc.function.arguments;
      parts.set(key, p);
    }
  }
  return { text, calls: [...parts.values()], usage, finish };
}
