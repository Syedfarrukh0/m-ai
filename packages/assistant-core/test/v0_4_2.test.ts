/**
 * 0.4.2 — the ERP's real catalog (Phase D, 55 actions): the right actions
 * reach the model for everyday messages, within a size budget; bulk imports
 * stay out; a licence that ends mid-token gets a plain answer.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ActionCatalog, CatalogEntry } from '@m-ai/action-contract';
import { catalogHash } from '@m-ai/action-contract';
import { DEMO_TENANT, IDS, createMockErp } from '@m-ai/mock-erp';
import { createAssistant, createInProcessActionsClient, fromToolName, selectTools, toToolName, toToolSpec } from '../src/index.js';
import type { ActionsClient } from '../src/index.js';
import { createScriptedModel } from '../src/testing/index.js';

const catalog = JSON.parse(
  readFileSync(new URL('../../../docs/erp-catalog/action-catalog.json', import.meta.url), 'utf8'),
) as ActionCatalog;
const actions: CatalogEntry[] = catalog.actions;
const BUDGET = 24_000;
const sizeOf = (sel: CatalogEntry[]) => sel.reduce((n, e) => n + JSON.stringify(toToolSpec(e)).length, 0);

describe('the ERP catalog, Phase D', () => {
  it('is the file the ERP sent (its hash matches theirs)', async () => {
    expect(catalog.contractVersion).toBe('0.1.3');
    expect(actions).toHaveLength(60);
    expect(await catalogHash(catalog)).toBe('8b6766a605a3f35f6e42e53e694a58924a8c75a15606bbba1645c47252010982');
  });

  it('every action becomes a tool whose name maps back', () => {
    for (const e of actions) {
      const spec = toToolSpec(e);
      expect(spec.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(fromToolName(spec.name)).toBe(e.name);
      expect(spec.inputSchema['type']).toBe('object');
      expect(JSON.stringify(spec.inputSchema)).not.toContain('"pattern":"^([0-9a-fA-F]{8}');
      expect(e.description.length).toBeLessThanOrEqual(200);
    }
  });

  const CASES: Array<[string, string[]]> = [
    ['Madina Store ko 10 carton Pepsi', ['sales.invoice.post', 'masters.customer.search', 'masters.product.search']],
    ['Madina Store se 5000 rupay wasool hue cash', ['receivables.receipt.post', 'masters.customer.search']],
    ['INV-0002 dikhao', ['sales.invoice.get', 'sales.invoice.list']],
    ['Madina ka phone number badal do 03001234567', ['masters.customer.update', 'masters.customer.search']],
    ['aaj ki sale kitni hui?', ['reports.sales.summary']],
    ['kis kis ka udhaar baqi hai', ['reports.receivables.outstanding']],
    ['Madina ka statement bhejo is mahine ka', ['documents.statement.render', 'masters.customer.search']],
    ['naya customer banao Ali Traders Lahore', ['masters.customer.create']],
    ['is mahine Nestle ki kitni sale hui', ['reports.sales.summary', 'masters.company.search']],
    ['booker wise sale dikhao', ['reports.sales.summary']],
    ['Pepsi ka rate kya hai', ['masters.product.search', 'masters.product.get']],
    ['INV-0002 ka pdf bhejo', ['documents.invoice.render', 'sales.invoice.list']],
    ['Madina ki unpaid invoices', ['sales.invoice.list']],
    ['آج کی سیل کتنی ہوئی', ['reports.sales.summary']],
    ['مدینہ سٹور سے 5000 وصول ہوئے', ['receivables.receipt.post']],
  ];

  it.each(CASES)('"%s" offers what it needs, within the budget', (text, wanted) => {
    const sel = selectTools(actions, text, 24, undefined, { maxChars: BUDGET });
    const names = sel.map((e) => e.name);
    for (const w of wanted) expect(names).toContain(w);
    expect(sizeOf(sel)).toBeLessThanOrEqual(BUDGET);
  });

  it('never offers bulk imports or the assistant’s own plumbing', () => {
    const sel = selectTools(actions, 'customers import spreadsheet opening balance stock settings usage consent', 55);
    const names = sel.map((e) => e.name);
    expect(names.some((n) => n.endsWith('.import'))).toBe(false);
    for (const n of ['core.context.get', 'assistant.usage.record', 'assistant.settings.get', 'assistant.settings.update', 'assistant.consent.accept'])
      expect(names).not.toContain(n);
  });

  it('an app can show bulk actions by clearing the hidden tags', () => {
    const sel = selectTools(actions, 'customer import', 55, undefined, { hiddenTags: new Set() });
    expect(sel.map((e) => e.name)).toContain('masters.customer.import');
  });

  it('the budget drops the lowest-scored tools first, and always keeps one', () => {
    const all = selectTools(actions, 'Madina Store ko 10 carton Pepsi', 24);
    const tight = selectTools(actions, 'Madina Store ko 10 carton Pepsi', 24, undefined, { maxChars: 8000 });
    expect(sizeOf(tight)).toBeLessThanOrEqual(8000);
    expect(tight.length).toBeLessThan(all.length);
    expect(tight.map((e) => e.name)).toContain('sales.invoice.post');
    expect(selectTools(actions, 'x', 24, undefined, { maxChars: 1 })).toHaveLength(1);
  });

  it('the assistant sends at most the default budget of tool definitions', async () => {
    const model = createScriptedModel(['Ji.']);
    const erp = createMockErp();
    const client = createInProcessActionsClient(erp.registry, () => erp.assistantCtx(IDS.owner, { actor: { clientId: 'm-ai', conversationId: 'c' } }));
    const wrapped: ActionsClient = { ...client, list: async () => ({ actions, catalogHash: 'x' }) };
    await createAssistant({ model }).handleTurn({ conversationId: 'c', tenantId: DEMO_TENANT, userId: IDS.owner, text: 'Madina Store ko 10 carton Pepsi', actions: wrapped });
    const tools = model.requests[0]!.tools.filter((t) => t.name !== 'remember');
    expect(JSON.stringify(tools).length).toBeLessThanOrEqual(BUDGET + tools.length + 2);
    expect(tools.map((t) => t.name)).toContain(toToolName('sales.invoice.post'));
  });
});

describe('a licence that ended while the token was live', () => {
  it('answers plainly in the person’s language and calls no model', async () => {
    const model = createScriptedModel([]);
    const notLicensed: ActionsClient = {
      list: async () => ({ actions: [], catalogHash: 'x' }),
      preview: async () => {
        throw new Error('not reached');
      },
      execute: async () => ({
        ok: false,
        error: { code: 'MODULE_NOT_LICENSED', message: 'Not licensed.', messages: { en: 'Not licensed.', ur: 'لائسنس نہیں۔' }, retryable: false, details: { module: 'ASSISTANT' } },
        meta: { requestId: 'r', action: 'core.context.get', version: 1, replayed: false, events: [] },
      }),
    };
    const result = await createAssistant({ model }).handleTurn({ conversationId: 'c', tenantId: DEMO_TENANT, userId: IDS.owner, text: 'aaj ki sale kitni hui?', actions: notLicensed });
    expect(result.status).toBe('refused');
    expect(result.reply).toMatch(/licence nahi hai/);
    expect(model.requests).toHaveLength(0);
  });
});

describe('the mock ERP, like the ERP', () => {
  it('records a turn once: the same turn again answers recorded: false', async () => {
    const erp = createMockErp();
    const client = createInProcessActionsClient(erp.registry, () => erp.assistantCtx(IDS.owner, { actor: { clientId: 'm-ai', conversationId: 'c' } }));
    const input = { turnId: 't-1', kind: 'reply', conversationId: 'c', model: 'm', inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, costUsd: '0.0001', occurredAt: '2026-10-08T10:00:00Z' };
    const first = await client.execute({ action: 'assistant.usage.record', idempotencyKey: 'k-1', input });
    const again = await client.execute({ action: 'assistant.usage.record', idempotencyKey: 'k-2', input });
    expect(first).toMatchObject({ ok: true, data: { recorded: true } });
    expect(again).toMatchObject({ ok: true, data: { recorded: false } });
  });
});
