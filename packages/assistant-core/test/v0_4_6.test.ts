/**
 * 0.4.6 — after the owner's second real-model run: "INV-… dikhao" made a PDF
 * instead of showing the invoice. A PDF is now offered only when one is asked
 * for. Plus the ERP's first E1 batch: cash and bank accounts, and the
 * statement as data.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ActionCatalog } from '@m-ai/action-contract';
import { buildSystemPrompt, selectTools, toToolSpec } from '../src/index.js';

const catalog = JSON.parse(readFileSync(new URL('../../../docs/erp-catalog/action-catalog.json', import.meta.url), 'utf8')) as ActionCatalog;
const pick = (text: string) => selectTools(catalog.actions, text, 24, undefined, { maxChars: 24_000 }).map((e) => e.name);

describe('a PDF only when one is asked for', () => {
  it('"dikhao" shows the invoice: the render is not offered', () => {
    const names = pick('INV-2026-001424 dikhao');
    expect(names).toContain('sales.invoice.get');
    expect(names).not.toContain('documents.invoice.render');
  });

  it.each(['INV-2026-001424 ka pdf bhejo', 'INV-2026-001424 print kar do', 'send me INV-2026-001424 as a file'])('"%s" offers the render', (text) => {
    expect(pick(text)).toContain('documents.invoice.render');
  });

  it('a render tool says when to use it, and does not claim to ask first', () => {
    const spec = toToolSpec(catalog.actions.find((e) => e.name === 'documents.invoice.render')!);
    expect(spec.description).toMatch(/ONLY when they ask for a PDF/);
    expect(spec.description).not.toMatch(/asked to confirm/);
  });

  it('the prompt says "dikhao" means read it', () => {
    const settings = { enabled: true, name: 'M.Ai', language: 'auto', tone: 'friendly', policy: { allowDestructive: false, stepUp: 'app' } } as never;
    expect(buildSystemPrompt({ settings, context: undefined, replyRule: 'x', notes: [] })).toMatch(/"dikhao".*query tool/);
  });
});

describe('the ERP’s E1 batch', () => {
  it('a customer’s account ("hisaab", "khata", "statement") offers the statement as data', () => {
    for (const text of ['Metro ka hisaab dikhao', 'Metro ka khata batao', 'Metro ka statement dikhao']) {
      const names = pick(text);
      expect(names).toContain('receivables.statement.get');
      expect(names).not.toContain('documents.statement.render');
    }
    expect(pick('Metro ka statement PDF bhejo')).toContain('documents.statement.render');
  });

  it('money in hand offers the cash and bank accounts', () => {
    for (const text of ['bank mein kitna paisa hai?', 'cash kitna hai', 'How much money is in the bank?', 'بینک میں کتنے پیسے ہیں'])
      expect(pick(text)).toContain('accounts.cash-account.list');
  });

  it('every new action is a single object at the top and maps to a tool', () => {
    for (const n of ['accounts.cash-account.list', 'accounts.cash-account.create', 'accounts.cash-account.update', 'receivables.statement.get']) {
      const spec = toToolSpec(catalog.actions.find((e) => e.name === n)!);
      expect(spec.inputSchema['type']).toBe('object');
      expect(spec.inputSchema['anyOf']).toBeUndefined();
    }
  });
});

describe('a provider’s DAILY limit (the owner’s second run: Groq free plan)', () => {
  const groq = (window: string, wait: string) =>
    JSON.stringify({ error: { message: `Rate limit reached for model \`openai/gpt-oss-120b\` in organization \`org_x\` service tier \`on_demand\` on ${window}: Limit 200000, Used 199500, Requested 6000. Please try again in ${wait}. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing`, type: 'tokens' } });

  it('a per-day limit is not worth waiting for in the turn, and carries the provider’s wait', async () => {
    const { httpModelError } = await import('../src/index.js');
    const e = httpModelError('groq', new Response(null, { status: 429 }), groq('tokens per day (TPD)', '7m12.5s'));
    expect(e.retryable).toBe(false);
    expect(e.retryAfterMs).toBe(432_500);
  });

  it('a per-minute limit is still waited for', async () => {
    const { httpModelError } = await import('../src/index.js');
    const e = httpModelError('groq', new Response(null, { status: 429 }), groq('tokens per minute (TPM)', '1.5s'));
    expect(e.retryable).toBe(true);
    expect(e.retryAfterMs).toBe(1500);
  });

  it('reads "try again in" in hours, minutes and seconds', async () => {
    const { waitHintMs, isDailyLimitMessage } = await import('../src/index.js');
    expect(waitHintMs('Please try again in 1h2m3s.')).toBe(3_723_000);
    expect(waitHintMs('retry in 250ms')).toBe(250);
    expect(waitHintMs('no hint here')).toBeUndefined();
    expect(isDailyLimitMessage('on requests per day (RPD)')).toBe(true);
    expect(isDailyLimitMessage('on tokens per minute (TPM)')).toBe(false);
  });

  it('the router leaves a model aside until its daily limit resets, and uses the next one', async () => {
    const { ModelError, withFallback } = await import('../src/index.js');
    let t = 0;
    const calls = { groq: 0, local: 0 };
    const answer = (model: string) => ({ content: [{ type: 'text' as const, text: model }], stopReason: 'end' as const, usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, model });
    let groqDown = true;
    const router = withFallback(
      [
        { label: 'groq', model: { complete: async () => { calls.groq++; if (groqDown) throw new ModelError('groq 429: tokens per day', 429, false, 7 * 60_000); return answer('groq'); } } },
        { label: 'local', model: { complete: async () => (calls.local++, answer('local')) } },
      ],
      { now: () => t },
    );
    const req = { system: 's', messages: [], tools: [], maxTokens: 10 };
    expect((await router.complete(req)).model).toBe('local');
    t += 2 * 60_000; // past the usual 60 s cooldown
    expect((await router.complete(req)).model).toBe('local');
    expect(calls.groq).toBe(1);
    t += 6 * 60_000; // past the provider's 7 minutes
    groqDown = false;
    expect((await router.complete(req)).model).toBe('groq');
  });
});
