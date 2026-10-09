/**
 * 0.4.0 — the owner's design: your own machine first, then paid providers;
 * every reply charged to the customer in their currency with a margin, the
 * model and the balance shown under the reply.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_TENANT, IDS, createMockErp } from '@m-ai/mock-erp';
import {
  ModelError,
  chargeFor,
  configFromEnv,
  costUnits,
  createAssistant,
  createInProcessActionsClient,
  createModel,
  formatCents,
  groupThousands,
  toCents,
  withFallback,
} from '../src/index.js';
import type { ModelClient, ModelRequest, ModelResponse } from '../src/index.js';
import { createScriptedModel } from '../src/testing/index.js';

afterEach(() => vi.unstubAllGlobals());

const REQ: ModelRequest = { system: 's', messages: [], tools: [], maxTokens: 10 };
const answer = (model: string): ModelResponse => ({ content: [{ type: 'text', text: model }], stopReason: 'end', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, model });

function fake(name: string, opts: { up?: () => boolean; delayMs?: number; fail?: boolean } = {}) {
  const m = {
    calls: 0,
    checks: 0,
    async complete() {
      m.calls++;
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fail) throw new ModelError(`${name} failed`, 503, true);
      return answer(name);
    },
    ...(opts.up ? { health: async () => (m.checks++, opts.up!()) } : {}),
  };
  return m as ModelClient & { calls: number; checks: number };
}

describe('your own machine first, then the cloud', () => {
  it('a local model that is down is skipped at once, without a call; it is used again once it is back', async () => {
    let up = false;
    let clock = 0;
    const local = fake('local', { up: () => up });
    const cloud = fake('cloud');
    const skipped: string[] = [];
    const router = withFallback(
      [{ label: 'ollama:gpt-oss:120b', model: local }, { label: 'groq:openai/gpt-oss-120b', model: cloud }],
      { now: () => clock, healthTtlMs: 30_000, onSkip: (l, why) => skipped.push(`${l} ${why}`) },
    );
    expect((await router.complete(REQ)).model).toBe('cloud');
    expect(local.calls).toBe(0);
    expect(skipped).toEqual(['ollama:gpt-oss:120b down']);
    await router.complete(REQ);
    expect(local.checks).toBe(1); // the answer is trusted for 30 s
    up = true;
    clock = 31_000;
    expect((await router.complete(REQ)).model).toBe('local');
  });

  it('a busy local machine spills over to the cloud instead of making people wait', async () => {
    const local = fake('local', { delayMs: 50 });
    const cloud = fake('cloud');
    const skipped: string[] = [];
    const router = withFallback([{ label: 'local', model: local, maxConcurrent: 1 }, { label: 'cloud', model: cloud }], { onSkip: (l, why) => skipped.push(`${l} ${why}`) });
    const [a, b] = await Promise.all([router.complete(REQ), router.complete(REQ)]);
    expect([a.model, b.model]).toEqual(['local', 'cloud']);
    expect(skipped).toEqual(['local busy']);
    expect((await router.complete(REQ)).model).toBe('local'); // free again
  });

  it('Ollama health: up and the model downloaded', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      String(url).endsWith('/api/tags') ? new Response(JSON.stringify({ models: [{ name: 'gpt-oss:120b', model: 'gpt-oss:120b' }] })) : new Response('{}'),
    );
    expect(await createModel('ollama:gpt-oss:120b', {}).model.health!()).toBe(true);
    expect(await createModel('ollama:gpt-oss:20b', {}).model.health!()).toBe(false);
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); });
    expect(await createModel('ollama:gpt-oss:120b', {}).model.health!()).toBe(false);
  });

  it('the whole chain from .env, with a limit for the local machine', () => {
    const config = configFromEnv({
      M_AI_PROVIDER: 'ollama',
      M_AI_MODEL: 'gpt-oss:120b',
      M_AI_BASE_URL: 'http://192.168.1.50:11434',
      M_AI_MAX_CONCURRENT: '1',
      GROQ_API_KEY: 'g',
      ZAI_API_KEY: 'z',
      M_AI_FALLBACK_MODELS: 'groq:openai/gpt-oss-120b, groq:openai/gpt-oss-20b, zai:glm-4.7-flash',
    });
    expect(config.primary).toMatchObject({ spec: 'ollama:gpt-oss:120b', maxConcurrent: 1 });
    expect(config.fallbacks.map((f) => f.spec)).toEqual(['groq:openai/gpt-oss-120b', 'groq:openai/gpt-oss-20b', 'zai:glm-4.7-flash']);
    expect(() => configFromEnv({ M_AI_PROVIDER: 'ollama', M_AI_MODEL: 'x', M_AI_MAX_CONCURRENT: 'two' })).toThrow(/M_AI_MAX_CONCURRENT must be a whole number/);
  });
});

describe('what the customer pays', () => {
  it('cost × rate × (1 + margin), exact, rounded up to paisa', () => {
    const million = costUnits({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 }, { inputPerMTok: '1', cachedInputPerMTok: '1', outputPerMTok: '1' });
    expect(chargeFor(million, { currency: 'PKR', usdRate: '276.35', margin: '20%' })).toBe('331.62');
    expect(chargeFor(million, { currency: 'PKR', usdRate: '276.35', margin: '0.2' })).toBe('331.62');
    expect(chargeFor(million, { currency: 'USD', usdRate: '1' })).toBe('1.00');
    // A typical gpt-oss-120b reply on Groq: 5,000 tokens in, 300 out, at $0.15 / $0.60 per million.
    const reply = costUnits({ inputTokens: 5000, cachedInputTokens: 0, outputTokens: 300 }, { inputPerMTok: '0.15', cachedInputPerMTok: '0.15', outputPerMTok: '0.6' });
    expect(chargeFor(reply, { currency: 'PKR', usdRate: '276.35', margin: '20%' })).toBe('0.31');
  });

  it('amounts', () => {
    expect(formatCents(toCents('2000') - toCents('0.31'))).toBe('1999.69');
    expect(formatCents(toCents('0.10') - toCents('0.31'))).toBe('-0.21');
    expect(groupThousands('1999.69')).toBe('1,999.69');
    expect(groupThousands('-1234567')).toBe('-1,234,567');
  });

  it('every reply: the model, the charge and the balance left, in the reply language', async () => {
    const erp = createMockErp();
    const model = createScriptedModel(['Ji, bataiye kya dekhna hai.']);
    const assistant = createAssistant({
      model,
      pricing: { inputPerMTok: '0.15', cachedInputPerMTok: '0.15', outputPerMTok: '0.6' },
      billing: { currency: 'PKR', usdRate: '276.35', margin: '20%' },
      usageFooter: 'on',
    });
    const r = await assistant.handleTurn({
      conversationId: 'b', tenantId: DEMO_TENANT, userId: IDS.owner, text: 'aaj ki sale kitni hui?', balance: '2000',
      actions: createInProcessActionsClient(erp.registry, () => erp.assistantCtx()),
    });
    // 1,000 in and 100 out (the scripted model's usage) → $0.00021 → PKR 0.0696… → 0.07
    expect(r.usage.charge).toEqual({ amount: '0.07', currency: 'PKR' });
    expect(r.balanceAfter).toBe('1999.93');
    expect(r.reply).toBe('Ji, bataiye kya dekhna hai.\n— scripted-model · is jawab ke PKR 0.07 · baqi PKR 1,999.93');
  });

  it('no balance left: a fixed reply, and no model is called', async () => {
    const erp = createMockErp();
    const model = createScriptedModel([]);
    const r = await createAssistant({ model, billing: { currency: 'PKR', usdRate: '276.35' } }).handleTurn({
      conversationId: 'z', tenantId: DEMO_TENANT, userId: IDS.owner, text: 'aaj ki sale kitni hui?', balance: '0',
      actions: createInProcessActionsClient(erp.registry, () => erp.assistantCtx()),
    });
    expect(r).toMatchObject({ status: 'refused', reply: expect.stringContaining('balance khatam'), usage: { modelCalls: 0 } });
    expect(model.requests).toHaveLength(0);
  });

  it('from .env', () => {
    const base = { M_AI_PROVIDER: 'groq', M_AI_MODEL: 'openai/gpt-oss-120b', GROQ_API_KEY: 'g' };
    expect(configFromEnv({ ...base, M_AI_CURRENCY: 'pkr', M_AI_USD_RATE: '276.35', M_AI_MARGIN: '20%', M_AI_USAGE_FOOTER: 'on' })).toMatchObject({
      billing: { currency: 'PKR', usdRate: '276.35', margin: '20%' },
      usageFooter: 'on',
    });
    expect(() => configFromEnv({ ...base, M_AI_CURRENCY: 'PKR' })).toThrow(/M_AI_USD_RATE is required/);
    expect(() => configFromEnv({ ...base, M_AI_CURRENCY: 'PKR', M_AI_USD_RATE: '276', M_AI_MARGIN: 'lots' })).toThrow(/margin must look like/);
  });
});

describe('the app is told the charge (contract 0.1.2)', () => {
  it('assistant.usage.record carries the charge and the balance after it', async () => {
    const erp = createMockErp();
    const assistant = createAssistant({
      model: createScriptedModel(['Ji, bataiye.', 'Ji, bataiye.']),
      pricing: { inputPerMTok: '0.15', cachedInputPerMTok: '0.15', outputPerMTok: '0.6' },
      billing: { currency: 'PKR', usdRate: '276.35', margin: '20%' },
    });
    const base = { tenantId: DEMO_TENANT, userId: IDS.owner, text: 'salam', actions: createInProcessActionsClient(erp.registry, () => erp.assistantCtx(IDS.owner, { actor: { clientId: 'm-ai', conversationId: 'w' } })) };
    const r = await assistant.handleTurn({ ...base, conversationId: 'w1', turnId: 'turn-1', balance: '2000' });
    expect(erp.data.usage.find((u) => u.turnId === 'turn-1')).toMatchObject({ charge: { amount: '0.07', currency: 'PKR' }, balanceAfter: r.balanceAfter });
    // Without a wallet nothing extra is sent.
    await createAssistant({ model: createScriptedModel(['Ji.']) }).handleTurn({ ...base, conversationId: 'w2', turnId: 'turn-2' });
    const plain = erp.data.usage.find((u) => u.turnId === 'turn-2')!;
    expect('charge' in plain || 'balanceAfter' in plain).toBe(false);
  });
});
