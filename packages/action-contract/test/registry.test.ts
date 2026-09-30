import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { alertTokenScope, createActionRegistry, defineAction, httpStatusOf } from '../src/index.js';
import type { ActionResult, PreviewResult } from '../src/index.js';
import {
  ENABLED_ASSISTANT,
  MADINA,
  METRO,
  OTHER_CO_CUSTOMER,
  TENANT_A,
  TENANT_B,
  assistantCtx,
  ctxFor,
  madinaInvoice,
  makeApp,
} from './fixtures/app.js';

function expectOk<T>(r: ActionResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message} ${JSON.stringify(r.error.details)}`);
  return r.data;
}
function expectCode(r: ActionResult<unknown>, code: string) {
  if (r.ok) throw new Error(`expected ${code}, got ok`);
  expect(r.error.code).toBe(code);
  return r.error;
}

const usageInput = (turnId: string) => ({
  turnId,
  kind: 'reply',
  model: 'model-x',
  inputTokens: 1200,
  cachedInputTokens: 800,
  outputTokens: 150,
  costUsd: '0.0042',
  occurredAt: '2026-10-01T09:00:00Z',
});

// ─────────────────────────────────────────────────────────────────────────────

describe('catalog', () => {
  it('exports every action, event and error with JSON Schemas, sorted', () => {
    const { registry } = makeApp();
    const catalog = registry.catalog();
    expect(catalog.contractVersion).toBe('0.1.0');
    expect(catalog.producer).toEqual({ name: 'demo-erp', version: '1.0.0' });
    expect(catalog.actions.map((a) => a.name)).toEqual([
      'assistant.usage.record',
      'core.context.get',
      'masters.customer.search',
      'masters.customer.update',
      'reports.sales.summary',
      'sales.invoice.cancel',
      'sales.invoice.post',
    ]);
    const post = catalog.actions.find((a) => a.name === 'sales.invoice.post')!;
    expect(post).toMatchObject({ risk: 'financial', requiresConfirmation: true, hasPreview: true, tags: ['sales', 'invoices'] });
    expect(post.input).toMatchObject({ type: 'object', required: ['customerId', 'date', 'lines'] });
    expect(post.examples[0]?.title).toBe('Ten cartons to Madina Store');
    expect(catalog.events.map((e) => e.type)).toEqual(['customer.updated', 'invoice.cancelled', 'invoice.posted']);
    expect(catalog.errors.find((e) => e.code === 'sales.credit_limit_exceeded')).toBeDefined();
    expect(catalog.errors.find((e) => e.code === 'CONFIRMATION_USED')?.messages.ur).toBeTruthy();
    expect(() => JSON.stringify(catalog)).not.toThrow();
  });

  it('has a stable hash that changes when the catalog changes', async () => {
    const a = makeApp().registry;
    const b = makeApp().registry;
    const hash = await a.catalogHash();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await b.catalogHash()).toBe(hash);
    b.register(
      defineAction({
        name: 'masters.product.search',
        version: 1,
        kind: 'query',
        module: 'CORE',
        description: 'Find products by name or code.',
        tags: ['products', 'search'],
        input: z.object({ query: z.string() }),
        output: z.object({ items: z.array(z.unknown()) }),
        permissions: [],
        risk: 'read',
        requiresConfirmation: false,
        idempotent: true,
        handler: async () => ({ items: [] }),
      }),
    );
    expect(await b.catalogHash()).not.toBe(hash);
  });
});

describe('list', () => {
  it('shows only what the user may call in licensed modules', async () => {
    const { registry } = makeApp({ licence: (_t, m) => (m === 'SALES' ? 'none' : 'active') });
    const all = await registry.list(ctxFor());
    expect(all.actions.map((a) => a.name)).not.toContain('sales.invoice.post');
    expect(all.catalogHash).toMatch(/^[0-9a-f]{64}$/);

    const { registry: r2 } = makeApp();
    const clerk = await r2.list(ctxFor({ permissions: ['customer:view'] }));
    expect(clerk.actions.map((a) => a.name)).toEqual(['assistant.usage.record', 'core.context.get', 'masters.customer.search']);
    const queries = await r2.list(ctxFor(), { kind: 'query', tags: ['sales'] });
    expect(queries.actions.map((a) => a.name)).toEqual(['reports.sales.summary']);
  });

  it('keeps queries of a read-only licence and drops its commands', async () => {
    const { registry } = makeApp({ licence: (_t, m) => (m === 'SALES' ? 'read-only' : 'active') });
    const names = (await registry.list(ctxFor())).actions.map((a) => a.name);
    expect(names).toContain('reports.sales.summary');
    expect(names).not.toContain('sales.invoice.post');
  });

  it('applies the assistant policy and the token scope', async () => {
    const { registry } = makeApp();
    const names = (await registry.list(assistantCtx())).actions.map((a) => a.name);
    expect(names).toContain('sales.invoice.post');
    expect(names).not.toContain('sales.invoice.cancel'); // destructive, not allowed by default

    const alert = assistantCtx({ actor: { clientId: 'm-ai-assistant', scope: alertTokenScope('SALES') } });
    const scoped = (await registry.list(alert)).actions.map((a) => a.name);
    expect(scoped).toEqual(['assistant.usage.record', 'core.context.get', 'masters.customer.search', 'reports.sales.summary']);
  });

  it('shows the assistant nothing but the always-allowed actions when it is disabled', async () => {
    const { registry } = makeApp();
    const names = (await registry.list(assistantCtx({ tenantId: TENANT_B }))).actions.map((a) => a.name);
    expect(names).toEqual(['assistant.usage.record', 'core.context.get']);
  });
});

describe('queries', () => {
  it('runs, applies the default page size and caps it', async () => {
    const { registry } = makeApp();
    const found = expectOk(
      await registry.execute(ctxFor(), { action: 'masters.customer.search', input: { query: 'madina' } }),
    ) as { items: Array<{ display: string; disambiguation: Record<string, string> }> };
    expect(found.items.map((i) => i.display)).toEqual(['Madina Store', 'Madina Traders']);
    expect(found.items[0]?.disambiguation).toEqual({ area: 'Saddar', phone: '03001234567' });

    const tooMany = await registry.execute(ctxFor(), { action: 'reports.sales.summary', input: { from: '2026-10-01', to: '2026-10-31', limit: 500 } });
    expect(expectCode(tooMany, 'VALIDATION_FAILED').details).toMatchObject({ issues: [{ path: 'limit' }] });
  });

  it('only sees its own company', async () => {
    const { registry } = makeApp();
    const found = expectOk(
      await registry.execute(ctxFor({ tenantId: TENANT_B }), { action: 'masters.customer.search', input: { query: 'madina' } }),
    ) as { items: unknown[] };
    expect(found.items).toEqual([]);
  });

  it('reports totals over the whole filter', async () => {
    const { registry } = makeApp();
    for (const customerId of [MADINA, METRO]) {
      const p = expectOk(await registry.preview(ctxFor(), { action: 'sales.invoice.post', input: { ...madinaInvoice, customerId } }));
      expectOk(
        await registry.execute(ctxFor(), {
          action: 'sales.invoice.post',
          input: { ...madinaInvoice, customerId },
          confirmation: { id: p.confirmationId, fingerprint: p.fingerprint },
        }),
      );
    }
    const report = expectOk(
      await registry.execute(ctxFor(), { action: 'reports.sales.summary', input: { from: '2026-10-01', to: '2026-10-31', limit: 1 } }),
    ) as { items: unknown[]; totals: { gross: string }; count: number; truncated: boolean };
    expect(report.items).toHaveLength(1);
    expect(report).toMatchObject({ totals: { gross: '10620.00' }, count: 2, truncated: true });
  });

  it('works on a read-only licence', async () => {
    const { registry } = makeApp({ licence: (_t, m) => (m === 'SALES' ? 'read-only' : 'active') });
    expectOk(await registry.execute(ctxFor(), { action: 'reports.sales.summary', input: { from: '2026-10-01', to: '2026-10-31' } }));
    expectCode(
      await registry.execute(ctxFor(), { action: 'sales.invoice.post', input: madinaInvoice }),
      'LICENCE_READ_ONLY',
    );
  });

  it('cannot be previewed', async () => {
    const { registry } = makeApp();
    expectCode(await registry.preview(ctxFor(), { action: 'masters.customer.search', input: { query: 'x' } }), 'PREVIEW_NOT_SUPPORTED');
  });
});

describe('refusals', () => {
  it('names unknown actions and versions', async () => {
    const { registry } = makeApp();
    const unknown = await registry.execute(ctxFor(), { action: 'sales.invoice.explode', input: {} });
    expectCode(unknown, 'UNKNOWN_ACTION');
    expect(httpStatusOf(unknown)).toBe(404);
    expectCode(await registry.execute(ctxFor(), { action: 'sales.invoice.post', version: 9, input: {} }), 'VERSION_NOT_SUPPORTED');
  });

  it('validates input and lists the issues', async () => {
    const { registry } = makeApp();
    const r = await registry.execute(ctxFor(), { action: 'sales.invoice.post', input: { customerId: 'nope', lines: [] } });
    const error = expectCode(r, 'VALIDATION_FAILED');
    const paths = (error.details as { issues: Array<{ path: string }> }).issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['customerId', 'date', 'lines']));
    expect(httpStatusOf(r)).toBe(400);
  });

  it('checks every required permission', async () => {
    const { registry } = makeApp();
    const r = await registry.execute(ctxFor({ permissions: ['customer:view'] }), { action: 'sales.invoice.post', input: madinaInvoice });
    expect(expectCode(r, 'PERMISSION_DENIED').details).toEqual({ missing: ['invoice:create'] });
  });

  it('refuses unlicensed modules', async () => {
    const { registry } = makeApp({ licence: (_t, m) => (m === 'SALES' ? 'none' : 'active') });
    expectCode(
      await registry.execute(ctxFor(), { action: 'reports.sales.summary', input: { from: '2026-10-01', to: '2026-10-31' } }),
      'MODULE_NOT_LICENSED',
    );
  });

  it('turns ctx.fail into a module error with both languages', async () => {
    const { registry } = makeApp();
    const big = { ...madinaInvoice, lines: [{ description: 'Bulk', quantity: 1000, rate: '450' }] };
    const p = await registry.preview(ctxFor({ locale: 'ur' }), { action: 'sales.invoice.post', input: big });
    const error = expectCode(p, 'sales.credit_limit_exceeded');
    expect(error.message).toContain('ادھار');
    expect(error.messages.en).toContain('credit limit');
    expect(httpStatusOf(p)).toBe(422);
  });

  it('hides unexpected errors behind INTERNAL and logs them', async () => {
    const { host, registry } = makeApp();
    registry.register(
      defineAction({
        name: 'masters.customer.explode',
        version: 1,
        kind: 'command',
        module: 'CORE',
        description: 'A handler that throws, for the test.',
        tags: ['test'],
        input: z.object({}),
        output: z.object({}),
        permissions: [],
        risk: 'write',
        requiresConfirmation: false,
        idempotent: false,
        handler: async () => {
          throw new Error('database is on fire');
        },
      }),
      defineAction({
        name: 'masters.customer.lie',
        version: 1,
        kind: 'query',
        module: 'CORE',
        description: 'A handler whose output breaks its schema.',
        tags: ['test'],
        input: z.object({}),
        output: z.object({ count: z.number() }),
        permissions: [],
        risk: 'read',
        requiresConfirmation: false,
        idempotent: true,
        handler: async () => ({ count: 'many' }) as unknown as { count: number },
      }),
    );
    const r = await registry.execute(ctxFor(), { action: 'masters.customer.explode', input: {} });
    expect(expectCode(r, 'INTERNAL').message).not.toContain('fire');
    expectCode(await registry.execute(ctxFor(), { action: 'masters.customer.lie', input: {} }), 'INTERNAL');
    expect(host.errors.map((e) => e.action)).toEqual(['masters.customer.explode', 'masters.customer.lie']);
  });

  it('refuses undeclared events and invalid payloads', async () => {
    const { host, registry } = makeApp();
    registry.register(
      defineAction({
        name: 'masters.customer.shout',
        version: 1,
        kind: 'command',
        module: 'CORE',
        description: 'Emits an event nobody declared.',
        tags: ['test'],
        input: z.object({}),
        output: z.object({}),
        permissions: [],
        risk: 'write',
        requiresConfirmation: false,
        idempotent: false,
        handler: async (_i, ctx) => {
          await (ctx.emit as (t: string, p: unknown) => Promise<void>)('customer.shouted', {});
          return {};
        },
      }),
    );
    expectCode(await registry.execute(ctxFor(), { action: 'masters.customer.shout', input: {} }), 'INTERNAL');
    expect(host.outboxCount()).toBe(0);
  });

  it('warns about deprecated versions', async () => {
    const { registry } = makeApp();
    registry.register(
      defineAction({
        name: 'masters.customer.find',
        version: 1,
        kind: 'query',
        module: 'CORE',
        description: 'Old customer search, replaced by masters.customer.search.',
        tags: ['customers'],
        input: z.object({}),
        output: z.object({}),
        permissions: [],
        risk: 'read',
        requiresConfirmation: false,
        idempotent: true,
        deprecated: { since: '2026-10-01', useInstead: 'masters.customer.search' },
        handler: async () => ({}),
      }),
    );
    registry.validate();
    const r = await registry.execute(ctxFor(), { action: 'masters.customer.find', input: {} });
    expect(r.meta.warnings?.[0]?.en).toContain('use masters.customer.search');
    expect((await registry.list(ctxFor())).actions.map((a) => a.name)).not.toContain('masters.customer.find');
    expect((await registry.list(ctxFor(), { includeDeprecated: true })).actions.map((a) => a.name)).toContain('masters.customer.find');
  });
});

describe('preview → confirm → execute', () => {
  it('previews by running the real handler, then rolls everything back', async () => {
    const { host, registry } = makeApp();
    const before = host.snapshot();
    const p = expectOk(await registry.preview(ctxFor(), { action: 'sales.invoice.post', input: madinaInvoice }));
    expect(p.preview).toMatchObject({
      summary: { en: 'Invoice INV-0001 to Madina Store for 5310.00' },
      primaryAmount: '5310.00',
      changes: [{ op: 'post', amounts: { net: '4500.00', tax: '810.00', gross: '5310.00' } }],
    });
    expect(p.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(p.expiresAt).toBe('2026-10-01T09:05:00.000Z'); // web: 5 minutes
    expect(host.snapshot()).toBe(before); // no invoice, no number used, no event
    expect(host.data.counters[TENANT_A]).toBeUndefined();
  });

  it('commits what was previewed, writes the event, audits and calls afterCommit', async () => {
    const { host, registry } = makeApp();
    const p = expectOk(await registry.preview(ctxFor(), { action: 'sales.invoice.post', input: madinaInvoice }));
    const r = await registry.execute(ctxFor(), {
      action: 'sales.invoice.post',
      input: madinaInvoice,
      idempotencyKey: 'k-1',
      confirmation: { id: p.confirmationId, fingerprint: p.fingerprint },
    });
    const data = expectOk(r) as { invoiceNo: string; gross: string };
    expect(data).toMatchObject({ invoiceNo: 'INV-0001', gross: '5310.00' });
    expect(r.meta.events).toEqual(['invoice.posted']);
    expect(host.outbox.map((e) => e.type)).toEqual(['invoice.posted']);
    expect(host.committed.map((c) => c.events)).toEqual([['invoice.posted']]);
    const audit = host.auditLog.filter((a) => a.action === 'sales.invoice.post');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ outcome: 'ok', source: 'web', idempotencyKey: 'k-1', risk: 'financial' });
  });

  it('refuses a stale preview and hands over the new one', async () => {
    const { host, registry } = makeApp();
    const p = expectOk(await registry.preview(ctxFor(), { action: 'sales.invoice.post', input: madinaInvoice }));
    // Someone pushes Madina close to the limit, so the preview would now carry a warning.
    host.data.customers.find((c) => c.id === MADINA)!.balance = '79000';
    const r = await registry.execute(ctxFor(), {
      action: 'sales.invoice.post',
      input: madinaInvoice,
      confirmation: { id: p.confirmationId, fingerprint: p.fingerprint },
    });
    const error = expectCode(r, 'PREVIEW_STALE');
    const fresh = error.details as PreviewResult;
    expect(fresh.preview.warnings.map((w) => w.code)).toEqual(['sales.near_credit_limit']);
    expect(fresh.fingerprint).not.toBe(p.fingerprint);
    expect(host.data.invoices).toHaveLength(0);
    // The new confirmation works.
    expectOk(
      await registry.execute(ctxFor(), {
        action: 'sales.invoice.post',
        input: madinaInvoice,
        confirmation: { id: fresh.confirmationId, fingerprint: fresh.fingerprint },
      }),
    );
  });

  it('refuses a confirmation for different input, another user or a forged fingerprint', async () => {
    const { registry } = makeApp();
    const p = expectOk(await registry.preview(ctxFor(), { action: 'sales.invoice.post', input: madinaInvoice }));
    const confirmation = { id: p.confirmationId, fingerprint: p.fingerprint };
    // Same totals, different customer: the fingerprint binds the input.
    const metro = await registry.execute(ctxFor(), { action: 'sales.invoice.post', input: { ...madinaInvoice, customerId: METRO }, confirmation });
    expectCode(metro, 'PREVIEW_STALE');
    const otherUser = await registry.execute(ctxFor({ userId: 'user-clerk' }), { action: 'sales.invoice.post', input: madinaInvoice, confirmation });
    expect(expectCode(otherUser, 'CONFIRMATION_REQUIRED').details).toEqual({ reason: 'invalid' });
    const forged = await registry.execute(ctxFor(), {
      action: 'sales.invoice.post',
      input: madinaInvoice,
      confirmation: { id: p.confirmationId, fingerprint: '0'.repeat(64) },
    });
    expectCode(forged, 'CONFIRMATION_REQUIRED');
  });

  it('expires confirmations (15 minutes for the assistant, 5 for others)', async () => {
    const { host, registry } = makeApp();
    const p = expectOk(await registry.preview(assistantCtx(), { action: 'sales.invoice.post', input: madinaInvoice }));
    expect(p.expiresAt).toBe('2026-10-01T09:15:00.000Z');
    host.advance(15 * 60_000);
    const r = await registry.execute(assistantCtx(), {
      action: 'sales.invoice.post',
      input: madinaInvoice,
      idempotencyKey: 'k-exp',
      confirmation: { id: p.confirmationId, fingerprint: p.fingerprint },
    });
    expectCode(r, 'PREVIEW_EXPIRED');
    expect(host.data.invoices).toHaveLength(0);
  });

  it('uses a confirmation once: same key replays, another key is refused', async () => {
    const { host, registry } = makeApp();
    const p = expectOk(await registry.preview(assistantCtx(), { action: 'sales.invoice.post', input: madinaInvoice }));
    const confirmation = { id: p.confirmationId, fingerprint: p.fingerprint };
    const first = await registry.execute(assistantCtx(), { action: 'sales.invoice.post', input: madinaInvoice, idempotencyKey: 'k-a', confirmation });
    expectOk(first);
    const replay = await registry.execute(assistantCtx(), { action: 'sales.invoice.post', input: madinaInvoice, idempotencyKey: 'k-a', confirmation });
    expect(expectOk(replay)).toEqual(expectOk(first));
    expect(replay.meta).toMatchObject({ replayed: true, events: ['invoice.posted'] });
    const again = await registry.execute(assistantCtx(), { action: 'sales.invoice.post', input: madinaInvoice, idempotencyKey: 'k-b', confirmation });
    expectCode(again, 'CONFIRMATION_USED');
    expect(host.data.invoices).toHaveLength(1);
    expect(host.outboxCount()).toBe(1);
  });

  it('replays a committed execute even after its confirmation expired', async () => {
    const { host, registry } = makeApp();
    const p = expectOk(await registry.preview(assistantCtx(), { action: 'sales.invoice.post', input: madinaInvoice }));
    const req = {
      action: 'sales.invoice.post',
      input: madinaInvoice,
      idempotencyKey: 'k-late',
      confirmation: { id: p.confirmationId, fingerprint: p.fingerprint },
    };
    expectOk(await registry.execute(assistantCtx(), req));
    host.advance(60 * 60_000);
    const retry = await registry.execute(assistantCtx(), req);
    expect(retry.ok && retry.meta.replayed).toBe(true);
    expect(host.data.invoices).toHaveLength(1);
  });

  it('refuses a reused idempotency key with different input', async () => {
    const { registry } = makeApp();
    expectOk(
      await registry.execute(ctxFor(), { action: 'masters.customer.update', input: { customerId: MADINA, phone: '03001112222' }, idempotencyKey: 'k-1' }),
    );
    expectCode(
      await registry.execute(ctxFor(), { action: 'masters.customer.update', input: { customerId: MADINA, phone: '03003334444' }, idempotencyKey: 'k-1' }),
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('requires an idempotency key from mobile, desktop, api and the assistant', async () => {
    const { registry } = makeApp();
    const input = { customerId: MADINA, phone: '03001112222' };
    expectCode(await registry.execute(ctxFor({ source: 'mobile' }), { action: 'masters.customer.update', input }), 'IDEMPOTENCY_KEY_REQUIRED');
    expectOk(await registry.execute(ctxFor({ source: 'web' }), { action: 'masters.customer.update', input }));
    expectOk(
      await registry.execute(ctxFor({ source: 'mobile', idempotencyKey: 'from-header' }), { action: 'masters.customer.update', input }),
    );
  });

  it('keeps sensitive input out of the audit log', async () => {
    const { host, registry } = makeApp();
    expectOk(
      await registry.execute(ctxFor(), {
        action: 'masters.customer.update',
        input: { customerId: MADINA, phone: '03001112222', cnic: '42101-1234567-1' },
      }),
    );
    const entry = host.auditLog.find((a) => a.action === 'masters.customer.update')!;
    expect(entry.input).toMatchObject({ cnic: '[redacted]', phone: '03001112222' });
  });

  it('rolls back the outbox with a failed transaction', async () => {
    const { host, registry } = makeApp();
    host.failNextTransaction();
    const r = await registry.execute(ctxFor(), { action: 'masters.customer.update', input: { customerId: MADINA, phone: '03001112222' } });
    expectCode(r, 'INTERNAL');
    expect(host.outboxCount()).toBe(0);
    expect(host.data.customers.find((c) => c.id === MADINA)!.phone).toBe('03001234567');
    expect(host.auditLog.at(-1)).toMatchObject({ action: 'masters.customer.update', outcome: 'error', errorCode: 'INTERNAL' });
  });
});

describe('the assistant', () => {
  async function previewAndExecute(registry: ReturnType<typeof makeApp>['registry'], key: string, input = madinaInvoice) {
    const p = expectOk(await registry.preview(assistantCtx(), { action: 'sales.invoice.post', input }));
    const r = await registry.execute(assistantCtx(), {
      action: 'sales.invoice.post',
      input,
      idempotencyKey: key,
      confirmation: { id: p.confirmationId, fingerprint: p.fingerprint },
    });
    return { p, r };
  }

  it('must confirm confirmation-bound actions', async () => {
    const { registry } = makeApp();
    const r = await registry.execute(assistantCtx(), { action: 'sales.invoice.post', input: madinaInvoice, idempotencyKey: 'k' });
    expectCode(r, 'CONFIRMATION_REQUIRED');
    expect(httpStatusOf(r)).toBe(428);
    // A web user's own dialog counts as the confirmation.
    expectOk(await registry.execute(ctxFor(), { action: 'sales.invoice.post', input: madinaInvoice }));
  });

  it('is refused by an app that hosts no assistant', async () => {
    const { registry } = makeApp({ assistantSettings: undefined as unknown as Record<string, unknown> });
    const r = await registry.execute(assistantCtx(), { action: 'core.context.get', input: {} });
    expect(expectCode(r, 'ASSISTANT_POLICY_DENIED').details).toEqual({ reason: 'not_supported' });
  });

  it('is refused while disabled, except for context and usage', async () => {
    const { registry } = makeApp();
    const b = { tenantId: TENANT_B };
    const r = await registry.execute(assistantCtx(b), { action: 'masters.customer.search', input: { query: 'x' } });
    expect(expectCode(r, 'ASSISTANT_POLICY_DENIED').details).toEqual({ reason: 'disabled' });
    expectOk(await registry.execute(assistantCtx(b), { action: 'core.context.get', input: {} }));
    expectOk(await registry.execute(assistantCtx(b), { action: 'assistant.usage.record', input: usageInput('t-1'), idempotencyKey: 't-1' }));
  });

  it('may not cancel unless the company allows destructive actions', async () => {
    const { host, registry } = makeApp();
    const posted = expectOk(await registry.execute(ctxFor(), { action: 'sales.invoice.post', input: madinaInvoice })) as { invoiceId: string };
    const input = { invoiceId: posted.invoiceId, reason: 'customer returned goods' };
    expect(expectCode(await registry.preview(assistantCtx(), { action: 'sales.invoice.cancel', input }), 'ASSISTANT_POLICY_DENIED').details).toEqual({
      reason: 'destructive_not_allowed',
    });
    host.setAssistantSettings(TENANT_A, { ...ENABLED_ASSISTANT, policy: { allowDestructive: true } });
    const p = expectOk(await registry.preview(assistantCtx(), { action: 'sales.invoice.cancel', input }));
    expectOk(
      await registry.execute(assistantCtx(), {
        action: 'sales.invoice.cancel',
        input,
        idempotencyKey: 'k-cancel',
        confirmation: { id: p.confirmationId, fingerprint: p.fingerprint },
      }),
    );
  });

  it('stays inside allowedModules (CORE is always allowed)', async () => {
    const { host, registry } = makeApp();
    host.setAssistantSettings(TENANT_A, { ...ENABLED_ASSISTANT, policy: { allowedModules: ['INVENTORY'] } });
    const r = await registry.execute(assistantCtx(), { action: 'reports.sales.summary', input: { from: '2026-10-01', to: '2026-10-31' } });
    expect(expectCode(r, 'ASSISTANT_POLICY_DENIED').details).toEqual({ reason: 'module_not_allowed' });
    expectOk(await registry.execute(assistantCtx(), { action: 'masters.customer.search', input: { query: 'madina' } }));
  });

  it('stops at the quota, but can still read its context and record usage', async () => {
    const { registry } = makeApp({ quota: () => ({ included: 1000, used: 1100, packsRemaining: 0, state: 'exhausted' }) });
    const r = await registry.execute(assistantCtx(), { action: 'masters.customer.search', input: { query: 'x' } });
    expectCode(r, 'ASSISTANT_QUOTA_EXCEEDED');
    expect(httpStatusOf(r)).toBe(402);
    expectOk(await registry.execute(assistantCtx(), { action: 'core.context.get', input: {} }));
    expectOk(await registry.execute(assistantCtx(), { action: 'assistant.usage.record', input: usageInput('t-2'), idempotencyKey: 't-2' }));
  });

  it('asks for approval in the app above the financial limit', async () => {
    const { host, registry } = makeApp();
    host.setAssistantSettings(TENANT_A, { ...ENABLED_ASSISTANT, policy: { financialLimit: '5000' } });

    const { p, r } = await previewAndExecute(registry, 'k-step');
    expect(p.stepUp).toEqual({ required: true });
    const error = expectCode(r, 'STEP_UP_REQUIRED');
    expect(error.details).toMatchObject({ stepUpId: expect.stringMatching(/^stp_/) });
    expect(host.data.invoices).toHaveLength(0);
    const request = host.stepUps.get(p.confirmationId)!;
    expect(request.preview.primaryAmount).toBe('5310.00');

    host.approveStepUp(p.confirmationId);
    const approved = await registry.execute(assistantCtx(), {
      action: 'sales.invoice.post',
      input: madinaInvoice,
      idempotencyKey: 'k-step',
      confirmation: { id: p.confirmationId, fingerprint: p.fingerprint },
    });
    expect((expectOk(approved) as { gross: string }).gross).toBe('5310.00');
  });

  it('replays an approved, committed execute even if the data has moved on', async () => {
    const { host, registry } = makeApp();
    host.setAssistantSettings(TENANT_A, { ...ENABLED_ASSISTANT, policy: { financialLimit: '5000' } });
    const { p } = await previewAndExecute(registry, 'k-replay');
    host.approveStepUp(p.confirmationId);
    const req = {
      action: 'sales.invoice.post',
      input: madinaInvoice,
      idempotencyKey: 'k-replay',
      confirmation: { id: p.confirmationId, fingerprint: p.fingerprint },
    };
    const first = await registry.execute(assistantCtx(), req);
    expectOk(first);
    // Madina is now near her limit, so a fresh preview would differ (a warning appears).
    host.data.customers.find((c) => c.id === MADINA)!.balance = '79000';
    const retry = await registry.execute(assistantCtx(), req);
    expect(expectOk(retry)).toEqual(expectOk(first));
    expect(retry.meta.replayed).toBe(true);
    expect(host.data.invoices).toHaveLength(1);
  });

  it('is refused when the user declines the approval', async () => {
    const { host, registry } = makeApp();
    host.setAssistantSettings(TENANT_A, { ...ENABLED_ASSISTANT, policy: { financialLimit: '5000' } });
    const { p } = await previewAndExecute(registry, 'k-dec');
    host.declineStepUp(p.confirmationId);
    const r = await registry.execute(assistantCtx(), {
      action: 'sales.invoice.post',
      input: madinaInvoice,
      idempotencyKey: 'k-dec',
      confirmation: { id: p.confirmationId, fingerprint: p.fingerprint },
    });
    expect(expectCode(r, 'ASSISTANT_POLICY_DENIED').details).toEqual({ reason: 'step_up_declined' });
  });

  it('needs no approval under the limit, or without a limit', async () => {
    const { host, registry } = makeApp();
    host.setAssistantSettings(TENANT_A, { ...ENABLED_ASSISTANT, policy: { financialLimit: '10000' } });
    const under = await previewAndExecute(registry, 'k-under');
    expect(under.p.stepUp.required).toBe(false);
    expectOk(under.r);
    host.setAssistantSettings(TENANT_A, { ...ENABLED_ASSISTANT });
    expectOk((await previewAndExecute(registry, 'k-nolimit', { ...madinaInvoice, customerId: METRO })).r);
    expect(host.stepUps.size).toBe(0);
  });

  it('is metered and audited with its actor', async () => {
    const { host, registry } = makeApp();
    expectOk(await registry.execute(assistantCtx(), { action: 'masters.customer.search', input: { query: 'madina' } }));
    expectOk((await previewAndExecute(registry, 'k-meter')).r);
    expect(host.usage.map((u) => [u.meter, u.module])).toEqual([
      ['assistant.actions', 'CORE'],
      ['assistant.actions', 'SALES'],
    ]);
    const searchAudit = host.auditLog.find((a) => a.action === 'masters.customer.search')!;
    expect(searchAudit).toMatchObject({ source: 'assistant', actor: { clientId: 'm-ai-assistant', conversationId: 'cnv-1' }, result: { rowCount: 2 } });
    expect(host.auditLog.some((a) => a.outcome === 'previewed')).toBe(true);
    // A web user's queries are not audited.
    const before = host.auditLog.length;
    expectOk(await registry.execute(ctxFor(), { action: 'masters.customer.search', input: { query: 'madina' } }));
    expect(host.auditLog.length).toBe(before);
  });

  it('is held to its alert token scope', async () => {
    const { registry } = makeApp();
    const alert = assistantCtx({ actor: { clientId: 'm-ai-assistant', conversationId: 'cnv-9', scope: alertTokenScope('SALES') } });
    expectOk(await registry.execute(alert, { action: 'reports.sales.summary', input: { from: '2026-10-01', to: '2026-10-31' } }));
    expectOk(await registry.execute(alert, { action: 'masters.customer.search', input: { query: 'madina' } }));
    expectOk(await registry.execute(alert, { action: 'assistant.usage.record', input: usageInput('t-3'), idempotencyKey: 't-3' }));
    const post = await registry.preview(alert, { action: 'sales.invoice.post', input: madinaInvoice });
    expect(expectCode(post, 'PERMISSION_DENIED').details).toEqual({ reason: 'token_scope' });
  });

  it('records usage only as the assistant client', async () => {
    const { registry } = makeApp();
    const r = await registry.execute(ctxFor(), { action: 'assistant.usage.record', input: usageInput('t-4') });
    expectCode(r, 'PERMISSION_DENIED');
  });
});

describe('tenant isolation through the registry', () => {
  it("cannot touch another company's customer", async () => {
    const { host, registry } = makeApp();
    const before = host.snapshot();
    const r = await registry.execute(ctxFor(), { action: 'masters.customer.update', input: { customerId: OTHER_CO_CUSTOMER, phone: '03001112222' } });
    expectCode(r, 'NOT_FOUND');
    expect(host.snapshot()).toBe(before);
  });
});

describe('a registry with a minimal host', () => {
  it('works without assistant hooks for UI sources', async () => {
    const { InMemoryHost } = await import('../src/testing/index.js');
    const host = new InMemoryHost({ data: { n: 0 }, runtime: (data: { n: number }) => data });
    const registry = createActionRegistry<{ n: number }, Record<string, unknown>>({ host, producer: { name: 'mini', version: '0.0.1' } });
    registry.register(
      defineAction<Record<string, never>, { n: number }, { n: number }>({
        name: 'counter.value.bump',
        version: 1,
        kind: 'command',
        module: 'CORE',
        description: 'Add one to the counter, for the test.',
        tags: ['test'],
        input: z.object({}).strict(),
        output: z.object({ n: z.number() }),
        permissions: [],
        risk: 'write',
        requiresConfirmation: false,
        idempotent: false,
        handler: async (_i, ctx) => ({ n: ++ctx.runtime.n }),
      }),
    );
    expect(expectOk(await registry.execute(ctxFor(), { action: 'counter.value.bump', input: {} }))).toEqual({ n: 1 });
    expect(host.data.n).toBe(1);
  });
});
