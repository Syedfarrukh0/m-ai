import type { ModelClient, ModelMessage, ModelRequest, ModelResponse, TextBlock, ToolCallBlock } from './model.js';
import { ModelError, httpModelError, networkModelError } from './model.js';
import { stripThinking } from './openai.js';
import type { ModelPricing } from './usage.js';

/**
 * A ModelClient for Ollama's own API (/api/chat), for models on this computer.
 * Unlike Ollama's OpenAI-compatible endpoint it can switch a model's thinking
 * off — on a CPU, thinking can take minutes and use up the whole token budget
 * before any answer — and it sets the context length per request, so a long
 * prompt with tools is never silently cut.
 */
export interface OllamaOptions {
  model: string;
  /** Default http://localhost:11434. */
  baseUrl?: string;
  /**
   * Let the model think before answering: false (default — faster, and the answer
   * can't be crowded out), true, or a level for models that have levels (gpt-oss: low/medium/high).
   */
  think?: boolean | 'low' | 'medium' | 'high';
  /** Context length in tokens. Default 8192. */
  numCtx?: number;
  /** How long the model stays loaded after a call. Default "30m". */
  keepAlive?: string;
  fetch?: typeof globalThis.fetch;
  /** Default 300 s: a CPU can be slow. */
  timeoutMs?: number;
  pricing?: ModelPricing;
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
  tool_name?: string;
}

interface OllamaResponse {
  model?: string;
  message?: { content?: string; thinking?: string; tool_calls?: Array<{ id?: string; function: { name: string; arguments: unknown } }> };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/** http://localhost:11434/v1 (the OpenAI-compatible address) → http://localhost:11434. */
export function ollamaBase(baseUrl: string | undefined): string {
  return (baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '').replace(/\/v1$/, '');
}

export function createOllamaModel(options: OllamaOptions): ModelClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = `${ollamaBase(options.baseUrl)}/api/chat`;
  // Some models have no thinking switch and refuse the field: then it is left out.
  let sendThink = true;

  async function call(request: ModelRequest): Promise<ModelResponse> {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toOllamaBody(options, request, sendThink)),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (sendThink && /think/i.test(text) && res.status === 400) {
          sendThink = false;
          return call(request);
        }
        throw httpModelError('Ollama answered', res, text);
      }
      const response = fromOllamaResponse((await res.json()) as OllamaResponse, options.model);
      if (options.pricing) response.pricing = options.pricing;
      return response;
    } catch (e) {
      if (e instanceof ModelError) throw e;
      const err = networkModelError(e, timeoutMs);
      if (/fetch failed|ECONNREFUSED|connect/i.test(err.message))
        throw new ModelError(`Ollama is not running at ${ollamaBase(options.baseUrl)} — open the Ollama app, or run: ollama serve`, undefined, true);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  /** Up, and the model is downloaded: one quick GET, at most 1.5 s. */
  async function health(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const res = await doFetch(`${ollamaBase(options.baseUrl)}/api/tags`, { method: 'GET', signal: controller.signal });
      if (!res.ok) return false;
      const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
      const names = new Set((body.models ?? []).flatMap((m) => [m.name, m.model]).filter((n): n is string => !!n));
      return names.has(options.model) || names.has(`${options.model}:latest`);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  return { complete: call, health };
}

export function toOllamaBody(options: OllamaOptions, request: ModelRequest, sendThink = true): Record<string, unknown> {
  const names = new Map<string, string>();
  const messages: OllamaMessage[] = [{ role: 'system', content: request.system }];
  for (const m of request.messages) messages.push(...toOllamaMessages(m, names));
  return {
    model: options.model,
    messages,
    ...(request.tools.length > 0
      ? { tools: request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
      : {}),
    stream: false,
    ...(sendThink ? { think: options.think ?? false } : {}),
    options: { num_ctx: options.numCtx ?? 8192, num_predict: request.maxTokens },
    keep_alive: options.keepAlive ?? '30m',
  };
}

/** Ollama tool results name the tool rather than an id; `names` maps our call ids to tool names. */
function toOllamaMessages(m: ModelMessage, names: Map<string, string>): OllamaMessage[] {
  const text = m.content.filter((b): b is TextBlock => b.type === 'text').map((b) => b.text).join('\n');
  if (m.role === 'assistant') {
    const calls = m.content.filter((b): b is ToolCallBlock => b.type === 'tool_call');
    for (const c of calls) names.set(c.id, c.name);
    const msg: OllamaMessage = { role: 'assistant', content: text };
    if (calls.length > 0) msg.tool_calls = calls.map((c) => ({ function: { name: c.name, arguments: c.input ?? {} } }));
    return [msg];
  }
  const out: OllamaMessage[] = [];
  for (const b of m.content)
    if (b.type === 'tool_result') {
      const name = names.get(b.toolCallId);
      out.push({ role: 'tool', content: b.isError ? `ERROR: ${b.content}` : b.content, ...(name ? { tool_name: name } : {}) });
    }
  if (text) out.push({ role: 'user', content: text });
  return out;
}

export function fromOllamaResponse(r: OllamaResponse, fallbackModel: string): ModelResponse {
  const content: Array<TextBlock | ToolCallBlock> = [];
  const text = stripThinking(r.message?.content ?? '');
  if (text) content.push({ type: 'text', text });
  for (const c of r.message?.tool_calls ?? []) {
    let input = c.function.arguments;
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        input = { _unparsedArguments: input };
      }
    }
    content.push({ type: 'tool_call', id: c.id ?? `call_${globalThis.crypto.randomUUID().slice(0, 12)}`, name: c.function.name, input: input ?? {} });
  }
  const done = r.done_reason;
  return {
    content,
    stopReason: content.some((b) => b.type === 'tool_call') ? 'tool_call' : done === 'length' ? 'max_tokens' : done === 'stop' ? 'end' : 'other',
    usage: { inputTokens: r.prompt_eval_count ?? 0, cachedInputTokens: 0, outputTokens: r.eval_count ?? 0 },
    model: r.model ?? fallbackModel,
  };
}

/** The models downloaded to this computer (GET /api/tags). */
export async function listOllamaModels(options: Pick<OllamaOptions, 'baseUrl' | 'fetch'> = {}): Promise<string[]> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = ollamaBase(options.baseUrl);
  let res: Response;
  try {
    res = await doFetch(`${base}/api/tags`, { method: 'GET' });
  } catch {
    throw new ModelError(`Ollama is not running at ${base} — open the Ollama app, or run: ollama serve`, undefined, true);
  }
  const text = await res.text();
  if (!res.ok) throw httpModelError('Ollama answered', res, text);
  const body = JSON.parse(text) as { models?: Array<{ name?: string; model?: string }> };
  return (body.models ?? []).map((m) => m.model ?? m.name ?? '').filter(Boolean);
}
