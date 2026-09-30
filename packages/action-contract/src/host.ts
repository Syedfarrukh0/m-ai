import type { AssistantQuota, AssistantSettings } from './assistant.js';
import type { ActionContext } from './context.js';
import type { ActionPreview } from './definition.js';
import type { ActionError } from './errors.js';
import type { CatalogEntry } from './catalog.js';
import type { ActionKind, ActionSource, Locale, RiskLevel } from './vocabulary.js';

/**
 * What the app supplies to the registry — the only app-shaped seam. The app
 * implements it once (transaction + row security + licences + audit + outbox
 * + idempotency + metering); every action then goes through the same pipeline.
 */
export interface ActionHost<R, E extends object> {
  /** Licence check for the action's module. */
  availability(
    action: CatalogEntry,
    ctx: ActionContext,
  ): Promise<{ ok: true } | { ok: false; code: 'MODULE_NOT_LICENSED' | 'LICENCE_READ_ONLY' }>;

  /**
   * Run `work` in ONE database transaction with the tenant context set for
   * row security (ctx.tenantId / ctx.userId). `rollback: true` = always roll
   * back (previews). `readOnly` is a hint the host may enforce for queries.
   * If `work` throws, roll back and rethrow.
   */
  transaction<T>(
    ctx: ActionContext,
    opts: { rollback: boolean; readOnly: boolean },
    work: (tx: HostTransaction<R, E>) => Promise<T>,
  ): Promise<T>;

  /** Audit rows for refusals, failures, previews and queries — in their own short transaction. */
  auditOutside(entry: AuditEntry): Promise<void>;

  /** Usage for calls whose own transaction could not write it (queries). */
  meterOutside(record: UsageRecord, ctx: ActionContext): Promise<void>;

  /** Map a thrown domain/database error to a stable code, or null for INTERNAL. */
  toError(e: unknown, locale: Locale): ActionError | null;

  /** HMAC secret for confirmation tokens (≥ 16 bytes). Rotate by accepting that in-flight previews fail. */
  confirmationSecret(): string | Uint8Array | Promise<string | Uint8Array>;

  /** After commit: fire-and-forget live hints to open screens. */
  afterCommit?(ctx: ActionContext, events: string[]): void;

  /** Clock, for tests. */
  now?(): Date;

  /** Required to accept calls with source 'assistant'. */
  assistant?: AssistantHostHooks;

  /** Log INTERNAL errors (they are returned to the caller without detail). */
  logError?(e: unknown, ctx: ActionContext, action: string): void;
}

export interface AssistantHostHooks {
  /** The company's settings, parsed with the AssistantSettings schema. */
  settings(ctx: ActionContext): Promise<AssistantSettings>;
  /** The company's message quota. 'exhausted' refuses assistant calls. */
  quota(ctx: ActionContext): Promise<AssistantQuota>;
  /**
   * Find or create the step-up request for this confirmation (idempotent on
   * confirmationId) and return its state. The app shows pending requests in
   * the user's bell; approving or declining emits
   * `assistant.stepup.approved|declined`.
   */
  stepUp(
    ctx: ActionContext,
    request: { confirmationId: string; action: string; version: number; preview: ActionPreview; expiresAt: string },
  ): Promise<{ status: 'approved' } | { status: 'declined' } | { status: 'pending'; stepUpId: string; expiresAt: string }>;
}

export type IdempotencyClaim =
  | { state: 'new' }
  | { state: 'done'; result: StoredResult }
  | { state: 'running' }
  | { state: 'mismatch' };

export interface StoredResult {
  data: unknown;
  events: string[];
}

export interface HostTransaction<R, E extends object> {
  runtime: R;
  /** Write a domain event to the outbox, in this transaction. */
  emit<K extends keyof E & string>(type: K, payload: E[K]): Promise<void>;
  audit(entry: AuditEntry): Promise<void>;
  /** Scope keys by tenant. Same key + same inputHash after commit = 'done'. */
  claimIdempotency(key: string, inputHash: string): Promise<IdempotencyClaim>;
  storeIdempotency(key: string, inputHash: string, result: StoredResult): Promise<void>;
  /**
   * Unique insert of the confirmation id. 'used' when it was already consumed
   * (by a committed execute with a different idempotency key).
   */
  consumeConfirmation(confirmationId: string, idempotencyKey: string | undefined): Promise<'ok' | 'used'>;
  meter(record: UsageRecord): Promise<void>;
}

export interface AuditEntry {
  action: string;
  version: number;
  kind: ActionKind;
  risk: RiskLevel;
  tenantId: string;
  userId: string;
  actor?: { clientId: string; conversationId?: string };
  source: ActionSource;
  requestId: string;
  idempotencyKey?: string;
  /** With `sensitive` paths replaced by "[redacted]". */
  input: unknown;
  outcome: 'ok' | 'error' | 'denied' | 'previewed' | 'replayed';
  /** Output for commands; for queries, the row count only. */
  result?: unknown;
  errorCode?: string;
  durationMs: number;
}

/** One metered unit of use. */
export interface UsageRecord {
  /** 'assistant.actions', 'gateway.whatsapp.outbound' … */
  meter: string;
  quantity: number;
  unit: 'call' | 'message' | 'second' | 'token' | 'unit';
  module: string;
  source: ActionSource;
  requestId: string;
}
