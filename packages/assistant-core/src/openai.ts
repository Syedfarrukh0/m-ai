import type { ModelClient, ModelMessage, ModelRequest, ModelResponse, TextBlock, ToolCallBlock } from './model.js';
import { ModelError, httpModelError, networkModelError } from './model.js';
import type { ModelPricing } from './usage.js';

/**
 * A ModelClient for the OpenAI Chat Completions API — and for every provider
 * that offers an OpenAI-compatible endpoint (many hosted providers, and local
 * servers such as Ollama or vLLM). The model must support tool calling.
 */
export interface OpenAICompatibleOptions {
  /** Not needed by some local servers; sent as a Bearer token when given. */
  apiKey?: string;
  model: string;
  /** e.g. https://api.openai.com/v1, or http://localhost:11434/v1 for Ollama. */
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  /** Send `parallel_tool_calls: false`. Turn off for servers that reject the field. Default true. */
  disableParallelToolCalls?: boolean;
  /** Use `max_completion_tokens` instead of `max_tokens` (newer OpenAI models). Default false. */
  useMaxCompletionTokens?: boolean;
  /** Extra headers some providers want. */
  headers?: Record<string, string>;
  /** Extra request fields some providers want, e.g. Z.ai's `{ thinking: { type: 'disabled' } }`. */
  extraBody?: Record<string, unknown>;
  /** This model's price, attached to every response so each call is costed correctly. */
  pricing?: ModelPricing;
  timeoutMs?: number;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

interface ChatResponse {
  model?: string;
  choices: Array<{
    finish_reason: string | null;
    message: {
      content?: string | null;
      tool_calls?: Array<{ id: string; type?: string; function: { name: string; arguments: string } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null };
}

export function createOpenAICompatibleModel(options: OpenAICompatibleOptions): ModelClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = `${options.baseUrl.replace(/\/$/, '')}/chat/completions`;

  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const body = toChatBody(options, request);
      const timeoutMs = options.timeoutMs ?? 60_000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
            ...options.headers,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) throw httpModelError('the provider answered', res, await res.text().catch(() => ''));
        const response = fromChatResponse((await res.json()) as ChatResponse, options.model);
        if (options.pricing) response.pricing = options.pricing;
        return response;
      } catch (e) {
        if (e instanceof ModelError) throw e;
        throw networkModelError(e, timeoutMs);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function toChatBody(
  options: Pick<OpenAICompatibleOptions, 'model' | 'disableParallelToolCalls' | 'useMaxCompletionTokens' | 'extraBody'>,
  request: ModelRequest,
): Record<string, unknown> {
  const messages: ChatMessage[] = [{ role: 'system', content: request.system }, ...request.messages.flatMap(toChatMessages)];
  const body: Record<string, unknown> = {
    ...options.extraBody,
    model: options.model,
    messages,
    [options.useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens']: request.maxTokens,
  };
  if (request.tools.length > 0) {
    body['tools'] = request.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
    body['tool_choice'] = 'auto';
    if (options.disableParallelToolCalls ?? true) body['parallel_tool_calls'] = false;
  }
  return body;
}

/** One neutral message can become several chat messages: tool results must be their own "tool" messages. */
function toChatMessages(m: ModelMessage): ChatMessage[] {
  if (m.role === 'assistant') {
    const text = m.content.filter((b): b is TextBlock => b.type === 'text').map((b) => b.text).join('\n');
    const calls = m.content.filter((b): b is ToolCallBlock => b.type === 'tool_call');
    const msg: ChatMessage = { role: 'assistant', content: text || null };
    if (calls.length > 0)
      msg.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } }));
    return [msg];
  }
  const out: ChatMessage[] = [];
  for (const b of m.content) if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.toolCallId, content: b.isError ? `ERROR: ${b.content}` : b.content });
  const text = m.content.filter((b): b is TextBlock => b.type === 'text').map((b) => b.text).join('\n');
  if (text) out.push({ role: 'user', content: text });
  return out;
}

export function fromChatResponse(r: ChatResponse, fallbackModel: string): ModelResponse {
  const choice = r.choices[0];
  if (!choice) throw new ModelError('model returned no choices', undefined, true);
  const content: Array<TextBlock | ToolCallBlock> = [];
  // Reasoning models (Qwen, DeepSeek, GLM via some servers) may put their thinking in the text.
  // It is not the reply: drop it. A separate `reasoning_content` field is ignored altogether.
  const text = choice.message.content ? stripThinking(choice.message.content) : '';
  if (text) content.push({ type: 'text', text });
  for (const c of choice.message.tool_calls ?? []) {
    let input: unknown;
    try {
      input = c.function.arguments ? JSON.parse(c.function.arguments) : {};
    } catch {
      input = { _unparsedArguments: c.function.arguments };
    }
    content.push({ type: 'tool_call', id: c.id, name: c.function.name, input });
  }
  const prompt = r.usage?.prompt_tokens ?? 0;
  const cached = r.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const finish = choice.finish_reason;
  return {
    content,
    stopReason: finish === 'tool_calls' || content.some((b) => b.type === 'tool_call') ? 'tool_call' : finish === 'length' ? 'max_tokens' : finish === 'stop' ? 'end' : 'other',
    usage: { inputTokens: Math.max(0, prompt - cached), cachedInputTokens: cached, outputTokens: r.usage?.completion_tokens ?? 0 },
    model: r.model ?? fallbackModel,
  };
}

/** Removes <think>…</think> sections (and an unfinished one at the end) from a model's text. */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim();
}

/** The model ids an OpenAI-compatible server offers (GET {baseUrl}/models). */
export async function listOpenAICompatibleModels(
  options: Pick<OpenAICompatibleOptions, 'apiKey' | 'baseUrl' | 'headers' | 'fetch'>,
): Promise<string[]> {
  const doFetch = options.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await doFetch(`${options.baseUrl.replace(/\/$/, '')}/models`, {
      method: 'GET',
      headers: { ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}), ...options.headers },
    });
  } catch (e) {
    throw new ModelError(`could not reach ${options.baseUrl}: ${(e as Error).message}`, undefined, true);
  }
  const text = await res.text();
  if (!res.ok) throw httpModelError('the provider answered', res, text);
  const body = JSON.parse(text) as { data?: Array<{ id: string }>; models?: Array<{ id?: string; name?: string }> };
  // Gemini lists "models/gemini-…" but takes the id without the prefix.
  return [...(body.data ?? []).map((m) => m.id), ...(body.models ?? []).map((m) => m.id ?? m.name ?? '')]
    .filter(Boolean)
    .map((id) => id.replace(/^models\//, ''));
}
