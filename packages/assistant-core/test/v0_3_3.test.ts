/**
 * 0.3.3 — from the second local run (qwen3.5:4b, thinking off): a reply that
 * says a change was made when none was is corrected, then marked; thinking
 * levels for models that can't switch thinking off (gpt-oss).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_TENANT, IDS, createMockErp } from '@m-ai/mock-erp';
import { PHRASE_KEYS, createAssistant, createInProcessActionsClient, createLanguages, createModel } from '../src/index.js';
import type { AssistantEvent, LanguagePack, ModelRequest } from '../src/index.js';
import { createScriptedModel } from '../src/testing/index.js';

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const erp = createMockErp();
  const events: AssistantEvent[] = [];
  const base = { tenantId: DEMO_TENANT, userId: IDS.owner, actions: createInProcessActionsClient(erp.registry, () => erp.assistantCtx()) };
  return { erp, events, base };
}

describe('"done" when nothing was done', () => {
  it('recognises claims in every built-in language, not questions or reports', () => {
    const l = createLanguages();
    expect(l.claimsDone('✅ Metro (Gulshan) ko 2 carton 7Up bill kiya gaya hai.')).toBe(true);
    expect(l.claimsDone('Madina Store ka order laga diya hai')).toBe(true);
    expect(l.claimsDone('The invoice has been posted.')).toBe(true);
    expect(l.claimsDone('آرڈر لگا دیا ہے')).toBe(true);
    expect(l.claimsDone('Aaj ki sale 2,124 hai.')).toBe(false);
    expect(l.claimsDone('Kya main order laga doon?')).toBe(false);
  });

  it('the model is asked to fix it; a fixed reply goes out as is', async () => {
    const { erp, events, base } = setup();
    const model = createScriptedModel(['✅ Metro ko 2 carton 7Up bill kiya gaya hai.', 'Metro ko 7Up bhejna hai to batayein, main preview dikhata hoon.']);
    const r = await createAssistant({ model, onEvent: (e) => events.push(e) }).handleTurn({ ...base, conversationId: 'a', text: 'nahi rehne do' });
    expect(r.reply).toBe('Metro ko 7Up bhejna hai to batayein, main preview dikhata hoon.');
    expect(events).toContainEqual({ type: 'done_check', retrying: true });
    expect(model.requests[1]!.messages.at(-1)!.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('NOTHING was executed') });
    expect(erp.data.invoices).toHaveLength(4);
  });

  it('still claimed after the fix: the person is told nothing was saved', async () => {
    const { base } = setup();
    const model = createScriptedModel(['Order laga diya hai.', 'Order laga diya hai, shukriya.']);
    const r = await createAssistant({ model }).handleTurn({ ...base, conversationId: 'b', text: 'Metro ko 2 carton 7up' });
    expect(r.reply).toBe('Order laga diya hai, shukriya.\n(Note: abhi kuch bhi save ya tabdeel nahi hua.)');
  });

  it('a real, executed change may be called done', async () => {
    const { erp, base } = setup();
    const model = createScriptedModel([
      { call: { name: 'sales.invoice.post', input: { customerId: IDS.madinaStore, lines: [{ productId: IDS.pepsi, quantity: 10 }] } } },
      'INV-0005 post ho gaya.',
    ]);
    const assistant = createAssistant({ model });
    const first = await assistant.handleTurn({ ...base, conversationId: 'c', text: 'Madina Store ko 10 carton Pepsi' });
    expect(first.status).toBe('awaiting_confirmation');
    const done = await assistant.handleTurn({ ...base, conversationId: 'c', text: 'haan' });
    expect(done.executed).toMatchObject([{ action: 'sales.invoice.post', ok: true }]);
    expect(done.reply).toBe('INV-0005 post ho gaya.');
    expect(erp.data.invoices).toHaveLength(5);
  });

  it('a language pack without the note falls back to English', () => {
    const phrases = Object.fromEntries(PHRASE_KEYS.map((k) => [k, k])) as LanguagePack['phrases'];
    const l = createLanguages([{ code: 'xx', name: 'X', yes: ['ya'], no: ['na'], replyRule: 'r', phrases }]);
    expect(l.phrase('notSaved', 'xx')).toBe('(Note: nothing has been saved or changed yet.)');
  });
});

describe('thinking levels', () => {
  const ANSWER = { message: { content: 'ok' }, done_reason: 'stop' };
  function stub() {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const isGroq = String(_url).includes('groq');
      return new Response(JSON.stringify(isGroq ? { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] } : ANSWER), { status: 200 });
    });
    return bodies;
  }
  const REQ: ModelRequest = { system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], maxTokens: 1024 };

  it('Ollama: gpt-oss gets "low" when thinking is off (it cannot stop); levels pass through', async () => {
    const bodies = stub();
    await createModel('ollama:gpt-oss:20b', {}).model.complete(REQ);
    await createModel('ollama:gpt-oss:20b', { M_AI_OLLAMA_THINKING: 'high' }).model.complete(REQ);
    await createModel('ollama:qwen3.5:4b', {}).model.complete(REQ);
    expect(bodies.map((b) => [b['think'], (b['options'] as { num_predict: number }).num_predict])).toEqual([['low', 4096], ['high', 4096], [false, 1024]]);
  });

  it('Groq: reasoning_effort for gpt-oss and qwen', async () => {
    const bodies = stub();
    await createModel('groq:openai/gpt-oss-20b', { GROQ_API_KEY: 'g' }).model.complete(REQ);
    await createModel('groq:openai/gpt-oss-120b', { GROQ_API_KEY: 'g', M_AI_GROQ_THINKING: 'medium' }).model.complete(REQ);
    await createModel('groq:qwen/qwen3.8-27b', { GROQ_API_KEY: 'g' }).model.complete(REQ);
    expect(bodies.map((b) => b['reasoning_effort'])).toEqual(['low', 'medium', 'none']);
  });
});

describe('rate limit or no credit — from real provider messages', () => {
  const classify = async (status: number, message: string, headers: Record<string, string> = {}) => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message } }), { status, headers }));
    try {
      await createModel('groq:x', { GROQ_API_KEY: 'g' }).model.complete({ system: 's', messages: [], tools: [], maxTokens: 1 });
    } catch (e) {
      return { retryable: (e as { retryable: boolean }).retryable, after: (e as { retryAfterMs?: number }).retryAfterMs };
    }
    throw new Error('should fail');
  };

  it('Groq: a per-minute limit that mentions billing is still a rate limit', async () => {
    const groq =
      'Rate limit reached for model `openai/gpt-oss-20b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 7000, Requested 2500. Please try again in 7.5s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing';
    expect(await classify(429, groq, { 'retry-after': '8' })).toEqual({ retryable: true, after: 8000 });
  });

  it('Gemini: "Quota exceeded … retry in 30s" is a rate limit', async () => {
    expect((await classify(429, 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 10. Please retry in 30s.')).retryable).toBe(true);
  });

  it('Z.ai and OpenAI: no credit is not retried', async () => {
    expect((await classify(429, 'Insufficient balance or no resource package. Please recharge.')).retryable).toBe(false);
    expect((await classify(429, 'You exceeded your current quota, please check your plan and billing details.')).retryable).toBe(false);
  });
});
