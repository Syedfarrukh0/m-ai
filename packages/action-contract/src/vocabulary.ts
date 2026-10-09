/**
 * The words every other file uses. Nothing here depends on an app, a
 * framework, a database, the network or an AI model.
 */

export const CONTRACT_VERSION = '0.1.3' as const;

export type ActionKind = 'query' | 'command';

/**
 * read        — changes nothing.
 * write       — changes records, moves no money and no stock (a customer's phone).
 * financial   — posts to the ledger, the stock ledger or a tax authority.
 * destructive — cancels, reverses, deletes, revokes, or cannot be undone.
 */
export type RiskLevel = 'read' | 'write' | 'financial' | 'destructive';
export const RISK_LEVELS = ['read', 'write', 'financial', 'destructive'] as const satisfies readonly RiskLevel[];

/** Which door the call came through. The channel, not the person. */
export const ACTION_SOURCES = ['web', 'mobile', 'desktop', 'api', 'assistant', 'system'] as const;
export type ActionSource = (typeof ACTION_SOURCES)[number];

/** en — English · ur — Urdu (Nastaliq) · ur-Latn — Roman Urdu. */
export const LOCALES = ['en', 'ur', 'ur-Latn'] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * Every human-readable string an app returns comes in English and Urdu.
 * Roman Urdu is rendered by the assistant from these.
 */
export interface LocalizedText {
  en: string;
  ur: string;
}

/** `sales.invoice.post`, `masters.customer.search` — 2–4 lower-case segments, verb last. */
export const ACTION_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,3}$/;
/** `invoice:create`, `report_financial:view` — `resource:action` permission keys. */
export const PERMISSION_KEY = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/;
/** `CORE`, `INVENTORY`, `ASSISTANT` — licence module codes. */
export const MODULE_CODE = /^[A-Z][A-Z0-9_]*$/;
/** `invoice.posted` — events are named for what happened, past tense. */
export const EVENT_TYPE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,3}$/;
/** `sales`, `receivables`, `export` — short lower-case tags from a controlled vocabulary. */
export const TAG = /^[a-z][a-z0-9-]{0,31}$/;
/** `PERMISSION_DENIED` — codes defined by this contract. */
export const STANDARD_ERROR_CODE = /^[A-Z][A-Z0-9_]*$/;
/** `sales.credit_limit_exceeded` — codes defined by an app module: `<area>.<snake_case>`. */
export const MODULE_ERROR_CODE = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9_]*$/;

/** Pick the message for a locale. Roman Urdu falls back to English. */
export function localize(text: LocalizedText, locale: Locale): string {
  return locale === 'ur' ? text.ur : text.en;
}
