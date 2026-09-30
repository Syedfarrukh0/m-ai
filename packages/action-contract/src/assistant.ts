import { z } from 'zod';
import type { ActionContext } from './context.js';
import type { AnyAction } from './definition.js';
import { IsoDate, IsoDateTime, ModuleCode, MoneyString, moneyAbsGreaterThan } from './schemas.js';
import { LOCALES } from './vocabulary.js';

// ─────────────────────────────────────────────────────────────────────────────
// Well-known actions — names the assistant relies on. The app defines them.
// ─────────────────────────────────────────────────────────────────────────────

export const WELL_KNOWN_ACTIONS = {
  /** query · who, which company, timezone, today, fiscal year, quota. Output: CoreContextOutput. */
  contextGet: 'core.context.get',
  /** query · the company's assistant settings. Output: AssistantSettings. */
  settingsGet: 'assistant.settings.get',
  /** command · change the settings (company admins). */
  settingsUpdate: 'assistant.settings.update',
  /** command · accept the current AI data-processing terms (company admins). */
  consentAccept: 'assistant.consent.accept',
  /** command · the assistant reports model usage per turn. Input: AssistantUsageRecordInput. */
  usageRecord: 'assistant.usage.record',
  /** command · send a message on a channel (only to the caller's own conversation for alert tokens). */
  messagingSend: 'messaging.send',
  /** command · render a document (invoice, ledger statement, receipt) to PDF; returns a file id. */
  documentsRender: 'documents.render',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Settings, policy and consent — stored by the app, read by the assistant
// ─────────────────────────────────────────────────────────────────────────────

/**
 * v0.1.0 knows 'none' and 'app'. Unknown values (e.g. 'pin', added later) are
 * read as 'app', the strictest one.
 */
export const StepUpMode = z.enum(['none', 'app']).catch('app');
export type StepUpMode = z.infer<typeof StepUpMode>;

export const AssistantPolicy = z.object({
  /** Cancel, reverse, delete through the assistant. Off by default. */
  allowDestructive: z.boolean().default(false),
  /** Financial actions whose primaryAmount is above this (in absolute value) need step-up. Unset = never. */
  financialLimit: MoneyString.optional(),
  stepUp: StepUpMode.default('app'),
  /** Unset = every licensed module. The host's always-allowed modules (e.g. CORE) are added implicitly. */
  allowedModules: z.array(ModuleCode).optional(),
});
export type AssistantPolicy = z.infer<typeof AssistantPolicy>;

export const AssistantConsent = z.object({
  termsVersion: z.string().min(1),
  acceptedAt: IsoDateTime,
  /** User id of the company admin who accepted. */
  acceptedBy: z.string().min(1),
});
export type AssistantConsent = z.infer<typeof AssistantConsent>;

/** Per-company assistant settings. `enabled` may be true only with consent to the current terms. */
export const AssistantSettings = z.object({
  enabled: z.boolean().default(false),
  name: z.string().trim().min(1).max(40).default('Assistant'),
  language: z.enum(['auto', ...LOCALES]).default('auto'),
  tone: z.enum(['formal', 'friendly', 'brief']).default('friendly'),
  greeting: z.string().trim().max(280).optional(),
  policy: AssistantPolicy.prefault({}),
  consent: AssistantConsent.optional(),
});
export type AssistantSettings = z.infer<typeof AssistantSettings>;

// ─────────────────────────────────────────────────────────────────────────────
// Quota and usage
// ─────────────────────────────────────────────────────────────────────────────

export const QuotaState = z.enum(['ok', 'warning', 'grace', 'exhausted']);
export type QuotaState = z.infer<typeof QuotaState>;

export const AssistantQuota = z.object({
  /** Monthly allowance included in the plan. */
  included: z.number().int().min(0),
  /** Messages used this month (tenant timezone). */
  used: z.number().int().min(0),
  packsRemaining: z.number().int().min(0),
  state: QuotaState,
});
export type AssistantQuota = z.infer<typeof AssistantQuota>;

/**
 * Input of `assistant.usage.record`: one call per assistant turn or alert,
 * idempotent on `turnId`. 1 message = one reply to a user's turn (however many
 * chat bubbles) or one proactive alert.
 */
export const AssistantUsageRecordInput = z.object({
  turnId: z.string().min(1).max(100),
  kind: z.enum(['reply', 'alert']),
  conversationId: z.string().max(100).optional(),
  model: z.string().min(1).max(100),
  inputTokens: z.number().int().min(0),
  cachedInputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  /** Speech-to-text seconds, when the turn had a voice note. */
  audioSeconds: z.number().min(0).optional(),
  /** Model providers bill in USD; the platform converts for reporting. */
  costUsd: MoneyString,
  occurredAt: IsoDateTime,
});
export type AssistantUsageRecordInput = z.infer<typeof AssistantUsageRecordInput>;

// ─────────────────────────────────────────────────────────────────────────────
// Well-known shapes
// ─────────────────────────────────────────────────────────────────────────────

/** Output of `core.context.get`. The assistant resolves "today", "this month", "this year" from it. */
export const CoreContextOutput = z.object({
  user: z.object({
    id: z.string(),
    displayName: z.string(),
    /** Display names of the user's roles. */
    roles: z.array(z.string()),
    locale: z.enum(LOCALES),
  }),
  company: z.object({
    id: z.string(),
    name: z.string(),
    /** IANA timezone, e.g. 'Asia/Karachi'. */
    timezone: z.string(),
    /** ISO 4217, e.g. 'PKR'. */
    currency: z.string().length(3),
    fiscalYear: z.object({ start: IsoDate, end: IsoDate }),
  }),
  /** Today's date in the company's timezone. */
  today: IsoDate,
  licensedModules: z.array(ModuleCode),
  assistant: z
    .object({
      settings: AssistantSettings,
      quota: AssistantQuota,
    })
    .optional(),
});
export type CoreContextOutput = z.infer<typeof CoreContextOutput>;

/** Input of every `*.search` action. */
export const SearchInput = z.object({
  query: z.string().trim().min(1).max(100),
  limit: z.number().int().min(1).max(50).optional(),
});
export type SearchInput = z.infer<typeof SearchInput>;

/** One hit of a `*.search` action. The assistant asks the user when top scores are close. */
export const SearchItem = z.object({
  id: z.string(),
  display: z.string(),
  /** What tells two similar names apart: area, phone, code, pack size… */
  disambiguation: z.record(z.string(), z.string()),
  /** 0–1, higher is better. */
  score: z.number().min(0).max(1),
  matchedOn: z.enum(['name', 'code', 'phone', 'other']),
});
export type SearchItem = z.infer<typeof SearchItem>;

export const SearchOutput = z.object({ items: z.array(SearchItem) });
export type SearchOutput = z.infer<typeof SearchOutput>;

// ─────────────────────────────────────────────────────────────────────────────
// Policy evaluation — used by the registry for source 'assistant'
// ─────────────────────────────────────────────────────────────────────────────

export type PolicyDenial = 'disabled' | 'not_supported' | 'destructive_not_allowed' | 'module_not_allowed';

/**
 * Whether the policy lets the assistant call this action at all. The policy
 * only ever narrows the user's own permissions; it never widens them.
 */
export function policyAllows(
  settings: AssistantSettings,
  def: Pick<AnyAction, 'risk' | 'module'>,
  alwaysAllowedModules: readonly string[],
): { ok: true } | { ok: false; reason: PolicyDenial } {
  if (!settings.enabled) return { ok: false, reason: 'disabled' };
  if (def.risk === 'destructive' && !settings.policy.allowDestructive)
    return { ok: false, reason: 'destructive_not_allowed' };
  const allowed = settings.policy.allowedModules;
  if (allowed !== undefined && !allowed.includes(def.module) && !alwaysAllowedModules.includes(def.module))
    return { ok: false, reason: 'module_not_allowed' };
  return { ok: true };
}

/** Whether a financial action with this primary amount needs the user's approval in the app. */
export function stepUpRequired(
  settings: AssistantSettings,
  def: Pick<AnyAction, 'risk'>,
  primaryAmount: string | undefined,
  ctx: Pick<ActionContext, 'source'>,
): boolean {
  if (ctx.source !== 'assistant' || def.risk !== 'financial') return false;
  const { financialLimit, stepUp } = settings.policy;
  if (financialLimit === undefined || stepUp === 'none' || primaryAmount === undefined) return false;
  return moneyAbsGreaterThan(primaryAmount, financialLimit);
}
