/**
 * 0.1.1 — the ERP review asks:
 *   A  module error codes carry their own HTTP status and retryability
 *   B  commands that only read the books run on a read-only licence
 *   C  the host is told which action an idempotency key is for
 *   D  examples/ ships in the tarball (checked in package.json)
 *   E  secrets shown once stay out of the audit log and the idempotency store
 * and §3: one render action per document kind.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CONTRACT_VERSION,
  WELL_KNOWN_ACTION_PATTERNS,
  checkDefinition,
  defineAction,
  httpStatusOf,
  matchesActionPattern,
} from '../src/index.js';
import type { ActionResult, AnyAction } from '../src/index.js';
import { MADINA, TENANT_A, ctxFor, madinaInvoice, makeApp } from './fixtures/app.js';
import type { Events, Runtime } from './fixtures/app.js';

function expectOk<T>(r: ActionResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.data;
}

let busy = false;
const invoiceRender = defineAction<{ invoiceId: string }, { fileId: string; pages: number }, Runtime, Events>({
  name: 'documents.invoice.render',
  version: 1,
  kind: 'command',
  module: 'SALES',
  description: 'Render a posted sales invoice to PDF and return the file id.',
  tags: ['documents', 'render'],
  input: z.object({ invoiceId: z.string() }),
  output: z.object({ fileId: z.string(), pages: z.number().int() }),
  permissions: ['invoice:view'],
  risk: 'write',
  requiresConfirmation: false,
  idempotent: true,
  availableWhenReadOnly: true,
  handler: async (input, ctx) => {
    if (busy) return ctx.fail('documents.busy', { en: 'Many documents are printing. Try again in a moment.', ur: 'بہت سے دستاویزات پرنٹ ہو رہے ہیں۔ تھوڑی دیر بعد کوشش کریں۔' });
    const inv = ctx.runtime.invoices.get(input.invoiceId);
    if (!inv) return ctx.fail('NOT_FOUND', { en: 'Invoice not found.', ur: 'انوائس نہیں ملی۔' });
    return { fileId: `file-${inv.invoiceNo}`, pages: 1 };
  },
});

const personInvite = defineAction<{ phone: string }, { personId: string; inviteLink: string; nested: { token: string } }, Runtime, Events>({
  name: 'people.person.invite',
  version: 1,
  kind: 'command',
  module: 'CORE',
  description: 'Invite a person to the company and return their one-time invitation link.',
  tags: ['people'],
  input: z.object({ phone: z.string() }),
  output: z.object({ personId: z.string(), inviteLink: z.string(), nested: z.object({ token: z.string() }) }),
  permissions: ['customer:update'],
  risk: 'write',
  requiresConfirmation: false,
  idempotent: true,
  sensitiveOutput: ['inviteLink', 'nested.token'],
  handler: async (input) => ({
    personId: `p-${input.phone}`,
    inviteLink: `https://erp.example/invite/SECRET-${input.phone}`,
    nested: { token: `tok-${input.phone}` },
  }),
});

function app(licence?: (tenantId: string, module: string) => 'active' | 'read-only' | 'none') {
  const made = makeApp(licence ? { licence } : {});
  made.registry.register(invoiceRender, personInvite);
  made.registry.registerErrors({
    'documents.busy': { en: 'Many documents are printing.', ur: 'بہت سے دستاویزات پرنٹ ہو رہے ہیں۔', http: 503, retryable: true },
    'documents.template_missing': { en: 'No template for this document.', ur: 'اس دستاویز کا سانچہ موجود نہیں۔' },
  });
  return made;
}

describe('A · module errors with their own status', () => {
  it('travel with the registered http and retryable', async () => {
    const { registry } = app();
    const posted = expectOk(await registry.execute(ctxFor(), { action: 'sales.invoice.post', input: madinaInvoice })) as { invoiceId: string };
    busy = true;
    try {
      const r = await registry.execute(ctxFor(), { action: 'documents.invoice.render', input: { invoiceId: posted.invoiceId } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatchObject({ code: 'documents.busy', http: 503, retryable: true });
      expect(httpStatusOf(r)).toBe(503);
    } finally {
      busy = false;
    }
  });

  it('default to 422 and not retryable; standard codes carry theirs', async () => {
    const { registry } = app();
    const big = { ...madinaInvoice, lines: [{ description: 'Bulk', quantity: 1000, rate: '450' }] };
    const r = await registry.preview(ctxFor(), { action: 'sales.invoice.post', input: big });
    if (r.ok) throw new Error('expected a refusal');
    expect(r.error).toMatchObject({ code: 'sales.credit_limit_exceeded', http: 422, retryable: false });
    const unknown = await registry.execute(ctxFor(), { action: 'sales.invoice.nope', input: {} });
    if (unknown.ok) throw new Error('expected a refusal');
    expect(unknown.error).toMatchObject({ http: 404, retryable: false });
  });

  it('are exported in the catalog with http and retryable', () => {
    const { registry } = app();
    const errors = registry.catalog().errors;
    expect(errors.find((e) => e.code === 'documents.busy')).toMatchObject({ http: 503, retryable: true });
    expect(errors.find((e) => e.code === 'documents.template_missing')).toMatchObject({ http: 422, retryable: false });
    expect(errors.find((e) => e.code === 'RATE_LIMITED')).toMatchObject({ http: 429, retryable: true });
    expect(errors.find((e) => e.code === 'IDEMPOTENCY_IN_PROGRESS')).toMatchObject({ retryable: true });
    expect(errors.every((e) => Number.isInteger(e.http) && typeof e.retryable === 'boolean')).toBe(true);
  });

  it('refuse a status outside 400–599', () => {
    const { registry } = app();
    expect(() => registry.registerErrors({ 'documents.ok': { en: 'x', ur: 'x', http: 200 } })).toThrow(/400 to 599/);
    expect(() => registry.registerErrors({ 'documents.odd': { en: 'x', ur: 'x', http: 503.5 } })).toThrow();
  });
});

describe('B · availableWhenReadOnly', () => {
  it('lets a book-reading command run, and lists it, on a read-only licence', async () => {
    const { registry, host } = app();
    const posted = expectOk(await registry.execute(ctxFor(), { action: 'sales.invoice.post', input: madinaInvoice })) as { invoiceId: string };
    // The licence lapses afterwards.
    const lapsed = app((_t, m) => (m === 'SALES' ? 'read-only' : 'active'));
    lapsed.host.data.invoices.push(...host.data.invoices);
    const r = await lapsed.registry.execute(ctxFor(), { action: 'documents.invoice.render', input: { invoiceId: posted.invoiceId } });
    expect(expectOk(r)).toMatchObject({ fileId: 'file-INV-0001' });
    const names = (await lapsed.registry.list(ctxFor())).actions.map((a) => a.name);
    expect(names).toContain('documents.invoice.render');
    expect(names).not.toContain('sales.invoice.post');
    const post = await lapsed.registry.execute(ctxFor(), { action: 'sales.invoice.post', input: madinaInvoice });
    expect(post.ok ? 'ok' : post.error.code).toBe('LICENCE_READ_ONLY');
  });

  it('is exported in the catalog (queries are always true)', () => {
    const { registry } = app();
    const entries = registry.catalog().actions;
    expect(entries.find((a) => a.name === 'documents.invoice.render')?.availableWhenReadOnly).toBe(true);
    expect(entries.find((a) => a.name === 'sales.invoice.post')?.availableWhenReadOnly).toBe(false);
    expect(entries.find((a) => a.name === 'reports.sales.summary')?.availableWhenReadOnly).toBe(true);
  });

  it('is only allowed on write commands', () => {
    const rule = 'availableWhenReadOnly ⇒ command with risk "write"';
    expect(checkDefinition({ ...(invoiceRender as AnyAction), risk: 'financial', requiresConfirmation: true, preview: () => ({ summary: { en: 'x', ur: 'x' }, primaryAmount: '1', changes: [], warnings: [] }) })).toContain(rule);
    expect(checkDefinition({ ...(invoiceRender as AnyAction), kind: 'query', risk: 'read' })).toContain(rule);
    expect(checkDefinition(invoiceRender as AnyAction)).toEqual([]);
  });
});

describe('C · the host knows which action a key is for', () => {
  it('passes { action, version } to claim and store', async () => {
    const { registry, host } = app();
    expectOk(await registry.execute(ctxFor(), { action: 'masters.customer.update', input: { customerId: MADINA, phone: '03001112222' }, idempotencyKey: 'k-c' }));
    expect(host.idempotencyRows[`${TENANT_A}:k-c`]).toMatchObject({ action: 'masters.customer.update', version: 1 });
  });
});

describe('D · examples ship in the tarball', () => {
  it('lists examples/ in package.json files, and the versions agree', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { files: string[]; version: string };
    expect(pkg.files).toContain('examples');
    expect(pkg.version).toBe(CONTRACT_VERSION);
  });
});

describe('E · sensitiveOutput', () => {
  const req = { action: 'people.person.invite', input: { phone: '03001234567' }, idempotencyKey: 'k-invite' };

  it('returns the secret once, and never stores it', async () => {
    const { registry, host } = app();
    const first = await registry.execute(ctxFor(), req);
    expect(expectOk(first)).toMatchObject({ inviteLink: 'https://erp.example/invite/SECRET-03001234567', nested: { token: 'tok-03001234567' } });
    expect(first.meta.redacted).toBeUndefined();

    const audit = host.auditLog.find((a) => a.action === 'people.person.invite' && a.outcome === 'ok')!;
    expect(audit.result).toEqual({ personId: 'p-03001234567', inviteLink: '[redacted]', nested: { token: '[redacted]' } });
    const row = host.idempotencyRows[`${TENANT_A}:k-invite`]!;
    expect(row.result).toMatchObject({ data: { inviteLink: '[redacted]', nested: { token: '[redacted]' } }, redacted: true });
    expect(JSON.stringify(host.auditLog)).not.toContain('SECRET');
    expect(JSON.stringify(host.idempotencyRows)).not.toContain('SECRET');
  });

  it('replays the redacted output, marked redacted', async () => {
    const { registry } = app();
    expectOk(await registry.execute(ctxFor(), req));
    const replay = await registry.execute(ctxFor(), req);
    expect(expectOk(replay)).toMatchObject({ personId: 'p-03001234567', inviteLink: '[redacted]' });
    expect(replay.meta).toMatchObject({ replayed: true, redacted: true });
  });

  it('does not mark replays of ordinary commands', async () => {
    const { registry } = app();
    const r = { action: 'masters.customer.update', input: { customerId: MADINA, phone: '03001112222' }, idempotencyKey: 'k-plain' };
    expectOk(await registry.execute(ctxFor(), r));
    const replay = await registry.execute(ctxFor(), r);
    expect(replay.meta.replayed).toBe(true);
    expect(replay.meta.redacted).toBeUndefined();
  });

  it('rejects empty paths', () => {
    expect(checkDefinition({ ...(personInvite as AnyAction), sensitiveOutput: [''] })).toContain(
      'every sensitiveOutput path is a non-empty string',
    );
  });
});

describe('§3 · one render action per document kind', () => {
  it('names the family and matches it', () => {
    expect(WELL_KNOWN_ACTION_PATTERNS.documentsRender).toBe('documents.<kind>.render');
    expect(matchesActionPattern('documents.invoice.render', WELL_KNOWN_ACTION_PATTERNS.documentsRender)).toBe(true);
    expect(matchesActionPattern('documents.receipt.render', WELL_KNOWN_ACTION_PATTERNS.documentsRender)).toBe(true);
    expect(matchesActionPattern('documents.render', WELL_KNOWN_ACTION_PATTERNS.documentsRender)).toBe(false);
    expect(matchesActionPattern('masters.customer.search', WELL_KNOWN_ACTION_PATTERNS.search)).toBe(true);
    expect(matchesActionPattern('masters.customer.update', WELL_KNOWN_ACTION_PATTERNS.search)).toBe(false);
  });

  it('is offered only to users who hold that kind\'s permission', async () => {
    const { registry } = app();
    const storekeeper = (await registry.list(ctxFor({ permissions: ['customer:view'] }))).actions.map((a) => a.name);
    expect(storekeeper).not.toContain('documents.invoice.render');
    const accountant = (await registry.list(ctxFor({ permissions: ['invoice:view'] }))).actions.map((a) => a.name);
    expect(accountant).toContain('documents.invoice.render');
  });
});
