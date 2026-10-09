/**
 * 0.1.3 — the wallet API, agreed with the ERP on 8 Oct 2026: signed
 * server-to-server requests, the wallet schemas and errors, the licence check,
 * `assistant.settings.lowBalanceMark`, and a fake wallet to build against.
 */
import { describe, expect, it } from 'vitest';
import {
  AssistantSettings,
  CONTRACT_VERSION,
  LedgerEntry,
  LicenceCheckReply,
  TopUpRequest,
  WALLET_ERRORS,
  WALLET_PATHS,
  Wallet,
  canonicalRequest,
  licenceCheckPath,
  signRequest,
  verifyRequest,
} from '../src/index.js';
import { createFakeWallet } from '../src/testing/index.js';

const SECRET = 'erp-app-secret-0123456789';
const KEYS = { 'erp-1': SECRET };
const T = 1_791_450_000; // a fixed second
const at = new Date(T * 1000);

describe('signed requests', () => {
  it('signs "<t>.<METHOD>.<path>.<body>" exactly, with lower-case hex', async () => {
    expect(new TextDecoder().decode(canonicalRequest(T, 'post', '/v1/wallets/t1/top-ups', '{"a":1}'))).toBe(`${T}.POST./v1/wallets/t1/top-ups.{"a":1}`);
    expect(new TextDecoder().decode(canonicalRequest(T, 'GET', '/v1/wallets/t1/ledger?limit=50&cursor=x'))).toBe(`${T}.GET./v1/wallets/t1/ledger?limit=50&cursor=x.`);
    const h = await signRequest({ keyId: 'erp-1', secret: SECRET, method: 'POST', path: '/v1/x', body: '{}', timestampSeconds: T });
    expect(h['m-ai-key-id']).toBe('erp-1');
    expect(h['m-ai-signature']).toMatch(new RegExp(`^t=${T},v1=[0-9a-f]{64}$`));
  });

  it('verifies, and refuses anything changed', async () => {
    const path = '/v1/wallets/t1/ledger?limit=50&cursor=x';
    const headers = await signRequest({ keyId: 'erp-1', secret: SECRET, method: 'GET', path, timestampSeconds: T });
    const ok = await verifyRequest({ method: 'GET', path, headers }, KEYS, { now: at });
    expect(ok).toEqual({ ok: true, keyId: 'erp-1' });
    // the query re-ordered, as a careless proxy might: not the same request
    expect(await verifyRequest({ method: 'GET', path: '/v1/wallets/t1/ledger?cursor=x&limit=50', headers }, KEYS, { now: at })).toMatchObject({ reason: 'bad_signature' });
    expect(await verifyRequest({ method: 'POST', path, headers }, KEYS, { now: at })).toMatchObject({ reason: 'bad_signature' });
    expect(await verifyRequest({ method: 'GET', path, headers }, { other: SECRET }, { now: at })).toMatchObject({ reason: 'unknown_key' });
    expect(await verifyRequest({ method: 'GET', path, headers }, KEYS, { now: new Date((T + 301) * 1000) })).toMatchObject({ reason: 'expired' });
    expect(await verifyRequest({ method: 'GET', path, headers: {} }, KEYS, { now: at })).toMatchObject({ reason: 'missing_headers' });
  });

  it('the body is raw bytes: a string and its UTF-8 bytes sign the same', async () => {
    const body = '{"note":"آج"}';
    const a = await signRequest({ keyId: 'k', secret: SECRET, method: 'POST', path: '/p', body, timestampSeconds: T });
    const b = await signRequest({ keyId: 'k', secret: SECRET, method: 'POST', path: '/p', body: new TextEncoder().encode(body), timestampSeconds: T });
    expect(a).toEqual(b);
  });

  it('each direction has its own keys: the app key cannot sign as M.Ai', async () => {
    const headers = await signRequest({ keyId: 'erp-1', secret: SECRET, method: 'GET', path: licenceCheckPath('t1', 'ASSISTANT'), timestampSeconds: T });
    const mAiKeys = { 'm-ai-1': 'm-ai-own-secret-0123456789' };
    expect((await verifyRequest({ method: 'GET', path: licenceCheckPath('t1', 'ASSISTANT'), headers }, mAiKeys, { now: at })).ok).toBe(false);
  });
});

describe('schemas', () => {
  it('is version 0.1.3', () => expect(CONTRACT_VERSION).toBe('0.1.3'));

  it('a top-up: positive money, an ISO currency, a reseller only as itself', () => {
    const base = { amount: '2000', currency: 'PKR', enteredBy: { as: 'platform', userId: 'u1' }, payment: { method: 'cash', reference: 'R-1' } };
    expect(TopUpRequest.safeParse(base).success).toBe(true);
    expect(TopUpRequest.safeParse({ ...base, amount: '0' }).success).toBe(false);
    expect(TopUpRequest.safeParse({ ...base, amount: 2000 }).success).toBe(false);
    expect(TopUpRequest.safeParse({ ...base, currency: 'pkr' }).success).toBe(false);
    const asReseller = { ...base, enteredBy: { as: 'reseller', userId: 'u2', resellerId: 'r1' } };
    expect(TopUpRequest.safeParse({ ...asReseller, resellerId: 'r1' }).success).toBe(true);
    expect(TopUpRequest.safeParse({ ...asReseller, resellerId: 'r2' }).success).toBe(false);
    expect(TopUpRequest.safeParse(asReseller).success).toBe(false);
  });

  it('a ledger entry follows its type', () => {
    const e = { id: 'le1', currency: 'PKR', balanceAfter: '1999.69', occurredAt: '2026-10-08T10:00:00+05:00' };
    expect(LedgerEntry.safeParse({ ...e, type: 'charge', amount: '-0.31', turnId: 't', model: 'm' }).success).toBe(true);
    expect(LedgerEntry.safeParse({ ...e, type: 'charge', amount: '0.31', turnId: 't', model: 'm' }).success).toBe(false);
    expect(LedgerEntry.safeParse({ ...e, type: 'charge', amount: '-0.31', model: 'm' }).success).toBe(false);
    expect(LedgerEntry.safeParse({ ...e, type: 'top_up_reversal', amount: '-2000', topUpId: 'tu1' }).success).toBe(false); // no reason
  });

  it('a wallet before its first top-up', () => {
    expect(Wallet.safeParse({ tenantId: 't', balance: '0', currency: null, state: 'empty', lowBalanceMark: null, updatedAt: null }).success).toBe(true);
  });

  it('the licence check: holds exactly for active and grace', () => {
    const base = { tenantId: 't', module: 'ASSISTANT', until: null };
    expect(LicenceCheckReply.safeParse({ ...base, holds: true, state: 'grace' }).success).toBe(true);
    expect(LicenceCheckReply.safeParse({ ...base, holds: true, state: 'read_only' }).success).toBe(false);
    expect(LicenceCheckReply.safeParse({ ...base, holds: false, state: 'ended' }).success).toBe(true);
    expect(licenceCheckPath('t 1', 'ASSISTANT')).toBe('/m-ai/v1/tenants/t%201/licences/ASSISTANT');
  });

  it('settings take a low-balance mark of zero or more', () => {
    expect(AssistantSettings.parse({ lowBalanceMark: '200' }).lowBalanceMark).toBe('200');
    expect(AssistantSettings.safeParse({ lowBalanceMark: '-1' }).success).toBe(false);
    expect(AssistantSettings.parse({}).lowBalanceMark).toBeUndefined();
  });

  it('wallet errors carry English, Urdu, a status and retryability', () => {
    for (const spec of Object.values(WALLET_ERRORS)) {
      expect(spec.messages.en && spec.messages.ur).toBeTruthy();
      expect(spec.http).toBeGreaterThanOrEqual(400);
    }
  });
});

describe('the fake wallet', () => {
  function setup(opts: { mark?: string } = {}) {
    let clock = at;
    const events: Array<{ type: string; payload: Record<string, string> }> = [];
    const wallet = createFakeWallet({
      appKeys: KEYS,
      resellerRates: { r1: '0.05' },
      now: () => clock,
      onEvent: (e) => events.push({ type: e.type, payload: e.payload }),
      ...(opts.mark ? { lowBalanceMark: () => opts.mark } : {}),
    });
    const call = async (method: 'GET' | 'POST', path: string, body?: unknown, key?: string, extra: Record<string, string> = {}) => {
      const raw = body === undefined ? '' : JSON.stringify(body);
      const signed = await signRequest({ keyId: 'erp-1', secret: SECRET, method, path, body: raw, timestampSeconds: Math.floor(clock.getTime() / 1000) });
      const res = await wallet.fetch(`https://m-ai.test${path}`, {
        method,
        headers: { ...signed, ...(key ? { 'idempotency-key': key } : {}), 'content-type': 'application/json', ...extra },
        ...(raw ? { body: raw } : {}),
      });
      return { status: res.status, body: (await res.json()) as { ok: boolean; data: any; error: any; meta: any } };
    };
    return { wallet, events, call, tick: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
  }
  const topUp = (amount: string, extra: object = {}) => ({
    amount,
    currency: 'PKR',
    enteredBy: { as: 'reseller', userId: 'u1', resellerId: 'r1' },
    resellerId: 'r1',
    payment: { method: 'cash', reference: 'RCPT-1' },
    ...extra,
  });

  it('answers for a company that has never topped up', async () => {
    const { call } = setup();
    const r = await call('GET', WALLET_PATHS.wallet('t1'));
    expect(r.body.data).toEqual({ tenantId: 't1', balance: '0', currency: null, state: 'empty', lowBalanceMark: null, updatedAt: null });
  });

  it('a top-up credits once, however often it is pressed, with the reseller cut rounded down', async () => {
    const { call } = setup();
    const first = await call('POST', WALLET_PATHS.topUps('t1'), topUp('1999.99'), 'k1');
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ balance: '1999.99', topUp: { resellerCut: '99.99', resellerRate: '0.05' } }); // 99.9995 → 99.99
    const again = await call('POST', WALLET_PATHS.topUps('t1'), topUp('1999.99'), 'k1');
    expect(again.status).toBe(200);
    expect(again.body.meta.replayed).toBe(true);
    expect((await call('GET', WALLET_PATHS.wallet('t1'))).body.data.balance).toBe('1999.99');
    const reused = await call('POST', WALLET_PATHS.topUps('t1'), topUp('500'), 'k1');
    expect(reused.body.error).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', http: 409 });
  });

  it('refuses unsigned calls, missing keys and other currencies — as ActionErrors, in Urdu on request', async () => {
    const { wallet, call } = setup();
    const unsigned = await wallet.fetch(`https://m-ai.test${WALLET_PATHS.wallet('t1')}`);
    expect(unsigned.status).toBe(401);
    expect((await call('POST', WALLET_PATHS.topUps('t1'), topUp('100'))).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    await call('POST', WALLET_PATHS.topUps('t1'), topUp('100'), 'k1');
    const usd = await call('POST', WALLET_PATHS.topUps('t1'), topUp('100', { currency: 'USD' }), 'k2', { 'accept-language': 'ur' });
    expect(usd.body.error).toEqual({
      code: 'wallet.currency_mismatch',
      message: WALLET_ERRORS['wallet.currency_mismatch'].messages.ur,
      messages: WALLET_ERRORS['wallet.currency_mismatch'].messages,
      http: 422,
      retryable: false,
    });
  });

  it('reversal: once, a reseller only its own and within 24 hours, the platform any time', async () => {
    const { call, tick } = setup();
    const a = (await call('POST', WALLET_PATHS.topUps('t1'), topUp('1000'), 'a')).body.data.topUp.id;
    const b = (await call('POST', WALLET_PATHS.topUps('t1'), topUp('500'), 'b')).body.data.topUp.id;
    const asOther = { reason: 'mistake', enteredBy: { as: 'reseller', userId: 'u9', resellerId: 'r2' } };
    expect((await call('POST', WALLET_PATHS.reversal('t1', a), asOther, 'r0')).body.error).toMatchObject({ code: 'PERMISSION_DENIED', details: { reason: 'not_own_top_up' } });
    const own = { reason: 'entered twice', enteredBy: { as: 'reseller', userId: 'u1', resellerId: 'r1' } };
    const rev = await call('POST', WALLET_PATHS.reversal('t1', a), own, 'r1');
    expect(rev.body.data).toMatchObject({ balance: '500.00', reversal: { type: 'top_up_reversal', amount: '-1000.00', topUpId: a } });
    expect((await call('POST', WALLET_PATHS.reversal('t1', a), own, 'r2')).body.error.code).toBe('wallet.already_reversed');
    tick(25 * 3_600_000);
    expect((await call('POST', WALLET_PATHS.reversal('t1', b), own, 'r3')).body.error.details).toEqual({ reason: 'reversal_window_closed' });
    const platform = { reason: 'refund agreed', enteredBy: { as: 'platform', userId: 'admin' } };
    expect((await call('POST', WALLET_PATHS.reversal('t1', b), platform, 'r4')).status).toBe(201);
  });

  it('the ledger: signed amounts, turnIds on charges, totals over the filter, pages', async () => {
    const { wallet, call } = setup();
    await call('POST', WALLET_PATHS.topUps('t1'), topUp('100'), 'a');
    for (let i = 1; i <= 3; i++) wallet.charge('t1', { turnId: `turn-${i}`, amount: '0.31', model: 'openai/gpt-oss-120b', costUsd: '0.0009' });
    wallet.charge('t1', { turnId: 'turn-1', amount: '0.31', model: 'x' }); // charged once only
    const page1 = await call('GET', `${WALLET_PATHS.ledger('t1')}?limit=2`);
    expect(page1.body.data.entries.map((e: any) => e.type)).toEqual(['top_up', 'charge']);
    expect(page1.body.data.totals).toEqual({ credits: '100.00', debits: '0.93' });
    const page2 = await call('GET', `${WALLET_PATHS.ledger('t1')}?limit=2&cursor=${page1.body.data.nextCursor}`);
    expect(page2.body.data.entries.map((e: any) => [e.turnId, e.amount, e.balanceAfter])).toEqual([
      ['turn-2', '-0.31', '99.38'],
      ['turn-3', '-0.31', '99.07'],
    ]);
    expect(page2.body.data.nextCursor).toBeNull();
    for (const e of [...page1.body.data.entries, ...page2.body.data.entries]) expect(LedgerEntry.safeParse(e).success).toBe(true);
  });

  it('the reseller and platform reports', async () => {
    const { wallet, call } = setup();
    await call('POST', WALLET_PATHS.topUps('t1'), topUp('1000'), 'a');
    await call('POST', WALLET_PATHS.topUps('t2'), topUp('2000'), 'b');
    wallet.charge('t1', { turnId: 'x', amount: '0.31', model: 'm', costUsd: '0.0009' });
    const sold = await call('GET', WALLET_PATHS.resellerTopUps('r1'));
    expect(sold.body.data.totals).toEqual({ sold: '3000.00', reversed: '0.00', cut: '150.00', count: 2 });
    const totals = await call('GET', `${WALLET_PATHS.platformTotals()}?groupBy=month`);
    expect(totals.body.data.periods).toEqual([
      { period: '2026-10', currency: 'PKR', topUps: '3000.00', reversals: '0.00', resellerCuts: '150.00', charges: '0.31', modelCostUsd: '0.0009', outstanding: '2999.69' },
    ]);
  });

  it('balance events: once per crossing — low, empty, restored', async () => {
    const { wallet, events, call } = setup({ mark: '50' });
    await call('POST', WALLET_PATHS.topUps('t1'), topUp('60'), 'a');
    wallet.charge('t1', { turnId: '1', amount: '5', model: 'm' }); // 55: still ok
    wallet.charge('t1', { turnId: '2', amount: '10', model: 'm' }); // 45: low
    wallet.charge('t1', { turnId: '3', amount: '1', model: 'm' }); // 44: still low, no event
    wallet.charge('t1', { turnId: '4', amount: '44.50', model: 'm' }); // -0.50: empty
    await call('POST', WALLET_PATHS.topUps('t1'), topUp('100'), 'b'); // 99.50: restored
    expect(events).toEqual([
      { type: 'wallet.balance.low', payload: { balance: '45.00', currency: 'PKR', mark: '50.00' } },
      { type: 'wallet.balance.empty', payload: { balance: '-0.50', currency: 'PKR' } },
      { type: 'wallet.balance.restored', payload: { balance: '99.50', currency: 'PKR' } },
    ]);
  });

  it('without a mark in settings: 10% of the last top-up', async () => {
    const { call } = setup();
    await call('POST', WALLET_PATHS.topUps('t1'), topUp('2000'), 'a');
    expect((await call('GET', WALLET_PATHS.wallet('t1'))).body.data).toMatchObject({ lowBalanceMark: '200.00', state: 'ok' });
  });
});
