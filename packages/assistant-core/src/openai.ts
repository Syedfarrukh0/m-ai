import type { ModelClient, ModelMessage, ModelRequest, ModelResponse, TextBlock, ToolCallBlock } from './model.js';
import { ModelError } from './model.js';

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
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
            ...options.headers,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (e) {
        throw new ModelError(`model request failed: ${(e as Error).message}`, undefined, true);
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ModelError(`model returned ${res.status}: ${text.slice(0, 300)}`, res.status, res.status === 429 || res.status >= 500);
      }
      return fromChatResponse((await res.json()) as ChatResponse, options.model);
    },
  };
}

export function toChatBody(options: Pick<OpenAICompatibleOptions, 'model' | 'disableParallelToolCalls' | 'useMaxCompletionTokens'>, request: ModelRequest): Record<string, unknown> {
  const messages: ChatMessage[] = [{ role: 'system', content: request.system }, ...request.messages.flatMap(toChatMessages)];
  const body: Record<string, unknown> = {
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
  if (choice.message.content) content.push({ type: 'text', text: choice.message.content });
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
