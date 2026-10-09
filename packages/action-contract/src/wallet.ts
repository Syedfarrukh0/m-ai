import { z } from 'zod';
import type { ActionError } from './errors.js';
import type { LocalizedText } from './vocabulary.js';
import { CurrencyCode, IsoDate, IsoDateTime, ModuleCode, MoneyString, moneyToScaled } from './schemas.js';

/**
 * The M.Ai wallet API — what an app (the ERP) calls, server to server, signed
 * with `signRequest()`. A company's assistant use is paid from its wallet:
 * top-ups add money, each assistant turn is charged at the cost of the model
 * that answered plus the margin. The ledger only grows; corrections are
 * reversing entries.
 *
 * Every reply is a `WalletResult`, whose error is exactly an `ActionError`, so
 * an app shows a wallet error and an action error with the same code.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared pieces
// ─────────────────────────────────────────────────────────────────────────────

/** An id from the app (its tenant, reseller and user ids). */
export const AppId = z.string().min(1).max(100);

const positive = (v: string) => moneyToScaled(v) > 0n;
const notNegative = (v: string) => moneyToScaled(v) >= 0n;

/** A money amount above zero. */
export const PositiveMoney = MoneyString.refine(positive, 'must be more than 0');
/** A money amount of zero or more. */
export const NonNegativeMoney = MoneyString.refine(notNegative, 'must not be negative');

/**
 * Who entered a top-up or a reversal, as the app vouches. A reseller acts only
 * for itself: the app enforces that, and the wallet checks `resellerId`.
 */
export const WalletActor = z.discriminatedUnion('as', [
  z.object({ as: z.literal('platform'), userId: AppId }),
  z.object({ as: z.literal('reseller'), userId: AppId, resellerId: AppId }),
]);
export type WalletActor = z.infer<typeof WalletActor>;

export const TopUpPayment = z.object({
  method: z.enum(['cash', 'bank_transfer', 'other']),
  /** Cash receipt or bank transfer reference. */
  reference: z.string().trim().min(1).max(100),
  receivedOn: IsoDate.optional(),
});
export type TopUpPayment = z.infer<typeof TopUpPayment>;

// ─────────────────────────────────────────────────────────────────────────────
// Requests and replies
// ─────────────────────────────────────────────────────────────────────────────

/** POST /v1/wallets/{tenantId}/top-ups — with an Idempotency-Key header. */
export const TopUpRequest = z
  .object({
    amount: PositiveMoney,
    currency: CurrencyCode,
    /** The reseller who sold it; absent for a direct sale. */
    resellerId: AppId.optional(),
    enteredBy: WalletActor,
    payment: TopUpPayment,
    note: z.string().trim().max(200).optional(),
  })
  .refine((v) => v.enteredBy.as !== 'reseller' || v.resellerId === v.enteredBy.resellerId, {
    message: 'a reseller enters top-ups only as itself: resellerId must be its own',
    path: ['resellerId'],
  });
export type TopUpRequest = z.infer<typeof TopUpRequest>;

export const TopUp = z.object({
  id: z.string().min(1),
  tenantId: AppId,
  amount: PositiveMoney,
  currency: CurrencyCode,
  resellerId: AppId.optional(),
  /** The reseller's cut at the rate in force, rounded down to 2 decimals. */
  resellerCut: NonNegativeMoney.optional(),
  /** That rate, as a fraction ("0.05"), stored with the top-up. */
  resellerRate: z.string().regex(/^0(?:\.\d{1,4})?$|^1(?:\.0{1,4})?$/).optional(),
  enteredBy: WalletActor,
  payment: TopUpPayment,
  note: z.string().optional(),
  createdAt: IsoDateTime,
  /** The id of the reversing ledger entry, once reversed. */
  reversedBy: z.string().optional(),
});
export type TopUp = z.infer<typeof TopUp>;

export const LedgerEntryType = z.enum(['top_up', 'top_up_reversal', 'charge', 'adjustment']);
export type LedgerEntryType = z.infer<typeof LedgerEntryType>;

/**
 * One line of a wallet's ledger. `amount` is signed: credits are positive,
 * charges and reversals negative. A charge carries the `turnId` of the app's
 * `usage_events` row (where the charge is stored as a positive amount).
 */
export const LedgerEntry = z
  .object({
    id: z.string().min(1),
    type: LedgerEntryType,
    amount: MoneyString,
    currency: CurrencyCode,
    balanceAfter: MoneyString,
    occurredAt: IsoDateTime,
    turnId: z.string().min(1).max(100).optional(),
    model: z.string().min(1).max(100).optional(),
    topUpId: z.string().optional(),
    resellerId: AppId.optional(),
    enteredBy: WalletActor.optional(),
    payment: TopUpPayment.optional(),
    reason: z.string().max(200).optional(),
  })
  .superRefine((e, ctx) => {
    const scaled = moneyToScaled(e.amount);
    const need = (cond: boolean, message: string, path: string) => {
      if (!cond) ctx.addIssue({ code: 'custom', message, path: [path] });
    };
    switch (e.type) {
      case 'top_up':
        need(scaled > 0n, 'a top-up is a positive amount', 'amount');
        need(e.topUpId !== undefined, 'a top-up names its topUpId', 'topUpId');
        break;
      case 'top_up_reversal':
        need(scaled < 0n, 'a reversal is a negative amount', 'amount');
        need(e.topUpId !== undefined, 'a reversal names the top-up it reverses', 'topUpId');
        need(e.reason !== undefined, 'a reversal gives a reason', 'reason');
        break;
      case 'charge':
        need(scaled <= 0n, 'a charge is zero or negative in the ledger', 'amount');
        need(e.turnId !== undefined, 'a charge names its turnId', 'turnId');
        need(e.model !== undefined, 'a charge names the model that answered', 'model');
        break;
      case 'adjustment':
        need(e.reason !== undefined, 'an adjustment gives a reason', 'reason');
        break;
    }
  });
export type LedgerEntry = z.infer<typeof LedgerEntry>;

export const TopUpReply = z.object({ topUp: TopUp, balance: MoneyString });
export type TopUpReply = z.infer<typeof TopUpReply>;

/** POST /v1/wallets/{tenantId}/top-ups/{topUpId}/reversal — with an Idempotency-Key header. */
export const ReversalRequest = z.object({
  reason: z.string().trim().min(1).max(200),
  enteredBy: WalletActor,
});
export type ReversalRequest = z.infer<typeof ReversalRequest>;

export const ReversalReply = z.object({ reversal: LedgerEntry, balance: MoneyString });
export type ReversalReply = z.infer<typeof ReversalReply>;

export const WalletState = z.enum(['ok', 'low', 'empty']);
export type WalletState = z.infer<typeof WalletState>;

/**
 * GET /v1/wallets/{tenantId}. Answered for any tenant of the app — before the
 * first top-up as `{ balance: "0", currency: null, state: "empty", lowBalanceMark: null }`.
 */
export const Wallet = z.object({
  tenantId: AppId,
  balance: MoneyString,
  /** Fixed by the first top-up; null before it. */
  currency: CurrencyCode.nullable(),
  state: WalletState,
  /** The mark in force: the company's setting, else 10% of its last top-up; null before any top-up. */
  lowBalanceMark: NonNegativeMoney.nullable(),
  updatedAt: IsoDateTime.nullable(),
});
export type Wallet = z.infer<typeof Wallet>;

/** Totals are over the whole filter, not the page. `debits` is a positive sum. */
export const LedgerPage = z.object({
  entries: z.array(LedgerEntry),
  nextCursor: z.string().nullable(),
  totals: z.object({ credits: NonNegativeMoney, debits: NonNegativeMoney }),
});
export type LedgerPage = z.infer<typeof LedgerPage>;

/** GET /v1/resellers/{resellerId}/top-ups?from=&to= */
export const ResellerTopUpsPage = z.object({
  topUps: z.array(TopUp),
  nextCursor: z.string().nullable(),
  totals: z.object({
    sold: NonNegativeMoney,
    reversed: NonNegativeMoney,
    cut: NonNegativeMoney,
    count: z.number().int().min(0),
  }),
});
export type ResellerTopUpsPage = z.infer<typeof ResellerTopUpsPage>;

/** GET /v1/reports/totals?from=&to=&groupBy=day|month — for the platform console. */
export const PlatformTotals = z.object({
  periods: z.array(
    z.object({
      /** "2026-10" or "2026-10-08". */
      period: z.string().regex(/^\d{4}-\d{2}(?:-\d{2})?$/),
      currency: CurrencyCode,
      topUps: NonNegativeMoney,
      reversals: NonNegativeMoney,
      resellerCuts: NonNegativeMoney,
      /** What companies were charged for replies. */
      charges: NonNegativeMoney,
      /** What the models behind those replies cost, in USD. */
      modelCostUsd: NonNegativeMoney,
      /** Balances held at the end of the period. */
      outstanding: MoneyString,
    }),
  ),
});
export type PlatformTotals = z.infer<typeof PlatformTotals>;

/** Every wallet reply. The error is exactly an ActionError. */
export interface WalletMeta {
  requestId: string;
  /** True when an Idempotency-Key replay returned the first reply. */
  replayed: boolean;
}
export type WalletResult<T> = { ok: true; data: T; meta: WalletMeta } | { ok: false; error: ActionError; meta: WalletMeta };

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

const seg = (v: string) => encodeURIComponent(v);

export const WALLET_PATHS = {
  wallet: (tenantId: string) => `/v1/wallets/${seg(tenantId)}`,
  topUps: (tenantId: string) => `/v1/wallets/${seg(tenantId)}/top-ups`,
  reversal: (tenantId: string, topUpId: string) => `/v1/wallets/${seg(tenantId)}/top-ups/${seg(topUpId)}/reversal`,
  ledger: (tenantId: string) => `/v1/wallets/${seg(tenantId)}/ledger`,
  resellerTopUps: (resellerId: string) => `/v1/resellers/${seg(resellerId)}/top-ups`,
  platformTotals: () => '/v1/reports/totals',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Errors — standard codes where one fits, `wallet.*` for the rest
// ─────────────────────────────────────────────────────────────────────────────

export interface WalletErrorSpec {
  http: number;
  retryable: boolean;
  messages: LocalizedText;
}

/**
 * The wallet's own codes. It also answers with standard codes:
 * VALIDATION_FAILED 400 · PERMISSION_DENIED 403 (e.g. a reseller reversing
 * after 24 hours: `details.reason: "reversal_window_closed"`) · NOT_FOUND 404 ·
 * IDEMPOTENCY_KEY_REQUIRED 400 · IDEMPOTENCY_KEY_REUSED 409 ·
 * MODULE_NOT_LICENSED 403 (a direct top-up without the licence) ·
 * RATE_LIMITED 429 · INTERNAL 500.
 */
export const WALLET_ERRORS = {
  'wallet.unauthenticated': {
    http: 401,
    retryable: false,
    messages: { en: 'The request could not be verified.', ur: 'درخواست کی تصدیق نہیں ہو سکی۔' },
  },
  'wallet.already_reversed': {
    http: 409,
    retryable: false,
    messages: { en: 'This top-up has already been reversed.', ur: 'یہ ٹاپ اپ پہلے ہی واپس ہو چکا ہے۔' },
  },
  'wallet.currency_mismatch': {
    http: 422,
    retryable: false,
    messages: { en: "This currency is not the wallet's currency.", ur: 'یہ کرنسی والٹ کی کرنسی نہیں ہے۔' },
  },
} as const satisfies Record<string, WalletErrorSpec>;
export type WalletErrorCode = keyof typeof WALLET_ERRORS;

// ─────────────────────────────────────────────────────────────────────────────
// Balance events — signed webhooks to the app, in the EventDelivery envelope
// ─────────────────────────────────────────────────────────────────────────────

export const WALLET_EVENTS = {
  /** The balance fell below the low-balance mark. */
  low: 'wallet.balance.low',
  /** The balance reached zero or below: the assistant now refuses new turns. */
  empty: 'wallet.balance.empty',
  /** A top-up lifted the balance back above the mark. */
  restored: 'wallet.balance.restored',
} as const;

export const WalletBalanceLowPayload = z.object({ balance: MoneyString, mark: NonNegativeMoney, currency: CurrencyCode });
export const WalletBalanceEmptyPayload = z.object({ balance: MoneyString, currency: CurrencyCode });
export const WalletBalanceRestoredPayload = z.object({ balance: MoneyString, currency: CurrencyCode });

// ─────────────────────────────────────────────────────────────────────────────
// The licence check — served by the APP, called by M.Ai (signed with M.Ai's key)
// ─────────────────────────────────────────────────────────────────────────────

export const LicenceCheckState = z.enum(['active', 'grace', 'read_only', 'ended', 'none']);
export type LicenceCheckState = z.infer<typeof LicenceCheckState>;

/** GET /m-ai/v1/tenants/{tenantId}/licences/{module} on the app. */
export const LicenceCheckReply = z
  .object({
    tenantId: AppId,
    module: ModuleCode,
    /** True exactly when `state` is active or grace. A direct top-up needs it. */
    holds: z.boolean(),
    state: LicenceCheckState,
    /** Null for a one-time licence; set when the company's whole subscription has an end. */
    until: IsoDateTime.nullable(),
  })
  .refine((v) => v.holds === (v.state === 'active' || v.state === 'grace'), {
    message: 'holds must be true exactly for active and grace',
    path: ['holds'],
  });
export type LicenceCheckReply = z.infer<typeof LicenceCheckReply>;

export const licenceCheckPath = (tenantId: string, module: string) => `/m-ai/v1/tenants/${seg(tenantId)}/licences/${seg(module)}`;
