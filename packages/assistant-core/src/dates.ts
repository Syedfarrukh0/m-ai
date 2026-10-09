/**
 * Date ranges worked out in code, so the model never does date arithmetic.
 * Small models get "this month" or "last week" wrong surprisingly often; with
 * the ranges written out they only have to copy them.
 */

const DAY = 86_400_000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parse(iso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new TypeError(`not a YYYY-MM-DD date: ${iso}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
const monthStart = (y: number, m: number) => new Date(Date.UTC(y, m, 1));

export interface DateRange {
  /** "today", "last month"… */
  name: string;
  from: string;
  to: string;
}

/**
 * The usual ranges around `today` (weeks start on Monday). `fiscalYearStart`
 * (YYYY-MM-DD) adds "this fiscal year".
 */
export function dateRanges(today: string, fiscalYearStart?: string): DateRange[] {
  const t = parse(today);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  const weekStart = addDays(t, -((t.getUTCDay() + 6) % 7));
  const ranges: DateRange[] = [
    { name: 'today', from: fmt(t), to: fmt(t) },
    { name: 'yesterday', from: fmt(addDays(t, -1)), to: fmt(addDays(t, -1)) },
    { name: 'this week', from: fmt(weekStart), to: fmt(t) },
    { name: 'last week', from: fmt(addDays(weekStart, -7)), to: fmt(addDays(weekStart, -1)) },
    { name: 'last 7 days', from: fmt(addDays(t, -6)), to: fmt(t) },
    { name: 'this month', from: fmt(monthStart(y, m)), to: fmt(t) },
    { name: 'last month', from: fmt(monthStart(y, m - 1)), to: fmt(addDays(monthStart(y, m), -1)) },
    { name: 'last 30 days', from: fmt(addDays(t, -29)), to: fmt(t) },
    { name: 'this year', from: `${y}-01-01`, to: fmt(t) },
    { name: 'last year', from: `${y - 1}-01-01`, to: `${y - 1}-12-31` },
  ];
  if (fiscalYearStart && /^\d{4}-\d{2}-\d{2}$/.test(fiscalYearStart) && fiscalYearStart <= fmt(t))
    ranges.push({ name: 'this fiscal year', from: fiscalYearStart, to: fmt(t) });
  return ranges;
}

/** "Friday" for a YYYY-MM-DD date. */
export function weekday(iso: string): string {
  return WEEKDAYS[parse(iso).getUTCDay()]!;
}

/** Every YYYY-MM-DD string in a value (e.g. a tool call's from/to), so a reply may state the dates it used. */
export function isoDatesIn(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) into.push(value.slice(0, 10));
  } else if (Array.isArray(value)) for (const v of value) isoDatesIn(v, into);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) isoDatesIn(v, into);
  return into;
}
