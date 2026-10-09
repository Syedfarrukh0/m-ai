import type { ModelUsage } from './model.js';

/** USD per million tokens, as decimal strings ("3", "0.30"). Set from your provider's price list. */
export interface ModelPricing {
  inputPerMTok: string;
  cachedInputPerMTok: string;
  outputPerMTok: string;
}

export interface TurnUsage extends ModelUsage {
  modelCalls: number;
  /** USD, 4 decimal places, rounded up. "0.0000" without pricing. */
  costUsd: string;
  model: string;
  /** What the customer is charged for this turn (with `billing`): amount in `currency`, 2 decimals. */
  charge?: { amount: string; currency: string };
}

const SCALE = 10_000n; // 4 decimal places of a dollar
const PRICE = /^\d{1,6}(?:\.\d{1,4})?$/;

function scaled(price: string): bigint {
  if (!PRICE.test(price)) throw new TypeError(`bad price ${price}`);
  const [whole = '0', fraction = ''] = price.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, '0'));
}

/**
 * The exact cost of one call, in millionths of 1/10000 of a dollar (not yet
 * rounded). Sum these across calls, then format once with formatCost().
 */
export function costUnits(usage: ModelUsage, pricing: ModelPricing | undefined): bigint {
  if (!pricing) return 0n;
  return (
    BigInt(usage.inputTokens) * scaled(pricing.inputPerMTok) +
    BigInt(usage.cachedInputTokens) * scaled(pricing.cachedInputPerMTok) +
    BigInt(usage.outputTokens) * scaled(pricing.outputPerMTok)
  );
}

/** Units from costUnits() → USD with 4 decimal places, rounded UP. */
export function formatCost(units: bigint): string {
  const million = 1_000_000n;
  const rounded = (units + million - 1n) / million;
  return `${rounded / SCALE}.${(rounded % SCALE).toString().padStart(4, '0')}`;
}

/** Exact cost: tokens × price per million, rounded UP to 1/10000 of a dollar. */
export function costUsd(usage: ModelUsage, pricing: ModelPricing | undefined): string {
  return formatCost(costUnits(usage, pricing));
}

/** True when a price string is valid ("3", "0.30", "0"). */
export function isPrice(v: string): boolean {
  return PRICE.test(v);
}

export function emptyUsage(): TurnUsage {
  return { modelCalls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: '0.0000', model: '' };
}

export function addUsage(into: TurnUsage, usage: ModelUsage, model: string): void {
  into.modelCalls += 1;
  into.inputTokens += usage.inputTokens;
  into.cachedInputTokens += usage.cachedInputTokens;
  into.outputTokens += usage.outputTokens;
  into.model = model;
}

// ─────────────────────────────────────────────────────────────────────────────
// What the customer pays: the provider's cost, in their currency, plus a margin
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a turn's provider cost becomes the customer's charge:
 * cost (USD) × `usdRate` × (1 + `margin`), rounded UP to 2 decimals.
 * Give every model a price — your own machine too (power and hardware) —
 * so every reply is charged the same way whichever model answered.
 */
export interface Billing {
  /** e.g. "PKR". */
  currency: string;
  /** Units of `currency` per US dollar, e.g. "276.35". "1" for USD. */
  usdRate: string;
  /** Your share on top of the cost: "0.20" or "20%". Default 0. */
  margin?: string;
}

const RATE = /^\d{1,7}(?:\.\d{1,4})?$/;
const MARGIN = /^(?:\d{1,3}(?:\.\d{1,4})?%|\d(?:\.\d{1,4})?)$/;

/** Problems with a Billing, in plain words; empty when it is fine. */
export function checkBilling(b: Billing): string[] {
  const problems: string[] = [];
  if (!/^[A-Z]{3}$/.test(b.currency)) problems.push(`currency must be a 3-letter code like PKR (got "${b.currency}")`);
  if (!RATE.test(b.usdRate) || /^0+(?:\.0+)?$/.test(b.usdRate)) problems.push(`the USD rate must be a number like 276.35 (got "${b.usdRate}")`);
  if (b.margin !== undefined && !MARGIN.test(b.margin)) problems.push(`the margin must look like 20% or 0.20 (got "${b.margin}")`);
  return problems;
}

/** "20%" → 2000, "0.2" → 2000: the margin in 1/10000. */
function marginScaled(margin: string | undefined): bigint {
  if (!margin) return 0n;
  if (margin.endsWith('%')) return scaledDecimal(margin.slice(0, -1), 4) / 100n;
  return scaledDecimal(margin, 4);
}

/** "276.35" with 4 places → 2763500n. */
function scaledDecimal(v: string, places: number): bigint {
  const [whole = '0', fraction = ''] = v.split('.');
  return BigInt(whole) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, '0').slice(0, places));
}

/**
 * The customer's charge for cost units from costUnits() (summed over a turn's
 * calls): in `billing.currency`, 2 decimals, rounded up. Exact integer arithmetic.
 */
export function chargeFor(units: bigint, billing: Billing): string {
  // units / 1e10 = USD. × rate (×1e4) × (1e4 + margin) (×1e4) × 100 (cents) → divide by 1e18.
  const numerator = units * scaledDecimal(billing.usdRate, 4) * (10_000n + marginScaled(billing.margin)) * 100n;
  const denominator = 10n ** 18n;
  const cents = (numerator + denominator - 1n) / denominator;
  return formatCents(cents);
}

/** "2000" / "1999.5" → cents. Throws on anything else. */
export function toCents(amount: string): bigint {
  const m = /^(-?)(\d{1,12})(?:\.(\d{1,2}))?$/.exec(amount.trim().replace(/,/g, ''));
  if (!m) throw new TypeError(`not an amount: ${amount}`);
  const cents = BigInt(m[2]!) * 100n + BigInt((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -cents : cents;
}

/** cents → "1999.69" (no separators). */
export function formatCents(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/** "1999.69" → "1,999.69". */
export function groupThousands(amount: string): string {
  const [whole = '0', fraction] = amount.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const digits = whole.replace('-', '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${digits}${fraction !== undefined ? `.${fraction}` : ''}`;
}
