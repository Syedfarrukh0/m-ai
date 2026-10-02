import type { ActionPreview, Locale, LocalizedText } from '@m-ai/action-contract';

/**
 * Fixed sentences the assistant says itself, without the model: asking for
 * confirmation, cancelling, waiting for approval, refusals. Deterministic, so
 * the confirmation a person sees is exactly what will be executed.
 */
type Phrase = Record<Locale, string>;

const P = {
  confirmQuestion: {
    en: 'Shall I go ahead? Reply "yes" or "no".',
    ur: 'کیا میں یہ کر دوں؟ "ہاں" یا "نہیں" لکھیں۔',
    'ur-Latn': 'Kya main ye kar doon? "haan" ya "nahi" likhein.',
  },
  confirmIntro: {
    en: 'This is what will happen:',
    ur: 'یہ ہو گا:',
    'ur-Latn': 'Ye hoga:',
  },
  warnings: {
    en: 'Please note:',
    ur: 'توجہ فرمائیں:',
    'ur-Latn': 'Dhyan dein:',
  },
  stepUpAhead: {
    en: 'This amount is above your company\'s limit for the assistant, so it will also need your approval in the app.',
    ur: 'یہ رقم اسسٹنٹ کے لیے کمپنی کی حد سے زیادہ ہے، اس لیے ایپ میں آپ کی منظوری بھی چاہیے ہو گی۔',
    'ur-Latn': 'Ye raqam assistant ke liye company ki had se zyada hai, is liye app mein aap ki approval bhi chahiye hogi.',
  },
  stepUpWaiting: {
    en: 'Please approve it in the app (check the bell), then send me "done".',
    ur: 'براہ کرم ایپ میں (گھنٹی میں) منظوری دیں، پھر مجھے "ہو گیا" لکھیں۔',
    'ur-Latn': 'Meherbani karke app mein (bell mein) approve karein, phir mujhe "ho gaya" likhein.',
  },
  stepUpStillWaiting: {
    en: 'It is still waiting for your approval in the app. Approve it there, or say "no" to cancel.',
    ur: 'یہ ابھی ایپ میں آپ کی منظوری کا انتظار کر رہا ہے۔ وہاں منظوری دیں، یا "نہیں" لکھ کر منسوخ کریں۔',
    'ur-Latn': 'Ye abhi app mein aap ki approval ka intezar kar raha hai. Wahan approve karein, ya "nahi" likh kar cancel karein.',
  },
  cancelled: {
    en: 'Okay, cancelled. Nothing was changed.',
    ur: 'ٹھیک ہے، منسوخ کر دیا۔ کچھ تبدیل نہیں ہوا۔',
    'ur-Latn': 'Theek hai, cancel kar diya. Kuch tabdeel nahi hua.',
  },
  changed: {
    en: 'The details changed since you saw them. Here is the new version:',
    ur: 'آپ کے دیکھنے کے بعد تفصیل بدل گئی ہے۔ نئی تفصیل یہ ہے:',
    'ur-Latn': 'Aap ke dekhne ke baad tafseel badal gayi hai. Nayi tafseel ye hai:',
  },
  expired: {
    en: 'That confirmation had expired, so I checked again. Here it is:',
    ur: 'وہ تصدیق پرانی ہو گئی تھی، اس لیے دوبارہ دیکھا۔ یہ رہی:',
    'ur-Latn': 'Wo confirmation purani ho gayi thi, is liye dobara check kiya. Ye rahi:',
  },
  disabled: {
    en: 'The assistant is switched off for your company. An admin can switch it on in the settings.',
    ur: 'آپ کی کمپنی کے لیے اسسٹنٹ بند ہے۔ ایڈمن سیٹنگز میں اسے آن کر سکتا ہے۔',
    'ur-Latn': 'Aap ki company ke liye assistant band hai. Admin settings mein isay on kar sakta hai.',
  },
  quota: {
    en: "The assistant's message limit for this month has been reached. Please ask your admin to add a message pack.",
    ur: 'اس مہینے کے لیے اسسٹنٹ کے پیغامات کی حد پوری ہو گئی ہے۔ براہ کرم ایڈمن سے پیک لگوائیں۔',
    'ur-Latn': 'Is mahine ke liye assistant ke messages ki had poori ho gayi hai. Meherbani karke admin se message pack lagwayein.',
  },
  unavailable: {
    en: "I can't reach the system right now. Please try again in a minute.",
    ur: 'ابھی سسٹم سے رابطہ نہیں ہو پا رہا۔ براہ کرم ایک منٹ بعد دوبارہ کوشش کریں۔',
    'ur-Latn': 'Abhi system se rabta nahi ho pa raha. Meherbani karke ek minute baad dobara koshish karein.',
  },
  unverified: {
    en: '(Some figures above could not be checked against the system. Please verify them before relying on them.)',
    ur: '(اوپر کے کچھ اعداد سسٹم سے تصدیق نہیں ہو سکے۔ ان پر بھروسہ کرنے سے پہلے چیک کر لیں۔)',
    'ur-Latn': '(Upar ke kuch figures system se tasdeeq nahi ho sake. In par bharosa karne se pehle check kar lein.)',
  },
  noAnswer: {
    en: "Sorry, I couldn't finish that. Could you say it another way?",
    ur: 'معذرت، میں یہ مکمل نہیں کر سکا۔ کیا آپ کسی اور طرح بتا سکتے ہیں؟',
    'ur-Latn': 'Maazrat, main ye mukammal nahi kar saka. Kya aap kisi aur tarah bata sakte hain?',
  },
} satisfies Record<string, Phrase>;

export type PhraseKey = keyof typeof P;
export const PHRASES: Readonly<Record<PhraseKey, Phrase>> = P;

export function phrase(key: PhraseKey, locale: Locale): string {
  return P[key][locale];
}

/** App text comes in en + ur; Roman Urdu readers get the English (names and numbers read the same). */
export function pick(text: LocalizedText, locale: Locale): string {
  return locale === 'ur' ? text.ur : text.en;
}

/** The deterministic confirmation message for a preview. */
export function confirmationMessage(
  preview: ActionPreview,
  locale: Locale,
  opts: { stepUp?: boolean; lead?: PhraseKey } = {},
): string {
  const parts: string[] = [];
  parts.push(phrase(opts.lead ?? 'confirmIntro', locale));
  parts.push(pick(preview.summary, locale));
  if (preview.warnings.length > 0) {
    parts.push(`${phrase('warnings', locale)} ${preview.warnings.map((w) => pick(w.message, locale)).join(' ')}`);
  }
  if (opts.stepUp) parts.push(phrase('stepUpAhead', locale));
  parts.push(phrase('confirmQuestion', locale));
  return parts.join('\n');
}
