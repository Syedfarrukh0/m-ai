/**
 * 0.4.3 — through the ERP's real door: sign in, a delegated token per
 * conversation, `/actions/*` over HTTP. Renders run without a yes/no and
 * their file is handed to the channel. The assistant's own actions stay hidden.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ActionCatalog } from '@m-ai/action-contract';
import { DEMO_TENANT, IDS, createMockErp } from '@m-ai/mock-erp';
import { createAssistant, createHttpActionsClient, createInProcessActionsClient, runsWithoutAsking, selectTools } from '../src/index.js';
import { createScriptedModel } from '../src/testing/index.js';
import { ErpError, decodeJwt, erpSettingsFromEnv, loginErp } from '../src/erp-live.js';
import { createFakeErpHttp } from './fake-erp-http.js';

const SETTINGS = { baseUrl: 'http://erp.test', tenantCode: 'DEMO', password: 'demo-password-1' };
const catalog = JSON.parse(readFileSync(new URL('../../../docs/erp-catalog/action-catalog.json', import.meta.url), 'utf8')) as ActionCatalog;

describe('the door, from a script', () => {
  it('signs in, gets a delegated token for M.Ai, and calls /actions with it', async () => {
    const fake = createFakeErpHttp();
    const session = await loginErp(SETTINGS, 'owner@demo.pk', { fetch: fake.fetch });
    const claims = await session.claims('c-1');
    expect(claims).toMatchObject({ sub: IDS.owner, tid: DEMO_TENANT, aud: 'erp:actions', act: { sub: 'm-ai' }, cnv: 'c-1' });
    const list = await session.actions('c-1').list();
    expect(list.actions.length).toBeGreaterThan(5);
    const call = fake.calls.find((c) => c.path === '/actions/list')!;
    expect(decodeJwt(call.headers['authorization']!.slice(7))?.['typ']).toBe('delegated');
    expect(call.headers['x-erp-source']).toBeUndefined();
  });

  it('keeps a token until 30 s before it expires, then asks again; renews the session after 15 minutes', async () => {
    let t = Date.parse('2026-10-08T10:00:00Z');
    const fake = createFakeErpHttp({ now: () => t });
    const session = await loginErp(SETTINGS, 'owner@demo.pk', { fetch: fake.fetch, now: () => t });
    const a = await session.token('c');
    expect(await session.token('c')).toBe(a);
    t += 280_000;
    expect(await session.token('c')).not.toBe(a);
    expect(fake.calls.filter((c) => c.path === '/auth/delegate')).toHaveLength(2);
    t += 15 * 60_000;
    await session.token('c');
    expect(fake.calls.some((c) => c.path === '/auth/refresh' && c.status === 200)).toBe(true);
  });

  it('says what went wrong: a wrong password, or a company without ASSISTANT', async () => {
    const fake = createFakeErpHttp({ password: 'right' });
    const err = await loginErp(SETTINGS, 'owner@demo.pk', { fetch: fake.fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(ErpError);
    expect(err).toMatchObject({ step: 'login', status: 401 });

    const unlicensed = createFakeErpHttp({ licensed: () => false });
    const session = await loginErp(SETTINGS, 'owner@demo.pk', { fetch: unlicensed.fetch });
    const e2 = await session.token('c').catch((e) => e);
    expect(e2).toMatchObject({ step: 'delegate', status: 403 });
    expect(e2.message).toMatch(/demo:assistant/);
  });

  it('reads its settings from .env, and names what is missing', () => {
    expect(erpSettingsFromEnv({})).toEqual({ missing: ['M_AI_ERP_URL (or --erp <url>)', 'M_AI_ERP_PASSWORD'] });
    const s = erpSettingsFromEnv({ M_AI_ERP_URL: 'http://localhost:3001/', M_AI_ERP_PASSWORD: 'p', M_AI_ERP_BOOKER: 'b@x.pk' });
    expect(s).toMatchObject({ baseUrl: 'http://localhost:3001', tenantCode: 'DEMO', users: { owner: 'owner@demo.pk', booker: 'b@x.pk' } });
  });

  it('a whole turn over HTTP: preview, "haan", execute with its Idempotency-Key', async () => {
    const fake = createFakeErpHttp();
    const session = await loginErp(SETTINGS, 'owner@demo.pk', { fetch: fake.fetch });
    const customerId = fake.erp.data.customers[0]!.id;
    const model = createScriptedModel([{ call: { name: 'masters.customer.update', input: { customerId, phone: '03001234567' } } }, 'Ho gaya.']);
    const assistant = createAssistant({ model });
    const claims = await session.claims('wa-1');
    const turn = (text: string) => assistant.handleTurn({ conversationId: 'wa-1', tenantId: claims.tid, userId: claims.sub, text, actions: session.actions('wa-1') });
    expect((await turn('Madina ka number 03001234567 kar do')).status).toBe('awaiting_confirmation');
    const done = await turn('haan');
    expect(done.executed).toEqual([{ action: 'masters.customer.update', ok: true }]);
    const exec = fake.calls.find((c) => c.path === '/actions/execute' && (c.body as { action: string }).action === 'masters.customer.update')!;
    expect(exec.headers['idempotency-key']).toBeTruthy();
    expect(fake.erp.data.customers[0]!.phone).toBe('03001234567');
  });

  it('accepts a list wrapped in an ActionResult', async () => {
    const fake = createFakeErpHttp({ wrapList: true });
    const session = await loginErp(SETTINGS, 'owner@demo.pk', { fetch: fake.fetch });
    expect((await session.actions('c').list()).actions.length).toBeGreaterThan(5);
  });

  it('turns a refused token into a clear transport error', async () => {
    const fake = createFakeErpHttp();
    const client = createHttpActionsClient({ baseUrl: 'http://erp.test', token: 'not-a-token', fetch: fake.fetch });
    await expect(client.list()).rejects.toThrow(/401/);
  });
});

describe('renders', () => {
  it('a document runs without a yes/no; its file is handed to the channel', async () => {
    const erp = createMockErp();
    const model = createScriptedModel([{ call: { name: 'documents.invoice.render', input: { invoiceNo: 'INV-0001' } } }, 'PDF tayyar hai.']);
    const r = await createAssistant({ model }).handleTurn({
      conversationId: 'c',
      tenantId: DEMO_TENANT,
      userId: IDS.owner,
      text: 'INV-0001 ka pdf bhejo',
      actions: createInProcessActionsClient(erp.registry, () => erp.assistantCtx(IDS.owner, { actor: { clientId: 'm-ai', conversationId: 'c' } })),
    });
    expect(r.status).toBe('answered');
    expect(r.pending).toBeUndefined();
    expect(r.executed).toEqual([{ action: 'documents.invoice.render', ok: true }]);
    expect(r.documents).toEqual([{ action: 'documents.invoice.render', documentId: expect.any(String), fileName: 'INV-0001.pdf', contentType: 'application/pdf' }]);
    // "tayyar hai" is not flagged as a false "done": something was executed.
    expect(r.reply).not.toMatch(/nothing has been saved|kuch bhi save/i);
  });

  it('only renders: every other change is still previewed', () => {
    const byName = new Map(catalog.actions.map((e) => [e.name, e]));
    expect(runsWithoutAsking(byName.get('documents.statement.render')!)).toBe(true);
    expect(runsWithoutAsking(byName.get('documents.invoice.render')!)).toBe(true);
    for (const n of ['sales.invoice.post', 'receivables.receipt.post', 'masters.customer.update', 'assistant.usage.record', 'assistant.settings.update'])
      expect(runsWithoutAsking(byName.get(n)!)).toBe(false);
  });
});

describe('the cross-checked catalog', () => {
  it('never offers the assistant’s own actions, the new terms action included', () => {
    const names = selectTools(catalog.actions, 'assistant terms settings usage consent accept', 56).map((e) => e.name);
    expect(names.filter((n) => n.startsWith('assistant.'))).toEqual([]);
  });

  it('finds an invoice by the ERP’s own number format (SI-000123)', () => {
    const names = selectTools(catalog.actions, 'SI-000123 dikhao', 24, undefined, { maxChars: 24_000 }).map((e) => e.name);
    expect(names).toContain('sales.invoice.get');
  });

  it('updates carry no "create" defaults, and no confirm flag', () => {
    for (const e of catalog.actions.filter((x) => /^masters\.\w+\.update$/.test(x.name))) {
      const props = (e.input as { properties: Record<string, unknown> }).properties;
      expect(JSON.stringify(props['changes'])).not.toMatch(/left out|leave it|is made/i);
      expect(props['confirm']).toBeUndefined();
    }
  });
});

describe('evals against a real ERP', () => {
  it('fill puts found records into a scenario, at any depth', async () => {
    const { fill, at } = await import('../scripts/eval-runner.js');
    expect(fill({ say: '{debtor} ka udhaar', input: { id: '{debtorId}', n: 2 } }, { debtor: 'Madina', debtorId: 'x' })).toEqual({ say: 'Madina ka udhaar', input: { id: 'x', n: 2 } });
    expect(fill('{missing} stays', {})).toBe('{missing} stays');
    expect(at({ items: [{ name: 'A' }] }, 'items.0.name')).toBe('A');
  });

  it('runs a scenario through the door, checking a figure read back from the ERP', async () => {
    const { runScenario } = await import('../scripts/eval-runner.js');
    const fake = createFakeErpHttp();
    const session = await loginErp(SETTINGS, 'owner@demo.pk', { fetch: fake.fetch });
    const inv = fake.erp.data.invoices[0]!;
    const model = createScriptedModel([{ call: { name: 'sales.invoice.get', input: { invoiceNo: inv.invoiceNo } } }, `${inv.invoiceNo}: total ${inv.gross}.`]);
    const { results } = await runScenario(
      {
        name: 'by-number',
        requires: ['invoiceNo'],
        turns: [{ say: '{invoiceNo} dikhao', expect: { calls: ['sales.invoice.get'], figuresFrom: [{ action: 'sales.invoice.get', input: { invoiceNo: '{invoiceNo}' }, path: 'gross' }] } }],
      },
      { model },
      {
        vars: { invoiceNo: inv.invoiceNo },
        connect: async (_role, cid) => {
          const c = await session.claims(cid);
          return { actions: session.actions(cid), tenantId: c.tid, userId: c.sub };
        },
      },
    );
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.map((r) => r.check)).toContain(`reply has sales.invoice.get gross (${inv.gross})`);
  });

  it('finds what it can in the ERP, and says what it could not', async () => {
    const { discoverVars } = await import('../scripts/erp-discover.js');
    const fake = createFakeErpHttp();
    const session = await loginErp(SETTINGS, 'owner@demo.pk', { fetch: fake.fetch });
    const { vars, notes } = await discoverVars(session.actions('d'));
    expect(vars['today']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(vars['monthFrom']).toMatch(/-01$/);
    expect(notes.some((n) => n.includes('{customer}'))).toBe(true); // the mock has no masters.customer.list
  });
});

describe('Roman Urdu around English names (found on the ERP run)', () => {
  it('a posting said with an English customer name is still Roman Urdu', async () => {
    const { detectLanguage } = await import('../src/index.js');
    expect(detectLanguage('Metro Cash & Carry se 100 rupay cash wasool hue')).toBe('ur-Latn');
    expect(detectLanguage('Metro Cash & Carry ko band kar do')).toBe('ur-Latn');
    expect(detectLanguage('Show me what Metro Cash & Carry owes')).toBe('en');
  });

  it('"band kar do" offers the update', () => {
    const names = selectTools(catalog.actions, 'Metro Cash & Carry ko band kar do', 24, undefined, { maxChars: 24_000 }).map((e) => e.name);
    expect(names).toContain('masters.customer.update');
  });
});

describe('the PDF door (GET /documents/{id})', () => {
  it('a render over HTTP hands back a file the same token can fetch', async () => {
    const fake = createFakeErpHttp();
    const session = await loginErp(SETTINGS, 'owner@demo.pk', { fetch: fake.fetch });
    const model = createScriptedModel([{ call: { name: 'documents.invoice.render', input: { invoiceNo: 'INV-0001' } } }, 'PDF tayyar hai.']);
    const claims = await session.claims('pdf-1');
    const r = await createAssistant({ model }).handleTurn({ conversationId: 'pdf-1', tenantId: claims.tid, userId: claims.sub, text: 'INV-0001 ka pdf', actions: session.actions('pdf-1') });
    const doc = r.documents[0]!;
    const file = await session.actions('pdf-1').document(doc.documentId);
    expect(file).toMatchObject({ ok: true, contentType: 'application/pdf', fileName: 'INV-0001.pdf' });
    expect(file.ok && new TextDecoder().decode(file.bytes).startsWith('%PDF-')).toBe(true);
    // The render carried its own Idempotency-Key, though it asked nobody.
    const exec = fake.calls.find((c) => c.path === '/actions/execute' && (c.body as { action: string }).action === 'documents.invoice.render')!;
    expect(exec.headers['idempotency-key']).toBeTruthy();
  });

  it('a refusal comes back in the app’s REST shape', async () => {
    const fake = createFakeErpHttp();
    const session = await loginErp(SETTINGS, 'owner@demo.pk', { fetch: fake.fetch });
    expect(await session.actions('x').document('no-such-file')).toEqual({ ok: false, status: 404, code: 'NOT_FOUND', message: 'The record was not found.' });
  });
});

describe('renders by number (the ERP, 8 Oct evening)', () => {
  it('a receipt or credit-note number brings its document actions', () => {
    const pick = (t: string) => selectTools(catalog.actions, t, 24, undefined, { maxChars: 24_000 }).map((e) => e.name);
    expect(pick('RC-2026-000412 ka pdf bhejo')).toContain('documents.receipt.render');
    expect(pick('CN-2026-000009 dikhao')).toContain('sales.invoice.get');
  });

  it('the renders take the number as one of two optional fields', () => {
    const byName = new Map(catalog.actions.map((e) => [e.name, e]));
    const inv = byName.get('documents.invoice.render')!.input as { properties: Record<string, unknown>; required?: string[]; anyOf?: unknown };
    expect(Object.keys(inv.properties).sort()).toEqual(['invoiceId', 'invoiceNo']);
    expect(inv.required ?? []).toEqual([]);
    expect(inv.anyOf).toBeUndefined();
  });
});

describe('finding records when the month has no sales (the owner’s run, 8 Oct)', () => {
  it('takes a product from the latest invoice when the sales summary is empty and the product list fails', async () => {
    const { discoverVars } = await import('../scripts/erp-discover.js');
    const meta = { requestId: 'r', action: 'x', version: 1, replayed: false, events: [] as string[] };
    const ok = (data: unknown) => ({ ok: true as const, data, meta });
    const data: Record<string, unknown> = {
      'core.context.get': { today: '2026-10-08', company: { fiscalYear: { start: '2026-07-01' } }, assistant: { settings: { policy: { financialLimit: '50000' } } } },
      'reports.receivables.outstanding': { items: [{ customerId: 'c1', name: 'Metro Cash & Carry', outstanding: '100.00' }] },
      'masters.customer.list': { items: [{ name: 'Al-Fatah Store', isActive: true }] },
      'reports.sales.summary': { items: [] },
      'sales.invoice.list': { items: [{ id: 'i1', invoiceNo: 'INV-2026-001394' }] },
      'sales.invoice.get': { lines: [{ description: 'Surf Excel 1kg', productCode: 'DET1KG' }] },
      'masters.company.list': { items: [{ name: 'Nestlé Pakistan', usageCount: 4 }] },
    };
    const client = {
      list: async () => ({ actions: [], catalogHash: 'x' }),
      preview: async () => {
        throw new Error('no');
      },
      execute: async (req: { action: string }) =>
        req.action in data
          ? ok(data[req.action])
          : { ok: false as const, error: { code: 'INTERNAL', message: 'x', messages: { en: 'x', ur: 'x' } }, meta },
    };
    const { vars, notes } = await discoverVars(client);
    expect(vars).toMatchObject({ product: 'Surf Excel 1kg', productCode: 'DET1KG', invoiceNo: 'INV-2026-001394', invoiceId: 'i1', overLimit: '51000' });
    expect(notes).toEqual([]);
  });
});
