import type { Locale, LocalizedText } from './vocabulary.js';
import { MODULE_ERROR_CODE, STANDARD_ERROR_CODE, localize } from './vocabulary.js';

export interface StandardErrorSpec {
  /** For developers: when this code is returned. */
  description: string;
  /** For people: what the app shows or the assistant says. */
  messages: LocalizedText;
  /** HTTP status on the `/actions/*` transport. */
  http: number;
  /** True when the same call may simply be sent again later (after a pause). */
  retryable: boolean;
}

/** Codes every action can return. Module codes are `<area>.<snake_case>`. */
export const STANDARD_ERRORS = {
  UNKNOWN_ACTION: {
    description: 'No action by that name.',
    messages: { en: 'That action does not exist.', ur: 'اس نام کا کوئی عمل موجود نہیں۔' },
    http: 404,
    retryable: false,
  },
  VERSION_NOT_SUPPORTED: {
    description: 'That version of the action is not available.',
    messages: { en: 'That version of the action is not available.', ur: 'اس عمل کا یہ ورژن دستیاب نہیں۔' },
    http: 404,
    retryable: false,
  },
  VALIDATION_FAILED: {
    description: "The input does not match the action's schema. `details.issues` lists the problems.",
    messages: { en: 'Some of the details are not valid.', ur: 'دی گئی کچھ معلومات درست نہیں۔' },
    http: 400,
    retryable: false,
  },
  PERMISSION_DENIED: {
    description: 'The user lacks a permission the action requires, or the token scope does not cover the action.',
    messages: { en: 'You do not have permission to do this.', ur: 'آپ کو اس کام کی اجازت نہیں ہے۔' },
    http: 403,
    retryable: false,
  },
  MODULE_NOT_LICENSED: {
    description: 'The company has not licensed the module the action belongs to.',
    messages: { en: 'Your company has not licensed this module.', ur: 'آپ کی کمپنی نے یہ ماڈیول نہیں لیا ہوا۔' },
    http: 403,
    retryable: false,
  },
  LICENCE_READ_ONLY: {
    description: 'The licence has lapsed: reading still works, changing does not.',
    messages: {
      en: 'The licence has expired. You can view but not change anything.',
      ur: 'لائسنس کی مدت ختم ہو چکی ہے۔ آپ دیکھ سکتے ہیں مگر کوئی تبدیلی نہیں کر سکتے۔',
    },
    http: 403,
    retryable: false,
  },
  NOT_FOUND: {
    description: 'The record does not exist for this company.',
    messages: { en: 'The record was not found.', ur: 'ریکارڈ نہیں ملا۔' },
    http: 404,
    retryable: false,
  },
  CONFLICT: {
    description: 'The record changed or already exists.',
    messages: { en: 'The record has changed or already exists.', ur: 'ریکارڈ تبدیل ہو چکا ہے یا پہلے سے موجود ہے۔' },
    http: 409,
    retryable: false,
  },
  CONFIRMATION_REQUIRED: {
    description:
      'Preview first, then execute with the confirmation from the preview. Also returned for a confirmation that is malformed or bound to another user, action or input (`details.reason: "invalid"`).',
    messages: { en: 'Please review the details and confirm first.', ur: 'پہلے تفصیل دیکھ کر تصدیق کریں۔' },
    http: 428,
    retryable: false,
  },
  CONFIRMATION_USED: {
    description: 'The confirmation was already consumed by an execute with a different idempotency key.',
    messages: { en: 'This confirmation has already been used.', ur: 'یہ تصدیق پہلے ہی استعمال ہو چکی ہے۔' },
    http: 409,
    retryable: false,
  },
  PREVIEW_STALE: {
    description: 'The data changed since the preview. `details` carries the new PreviewResult.',
    messages: {
      en: 'The details changed after you reviewed them. Please review again.',
      ur: 'آپ کے دیکھنے کے بعد تفصیلات بدل گئی ہیں۔ براہ کرم دوبارہ دیکھ لیں۔',
    },
    http: 409,
    retryable: false,
  },
  PREVIEW_EXPIRED: {
    description: 'The confirmation is older than its expiry. Preview again.',
    messages: {
      en: 'The confirmation has expired. Please review again.',
      ur: 'تصدیق کا وقت ختم ہو گیا ہے۔ براہ کرم دوبارہ دیکھ لیں۔',
    },
    http: 409,
    retryable: false,
  },
  PREVIEW_NOT_SUPPORTED: {
    description: 'Queries, and commands without a preview, cannot be previewed.',
    messages: { en: 'This action has no preview.', ur: 'اس عمل کا پیشگی جائزہ دستیاب نہیں۔' },
    http: 400,
    retryable: false,
  },
  IDEMPOTENCY_KEY_REQUIRED: {
    description: 'Commands from this source must carry an Idempotency-Key.',
    messages: { en: 'A request key is required.', ur: 'درخواست کی کلید ضروری ہے۔' },
    http: 400,
    retryable: false,
  },
  IDEMPOTENCY_KEY_REUSED: {
    description: 'That idempotency key was already used with a different action or input.',
    messages: {
      en: 'This request key was already used with different details.',
      ur: 'یہ درخواست کی کلید مختلف تفصیلات کے ساتھ پہلے استعمال ہو چکی ہے۔',
    },
    http: 409,
    retryable: false,
  },
  IDEMPOTENCY_IN_PROGRESS: {
    description: 'The first call with that key is still running.',
    messages: { en: 'The same request is still being processed.', ur: 'یہی درخواست ابھی جاری ہے۔' },
    http: 409,
    retryable: true,
  },
  ASSISTANT_POLICY_DENIED: {
    description:
      "The company's assistant policy refuses this call. `details.reason`: disabled | not_supported | destructive_not_allowed | module_not_allowed | step_up_declined.",
    messages: {
      en: "Your company's settings do not allow the assistant to do this.",
      ur: 'آپ کی کمپنی کی ترتیبات کے مطابق اسسٹنٹ یہ کام نہیں کر سکتا۔',
    },
    http: 403,
    retryable: false,
  },
  ASSISTANT_QUOTA_EXCEEDED: {
    description: "The company's assistant message allowance, packs and grace are used up.",
    messages: {
      en: "The assistant's message limit has been reached. Please contact your admin.",
      ur: 'اسسٹنٹ کے پیغامات کی حد پوری ہو چکی ہے۔ براہ کرم اپنے ایڈمن سے رابطہ کریں۔',
    },
    http: 402,
    retryable: false,
  },
  STEP_UP_REQUIRED: {
    description:
      'The amount is above the company\'s limit for the assistant. The user must approve in the app. `details`: { stepUpId, expiresAt }.',
    messages: {
      en: 'This needs your approval in the app.',
      ur: 'اس کام کے لیے ایپ میں آپ کی منظوری ضروری ہے۔',
    },
    http: 428,
    retryable: false,
  },
  RATE_LIMITED: {
    description: 'Too many calls; retry later.',
    messages: {
      en: 'Too many requests. Please try again shortly.',
      ur: 'بہت زیادہ درخواستیں۔ تھوڑی دیر بعد دوبارہ کوشش کریں۔',
    },
    http: 429,
    retryable: true,
  },
  INTERNAL: {
    description: 'Something failed inside the app. The request id finds it in the logs.',
    messages: { en: 'Something went wrong. Please try again.', ur: 'کچھ خرابی ہو گئی۔ براہ کرم دوبارہ کوشش کریں۔' },
    http: 500,
    retryable: false,
  },
} as const satisfies Record<string, StandardErrorSpec>;

export type StandardErrorCode = keyof typeof STANDARD_ERRORS;

/** HTTP status for module (app-specific) error codes registered without one. */
export const MODULE_ERROR_HTTP = 422;

/**
 * A module error code's entry in the app's error catalogue. `http` defaults to
 * 422 ("your input is not acceptable"); use 409, 423 or 503 for conflicts,
 * locks and "busy, try again" — and say so with `retryable`.
 */
export interface ModuleErrorSpec extends LocalizedText {
  /** 400–599. Default 422. */
  http?: number;
  /** True when the same call may simply be sent again later. Default false. */
  retryable?: boolean;
}

export interface ActionError {
  code: string;
  /** In the caller's locale (Roman Urdu falls back to English). */
  message: string;
  messages: LocalizedText;
  details?: unknown;
  /** HTTP status on the `/actions/*` transport. Set by the registry. */
  http?: number;
  /** True when the same call may simply be sent again later. Set by the registry. */
  retryable?: boolean;
}

export function isStandardErrorCode(code: string): code is StandardErrorCode {
  return Object.prototype.hasOwnProperty.call(STANDARD_ERRORS, code);
}

export function isValidErrorCode(code: string): boolean {
  return (STANDARD_ERROR_CODE.test(code) && isStandardErrorCode(code)) || MODULE_ERROR_CODE.test(code);
}

/** Status of a code without a registry at hand: standard codes, else 422. Prefer `error.http`. */
export function httpStatusFor(code: string): number {
  return isStandardErrorCode(code) ? STANDARD_ERRORS[code].http : MODULE_ERROR_HTTP;
}

/**
 * Thrown by `ctx.fail()` inside a handler, and usable by a host's error
 * mapping. The registry turns it into an `ActionError` and rolls back.
 */
export class ActionFailure extends Error {
  readonly code: string;
  readonly messages: LocalizedText;
  readonly details: unknown;

  constructor(code: string, messages: LocalizedText, details?: unknown) {
    if (!isValidErrorCode(code)) {
      throw new TypeError(
        `invalid error code "${code}": use a STANDARD_ERRORS code or a module code like "sales.credit_limit_exceeded"`,
      );
    }
    super(messages.en);
    this.name = 'ActionFailure';
    this.code = code;
    this.messages = messages;
    this.details = details;
  }

  toActionError(locale: Locale): ActionError {
    return makeError(this.code, this.messages, locale, this.details);
  }
}

export function isActionFailure(e: unknown): e is ActionFailure {
  return e instanceof ActionFailure;
}

/** Build an ActionError for a standard code, with its standard messages, status and retryability. */
export function standardError(code: StandardErrorCode, locale: Locale, details?: unknown): ActionError {
  const spec = STANDARD_ERRORS[code];
  return { ...makeError(code, spec.messages, locale, details), http: spec.http, retryable: spec.retryable };
}

export function makeError(code: string, messages: LocalizedText, locale: Locale, details?: unknown): ActionError {
  const error: ActionError = { code, message: localize(messages, locale), messages };
  if (details !== undefined) error.details = details;
  return error;
}
