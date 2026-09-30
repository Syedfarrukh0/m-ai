import { describe, expect, it } from 'vitest';
import {
  AssistantSettings,
  canonicalJson,
  compareMoney,
  computeFingerprint,
  issueConfirmation,
  moneyAbsGreaterThan,
  moneyToScaled,
  signWebhook,
  stepUpRequired,
  verifyConfirmation,
  verifyWebhook,
} from '../src/index.js';
import type { ActionPreview } from '../src/index.js';

describe('canonicalJson', () => {
  it('is independent of key order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: undefined }], c: 'x' } })).toBe(
      canonicalJson({ a: { c: 'x', d: [1, { y: 2 }] }, b: 1 }),
    );
    expect(canonicalJson({ a: undefined })).toBe('{}');
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson(10n)).toBe('"10"');
    expect(canonicalJson(new Date('2026-10-01T00:00:00Z'))).toBe('"2026-10-01T00:00:00.000Z"');
  });

  it('refuses non-finite numbers and cycles', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/circular/);
  });
});

describe('money', () => {
  it('compares exactly', () => {
    expect(moneyToScaled('1250.5')).toBe(12_505_000n);
    expect(moneyToScaled('-0.0001')).toBe(-1n);
    expect(compareMoney('100000', '99999.9999')).toBe(1);
    expect(compareMoney('0.10', '0.1')).toBe(0);
    expect(moneyAbsGreaterThan('-150000', '100000')).toBe(true);
    expect(moneyAbsGreaterThan('100000', '100000')).toBe(false);
    expect(() => moneyToScaled('1e5')).toThrow();
  });
});

const preview: ActionPreview = {
  summary: { en: 'Invoice INV-0001 to Madina for 5310.00', ur: '…' },
  primaryAmount: '5310.00',
  changes: [{ op: 'post', entity: 'sales_invoice', ref: 'INV-0001', label: { en: 'Sales invoice', ur: '…' }, amounts: { gross: '5310.00' } }],
  warnings: [],
};
const base = { action: 'sales.invoice.post', version: 1, tenantId: 't1', userId: 'u1', input: { customerId: 'A' }, preview };

describe('fingerprint', () => {
  it('ignores provisional refs, summary and labels', async () => {
    const fp = await computeFingerprint(base);
    const renumbered: ActionPreview = {
      ...preview,
      summary: { en: 'Invoice INV-0002 to Madina for 5310.00', ur: '…' },
      changes: [{ ...preview.changes[0]!, ref: 'INV-0002', label: { en: 'Invoice', ur: '…' } }],
    };
    expect(await computeFingerprint({ ...base, preview: renumbered })).toBe(fp);
  });

  it('binds input, user, amounts and warnings', async () => {
    const fp = await computeFingerprint(base);
    expect(await computeFingerprint({ ...base, input: { customerId: 'B' } })).not.toBe(fp);
    expect(await computeFingerprint({ ...base, userId: 'u2' })).not.toBe(fp);
    expect(
      await computeFingerprint({
        ...base,
        preview: { ...preview, changes: [{ ...preview.changes[0]!, amounts: { gross: '5310.01' } }] },
      }),
    ).not.toBe(fp);
    expect(
      await computeFingerprint({
        ...base,
        preview: { ...preview, warnings: [{ code: 'sales.near_credit_limit', message: { en: 'x', ur: 'x' } }] },
      }),
    ).not.toBe(fp);
  });
});

describe('confirmation token', () => {
  const secret = 'a-test-secret-of-enough-length';
  const claims = { fingerprint: 'f'.repeat(64), tenantId: 't1', userId: 'u1', action: 'sales.invoice.post', version: 1 };
  const now = new Date('2026-10-01T09:00:00Z');

  it('verifies what it issued, until it expires', async () => {
    const { confirmationId, expiresAt } = await issueConfirmation(secret, claims, new Date(now.getTime() + 60_000));
    expect(confirmationId).toMatch(/^c1\.[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]+$/);
    expect(expiresAt).toBe('2026-10-01T09:01:00.000Z');
    expect((await verifyConfirmation(secret, confirmationId, claims, now)).ok).toBe(true);
    expect(await verifyConfirmation(secret, confirmationId, claims, new Date(now.getTime() + 60_000))).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('is bound to fingerprint, user, action and secret', async () => {
    const { confirmationId } = await issueConfirmation(secret, claims, new Date(now.getTime() + 60_000));
    for (const other of [
      { ...claims, fingerprint: 'e'.repeat(64) },
      { ...claims, userId: 'u2' },
      { ...claims, tenantId: 't2' },
      { ...claims, action: 'sales.invoice.cancel' },
      { ...claims, version: 2 },
    ]) {
      expect(await verifyConfirmation(secret, confirmationId, other, now)).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(await verifyConfirmation('another-secret-of-length', confirmationId, claims, now)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('rejects a tampered expiry and garbage', async () => {
    const { confirmationId } = await issueConfirmation(secret, claims, new Date(now.getTime() + 60_000));
    const [p, r, exp, mac] = confirmationId.split('.');
    const extended = [p, r, String(Number(exp) + 3600), mac].join('.');
    expect(await verifyConfirmation(secret, extended, claims, now)).toEqual({ ok: false, reason: 'invalid' });
    expect(await verifyConfirmation(secret, 'nonsense', claims, now)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('webhook signatures', () => {
  const secret = 'whsec_test_secret_value_123';
  const body = JSON.stringify({ eventId: 'evt_1', type: 'invoice.posted' });
  const now = new Date('2026-10-01T09:00:00Z');
  const t = Math.floor(now.getTime() / 1000);

  it('round-trips and rejects tampering, age and wrong secrets', async () => {
    const header = await signWebhook(secret, body, t);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(await verifyWebhook(secret, body, header, { now })).toBe(true);
    expect(await verifyWebhook(secret, body + ' ', header, { now })).toBe(false);
    expect(await verifyWebhook('whsec_other_secret_value_9', body, header, { now })).toBe(false);
    expect(await verifyWebhook(secret, body, header, { now: new Date(now.getTime() + 301_000) })).toBe(false);
    expect(await verifyWebhook(secret, body, undefined, { now })).toBe(false);
  });

  it('accepts any of several secrets during rotation', async () => {
    const header = await signWebhook(secret, body, t);
    expect(await verifyWebhook(['whsec_new_secret_value_456', secret], body, header, { now })).toBe(true);
  });
});

describe('assistant settings and step-up', () => {
  it('fills defaults, including the nested policy', () => {
    const s = AssistantSettings.parse({});
    expect(s).toMatchObject({ enabled: false, name: 'Assistant', language: 'auto', tone: 'friendly' });
    expect(s.policy).toEqual({ allowDestructive: false, stepUp: 'app' });
  });

  it("reads an unknown step-up mode (e.g. a later 'pin') as 'app'", () => {
    expect(AssistantSettings.parse({ policy: { stepUp: 'pin' } }).policy.stepUp).toBe('app');
  });

  it('requires step-up only above the limit, for the assistant, for financial actions', () => {
    const s = AssistantSettings.parse({ enabled: true, policy: { financialLimit: '100000' } });
    const assistant = { source: 'assistant' as const };
    expect(stepUpRequired(s, { risk: 'financial' }, '100000.01', assistant)).toBe(true);
    expect(stepUpRequired(s, { risk: 'financial' }, '100000', assistant)).toBe(false);
    expect(stepUpRequired(s, { risk: 'financial' }, '-150000', assistant)).toBe(true);
    expect(stepUpRequired(s, { risk: 'write' }, '150000', assistant)).toBe(false);
    expect(stepUpRequired(s, { risk: 'financial' }, '150000', { source: 'web' })).toBe(false);
    const noLimit = AssistantSettings.parse({ enabled: true });
    expect(stepUpRequired(noLimit, { risk: 'financial' }, '9999999', assistant)).toBe(false);
    const none = AssistantSettings.parse({ enabled: true, policy: { financialLimit: '1', stepUp: 'none' } });
    expect(stepUpRequired(none, { risk: 'financial' }, '9999999', assistant)).toBe(false);
  });
});
