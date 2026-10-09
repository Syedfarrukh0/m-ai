/**
 * 0.3.1 — from the first runs on Z.ai: dates worked out in code, "no credit"
 * told apart from "busy", Retry-After, clear timeouts, and presets for free
 * and local models (Groq, Gemini, OpenRouter, Ollama).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_TENANT, IDS, createMockErp } from '@m-ai/mock-erp';
import {
  ModelError,
  createAssistant,
  createInProcessActionsClient,
  createModel,
  createOpenAICompatibleModel,
  dateRanges,
  isoDatesIn,
  preflight,
} from '../src/index.js';
import type { ModelClient, ModelRequest } from '../src/index.js';
import { createScriptedModel } from '../src/testing/index.js';

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> | undefined };
function stubFetch(handler: (c: Call) => { status: number; body: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const c: Call = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const r = handler(c);
    return new Response(JSON.stringify(r.body), { status: r.status, ...(r.headers ? { headers: r.headers } : {}) });
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

const CHAT_OK = { model: 'm', choices: [{ finish_reason: 'stop', message: { content: 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
const REQUEST: ModelRequest = { system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], maxTokens: 1024 };

describe('dates worked out in code', () => {
  it('the usual ranges around today (weeks start on Monday)', () => {
    const r = Object.fromEntries(dateRanges('2026-10-02', '2026-07-01').map((x) => [x.name, `${x.from}..${x.to}`]));
    expect(r).toMatchObject({
      today: '2026-10-02..2026-10-02',
      yesterday: '2026-10-01..2026-10-01',
      'this week': '2026-09-28..2026-10-02',
      'last week': '2026-09-21..2026-09-27',
      'this month': '2026-10-01..2026-10-02',
      'last month': '2026-09-01..2026-09-30',
      'this year': '2026-01-01..2026-10-02',
      'last year': '2025-01-01..2025-12-31',
      'this fiscal year': '2026-07-01..2026-10-02',
    });
  });

  it('across a year end, and on a Sunday', () => {
    const r = Object.fromEntries(dateRanges('2026-01-04').map((x) => [x.name, `${x.from}..${x.to}`]));
    expect(r['last month']).toBe('2025-12-01..2025-12-31');
    expect(r['this week']).toBe('2025-12-29..2026-01-04');
    expect(r['yesterday']).toBe('2026-01-03..2026-01-03');
  });

  it('the model is given them, so it only has to copy', async () => {
    const erp = createMockErp();
    const model = createScriptedModel(['ok']);
    await createAssistant({ model }).handleTurn({
      conversationId: 'd', tenantId: DEMO_TENANT, userId: IDS.owner, text: 'is mahine ki sale?',
      actions: createInProcessActionsClient(erp.registry, () => erp.assistantCtx()),
    });
    const system = model.requests[0]!.system;
    expect(system).toContain('Today is Friday 2026-10-02');
    expect(system).toContain('- this month: from 2026-10-01 to 2026-10-02');
    expect(system).toContain('- today: 2026-10-02 (from and to both 2026-10-02)');
  });

  it('a reply may state the dates it used, without the numbers guard objecting', async () => {
    const erp = createMockErp();
    const model = createScriptedModel([
      { call: { name: 'reports.sales.summary', input: { from: '2026-09-01', to: '2026-09-30', groupBy: 'booker' } } },
      'Pichle mahine (1 Sep se 30 Sep 2026) ki report upar hai.',
    ]);
    const r = await createAssistant({ model }).handleTurn({
      conversationId: 'd2', tenantId: DEMO_TENANT, userId: IDS.owner, text: 'pichle mahine ki sale?',
      actions: createInProcessActionsClient(erp.registry, () => erp.assistantCtx()),
    });
    expect(r.unverifiedNumbers).toEqual([]);
    expect(isoDatesIn({ a: ['2026-09-01', { b: '2026-09-30T00:00:00Z' }], c: 5 })).toEqual(['2026-09-01', '2026-09-30']);
  });
});

describe('"no credit" is not "busy"', () => {
  it("Z.ai's 429 for no balance: not retried, and pre-flight says it plainly", async () => {
    stubFetch((c) =>
      c.url.endsWith('/models')
        ? { status: 200, body: { data: [{ id: 'glm-4.6' }] } }
        : { status: 429, body: { error: { code: '1113', message: 'Insufficient balance or no resource package. Please recharge.' } } },
    );
    const setup = createModel('zai:glm-4.6', { ZAI_API_KEY: 'zk' });
    await expect(setup.model.complete(REQUEST)).rejects.toMatchObject({ status: 429, retryable: false });
    const r = await preflight(setup);
    expect(r.ok).toBe(false); // listed, but refused: the test call catches it
    expect(r.problems[0]).toContain('no credit for this model');
    expect(r.suggestions).toEqual(['glm-4.7-flash', 'glm-4.5-flash']);
  });

  it('a real rate limit is retried, after the time the provider asks for', async () => {
    stubFetch(() => ({ status: 429, body: { error: { message: 'Rate limit reached for requests' } }, headers: { 'retry-after': '3' } }));
    await expect(createModel('groq:x', { GROQ_API_KEY: 'g' }).model.complete(REQUEST)).rejects.toMatchObject({ retryable: true, retryAfterMs: 3000 });
  });

  it('the assistant waits the Retry-After time before retrying', async () => {
    let calls = 0;
    const model: ModelClient = {
      complete: async () => {
        if (++calls === 1) throw new ModelError('busy', 429, true, 60);
        return { content: [{ type: 'text', text: 'ok' }], stopReason: 'end', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, model: 'm' };
      },
    };
    const erp = createMockErp();
    const started = Date.now();
    const r = await createAssistant({ model, retryDelayMs: 1 }).handleTurn({
      conversationId: 'r', tenantId: DEMO_TENANT, userId: IDS.owner, text: 'hi',
      actions: createInProcessActionsClient(erp.registry, () => erp.assistantCtx()),
    });
    expect(r.reply).toBe('ok');
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });

  it('TurnResult.error says whether waiting can help', async () => {
    const erp = createMockErp();
    const model: ModelClient = { complete: async () => { throw new ModelError('no credit', 429, false); } };
    const r = await createAssistant({ model }).handleTurn({
      conversationId: 'e', tenantId: DEMO_TENANT, userId: IDS.owner, text: 'hi',
      actions: createInProcessActionsClient(erp.registry, () => erp.assistantCtx()),
    });
    expect(r.error).toEqual({ source: 'model', message: 'no credit', status: 429, retryable: false });
  });
});

describe('timeouts', () => {
  it('say what happened and what to change', async () => {
    const fetch = async () => { throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }); };
    const model = createOpenAICompatibleModel({ baseUrl: 'http://x', model: 'm', fetch, timeoutMs: 120_000 });
    await expect(model.complete(REQUEST)).rejects.toMatchObject({
      retryable: true,
      message: 'the model did not answer within 120 s (raise M_AI_TIMEOUT_SECONDS for slow or local models)',
    });
  });

  it('M_AI_TIMEOUT_SECONDS is checked', () => {
    expect(() => createModel('zai:glm-4.7-flash', { ZAI_API_KEY: 'k', M_AI_PROVIDER: 'zai', M_AI_TIMEOUT_SECONDS: 'long' })).toThrow(/M_AI_TIMEOUT_SECONDS must be a number/);
  });
});

describe('free and local model presets', () => {
  it('Groq, Gemini, OpenRouter: their endpoints and keys; room for models that reason', async () => {
    const calls = stubFetch(() => ({ status: 200, body: CHAT_OK }));
    const env = { GROQ_API_KEY: 'g', GEMINI_API_KEY: 'gm', OPENROUTER_API_KEY: 'or' };
    await createModel('groq:openai/gpt-oss-120b', env).model.complete(REQUEST);
    await createModel('gemini:gemini-3.5-flash', env).model.complete(REQUEST);
    await createModel('openrouter:some/model:free', env).model.complete(REQUEST);
    expect(calls.map((c) => [c.url, c.headers['authorization'], c.body?.['model'], c.body?.['max_tokens']])).toEqual([
      ['https://api.groq.com/openai/v1/chat/completions', 'Bearer g', 'openai/gpt-oss-120b', 2048],
      ['https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', 'Bearer gm', 'gemini-3.5-flash', 4096],
      ['https://openrouter.ai/api/v1/chat/completions', 'Bearer or', 'some/model:free', 4096],
    ]);
  });

  it('Gemini lists "models/…" ids; they are compared without the prefix', async () => {
    stubFetch(() => ({ status: 200, body: { data: [{ id: 'models/gemini-3.5-flash' }] } }));
    expect(await createModel('gemini:gemini-3.5-flash', { GEMINI_API_KEY: 'k' }).listModels()).toEqual(['gemini-3.5-flash']);
  });
});
