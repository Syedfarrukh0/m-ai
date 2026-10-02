import type { z } from 'zod';
import type { ActionContext, HandlerContext } from './context.js';
import type { MoneyString } from './schemas.js';
import type { ActionKind, LocalizedText, RiskLevel } from './vocabulary.js';
import { ACTION_NAME, EVENT_TYPE, MODULE_CODE, PERMISSION_KEY, RISK_LEVELS, TAG } from './vocabulary.js';

// ─────────────────────────────────────────────────────────────────────────────
// Preview
// ─────────────────────────────────────────────────────────────────────────────

export interface PreviewChange {
  op: 'create' | 'update' | 'delete' | 'post' | 'reverse' | 'send';
  /** Table-level noun: 'sales_invoice', 'customer', 'stock_movement'. */
  entity: string;
  /** Document number or code. In a preview it is provisional and NOT fingerprinted. */
  ref?: string;
  label: LocalizedText;
  /** Named totals — { net, tax, gross }. These ARE fingerprinted. */
  amounts?: Record<string, MoneyString>;
  /** Field-level before/after for updates. These ARE fingerprinted. */
  fields?: Record<string, { from?: unknown; to?: unknown }>;
}

export interface PreviewWarning {
  code: string;
  message: LocalizedText;
}

export interface ActionPreview {
  summary: LocalizedText;
  /**
   * The one amount a person would name for this operation: the invoice's
   * gross, the payment's amount. REQUIRED for `risk: 'financial'`; the
   * assistant's `financialLimit` is compared against it.
   */
  primaryAmount?: MoneyString;
  changes: PreviewChange[];
  warnings: PreviewWarning[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A map of event type → payload type, supplied by the app as an interface
 * (no index signature), so emitting an undeclared event does not compile.
 */
export type EventMap = Record<string, unknown>;

export interface ActionExample<I> {
  /** English, one line: what this example does. Not a prompt. */
  title: string;
  input: I;
}

export interface ActionDefinition<I = unknown, O = unknown, R = unknown, E extends object = EventMap> {
  /** Stable forever once published. */
  name: string;
  /** Major version of this action's input/output. A breaking change is a new version. */
  version: number;
  kind: ActionKind;
  /** Licence module code. Unlicensed → invisible in list(), refused by execute(). */
  module: string;
  /** English, plain, for people and for the catalog. At least one full sentence. */
  description: string;
  examples?: readonly ActionExample<I>[];
  /** At least one, from the app's controlled vocabulary. The assistant selects tools by module + tags. */
  tags: readonly string[];
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  /** ALL of these are required. Empty = any signed-in user of the company (read/write only). */
  permissions: readonly string[];
  risk: RiskLevel;
  /** Enforced by the registry for source 'assistant'; UI dialogs count for web/mobile/desktop. */
  requiresConfirmation: boolean;
  /** Same input + same idempotency key twice = one effect, same result. */
  idempotent: boolean;
  deprecated?: { since: string; useInstead?: string };
  /** List-returning queries: the default and hard cap on `limit`. */
  paging?: { defaultLimit: number; maxLimit: number };
  /** Top-level input keys kept out of the audit log: ['password'], ['cnic']. Dotted paths reach nested keys. */
  sensitive?: readonly string[];
  /**
   * Output paths holding a secret shown once (an invitation or reset link).
   * The caller gets the full output; the audit log and the idempotency store
   * get it with these paths replaced by "[redacted]", so a replay returns the
   * redacted output with `meta.redacted: true`.
   */
  sensitiveOutput?: readonly string[];
  /**
   * A command that only reads the books (prints an old invoice, exports a
   * report) but writes a file or a log, so it is not a query. True = it still
   * runs when the module's licence is read-only. Only for risk "write".
   */
  availableWhenReadOnly?: boolean;
  /**
   * Describe what `handler` produced, for a person to confirm. Called with the
   * handler's REAL output — in preview mode from a rolled-back run — so the
   * totals shown are the totals that will be committed. Required when
   * `requiresConfirmation` is true.
   */
  preview?: (args: { input: I; result: O; ctx: ActionContext }) => ActionPreview | Promise<ActionPreview>;
  handler: (input: I, ctx: HandlerContext<R, E>) => Promise<O>;
}

/** The registry holds definitions of every shape. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAction = ActionDefinition<any, any, any, any>;

/**
 * The rules a definition must satisfy. `defineAction` throws listing every
 * rule broken; `registry.validate()` adds the cross-definition rules.
 */
export const DEFINITION_RULES = [
  'name matches ACTION_NAME',
  'version is an integer ≥ 1',
  'module matches MODULE_CODE',
  'description is at least 20 characters',
  'tags has at least one entry and every tag matches TAG',
  'every permission matches PERMISSION_KEY',
  'risk is one of read | write | financial | destructive',
  'query ⇒ risk "read", idempotent, no confirmation, no preview',
  'command ⇒ risk is not "read"',
  'financial or destructive ⇒ requiresConfirmation and at least one permission',
  'requiresConfirmation ⇒ preview is defined',
  'paging only on queries, and 1 ≤ defaultLimit ≤ maxLimit ≤ 200',
  'every sensitive path is a non-empty string',
  'every sensitiveOutput path is a non-empty string',
  'availableWhenReadOnly ⇒ command with risk "write"',
  'examples have a title',
  '(registry) name + version is unique',
  '(registry) deprecated.useInstead names a registered action',
  '(runtime) a financial preview declares primaryAmount',
] as const;

export class ActionDefinitionError extends Error {
  readonly action: string;
  readonly broken: string[];

  constructor(action: string, broken: string[]) {
    super(`action "${action}" breaks ${broken.length} rule(s):\n  - ${broken.join('\n  - ')}`);
    this.name = 'ActionDefinitionError';
    this.action = action;
    this.broken = broken;
  }
}

/** Check a definition against DEFINITION_RULES (the single-definition ones). */
export function checkDefinition(def: AnyAction): string[] {
  const broken: string[] = [];
  const isQuery = def.kind === 'query';

  if (typeof def.name !== 'string' || !ACTION_NAME.test(def.name)) broken.push('name matches ACTION_NAME');
  if (!Number.isInteger(def.version) || def.version < 1) broken.push('version is an integer ≥ 1');
  if (typeof def.module !== 'string' || !MODULE_CODE.test(def.module)) broken.push('module matches MODULE_CODE');
  if (typeof def.description !== 'string' || def.description.trim().length < 20)
    broken.push('description is at least 20 characters');
  if (!Array.isArray(def.tags) || def.tags.length === 0 || !def.tags.every((t) => typeof t === 'string' && TAG.test(t)))
    broken.push('tags has at least one entry and every tag matches TAG');
  if (!Array.isArray(def.permissions) || !def.permissions.every((p) => typeof p === 'string' && PERMISSION_KEY.test(p)))
    broken.push('every permission matches PERMISSION_KEY');
  if (!(RISK_LEVELS as readonly string[]).includes(def.risk))
    broken.push('risk is one of read | write | financial | destructive');

  if (def.kind !== 'query' && def.kind !== 'command') broken.push('kind is "query" or "command"');
  if (isQuery && (def.risk !== 'read' || !def.idempotent || def.requiresConfirmation || def.preview !== undefined))
    broken.push('query ⇒ risk "read", idempotent, no confirmation, no preview');
  if (def.kind === 'command' && def.risk === 'read') broken.push('command ⇒ risk is not "read"');
  if (
    (def.risk === 'financial' || def.risk === 'destructive') &&
    (!def.requiresConfirmation || !Array.isArray(def.permissions) || def.permissions.length === 0)
  )
    broken.push('financial or destructive ⇒ requiresConfirmation and at least one permission');
  if (def.requiresConfirmation && typeof def.preview !== 'function') broken.push('requiresConfirmation ⇒ preview is defined');

  if (def.paging !== undefined) {
    const { defaultLimit, maxLimit } = def.paging;
    const ok =
      isQuery &&
      Number.isInteger(defaultLimit) &&
      Number.isInteger(maxLimit) &&
      defaultLimit >= 1 &&
      defaultLimit <= maxLimit &&
      maxLimit <= 200;
    if (!ok) broken.push('paging only on queries, and 1 ≤ defaultLimit ≤ maxLimit ≤ 200');
  }
  if (def.sensitive !== undefined && !def.sensitive.every((p) => typeof p === 'string' && p.length > 0))
    broken.push('every sensitive path is a non-empty string');
  if (def.sensitiveOutput !== undefined && !def.sensitiveOutput.every((p) => typeof p === 'string' && p.length > 0))
    broken.push('every sensitiveOutput path is a non-empty string');
  if (def.availableWhenReadOnly === true && (def.kind !== 'command' || def.risk !== 'write'))
    broken.push('availableWhenReadOnly ⇒ command with risk "write"');
  if (def.examples !== undefined && !def.examples.every((e) => typeof e.title === 'string' && e.title.trim().length > 0))
    broken.push('examples have a title');
  if (typeof def.handler !== 'function') broken.push('handler is a function');

  return broken;
}

/**
 * Declare an action. Throws `ActionDefinitionError` listing every broken rule,
 * so a bad definition fails at boot (and in the catalog test), never at runtime.
 */
export function defineAction<I, O, R = unknown, E extends object = EventMap>(
  def: ActionDefinition<I, O, R, E>,
): ActionDefinition<I, O, R, E> {
  const broken = checkDefinition(def as AnyAction);
  if (broken.length > 0) throw new ActionDefinitionError(String(def.name), broken);
  return Object.freeze({ ...def });
}

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

export interface EventDefinition<P = unknown> {
  type: string;
  /** Payload version. Consumers declare the versions they understand. */
  version: number;
  description: string;
  payload: z.ZodType<P>;
  /** Licence module the event belongs to (alert tokens are scoped to it). */
  module: string;
  /** The permission a user needs to be told about it (bell, assistant alert). */
  audience?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEvent = EventDefinition<any>;

export function defineEvent<P>(def: EventDefinition<P>): EventDefinition<P> {
  const broken: string[] = [];
  if (!EVENT_TYPE.test(def.type)) broken.push('type matches EVENT_TYPE');
  if (!Number.isInteger(def.version) || def.version < 1) broken.push('version is an integer ≥ 1');
  if (!MODULE_CODE.test(def.module)) broken.push('module matches MODULE_CODE');
  if (def.description.trim().length < 10) broken.push('description is at least 10 characters');
  if (def.audience !== undefined && !PERMISSION_KEY.test(def.audience)) broken.push('audience matches PERMISSION_KEY');
  if (broken.length > 0) throw new ActionDefinitionError(`event ${def.type}`, broken);
  return Object.freeze({ ...def });
}
