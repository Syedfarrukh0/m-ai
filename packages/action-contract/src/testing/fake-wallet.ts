import { canonicalJson } from '../crypto.js';
import type { ActionError } from '../errors.js';
import { makeError, standardError } from '../errors.js';
import type { StandardErrorCode } from '../errors.js';
import { verifyRequest } from '../requests.js';
import { moneyToScaled } from '../schemas.js';
import type { Locale } from '../vocabulary.js';
import type { LedgerEntry, TopUp, Wallet, WalletErrorCode, WalletResult, WalletState } from '../wallet.js';
import {
  LedgerEntryType,
  ReversalRequest,
  TopUpRequest,
  WALLET_ERRORS,
  WALLET_EVENTS,
} from '../wallet.js';

/**
 * An in-memory M.Ai wallet that answers the wallet API exactly as the
 * service will: signatures, idempotency, the reversal rules, the ledger, the
 * reports and the balance events. Point an app's HTTP client at `fake.fetch`
 * to build and test the wallet screens before the service runs.
 */
export interface FakeWalletOptions {
  /** Key id → secret: the keys the APP signs its calls with. */
  appKeys: Readonly<Record<string, string>>;
  /** Reseller id → cut rate as a fraction, e.g. "0.05". Unlisted resellers earn 0. */
  resellerRates?: Readonly<Record<string, string>>;
  /** The company's `assistant.settings.lowBalanceMark`, when set. */
  lowBalanceMark?: (tenantId: string) => string | undefined;
  /** Balance events, as they would be delivered to the app. */
  onEvent?: (event: { eventId: string; type: string; tenantId: string; occurredAt: string; payload: Record<string, string> }) => void;
  now?: () => Date;
}

export interface FakeWalletRequest {
  method: string;
  /** Path and query, exactly as sent. */
  path: string;
  headers: Record<string, string>;
  body?: string;
}

export interface FakeWallet {
  handle(request: FakeWalletRequest): Promise<{ status: number; body: WalletResult<unknown> }>;
  /** A fetch that routes to `handle` (any host). */
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  /** M.Ai's own side: charge one assistant turn. Idempotent on turnId. */
  charge(tenantId: string, charge: { turnId: string; amount: string; model: string; costUsd?: string }): { balance: string };
}

const SCALE = 10_000n;
const DAY_MS = 86_400_000;

function fmt(scaled: bigint): string {
  const sign = scaled < 0n ? '-' : '';
  const abs = scaled < 0n ? -scaled : scaled;
  const whole = abs / SCALE;
  const frac = abs % SCALE;
  return frac % 100n === 0n ? `${sign}${whole}.${(frac / 100n).toString().padStart(2, '0')}` : `${sign}${whole}.${frac.toString().padStart(4, '0')}`;
}

/** rate "0.05" → 500 (per 10,000). */
function rateScaled(rate: string | undefined): bigint {
  if (!rate) return 0n;
  const [w = '0', f = ''] = rate.split('.');
  return BigInt(w) * SCALE + BigInt(f.padEnd(4, '0').slice(0, 4));
}

/** Round DOWN to 2 decimals (in 1/10,000 units). */
const floor2 = (v: bigint) => (v >= 0n ? (v / 100n) * 100n : -((-v + 99n) / 100n) * 100n);

interface WalletRow {
  currency: string | null;
  entries: Array<LedgerEntry & { costUsd?: string }>;
  topUps: Map<string, TopUp>;
  lastTopUp: bigint;
  updatedAt: string | null;
  state: WalletState;
}

export function createFakeWallet(options: FakeWalletOptions): FakeWallet {
  const now = options.now ?? (() => new Date());
  const wallets = new Map<string, WalletRow>();
  const idem = new Map<string, { request: string; status: number; body: WalletResult<unknown> }>();
  const charged = new Set<string>();
  let seq = 0;
  const id = (prefix: string) => `${prefix}_${(++seq).toString().padStart(6, '0')}`;

  const row = (tenantId: string): WalletRow => {
    let w = wallets.get(tenantId);
    if (!w) {
      // `state` here is the last state an event was sent for: none yet, so a first top-up announces nothing.
      w = { currency: null, entries: [], topUps: new Map(), lastTopUp: 0n, updatedAt: null, state: 'ok' };
      wallets.set(tenantId, w);
    }
    return w;
  };
  const balanceOf = (w: WalletRow) => w.entries.reduce((s, e) => s + moneyToScaled(e.amount), 0n);
  const markOf = (tenantId: string, w: WalletRow): bigint | null => {
    const set = options.lowBalanceMark?.(tenantId);
    if (set !== undefined) return moneyToScaled(set);
    return w.lastTopUp > 0n ? floor2(w.lastTopUp / 10n) : null;
  };
  const stateOf = (tenantId: string, w: WalletRow): WalletState => {
    const b = balanceOf(w);
    if (b <= 0n) return 'empty';
    const mark = markOf(tenantId, w);
    return mark !== null && b < mark ? 'low' : 'ok';
  };
  const view = (tenantId: string, w: WalletRow): Wallet => {
    const mark = markOf(tenantId, w);
    return {
      tenantId,
      balance: w.entries.length ? fmt(balanceOf(w)) : '0',
      currency: w.currency,
      state: stateOf(tenantId, w),
      // Before the first top-up there is nothing to measure against.
      lowBalanceMark: mark === null || w.currency === null ? null : fmt(mark),
      updatedAt: w.updatedAt,
    };
  };

  /** After every change: one event when the state crosses into low, empty or back to ok. */
  function settle(tenantId: string, w: WalletRow): void {
    const next = stateOf(tenantId, w);
    if (next === w.state) return;
    w.state = next;
    if (!options.onEvent || !w.currency) return;
    const balance = fmt(balanceOf(w));
    const type = next === 'low' ? WALLET_EVENTS.low : next === 'empty' ? WALLET_EVENTS.empty : WALLET_EVENTS.restored;
    const payload: Record<string, string> = { balance, currency: w.currency };
    if (next === 'low') payload['mark'] = fmt(markOf(tenantId, w) ?? 0n);
    options.onEvent({ eventId: id('evt'), type, tenantId, occurredAt: now().toISOString(), payload });
  }

  function add(w: WalletRow, entry: Omit<LedgerEntry, 'id' | 'balanceAfter' | 'occurredAt' | 'currency'> & { costUsd?: string }): LedgerEntry {
    const balanceAfter = fmt(balanceOf(w) + moneyToScaled(entry.amount));
    const full = { ...entry, id: id('le'), currency: w.currency!, balanceAfter, occurredAt: now().toISOString() } as LedgerEntry & { costUsd?: string };
    w.entries.push(full);
    w.updatedAt = full.occurredAt;
    const { costUsd: _c, ...visible } = full;
    return visible;
  }

  // ── HTTP ────────────────────────────────────────────────────────────────

  function localeOf(headers: Record<string, string>): Locale {
    const raw = Object.entries(headers).find(([k]) => k.toLowerCase() === 'accept-language')?.[1] ?? 'en';
    const first = raw.split(',')[0]!.trim();
    return first.toLowerCase().startsWith('ur-latn') ? 'ur-Latn' : first.toLowerCase().startsWith('ur') ? 'ur' : 'en';
  }

  async function handle(req: FakeWalletRequest): Promise<{ status: number; body: WalletResult<unknown> }> {
    const meta = { requestId: id('req'), replayed: false };
    const locale = localeOf(req.headers);
    const fail = (error: ActionError) => ({ status: error.http ?? 400, body: { ok: false as const, error, meta } });
    const std = (code: StandardErrorCode, details?: unknown) => fail(standardError(code, locale, details));
    const own = (code: WalletErrorCode) => {
      const spec = WALLET_ERRORS[code];
      return fail({ ...makeError(code, spec.messages, locale), http: spec.http, retryable: spec.retryable });
    };
    const ok = (data: unknown, status = 200) => ({ status, body: { ok: true as const, data, meta } });

    const verified = await verifyRequest({ method: req.method, path: req.path, body: req.body ?? '', headers: req.headers }, options.appKeys, {
      now: now(),
    });
    if (!verified.ok) return own('wallet.unauthenticated');

    const [pathname = '', query = ''] = req.path.split('?', 2);
    const params = new URLSearchParams(query);
    const method = req.method.toUpperCase();
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);

    let body: unknown = undefined;
    if (method === 'POST') {
      try {
        body = req.body ? JSON.parse(req.body) : {};
      } catch {
        return std('VALIDATION_FAILED', { reason: 'body is not JSON' });
      }
      const key = Object.entries(req.headers).find(([k]) => k.toLowerCase() === 'idempotency-key')?.[1];
      if (!key) return std('IDEMPOTENCY_KEY_REQUIRED');
      const fingerprint = canonicalJson({ path: pathname, body });
      const seen = idem.get(`${verified.keyId}:${key}`);
      if (seen) {
        if (seen.request !== fingerprint) return std('IDEMPOTENCY_KEY_REUSED');
        return { status: 200, body: { ...seen.body, meta: { ...meta, replayed: true } } as WalletResult<unknown> };
      }
      const result = route();
      if (result.body.ok) idem.set(`${verified.keyId}:${key}`, { request: fingerprint, status: result.status, body: result.body });
      return result;
    }
    if (method === 'GET') return route();
    return std('NOT_FOUND');

    function page<T>(items: T[]): { items: T[]; nextCursor: string | null } {
      const limit = Math.min(Math.max(Number(params.get('limit') ?? 50) || 50, 1), 200);
      const start = Number(params.get('cursor') ?? 0) || 0;
      const slice = items.slice(start, start + limit);
      return { items: slice, nextCursor: start + limit < items.length ? String(start + limit) : null };
    }
    function inPeriod(iso: string): boolean {
      const day = iso.slice(0, 10);
      const from = params.get('from');
      const to = params.get('to');
      return (!from || day >= from) && (!to || day <= to);
    }

    function route(): { status: number; body: WalletResult<unknown> } {
      // /v1/wallets/{tenantId}[/top-ups[/{id}/reversal] | /ledger]
      if (parts[0] === 'v1' && parts[1] === 'wallets' && parts[2]) {
        const tenantId = parts[2];
        const w = row(tenantId);
        if (method === 'GET' && parts.length === 3) return ok(view(tenantId, w));

        if (method === 'GET' && parts[3] === 'ledger' && parts.length === 4) {
          const type = params.get('type');
          if (type && !LedgerEntryType.safeParse(type).success) return std('VALIDATION_FAILED', { type });
          const all = w.entries.filter((e) => inPeriod(e.occurredAt) && (!type || e.type === type)).map(({ costUsd: _c, ...e }) => e as LedgerEntry);
          let credits = 0n;
          let debits = 0n;
          for (const e of all) {
            const a = moneyToScaled(e.amount);
            if (a > 0n) credits += a;
            else debits -= a;
          }
          const p = page(all);
          return ok({ entries: p.items, nextCursor: p.nextCursor, totals: { credits: fmt(credits), debits: fmt(debits) } });
        }

        if (method === 'POST' && parts[3] === 'top-ups' && parts.length === 4) {
          const parsed = TopUpRequest.safeParse(body);
          if (!parsed.success) return std('VALIDATION_FAILED', { issues: parsed.error.issues });
          const r = parsed.data;
          if (w.currency && w.currency !== r.currency) return own('wallet.currency_mismatch');
          w.currency ??= r.currency;
          const amount = moneyToScaled(r.amount);
          const rate = r.resellerId ? options.resellerRates?.[r.resellerId] : undefined;
          const topUpId = id('tu');
          const topUp: TopUp = {
            id: topUpId,
            tenantId,
            amount: fmt(amount),
            currency: r.currency,
            enteredBy: r.enteredBy,
            payment: r.payment,
            createdAt: now().toISOString(),
            ...(r.resellerId ? { resellerId: r.resellerId, resellerCut: fmt(floor2((amount * rateScaled(rate)) / SCALE)), resellerRate: rate ?? '0' } : {}),
            ...(r.note ? { note: r.note } : {}),
          };
          w.topUps.set(topUpId, topUp);
          w.lastTopUp = amount;
          add(w, {
            type: 'top_up',
            amount: fmt(amount),
            topUpId,
            enteredBy: r.enteredBy,
            payment: r.payment,
            ...(r.resellerId ? { resellerId: r.resellerId } : {}),
          });
          settle(tenantId, w);
          return ok({ topUp, balance: fmt(balanceOf(w)) }, 201);
        }

        if (method === 'POST' && parts[3] === 'top-ups' && parts[4] && parts[5] === 'reversal' && parts.length === 6) {
          const parsed = ReversalRequest.safeParse(body);
          if (!parsed.success) return std('VALIDATION_FAILED', { issues: parsed.error.issues });
          const topUp = w.topUps.get(parts[4]);
          if (!topUp) return std('NOT_FOUND');
          if (topUp.reversedBy) return own('wallet.already_reversed');
          const actor = parsed.data.enteredBy;
          if (actor.as === 'reseller') {
            if (actor.resellerId !== topUp.resellerId) return std('PERMISSION_DENIED', { reason: 'not_own_top_up' });
            if (now().getTime() - new Date(topUp.createdAt).getTime() > DAY_MS) return std('PERMISSION_DENIED', { reason: 'reversal_window_closed' });
          }
          const reversal = add(w, {
            type: 'top_up_reversal',
            amount: fmt(-moneyToScaled(topUp.amount)),
            topUpId: topUp.id,
            enteredBy: actor,
            reason: parsed.data.reason,
            ...(topUp.resellerId ? { resellerId: topUp.resellerId } : {}),
          });
          topUp.reversedBy = reversal.id;
          settle(tenantId, w);
          return ok({ reversal, balance: fmt(balanceOf(w)) }, 201);
        }
      }

      // /v1/resellers/{resellerId}/top-ups
      if (method === 'GET' && parts[0] === 'v1' && parts[1] === 'resellers' && parts[2] && parts[3] === 'top-ups' && parts.length === 4) {
        const all = [...wallets.values()].flatMap((w) => [...w.topUps.values()]).filter((t) => t.resellerId === parts[2] && inPeriod(t.createdAt));
        let sold = 0n;
        let reversed = 0n;
        let cut = 0n;
        for (const t of all) {
          sold += moneyToScaled(t.amount);
          if (t.reversedBy) reversed += moneyToScaled(t.amount);
          else cut += moneyToScaled(t.resellerCut ?? '0');
        }
        const p = page(all);
        return ok({ topUps: p.items, nextCursor: p.nextCursor, totals: { sold: fmt(sold), reversed: fmt(reversed), cut: fmt(cut), count: all.length } });
      }

      // /v1/reports/totals
      if (method === 'GET' && pathname === '/v1/reports/totals') {
        const byDay = params.get('groupBy') === 'day';
        const periods = new Map<string, { currency: string; topUps: bigint; reversals: bigint; resellerCuts: bigint; charges: bigint; cost: bigint }>();
        for (const w of wallets.values()) {
          for (const e of w.entries) {
            if (!inPeriod(e.occurredAt) || !w.currency) continue;
            const key = `${byDay ? e.occurredAt.slice(0, 10) : e.occurredAt.slice(0, 7)}|${w.currency}`;
            const p = periods.get(key) ?? { currency: w.currency, topUps: 0n, reversals: 0n, resellerCuts: 0n, charges: 0n, cost: 0n };
            const a = moneyToScaled(e.amount);
            if (e.type === 'top_up') {
              p.topUps += a;
              p.resellerCuts += moneyToScaled(w.topUps.get(e.topUpId!)?.resellerCut ?? '0');
            } else if (e.type === 'top_up_reversal') {
              p.reversals -= a;
              p.resellerCuts -= moneyToScaled(w.topUps.get(e.topUpId!)?.resellerCut ?? '0');
            } else if (e.type === 'charge') {
              p.charges -= a;
              p.cost += moneyToScaled(e.costUsd ?? '0');
            }
            periods.set(key, p);
          }
        }
        const outstanding = [...wallets.values()].reduce((s, w) => s + balanceOf(w), 0n);
        return ok({
          periods: [...periods.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, p]) => ({
            period: key.split('|')[0]!,
            currency: p.currency,
            topUps: fmt(p.topUps),
            reversals: fmt(p.reversals),
            resellerCuts: fmt(p.resellerCuts),
            charges: fmt(p.charges),
            modelCostUsd: fmt(p.cost),
            outstanding: fmt(outstanding),
          })),
        });
      }

      return std('NOT_FOUND');
    }
  }

  return {
    handle,
    async fetch(input, init = {}) {
      const url = new URL(String(input));
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => (headers[k] = v));
      const r = await handle({ method: init.method ?? 'GET', path: url.pathname + url.search, headers, body: typeof init.body === 'string' ? init.body : '' });
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    },
    charge(tenantId, c) {
      const w = row(tenantId);
      if (!w.currency) throw new Error('fake wallet: no top-up yet, so no currency to charge in');
      const amount = moneyToScaled(c.amount);
      if (amount < 0n) throw new Error('fake wallet: a charge is never negative');
      if (!charged.has(`${tenantId}:${c.turnId}`)) {
        charged.add(`${tenantId}:${c.turnId}`);
        add(w, { type: 'charge', amount: fmt(-amount), turnId: c.turnId, model: c.model, ...(c.costUsd ? { costUsd: c.costUsd } : {}) });
        settle(tenantId, w);
      }
      return { balance: fmt(balanceOf(w)) };
    },
  };
}
