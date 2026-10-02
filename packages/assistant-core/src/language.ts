import type { Locale } from '@m-ai/action-contract';

const URDU_SCRIPT = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g;
const LATIN = /[a-z]/gi;

/** Words that mark Roman Urdu. Strong ones are rarely English. */
const STRONG = new Set([
  'hai', 'hain', 'hy', 'hn', 'kya', 'kia', 'kitni', 'kitna', 'kitne', 'mujhe', 'muje', 'mujhy', 'mjhe', 'karo', 'kro', 'krdo',
  'kardo', 'nahi', 'nhi', 'nahin', 'haan', 'han', 'batao', 'btao', 'bata', 'dikhao', 'bhejo', 'chahiye', 'chahye', 'aaj',
  'kal', 'parson', 'wala', 'wali', 'waly', 'kaun', 'kon', 'kis', 'kisi', 'yaar', 'acha', 'achha', 'theek', 'thik', 'thk',
  'bhai', 'jee', 'abhi', 'pehle', 'phir', 'phr', 'sab', 'saare', 'gaya', 'gya', 'raha', 'rahi', 'rahy', 'banao', 'bana',
  'lagao', 'daalo', 'dalo', 'karna', 'krna', 'tak', 'aur', 'bhi', 'mein', 'mai', 'hum', 'tum', 'aap', 'apna', 'apne',
  'unka', 'uska', 'iska', 'baqi', 'baki', 'wasooli', 'wasoli', 'udhaar', 'udhar', 'dukaan', 'dukan', 'maal', 'bikri',
  'hisaab', 'hisab', 'kitny', 'kese', 'kaise', 'kyun', 'kyu', 'dena', 'dyna', 'lena', 'karain', 'karein', 'krain',
]);
const WEAK = new Set(['or', 'ka', 'ki', 'ke', 'ko', 'se', 'sy', 'me', 'do', 'ho', 'to', 'ye', 'yeh', 'wo', 'woh', 'ji', 'na', 'ne', 'pe', 'par']);
const ENGLISH = new Set([
  'the', 'is', 'are', 'what', 'how', 'my', 'please', 'show', 'today', 'give', 'which', 'who', 'much', 'many', 'with',
  'and', 'for', 'from', 'this', 'that', 'was', 'were', 'have', 'has', 'can', 'could', 'would', 'should', 'send', 'make',
]);

/** Urdu script → 'ur'; Roman Urdu → 'ur-Latn'; otherwise 'en'. */
export function detectLanguage(text: string, fallback: Locale = 'en'): Locale {
  const urdu = (text.match(URDU_SCRIPT) ?? []).length;
  const latin = (text.match(LATIN) ?? []).length;
  if (urdu > 0 && urdu >= latin * 0.5) return 'ur';
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.length === 0) return urdu > 0 ? 'ur' : fallback;
  let ur = 0;
  let en = 0;
  for (const w of words) {
    if (STRONG.has(w)) ur += 2;
    else if (WEAK.has(w)) ur += 1;
    if (ENGLISH.has(w)) en += 2;
  }
  if (ur >= 2 && ur > en) return 'ur-Latn';
  if (en >= 2) return 'en';
  return fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// Yes / no — deterministic, never decided by the model
// ─────────────────────────────────────────────────────────────────────────────

const YES = [
  'haan', 'han', 'haa', 'hn', 'ha', 'ji', 'jee', 'ji haan', 'jee haan', 'g', 'yes', 'y', 'yeah', 'yep', 'yup', 'ok', 'okay',
  'okk', 'theek hai', 'thik hai', 'theek', 'thik', 'thk', 'thk hai', 'sahi', 'sahi hai', 'bilkul', 'kar do', 'kardo', 'kr do',
  'krdo', 'kar dain', 'kar dein', 'kr dain', 'confirm', 'confirmed', 'done', 'go ahead', 'proceed', 'haan kar do', 'ji kar do',
  'ہاں', 'ہاں جی', 'جی', 'جی ہاں', 'ٹھیک ہے', 'کر دو', 'کردو', 'کر دیں', 'بالکل', 'اوکے',
];
const NO = [
  'nahi', 'nhi', 'nahin', 'nai', 'na', 'no', 'n', 'nope', 'cancel', 'mat karo', 'mat kro', 'rehne do', 'rehnay do', 'rhne do',
  'ruk jao', 'ruko', 'stop', 'chhoro', 'chhodo', 'cancel karo', 'cancel kr do', 'nahi karna', 'nhi krna',
  'نہیں', 'نہ', 'مت کرو', 'رہنے دو', 'رکو', 'کینسل',
];

const clean = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[ً-ٟ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const YES_SET = new Set(YES.map(clean));
const NO_SET = new Set(NO.map(clean));
/** Words that may follow a yes without changing it: "haan ji kar do bhai". */
const YES_TAIL = new Set(['kar', 'kr', 'do', 'kardo', 'krdo', 'dain', 'dein', 'den', 'de', 'ji', 'jee', 'bhai', 'please', 'plz', 'pls', 'yaar', 'bilkul', 'hai', 'sahi', 'کر', 'دو', 'دیں', 'جی', 'بھائی', 'ہے']);
/** Words that may follow a no: "nahi rehne do bhai". */
const NO_TAIL = new Set(['bhai', 'yaar', 'ji', 'jee', 'abhi', 'please', 'plz', 'karo', 'kro', 'karna', 'krna', 'rehne', 'rhne', 'do', 'mat', 'کرو', 'بھائی', 'ابھی', 'رہنے', 'دو']);

/**
 * 'yes' only for a short, clear confirmation; 'no' for a clear refusal;
 * 'other' for anything else — including "haan lekin 12 carton karo", which
 * changes the request and must not execute the old preview.
 */
export function parseConfirmation(text: string): 'yes' | 'no' | 'other' {
  const t = clean(text);
  if (!t || /\d/.test(t)) return 'other';
  if (YES_SET.has(t)) return 'yes';
  if (NO_SET.has(t)) return 'no';
  const words = t.split(' ');
  if (words.length > 5) return 'other';
  for (let k = words.length - 1; k >= 1; k--) {
    const head = words.slice(0, k).join(' ');
    const tail = words.slice(k);
    if (YES_SET.has(head) && tail.every((w) => YES_TAIL.has(w))) return 'yes';
    if (NO_SET.has(head) && tail.every((w) => NO_TAIL.has(w))) return 'no';
  }
  return 'other';
}
