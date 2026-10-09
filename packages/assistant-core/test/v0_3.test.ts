/**
 * 0.3.0 — Z.ai, and choosing the model at runtime: provider:model specs,
 * keys for several providers in one .env, a per-turn model, fallback models,
 * and each call costed at the price of the model that answered it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_TENANT, IDS, createMockErp } from '@m-ai/mock-erp';
import {
  ConfigError,
  ModelError,
  configFromEnv,
  createAssistant,
  createInProcessActionsClient,
  createModel,
  fromChatResponse,
  parseModelSpec,
  parsePrices,
  preflight,
  stripThinking,
  toAnthropicBody,
  withFallback,
} from '../src/index.js';
import type { ModelClient, ModelRequest, ModelResponse } from '../src/index.js';

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> | undefined };

/** Replaces fetch for clients created afterwards. */
function stubFetch(handler: (c: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const c: Call = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const r = handler(c);
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

const CHAT_OK = { model: 'glm-4.7-flash', choices: [{ finish_reason: 'stop', message: { content: 'OK' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
const REQUEST: ModelRequest = {
  system: 's',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [{ name: 'reports__sales__summary', description: 'd', inputSchema: { type: 'object' } }],
  maxTokens: 1024,
};

function text(t: string, model = 'm', pricing?: ModelResponse['pricing']): ModelResponse {
  return { content: [{ type: 'text', text: t }], stopReason: 'end', usage: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 }, model, ...(pricing ? { pricing } : {}) };
}

describe('model specs', () => {
  it('reads provider:model, and leaves ids with colons alone', () => {
    expect(parseModelSpec('zai:glm-4.7-flash', 'anthropic')).toEqual({ provider: 'zai', modelId: 'glm-4.7-flash' });
    expect(parseModelSpec('qwen3:4b', 'openai-compatible')).toEqual({ provider: 'openai-compatible', modelId: 'qwen3:4b' });
    expect(parseModelSpec('openai-compatible:qwen3:4b', 'zai')).toEqual({ provider: 'openai-compatible', modelId: 'qwen3:4b' });
    expect(parseModelSpec(' glm-4.5-flash ', 'zai')).toEqual({ provider: 'zai', modelId: 'glm-4.5-flash' });
  });
});

describe('Z.ai', () => {
  it('calls the Z.ai endpoint in its own format', async () => {
    const calls = stubFetch(() => ({ status: 200, body: CHAT_OK }));
    const setup = createModel('zai:glm-4.7-flash', { ZAI_API_KEY: 'zk' });
    expect(setup).toMatchObject({ provider: 'zai', modelId: 'glm-4.7-flash', spec: 'zai:glm-4.7-flash', thinking: false });
    const r = await setup.model.complete(REQUEST);
    expect(r.content).toEqual([{ type: 'text', text: 'OK' }]);
    expect(calls[0]!.url).toBe('https://api.z.ai/api/paas/v4/chat/completions');
    expect(calls[0]!.headers['authorization']).toBe('Bearer zk');
    expect(calls[0]!.body).toMatchObject({ model: 'glm-4.7-flash', thinking: { type: 'disabled' }, tool_choice: 'auto', max_tokens: 1024 });
    expect(calls[0]!.body).not.toHaveProperty('parallel_tool_calls');
  });

  it('thinking on: asks for it and leaves room for the reply', async () => {
    const calls = stubFetch(() => ({ status: 200, body: CHAT_OK }));
    const setup = createModel('zai:glm-4.7-flash', { ZAI_API_KEY: 'zk', M_AI_ZAI_THINKING: 'on' });
    await setup.model.complete(REQUEST);
    expect(calls[0]!.body).toMatchObject({ thinking: { type: 'enabled' }, max_tokens: 4096 });
    expect(() => createModel('zai:x', { ZAI_API_KEY: 'zk', M_AI_ZAI_THINKING: 'maybe' })).toThrow(/M_AI_ZAI_THINKING must be off, on, low, medium or high/);
  });

  it('as the main provider, with M_AI_API_KEY', () => {
    const config = configFromEnv({ M_AI_PROVIDER: 'zai', M_AI_MODEL: 'glm-4.7-flash', M_AI_API_KEY: 'zk' });
    expect(config.primary.spec).toBe('zai:glm-4.7-flash');
    expect(config.provider).toBe('zai');
  });

  it('says which key is missing and where to get one', () => {
    try {
      createModel('zai:glm-4.7-flash', {});
      throw new Error('should have failed');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).problems[0]).toBe('ZAI_API_KEY is required for provider zai (create one at https://z.ai/manage-apikey/apikey-list)');
    }
  });

  it("drops thinking text, and ignores reasoning_content", () => {
    expect(stripThinking('<think>sochta hun… 2+2</think>\nAaj ki sale 2,124 hai.')).toBe('Aaj ki sale 2,124 hai.');
    expect(stripThinking('<think>cut off mid-way')).toBe('');
    const r = fromChatResponse(
      { choices: [{ finish_reason: 'stop', message: { content: '<think>99</think>Done', reasoning_content: 'maybe 12345' } as never }] },
      'glm',
    );
    expect(r.content).toEqual([{ type: 'text', text: 'Done' }]);
  });
});

describe('keys for several providers in one .env', () => {
  const env = { M_AI_PROVIDER: 'zai', M_AI_MODEL: 'glm-4.7-flash', M_AI_API_KEY: 'zk', ANTHROPIC_API_KEY: 'ak', M_AI_OPENAI_COMPATIBLE_BASE_URL: 'http://localhost:11434/v1' };

  it('each provider uses its own key; M_AI_API_KEY belongs to the main one', async () => {
    const calls = stubFetch(() => ({ status: 200, body: { model: 'c', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } }));
    await createModel('anthropic:claude-x', env).model.complete(REQUEST);
    expect(calls[0]!.headers['x-api-key']).toBe('ak');
    expect(() => createModel('anthropic:claude-x', { M_AI_PROVIDER: 'zai', M_AI_API_KEY: 'zk' })).toThrow(/ANTHROPIC_API_KEY is required/);
  });

  it('a local server needs its base URL', () => {
    expect(createModel('openai-compatible:qwen3:4b', env)).toMatchObject({ provider: 'openai-compatible', modelId: 'qwen3:4b' });
    expect(() => createModel('openai-compatible:qwen3:4b', { M_AI_PROVIDER: 'zai' })).toThrow(/M_AI_OPENAI_COMPATIBLE_BASE_URL is required/);
  });

  it('a spec without a provider uses the main provider', () => {
    expect(createModel('glm-4.5-flash', env).spec).toBe('zai:glm-4.5-flash');
  });
});

describe('fallback models', () => {
  const failing = (status: number, retryable = false, message = `answered ${status}`): ModelClient & { calls: number } => {
    const m = { calls: 0, complete: async () => { m.calls++; throw new ModelError(message, status, retryable); } };
    return m;
  };
  const answering = (t: string): ModelClient & { calls: number } => {
    const m = { calls: 0, complete: async () => { m.calls++; return text(t); } };
    return m;
  };

  it('uses the next model when one fails, and skips the failed one for a while', async () => {
    let clock = 0;
    const seen: string[] = [];
    const a = failing(402, false, 'no credit');
    const b = answering('from b');
    const model = withFallback([{ label: 'a', model: a }, { label: 'b', model: b }], { now: () => clock, cooldownMs: 1000, onFallback: (f, t) => seen.push(`${f}→${t}`) });
    expect((await model.complete(REQUEST)).content).toEqual([{ type: 'text', text: 'from b' }]);
    expect(seen).toEqual(['a→b']);
    await model.complete(REQUEST);
    expect(a.calls).toBe(1); // still cooling down: b answered first
    clock = 2000;
    await model.complete(REQUEST);
    expect(a.calls).toBe(2); // tried again after the cooldown
  });

  it('when every model fails, says why for each', async () => {
    const model = withFallback([{ label: 'a', model: failing(402) }, { label: 'b', model: failing(429, true) }]);
    await expect(model.complete(REQUEST)).rejects.toMatchObject({ name: 'ModelError', retryable: true, message: 'every model failed — a: answered 402 | b: answered 429' });
  });

  it('does not hide bugs', async () => {
    const bug: ModelClient = { complete: async () => { throw new TypeError('bug'); } };
    const b = answering('b');
    await expect(withFallback([{ label: 'a', model: bug }, { label: 'b', model: b }]).complete(REQUEST)).rejects.toThrow('bug');
    expect(b.calls).toBe(0);
  });

  it('M_AI_FALLBACK_MODELS builds the chain', async () => {
    stubFetch((c) =>
      c.url.startsWith('https://api.anthropic.com')
        ? { status: 400, body: { error: { message: 'Your credit balance is too low' } } }
        : { status: 200, body: CHAT_OK },
    );
    const config = configFromEnv({ M_AI_MODEL: 'claude-x', ANTHROPIC_API_KEY: 'ak', ZAI_API_KEY: 'zk', M_AI_FALLBACK_MODELS: 'zai:glm-4.7-flash, zai:glm-4.5-flash' });
    expect(config.fallbacks.map((f) => f.spec)).toEqual(['zai:glm-4.7-flash', 'zai:glm-4.5-flash']);
    expect((await config.model.complete(REQUEST)).model).toBe('glm-4.7-flash');
  });

  it('a broken fallback is reported at start-up like any other setting', () => {
    expect(() => configFromEnv({ M_AI_MODEL: 'x', ANTHROPIC_API_KEY: 'ak', M_AI_FALLBACK_MODELS: 'zai:glm-4.7-flash' })).toThrow(/ZAI_API_KEY is required/);
  });
});

describe('a model per turn', () => {
  const erp = createMockErp();
  const actions = createInProcessActionsClient(erp.registry, () => erp.assistantCtx());
  const recorder = (t: string, pricing?: ModelResponse['pricing']) => {
    const requests: ModelRequest[] = [];
    return { requests, complete: async (r: ModelRequest) => (requests.push({ ...r, messages: [...r.messages] }), text(t, t, pricing)) };
  };

  it('switches model mid-conversation; the history carries over', async () => {
    const a = recorder('from a');
    const b = recorder('from b');
    const assistant = createAssistant({ model: a });
    const base = { conversationId: 'c1', tenantId: DEMO_TENANT, userId: IDS.owner, actions };
    expect((await assistant.handleTurn({ ...base, text: 'hello' })).reply).toBe('from a');
    expect((await assistant.handleTurn({ ...base, text: 'and now?', model: b })).reply).toBe('from b');
    expect(b.requests[0]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect((await assistant.handleTurn({ ...base, text: 'back' })).reply).toBe('from a');
    expect(a.requests).toHaveLength(2);
  });

  it('costs each call at the price of the model that answered', async () => {
    const price = { inputPerMTok: '1', cachedInputPerMTok: '0.1', outputPerMTok: '5' };
    const priced = recorder('priced', price);
    const free = recorder('free');
    const assistant = createAssistant({ model: priced, pricing: { inputPerMTok: '9', cachedInputPerMTok: '9', outputPerMTok: '9' } });
    const base = { conversationId: 'c2', tenantId: DEMO_TENANT, userId: IDS.owner, actions, text: 'hi' };
    expect((await assistant.handleTurn(base)).usage.costUsd).toBe('1.0000'); // the response's own price wins
    // A model chosen for the turn without a price is not costed at another model's price.
    expect((await assistant.handleTurn({ ...base, model: free })).usage.costUsd).toBe('0.0000');
  });
});

describe('prices', () => {
  it('M_AI_PRICES gives any model its price', () => {
    const problems: string[] = [];
    const prices = parsePrices('zai:glm-4.7-flash=0/0/0; anthropic:claude-x=1/0.1/5, glm-4.5-air=0.2/1.1\nbad entry', 'zai', problems);
    expect(prices.get('zai:glm-4.7-flash')).toEqual({ inputPerMTok: '0', cachedInputPerMTok: '0', outputPerMTok: '0' });
    expect(prices.get('anthropic:claude-x')).toEqual({ inputPerMTok: '1', cachedInputPerMTok: '0.1', outputPerMTok: '5' });
    expect(prices.get('zai:glm-4.5-air')).toEqual({ inputPerMTok: '0.2', cachedInputPerMTok: '0.2', outputPerMTok: '1.1' });
    expect(problems).toEqual(['M_AI_PRICES entry "bad entry" must look like zai:glm-4.7-flash=0.15/0.03/0.5']);
  });

  it('the main model keeps M_AI_PRICE_*; others take M_AI_PRICES', () => {
    const config = configFromEnv({
      M_AI_PROVIDER: 'zai', M_AI_MODEL: 'glm-5.3-flash', M_AI_API_KEY: 'zk',
      M_AI_PRICE_IN: '0.15', M_AI_PRICE_CACHED: '0.03', M_AI_PRICE_OUT: '0.5',
      M_AI_FALLBACK_MODELS: 'glm-4.7-flash', M_AI_PRICES: 'zai:glm-4.7-flash=0/0',
    });
    expect(config.primary.pricing).toEqual({ inputPerMTok: '0.15', cachedInputPerMTok: '0.03', outputPerMTok: '0.5' });
    expect(config.fallbacks[0]!.pricing).toEqual({ inputPerMTok: '0', cachedInputPerMTok: '0', outputPerMTok: '0' });
  });
});

describe('pre-flight for any provider', () => {
  it('a provider that cannot list models: one test call', async () => {
    stubFetch((c) => (c.url.endsWith('/models') ? { status: 404, body: { error: { message: 'not found' } } } : { status: 200, body: CHAT_OK }));
    const r = await preflight(createModel('zai:glm-4.7-flash', { ZAI_API_KEY: 'zk' }));
    expect(r.ok).toBe(true);
    expect(r.warnings[0]).toContain('zai does not list its models');
  });

  it('a wrong id: suggestions from the provider docs', async () => {
    stubFetch((c) => (c.url.endsWith('/models') ? { status: 404, body: {} } : { status: 400, body: { error: { code: '1211', message: 'Model does not exist' } } }));
    const r = await preflight(createModel('zai:glm-flash', { ZAI_API_KEY: 'zk' }), '"zai:glm-flash"');
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain('"zai:glm-flash" did not work: the provider answered 400: Model does not exist');
    expect(r.suggestions).toContain('glm-4.7-flash');
  });

  it('a wrong key: the hint says so, whatever the language of the message', async () => {
    stubFetch(() => ({ status: 401, body: { error: { code: '1000', message: '身份验证失败' } } }));
    const r = await preflight(createModel('zai:glm-4.7-flash', { ZAI_API_KEY: 'bad' }));
    expect(r.problems[0]).toContain('The key is wrong, revoked or for another provider');
  });

  it('a busy free model is a note, not a failure', async () => {
    stubFetch(() => ({ status: 429, body: { error: { code: '1302', message: 'High concurrency' } } }));
    const r = await preflight(createModel('zai:glm-4.7-flash', { ZAI_API_KEY: 'zk' }));
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toContain('busy');
  });

  it('checks the main model, not its fallbacks', async () => {
    stubFetch((c) => (c.url.startsWith('https://api.anthropic.com') ? { status: 401, body: { error: { message: 'invalid x-api-key' } } } : { status: 200, body: CHAT_OK }));
    const config = configFromEnv({ M_AI_MODEL: 'claude-x', ANTHROPIC_API_KEY: 'ak', ZAI_API_KEY: 'zk', M_AI_FALLBACK_MODELS: 'zai:glm-4.7-flash' });
    expect((await preflight(config)).ok).toBe(false);
  });
});

describe('switching providers mid-conversation', () => {
  it('tool ids from another provider are made acceptable to Anthropic, the same way on both sides', () => {
    const body = toAnthropicBody('m', {
      system: 's',
      tools: [],
      maxTokens: 10,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_call', id: 'call:1.2', name: 't', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', toolCallId: 'call:1.2', content: '{}' }] },
      ],
    }, false) as { messages: Array<{ content: Array<{ id?: string; tool_use_id?: string }> }> };
    const id = body.messages[0]!.content[0]!.id!;
    expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(body.messages[1]!.content[0]!.tool_use_id).toBe(id);
  });
});
