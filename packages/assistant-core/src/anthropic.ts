import type { ContentBlock, ModelClient, ModelRequest, ModelResponse, TextBlock, ToolCallBlock } from './model.js';
import { ModelError, httpModelError, networkModelError } from './model.js';
import type { ModelPricing } from './usage.js';

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
  /** For API keys that are not scoped to a workspace: sent as the anthropic-workspace-id header. */
  workspaceId?: string;
  /** Extra headers. */
  headers?: Record<string, string>;
  /** This model's price, attached to every response so each call is costed correctly. */
  pricing?: ModelPricing;
}

function anthropicHeaders(o: Pick<AnthropicOptions, 'apiKey' | 'workspaceId' | 'headers'>): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-api-key': o.apiKey,
    'anthropic-version': '2023-06-01',
    ...(o.workspaceId ? { 'anthropic-workspace-id': o.workspaceId } : {}),
    ...o.headers,
  };
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
      const timeoutMs = options.timeoutMs ?? 60_000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: anthropicHeaders(options),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) throw httpModelError('Anthropic answered', res, await res.text().catch(() => ''));
        const response = fromAnthropicResponse((await res.json()) as AnthropicResponse);
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

/** The model ids this key may use (GET /v1/models). */
export async function listAnthropicModels(
  options: Pick<AnthropicOptions, 'apiKey' | 'baseUrl' | 'workspaceId' | 'headers' | 'fetch'>,
): Promise<string[]> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = `${(options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/models`;
  const ids: string[] = [];
  let after: string | undefined;
  for (let page = 0; page < 5; page++) {
    let res: Response;
    try {
      res = await doFetch(`${base}?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ''}`, {
        method: 'GET',
        headers: anthropicHeaders(options),
      });
    } catch (e) {
      throw new ModelError(`could not reach Anthropic: ${(e as Error).message}`, undefined, true);
    }
    const text = await res.text();
    if (!res.ok) throw httpModelError('Anthropic answered', res, text);
    const body = JSON.parse(text) as { data?: Array<{ id: string }>; has_more?: boolean; last_id?: string };
    ids.push(...(body.data ?? []).map((m) => m.id));
    if (!body.has_more || !body.last_id) break;
    after = body.last_id;
  }
  return ids;
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

/**
 * Anthropic accepts tool ids of [a-zA-Z0-9_-] only. A conversation started on
 * another provider may carry other ids; map them the same way on both sides.
 */
function anthropicId(id: string): string {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(id) ? id : `x_${id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120)}`;
}

function toAnthropicBlock(block: ContentBlock): Record<string, unknown> {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_call':
      return { type: 'tool_use', id: anthropicId(block.id), name: block.name, input: block.input ?? {} };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: anthropicId(block.toolCallId),
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
