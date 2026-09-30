import { z } from 'zod';
import { MODULE_CODE } from './vocabulary.js';

// ─────────────────────────────────────────────────────────────────────────────
// Money
// ─────────────────────────────────────────────────────────────────────────────

const MONEY_PATTERN = /^-?\d{1,15}(?:\.\d{1,4})?$/;

/**
 * Money on the wire is a decimal STRING, never a JSON number. Up to 4 decimal
 * places. Apps convert it to their own money type inside the handler; nothing
 * outside the app does arithmetic on it, and the assistant never adds numbers.
 */
export const MoneyString = z
  .string()
  .regex(MONEY_PATTERN, 'a decimal amount such as "1250" or "1250.50"')
  .describe('Money as a decimal string, up to 4 decimal places. Never a number.');
export type MoneyString = z.infer<typeof MoneyString>;

const MONEY_SCALE = 4;

/** Exact integer representation of a MoneyString, scaled by 10^4. */
export function moneyToScaled(value: string): bigint {
  if (!MONEY_PATTERN.test(value)) throw new TypeError(`not a MoneyString: ${JSON.stringify(value)}`);
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const scaled = BigInt(whole) * 10n ** BigInt(MONEY_SCALE) + BigInt(fraction.padEnd(MONEY_SCALE, '0'));
  return negative ? -scaled : scaled;
}

/** -1, 0 or 1. Exact — no floating point. */
export function compareMoney(a: string, b: string): -1 | 0 | 1 {
  const x = moneyToScaled(a);
  const y = moneyToScaled(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** |a| > |b|, exactly. */
export function moneyAbsGreaterThan(a: string, b: string): boolean {
  const x = moneyToScaled(a);
  const y = moneyToScaled(b);
  return (x < 0n ? -x : x) > (y < 0n ? -y : y);
}

// ─────────────────────────────────────────────────────────────────────────────
// Dates, ids, text
// ─────────────────────────────────────────────────────────────────────────────

export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('A calendar date, YYYY-MM-DD.');
export const IsoDateTime = z.iso.datetime({ offset: true }).describe('An ISO 8601 timestamp.');
export const Uuid = z.uuid();
export const ModuleCode = z.string().regex(MODULE_CODE);

export const LocalizedTextSchema = z.object({
  en: z.string().min(1),
  ur: z.string().min(1),
});

// ─────────────────────────────────────────────────────────────────────────────
// Paging and totals
// ─────────────────────────────────────────────────────────────────────────────

/** Every list-returning query takes these; `limit` is capped per action (`paging.maxLimit`). */
export const PageInput = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().max(200).optional(),
});
export type PageInput = z.infer<typeof PageInput>;

/** A page of items. */
export const page = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    /** True when there were more rows than the limit allowed. */
    truncated: z.boolean(),
  });

/**
 * A page of items plus named money totals computed by the app over the WHOLE
 * filter, not just this page — so the assistant never has to add numbers.
 */
export const pageWithTotals = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    truncated: z.boolean(),
    totals: z.record(z.string(), MoneyString),
    /** Number of rows matching the filter, across all pages. */
    count: z.number().int().min(0),
  });
