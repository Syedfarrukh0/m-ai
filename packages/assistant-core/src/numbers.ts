/**
 * The numbers guard. M.Ai never calculates: every figure in a reply must
 * appear in something the app returned (or the person said). This finds the
 * figures in a reply that don't.
 */

const EASTERN_DIGITS: Record<string, string> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

export function westernDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (d) => EASTERN_DIGITS[d] ?? d).replace(/[٫]/g, '.').replace(/[٬]/g, ',');
}

/** "5,310.00" → "5310"; "0.50" → "0.5"; "007" → "7". */
export function normalizeNumber(raw: string): string {
  let s = westernDigits(raw).replace(/,/g, '');
  if (s.startsWith('-')) s = s.slice(1);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  s = s.replace(/^0+(?=\d)/, '');
  return s === '' ? '0' : s;
}

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

/** Every number in a text, normalized. Digit runs inside codes (INV-0003) count too. */
export function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of westernDigits(text).matchAll(NUMBER)) {
    const raw = m[0].replace(/,+$/, '');
    out.add(normalizeNumber(raw));
    // "2026-10-02" also offers 2026, 10, 2 — dates are quoted in parts.
    for (const part of raw.split(/[.,]/)) if (part) out.add(normalizeNumber(part));
  }
  return out;
}

/** Every number anywhere in a JSON value (numbers, and digits inside strings). */
export function numbersInValue(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === 'number' && Number.isFinite(value)) into.add(normalizeNumber(String(value)));
  else if (typeof value === 'string') for (const n of numbersIn(value)) into.add(n);
  else if (Array.isArray(value)) for (const v of value) numbersInValue(v, into);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) numbersInValue(v, into);
  return into;
}

/** Numbers that are always fine: list markers and tiny counts like "one of them". */
const ALWAYS_FINE = new Set(['0', '1']);

/**
 * The figures in `reply` that appear in none of `sources`. A numbered-list
 * marker at the start of a line ("1. ", "2) ") is ignored.
 */
export function unverifiedNumbers(reply: string, sources: Iterable<string>): string[] {
  const known = new Set<string>(ALWAYS_FINE);
  for (const s of sources) for (const n of numbersIn(s)) known.add(n);
  const withoutMarkers = westernDigits(reply).replace(/^\s*\d{1,2}[.)]\s+/gm, '');
  const bad: string[] = [];
  for (const m of withoutMarkers.matchAll(NUMBER)) {
    const raw = m[0].replace(/,+$/, '');
    const n = normalizeNumber(raw);
    if (!known.has(n) && !bad.includes(raw)) bad.push(raw);
  }
  return bad;
}
