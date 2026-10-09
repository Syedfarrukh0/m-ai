/**
 * 0.3.2 — from the first local run (Ollama, qwen3.5:4b): Ollama's own API so
 * thinking can be switched off and the context length set per request, and
 * one more try when a model returns nothing usable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_TENANT, IDS, createMockErp } from '@m-ai/mock-erp';
import { createAssistant, createInProcessActionsClient, createModel, preflight } from '../src/index.js';
import type { AssistantEvent, ModelClient, ModelRequest, ModelResponse } from '../src/index.js';

type Call = { url: string; body: Record<string, unknown> | undefined };
function stubFetch(handler: (c: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const c: Call = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const r = handler(c);
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

const REQUEST: ModelRequest = {
  system: 'sys',
  tools: [{ name: 'reports__sales__summary', description: 'd', inputSchema: { type: 'object' } }],
  maxTokens: 1024,
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'aaj ki sale?' }] },
    { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'reports__sales__summary', input: { from: '2026-10-02' } }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c1', content: '{"gross":"2124.00"}' }] },
  ],
};
const ANSWER = { model: 'qwen3.5:4b', message: { role: 'assistant', content: 'Aaj 2,124' }, done_reason: 'stop', prompt_eval_count: 900, eval_count: 12 };

describe('Ollama, through its own API', () => {
  it('thinking off, the context set, tool results named', async () => {
    const calls = stubFetch(() => ({ status: 200, body: ANSWER }));
    const setup = createModel('ollama:qwen3.5:4b', {});
    expect(setup.thinking).toBe(false);
    const r = await setup.model.complete(REQUEST);
    expect(r).toMatchObject({ content: [{ type: 'text', text: 'Aaj 2,124' }], stopReason: 'end', usage: { inputTokens: 900, outputTokens: 12 } });
    expect(calls[0]!.url).toBe('http://localhost:11434/api/chat');
    expect(calls[0]!.body).toMatchObject({
      model: 'qwen3.5:4b',
      stream: false,
      think: false,
      options: { num_ctx: 8192, num_predict: 1024 },
      tools: [{ type: 'function', function: { name: 'reports__sales__summary' } }],
    });
    expect((calls[0]!.body!['messages'] as unknown[]).slice(2)).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'reports__sales__summary', arguments: { from: '2026-10-02' } } }] },
      { role: 'tool', content: '{"gross":"2124.00"}', tool_name: 'reports__sales__summary' },
    ]);
  });

  it('reads tool calls (arguments as an object or a string) and gives them ids', async () => {
    stubFetch(() => ({
      status: 200,
      body: { message: { content: '', tool_calls: [{ function: { name: 'a', arguments: { x: 1 } } }, { function: { name: 'b', arguments: '{"y":2}' } }] }, done_reason: 'stop' },
    }));
    const r = await createModel('ollama:m', {}).model.complete(REQUEST);
    expect(r.stopReason).toBe('tool_call');
    expect(r.content).toMatchObject([{ type: 'tool_call', name: 'a', input: { x: 1 } }, { type: 'tool_call', name: 'b', input: { y: 2 } }]);
    expect((r.content[0] as { id: string }).id).toMatch(/^call_/);
  });

  it('M_AI_THINKING=on, M_AI_NUM_CTX, and the old /v1 address all work', async () => {
    const calls = stubFetch(() => ({ status: 200, body: ANSWER }));
    await createModel('m', { M_AI_PROVIDER: 'ollama', M_AI_THINKING: 'on', M_AI_NUM_CTX: '16384', M_AI_BASE_URL: 'http://127.0.0.1:11434/v1' }).model.complete(REQUEST);
    expect(calls[0]!.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(calls[0]!.body).toMatchObject({ think: true, options: { num_ctx: 16384, num_predict: 4096 } });
    expect(() => createModel('m', { M_AI_PROVIDER: 'ollama', M_AI_NUM_CTX: 'big' })).toThrow(/M_AI_NUM_CTX must be a number/);
  });

  it('a model without a thinking switch: asked again without it', async () => {
    const calls = stubFetch((c) =>
      'think' in (c.body ?? {}) ? { status: 400, body: { error: '"llama3.2" does not support thinking' } } : { status: 200, body: ANSWER },
    );
    const model = createModel('ollama:llama3.2', {}).model;
    await model.complete(REQUEST);
    await model.complete(REQUEST);
    expect(calls.map((c) => 'think' in (c.body ?? {}))).toEqual([true, false, false]);
  });

  it('says plainly when Ollama is not running, or the model is not downloaded', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); });
    await expect(createModel('ollama:m', {}).model.complete(REQUEST)).rejects.toThrow('Ollama is not running at http://localhost:11434 — open the Ollama app, or run: ollama serve');
    stubFetch((c) => (c.url.endsWith('/api/tags') ? { status: 200, body: { models: [{ name: 'llama3.2:latest', model: 'llama3.2:latest' }] } } : { status: 404, body: { error: "model 'qwen3.5:4b' not found, try pulling it first" } }));
    const r = await preflight(createModel('ollama:qwen3.5:4b', {}));
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain('Download the model first: ollama pull');
    expect(r.suggestions).toEqual(['llama3.2:latest']);
  });
});

describe('a model that returns nothing usable', () => {
  it('is asked once more, then the person gets the no-answer reply', async () => {
    const erp = createMockErp();
    const empty: ModelResponse = { content: [], stopReason: 'max_tokens', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, model: 'm' };
    let n = 0;
    const flaky: ModelClient = { complete: async () => (++n === 1 ? empty : { ...empty, content: [{ type: 'text', text: 'ok' }], stopReason: 'end' }) };
    const events: AssistantEvent[] = [];
    const base = { tenantId: DEMO_TENANT, userId: IDS.owner, text: 'hi', actions: createInProcessActionsClient(erp.registry, () => erp.assistantCtx()) };
    expect((await createAssistant({ model: flaky, onEvent: (e) => events.push(e) }).handleTurn({ ...base, conversationId: 'a' })).reply).toBe('ok');
    expect(events).toContainEqual({ type: 'empty', step: 0, stopReason: 'max_tokens', retrying: true });

    const dead: ModelClient = { complete: async () => empty };
    const r = await createAssistant({ model: dead }).handleTurn({ ...base, conversationId: 'b' });
    expect(r.reply).toMatch(/Maazrat|Sorry/);
  });
});
