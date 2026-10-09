import { z } from 'zod';
import type { ActionPreview, LocalizedText } from '@m-ai/action-contract';

/**
 * Language packs. Everything the assistant says or recognises WITHOUT the
 * model lives here: the fixed sentences, the words for "yes" and "no", and
 * the words that tell languages apart. The model itself understands any
 * language; these packs only cover the parts that must be deterministic.
 *
 * Built in: English, Urdu, Roman Urdu. Add a language by adding a pack (a
 * JSON file validated by LanguagePackSchema) — no code change.
 */

export const PHRASE_KEYS = [
  'confirmQuestion',
  'confirmIntro',
  'warnings',
  'stepUpAhead',
  'stepUpWaiting',
  'stepUpStillWaiting',
  'cancelled',
  'changed',
  'expired',
  'disabled',
  'quota',
  'unavailable',
  'unverified',
  'noAnswer',
  'yesLabel',
  'noLabel',
] as const;
type RequiredPhraseKey = (typeof PHRASE_KEYS)[number];

/** Sentences a pack may leave out: English is used instead. {amount} and {n} are filled in. */
export const OPTIONAL_PHRASES = {
  notSaved: '(Note: nothing has been saved or changed yet.)',
  noBalance: 'Your assistant balance has run out. Please top it up to continue.',
  notLicensed: 'Your company does not have the assistant licence. Please ask your administrator.',
  usageCharge: 'this reply {amount}',
  usageBalance: '{amount} left',
  usageTokens: '{n} tokens',
} as const;
type OptionalPhraseKey = keyof typeof OPTIONAL_PHRASES;
export type PhraseKey = RequiredPhraseKey | OptionalPhraseKey;

export const LanguagePackSchema = z.object({
  /** e.g. 'en', 'ur', 'ur-Latn', 'pa-Latn', 'sd'. */
  code: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
  /** In English, e.g. 'Roman Urdu'. */
  name: z.string().min(1),
  /** Unicode ranges of the script, as a regex character-class body (e.g. "\\u0600-\\u06FF"). Omit for Latin script. */
  script: z.string().min(1).optional(),
  /** Words that clearly mark this language (weight 2). */
  markers: z.array(z.string().min(1)).default([]),
  /** Short words that lean towards it (weight 1). */
  weakMarkers: z.array(z.string().min(1)).default([]),
  /** A clear yes / no, as people type it. */
  yes: z.array(z.string().min(1)).min(1),
  no: z.array(z.string().min(1)).min(1),
  /** Words that may follow a yes or a no without changing it ("haan ji kar do"). */
  yesTail: z.array(z.string().min(1)).default([]),
  noTail: z.array(z.string().min(1)).default([]),
  /** Told to the model: how to reply in this language. */
  replyRule: z.string().min(1),
  /** Which of the app's two texts to show: its English or its Urdu. */
  appText: z.enum(['en', 'ur']).default('en'),
  /**
   * Phrases that say a change WAS made ("order laga diya", "has been posted").
   * A model reply that says so when nothing was executed is corrected, then marked.
   */
  doneClaims: z.array(z.string().min(1)).default([]),
  phrases: z.object({
    ...(Object.fromEntries(PHRASE_KEYS.map((k) => [k, z.string().min(1)])) as Record<RequiredPhraseKey, z.ZodString>),
    // Optional: English is used if missing (see OPTIONAL_PHRASES).
    ...(Object.fromEntries(Object.keys(OPTIONAL_PHRASES).map((k) => [k, z.string().min(1).optional()])) as Record<
      OptionalPhraseKey,
      z.ZodOptional<z.ZodString>
    >),
  }),
});
export type LanguagePack = z.input<typeof LanguagePackSchema>;
type ParsedPack = z.output<typeof LanguagePackSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Built-in packs
// ─────────────────────────────────────────────────────────────────────────────

export const ENGLISH: LanguagePack = {
  code: 'en',
  name: 'English',
  markers: [
    'the', 'is', 'are', 'what', 'how', 'my', 'please', 'show', 'today', 'give', 'which', 'who', 'much', 'many', 'with',
    'and', 'for', 'from', 'this', 'that', 'was', 'were', 'have', 'has', 'can', 'could', 'would', 'should', 'send', 'make',
  ],
  yes: ['yes', 'y', 'yeah', 'yep', 'yup', 'ok', 'okay', 'okk', 'sure', 'confirm', 'confirmed', 'done', 'go ahead', 'proceed', 'do it'],
  no: ['no', 'n', 'nope', 'cancel', 'stop', "don't", 'dont', 'do not'],
  yesTail: ['please', 'plz', 'pls', 'thanks', 'sure'],
  noTail: ['please', 'thanks', 'it'],
  replyRule: 'Reply in English.',
  appText: 'en',
  doneClaims: [
    'has been posted', 'has been placed', 'has been created', 'has been saved', 'has been sent', 'has been updated', 'has been booked',
    'i have posted', "i've posted", 'i have placed', "i've placed", 'i have created', "i've created", 'i have saved', "i've saved",
    'order placed', 'order is placed', 'invoice posted', 'invoice is posted', 'successfully posted', 'successfully placed', 'successfully saved',
  ],
  phrases: {
    confirmQuestion: 'Shall I go ahead? Reply "yes" or "no".',
    confirmIntro: 'This is what will happen:',
    warnings: 'Please note:',
    stepUpAhead: "This amount is above your company's limit for the assistant, so it will also need your approval in the app.",
    stepUpWaiting: 'Please approve it in the app (check the bell), then send me "done".',
    stepUpStillWaiting: 'It is still waiting for your approval in the app. Approve it there, or say "no" to cancel.',
    cancelled: 'Okay, cancelled. Nothing was changed.',
    changed: 'The details changed since you saw them. Here is the new version:',
    expired: 'That confirmation had expired, so I checked again. Here it is:',
    disabled: 'The assistant is switched off for your company. An admin can switch it on in the settings.',
    quota: "The assistant's message limit for this month has been reached. Please ask your admin to add a message pack.",
    unavailable: "I can't reach the system right now. Please try again in a minute.",
    unverified: '(Some figures above could not be checked against the system. Please verify them before relying on them.)',
    noAnswer: "Sorry, I couldn't finish that. Could you say it another way?",
    yesLabel: 'Yes',
    noLabel: 'No',
    ...OPTIONAL_PHRASES,
  },
};

export const URDU: LanguagePack = {
  code: 'ur',
  name: 'Urdu',
  script: '\\u0600-\\u06FF\\u0750-\\u077F\\uFB50-\\uFDFF\\uFE70-\\uFEFF',
  markers: ['ہے', 'ہیں', 'کیا', 'کتنی', 'کتنا', 'آج', 'کل', 'مجھے', 'کرو', 'نہیں', 'ہاں', 'بتاؤ', 'کی', 'کا', 'کے'],
  yes: ['ہاں', 'ہاں جی', 'جی', 'جی ہاں', 'ٹھیک ہے', 'کر دو', 'کردو', 'کر دیں', 'بالکل', 'اوکے'],
  no: ['نہیں', 'نہ', 'مت کرو', 'رہنے دو', 'رکو', 'کینسل'],
  yesTail: ['کر', 'دو', 'دیں', 'جی', 'بھائی', 'ہے'],
  noTail: ['کرو', 'بھائی', 'ابھی', 'رہنے', 'دو'],
  replyRule: 'Reply in Urdu, in Urdu script (Nastaliq). Keep names, codes and numbers exactly as the tools return them.',
  appText: 'ur',
  doneClaims: ['آرڈر لگا دیا', 'آرڈر لگ گیا', 'بل بنا دیا', 'بل بن گیا', 'پوسٹ کر دیا', 'پوسٹ ہو گیا', 'محفوظ کر دیا', 'محفوظ ہو گیا', 'بھیج دیا', 'کامیابی سے'],
  phrases: {
    confirmQuestion: 'کیا میں یہ کر دوں؟ "ہاں" یا "نہیں" لکھیں۔',
    confirmIntro: 'یہ ہو گا:',
    warnings: 'توجہ فرمائیں:',
    stepUpAhead: 'یہ رقم اسسٹنٹ کے لیے کمپنی کی حد سے زیادہ ہے، اس لیے ایپ میں آپ کی منظوری بھی چاہیے ہو گی۔',
    stepUpWaiting: 'براہ کرم ایپ میں (گھنٹی میں) منظوری دیں، پھر مجھے "ہو گیا" لکھیں۔',
    stepUpStillWaiting: 'یہ ابھی ایپ میں آپ کی منظوری کا انتظار کر رہا ہے۔ وہاں منظوری دیں، یا "نہیں" لکھ کر منسوخ کریں۔',
    cancelled: 'ٹھیک ہے، منسوخ کر دیا۔ کچھ تبدیل نہیں ہوا۔',
    changed: 'آپ کے دیکھنے کے بعد تفصیل بدل گئی ہے۔ نئی تفصیل یہ ہے:',
    expired: 'وہ تصدیق پرانی ہو گئی تھی، اس لیے دوبارہ دیکھا۔ یہ رہی:',
    disabled: 'آپ کی کمپنی کے لیے اسسٹنٹ بند ہے۔ ایڈمن سیٹنگز میں اسے آن کر سکتا ہے۔',
    quota: 'اس مہینے کے لیے اسسٹنٹ کے پیغامات کی حد پوری ہو گئی ہے۔ براہ کرم ایڈمن سے پیک لگوائیں۔',
    unavailable: 'ابھی سسٹم سے رابطہ نہیں ہو پا رہا۔ براہ کرم ایک منٹ بعد دوبارہ کوشش کریں۔',
    unverified: '(اوپر کے کچھ اعداد سسٹم سے تصدیق نہیں ہو سکے۔ ان پر بھروسہ کرنے سے پہلے چیک کر لیں۔)',
    noAnswer: 'معذرت، میں یہ مکمل نہیں کر سکا۔ کیا آپ کسی اور طرح بتا سکتے ہیں؟',
    yesLabel: 'ہاں',
    noLabel: 'نہیں',
    notSaved: '(نوٹ: ابھی کچھ بھی محفوظ یا تبدیل نہیں ہوا۔)',
    noBalance: 'آپ کا اسسٹنٹ بیلنس ختم ہو گیا ہے۔ جاری رکھنے کے لیے بیلنس ڈلوائیں۔',
    notLicensed: 'آپ کی کمپنی کے پاس اسسٹنٹ کا لائسنس نہیں ہے۔ اپنے ایڈمن سے بات کریں۔',
    usageCharge: 'اس جواب کے {amount}',
    usageBalance: 'باقی {amount}',
    usageTokens: '{n} ٹوکن',
  },
};

export const ROMAN_URDU: LanguagePack = {
  code: 'ur-Latn',
  name: 'Roman Urdu',
  markers: [
    'hai', 'hain', 'hy', 'hn', 'kya', 'kia', 'kitni', 'kitna', 'kitne', 'mujhe', 'muje', 'mujhy', 'mjhe', 'karo', 'kro', 'krdo',
    'kardo', 'nahi', 'nhi', 'nahin', 'haan', 'han', 'batao', 'btao', 'bata', 'dikhao', 'bhejo', 'chahiye', 'chahye', 'aaj',
    'kal', 'parson', 'wala', 'wali', 'waly', 'kaun', 'kon', 'kis', 'kisi', 'yaar', 'acha', 'achha', 'theek', 'thik', 'thk',
    'bhai', 'jee', 'abhi', 'pehle', 'phir', 'phr', 'sab', 'saare', 'gaya', 'gya', 'raha', 'rahi', 'rahy', 'banao', 'bana',
    'lagao', 'daalo', 'dalo', 'karna', 'krna', 'tak', 'aur', 'bhi', 'mein', 'mai', 'hum', 'tum', 'aap', 'apna', 'apne',
    'unka', 'uska', 'iska', 'baqi', 'baki', 'wasooli', 'wasoli', 'udhaar', 'udhar', 'dukaan', 'dukan', 'maal', 'bikri',
    'hisaab', 'hisab', 'kitny', 'kese', 'kaise', 'kyun', 'kyu', 'dena', 'dyna', 'lena', 'karain', 'karein', 'krain',
    // The everyday postings, said with English names around them ("Metro Cash & Carry se 100 rupay wasool hue").
    'wasool', 'wasul', 'hue', 'hua', 'hui', 'huwa', 'rupay', 'rupaye', 'rupye', 'diya', 'diye', 'dijiye', 'kijiye',
    'banado', 'badal', 'badlo', 'band', 'bhej', 'mila', 'mili', 'mile', 'jama', 'wapas', 'wapis',
  ],
  weakMarkers: ['or', 'ka', 'ki', 'ke', 'ko', 'se', 'sy', 'me', 'do', 'ho', 'to', 'ye', 'yeh', 'wo', 'woh', 'ji', 'na', 'ne', 'pe', 'par'],
  yes: [
    'haan', 'han', 'haa', 'hn', 'ha', 'ji', 'jee', 'ji haan', 'jee haan', 'g', 'theek hai', 'thik hai', 'theek', 'thik', 'thk',
    'thk hai', 'sahi', 'sahi hai', 'bilkul', 'kar do', 'kardo', 'kr do', 'krdo', 'kar dain', 'kar dein', 'kr dain',
    'haan kar do', 'ji kar do', 'ho gaya', 'ho gya',
  ],
  no: [
    'nahi', 'nhi', 'nahin', 'nai', 'na', 'mat karo', 'mat kro', 'rehne do', 'rehnay do', 'rhne do', 'ruk jao', 'ruko',
    'chhoro', 'chhodo', 'cancel karo', 'cancel kr do', 'nahi karna', 'nhi krna',
  ],
  yesTail: ['kar', 'kr', 'do', 'kardo', 'krdo', 'dain', 'dein', 'den', 'de', 'ji', 'jee', 'bhai', 'please', 'plz', 'pls', 'yaar', 'bilkul', 'hai', 'sahi'],
  noTail: ['bhai', 'yaar', 'ji', 'jee', 'abhi', 'please', 'plz', 'karo', 'kro', 'karna', 'krna', 'rehne', 'rhne', 'do', 'mat'],
  replyRule:
    'Reply in Roman Urdu (Urdu written in English letters, the way people type on WhatsApp, e.g. "Aaj ki sale 4,850 hai"). Keep names, codes and numbers exactly as the tools return them.',
  appText: 'en',
  doneClaims: [
    'bill kiya gaya', 'bill kar diya', 'bill kr diya', 'bill ho gaya', 'bill bana diya', 'bill ban gaya',
    'order laga diya', 'order lga diya', 'order lag gaya', 'order ho gaya', 'order place ho gaya', 'order place kar diya',
    'post kar diya', 'post kr diya', 'post ho gaya', 'post ho gayi', 'invoice ban gayi', 'invoice bana di',
    'save kar diya', 'save ho gaya', 'bhej diya', 'bhej di', 'update kar diya', 'update ho gaya', 'kamyabi se',
  ],
  phrases: {
    confirmQuestion: 'Kya main ye kar doon? "haan" ya "nahi" likhein.',
    confirmIntro: 'Ye hoga:',
    warnings: 'Dhyan dein:',
    stepUpAhead: 'Ye raqam assistant ke liye company ki had se zyada hai, is liye app mein aap ki approval bhi chahiye hogi.',
    stepUpWaiting: 'Meherbani karke app mein (bell mein) approve karein, phir mujhe "ho gaya" likhein.',
    stepUpStillWaiting: 'Ye abhi app mein aap ki approval ka intezar kar raha hai. Wahan approve karein, ya "nahi" likh kar cancel karein.',
    cancelled: 'Theek hai, cancel kar diya. Kuch tabdeel nahi hua.',
    changed: 'Aap ke dekhne ke baad tafseel badal gayi hai. Nayi tafseel ye hai:',
    expired: 'Wo confirmation purani ho gayi thi, is liye dobara check kiya. Ye rahi:',
    disabled: 'Aap ki company ke liye assistant band hai. Admin settings mein isay on kar sakta hai.',
    quota: 'Is mahine ke liye assistant ke messages ki had poori ho gayi hai. Meherbani karke admin se message pack lagwayein.',
    unavailable: 'Abhi system se rabta nahi ho pa raha. Meherbani karke ek minute baad dobara koshish karein.',
    unverified: '(Upar ke kuch figures system se tasdeeq nahi ho sake. In par bharosa karne se pehle check kar lein.)',
    noAnswer: 'Maazrat, main ye mukammal nahi kar saka. Kya aap kisi aur tarah bata sakte hain?',
    yesLabel: 'Haan',
    noLabel: 'Nahi',
    notSaved: '(Note: abhi kuch bhi save ya tabdeel nahi hua.)',
    noBalance: 'Aap ka assistant balance khatam ho gaya hai. Jari rakhne ke liye balance dalwayein.',
    notLicensed: 'Aap ki company ke paas assistant ka licence nahi hai. Apne admin se baat karein.',
    usageCharge: 'is jawab ke {amount}',
    usageBalance: 'baqi {amount}',
    usageTokens: '{n} tokens',
  },
};

export const BUILTIN_LANGUAGES: readonly LanguagePack[] = [ENGLISH, URDU, ROMAN_URDU];

// ─────────────────────────────────────────────────────────────────────────────
// The language service
// ─────────────────────────────────────────────────────────────────────────────

export interface Languages {
  readonly codes: readonly string[];
  has(code: string): boolean;
  /** The pack's code for a message, or `fallback` when the message gives no clear signal. */
  detect(text: string, fallback: string): string;
  /** Deterministic: 'yes' / 'no' only for a short, clear answer in any enabled language. */
  parseConfirmation(text: string): 'yes' | 'no' | 'other';
  phrase(key: PhraseKey, code: string): string;
  /** True when a text says a change was made (any enabled language), e.g. "order laga diya", "✅". */
  claimsDone(text: string): boolean;
  /** The app's text (en + ur) in the form this language reads. */
  pick(text: LocalizedText, code: string): string;
  replyRule(code: string): string;
  confirmationMessage(preview: ActionPreview, code: string, opts?: { stepUp?: boolean; lead?: PhraseKey }): string;
}

export const normalizeText = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[ً-ٟ]/g, '')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/'/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export function createLanguages(packs: readonly LanguagePack[] = BUILTIN_LANGUAGES): Languages {
  if (packs.length === 0) throw new Error('at least one language pack is required');
  const parsed: ParsedPack[] = packs.map((p) => LanguagePackSchema.parse(p));
  const byCode = new Map(parsed.map((p) => [p.code, p]));
  if (byCode.size !== parsed.length) throw new Error('language pack codes must be unique');
  const base = byCode.get('en') ?? parsed[0]!;

  const scripts = parsed
    .filter((p) => p.script)
    .map((p) => ({ pack: p, re: new RegExp(`[${p.script}]`, 'gu') }));
  const markerSets = new Map(
    parsed.map((p) => [p.code, { strong: new Set(p.markers.map(normalizeText)), weak: new Set(p.weakMarkers.map(normalizeText)) }]),
  );

  // yes/no from every pack; a word that is "yes" in one and "no" in another counts as neither.
  const yes = new Set(parsed.flatMap((p) => p.yes.map(normalizeText)));
  const no = new Set(parsed.flatMap((p) => p.no.map(normalizeText)));
  for (const w of [...yes]) if (no.has(w)) (yes.delete(w), no.delete(w));
  const yesTail = new Set(parsed.flatMap((p) => p.yesTail.map(normalizeText)));
  const noTail = new Set(parsed.flatMap((p) => p.noTail.map(normalizeText)));

  const packFor = (code: string) => byCode.get(code) ?? byCode.get(code.split('-')[0]!) ?? base;

  function score(code: string, words: string[]): number {
    const m = markerSets.get(code)!;
    let s = 0;
    for (const w of words) s += m.strong.has(w) ? 2 : m.weak.has(w) ? 1 : 0;
    return s;
  }

  function detect(text: string, fallback: string): string {
    const letters = (text.match(/\p{L}/gu) ?? []).length;
    if (letters === 0) return fallback;
    const words = normalizeText(text).split(' ').filter(Boolean);

    // Scripts first: a message mostly in a pack's script belongs to the packs of that script.
    const inScript = scripts.filter((s) => (text.match(s.re) ?? []).length >= letters * 0.5).map((s) => s.pack);
    if (inScript.length === 1) return inScript[0]!.code;
    if (inScript.length > 1) {
      const ranked = inScript.map((p) => ({ code: p.code, s: score(p.code, words) })).sort((a, b) => b.s - a.s);
      return ranked[0]!.s > (ranked[1]?.s ?? 0) ? ranked[0]!.code : inScript[0]!.code;
    }

    // Otherwise by marker words, among the packs without their own script.
    const ranked = parsed
      .filter((p) => !p.script)
      .map((p) => ({ code: p.code, s: score(p.code, words) }))
      .sort((a, b) => b.s - a.s);
    const [best, second] = ranked;
    if (best && best.s >= 2 && best.s > (second?.s ?? 0)) return best.code;
    return fallback;
  }

  function parseConfirmation(text: string): 'yes' | 'no' | 'other' {
    const t = normalizeText(text);
    if (!t || /\d/.test(t)) return 'other';
    if (yes.has(t)) return 'yes';
    if (no.has(t)) return 'no';
    const words = t.split(' ');
    if (words.length > 5) return 'other';
    for (let k = words.length - 1; k >= 1; k--) {
      const head = words.slice(0, k).join(' ');
      const tail = words.slice(k);
      if (yes.has(head) && tail.every((w) => yesTail.has(w))) return 'yes';
      if (no.has(head) && tail.every((w) => noTail.has(w))) return 'no';
    }
    return 'other';
  }

  const phrase = (key: PhraseKey, code: string): string =>
    packFor(code).phrases[key] ?? base.phrases[key] ?? OPTIONAL_PHRASES[key as OptionalPhraseKey];
  const doneClaims = [...new Set(parsed.flatMap((p) => p.doneClaims.map(normalizeText)).filter(Boolean))];
  const claimsDone = (text: string) => {
    if (text.includes('✅') || text.includes('✔')) return true;
    const t = ` ${normalizeText(text)} `;
    return doneClaims.some((c) => t.includes(` ${c} `));
  };
  const pick = (text: LocalizedText, code: string) => (packFor(code).appText === 'ur' ? text.ur : text.en);

  return {
    codes: parsed.map((p) => p.code),
    has: (code) => byCode.has(code),
    detect,
    parseConfirmation,
    phrase,
    claimsDone,
    pick,
    replyRule: (code) =>
      byCode.has(code)
        ? packFor(code).replyRule
        : `Reply in the language the person writes in (${code}). Keep names, codes and numbers exactly as the tools return them.`,
    confirmationMessage(preview, code, opts = {}) {
      const parts: string[] = [phrase(opts.lead ?? 'confirmIntro', code), pick(preview.summary, code)];
      if (preview.warnings.length > 0)
        parts.push(`${phrase('warnings', code)} ${preview.warnings.map((w) => pick(w.message, code)).join(' ')}`);
      if (opts.stepUp) parts.push(phrase('stepUpAhead', code));
      parts.push(phrase('confirmQuestion', code));
      return parts.join('\n');
    },
  };
}

// ── Defaults over the built-in packs ────────────────────────────────────────

const builtin = createLanguages(BUILTIN_LANGUAGES);

/** Built-in detection: 'ur' (Urdu script), 'ur-Latn' (Roman Urdu), 'en'; otherwise `fallback`. */
export const detectLanguage = (text: string, fallback = 'en'): string => builtin.detect(text, fallback);
/** Built-in yes / no / other. */
export const parseConfirmation = (text: string): 'yes' | 'no' | 'other' => builtin.parseConfirmation(text);

/** The built-in sentences, by key then language code. */
export const PHRASES: Readonly<Record<PhraseKey, Record<string, string>>> = Object.fromEntries(
  PHRASE_KEYS.map((k) => [k, Object.fromEntries(BUILTIN_LANGUAGES.map((p) => [p.code, p.phrases[k]]))]),
) as Record<PhraseKey, Record<string, string>>;
