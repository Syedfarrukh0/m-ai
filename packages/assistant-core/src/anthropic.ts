import type { ContentBlock, ModelClient, ModelRequest, ModelResponse, TextBlock, ToolCallBlock } from './model.js';
import { ModelError } from './model.js';

export { ModelError } from './model.js';

export interface AnthropicOptions {
  apiKey: string;
  /** The model id to use, e.g. from your account's model list. Required: no default is guessed. */
  model: string;
  baseUrl?: string;
  /** Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Mark the system prompt and tool list as cacheable (prompt caching). Default true. */
  cache?: boolean;
  /** Request timeout. Default 60 s. */
  timeoutMs?: number;
}

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicResponse {
  model: string;
  content: AnthropicBlock[];
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}

/** A ModelClient for the Anthropic Messages API, over fetch (no SDK dependency). */
export function createAnthropicModel(options: AnthropicOptions): ModelClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = `${(options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`;
  const cache = options.cache ?? true;

  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const body = toAnthropicBody(options.model, request, cache);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': options.apiKey,
            'anthropic-version': '2023-06-01',
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
        const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
        throw new ModelError(`model returned ${res.status}: ${text.slice(0, 300)}`, res.status, retryable);
      }
      return fromAnthropicResponse((await res.json()) as AnthropicResponse);
    },
  };
}

export function toAnthropicBody(model: string, request: ModelRequest, cache: boolean): Record<string, unknown> {
  const tools = request.tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
    ...(cache && i === request.tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
  }));
  return {
    model,
    max_tokens: request.maxTokens,
    system: [{ type: 'text', text: request.system, ...(cache ? { cache_control: { type: 'ephemeral' } } : {}) }],
    messages: request.messages.map((m) => ({ role: m.role, content: m.content.map(toAnthropicBlock) })),
    ...(tools.length > 0 ? { tools, tool_choice: { type: 'auto', disable_parallel_tool_use: true } } : {}),
  };
}

function toAnthropicBlock(block: ContentBlock): Record<string, unknown> {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_call':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolCallId,
        content: block.content,
        ...(block.isError ? { is_error: true } : {}),
      };
  }
}

export function fromAnthropicResponse(r: AnthropicResponse): ModelResponse {
  const content: Array<TextBlock | ToolCallBlock> = [];
  for (const b of r.content) {
    if (b.type === 'text' && typeof b.text === 'string') content.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use' && b.id && b.name) content.push({ type: 'tool_call', id: b.id, name: b.name, input: b.input ?? {} });
  }
  const stop = r.stop_reason;
  return {
    content,
    stopReason: stop === 'tool_use' ? 'tool_call' : stop === 'end_turn' || stop === 'stop_sequence' ? 'end' : stop === 'max_tokens' ? 'max_tokens' : 'other',
    usage: {
      inputTokens: r.usage.input_tokens + (r.usage.cache_creation_input_tokens ?? 0),
      cachedInputTokens: r.usage.cache_read_input_tokens ?? 0,
      outputTokens: r.usage.output_tokens,
    },
    model: r.model,
  };
}
