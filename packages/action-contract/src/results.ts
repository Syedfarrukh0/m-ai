import type { ActionPreview } from './definition.js';
import type { ActionError } from './errors.js';
import type { ActionKind, LocalizedText } from './vocabulary.js';

export interface ResultMeta {
  requestId: string;
  action: string;
  version: number;
  /** True when an idempotent retry returned the stored result of the first call. */
  replayed: boolean;
  /** Outbox event types written by this call (execute only). */
  events: string[];
  /** E.g. "this version is deprecated, use X". */
  warnings?: LocalizedText[];
}

export type ActionResult<O> =
  | { ok: true; data: O; meta: ResultMeta }
  | { ok: false; error: ActionError; meta: ResultMeta };

export interface PreviewResult {
  preview: ActionPreview;
  /** sha-256 over what the person saw (see computeFingerprint). */
  fingerprint: string;
  /** Send back with the fingerprint in ExecuteRequest.confirmation. Single-use. */
  confirmationId: string;
  /** A confirmation older than this is refused with PREVIEW_EXPIRED. */
  expiresAt: string;
  /** For the assistant: executing will ask the user to approve in the app first. */
  stepUp: { required: boolean };
}

export interface ListRequest {
  module?: string;
  kind?: ActionKind;
  tags?: string[];
  includeDeprecated?: boolean;
}

export interface PreviewRequest {
  action: string;
  /** Omitted = the highest registered version. */
  version?: number;
  input: unknown;
}

export interface ExecuteRequest {
  action: string;
  /** Omitted = the highest registered version. */
  version?: number;
  input: unknown;
  /** The `Idempotency-Key` header wins over this. */
  idempotencyKey?: string;
  /** Required for confirmation-bound actions called by the assistant. */
  confirmation?: { id: string; fingerprint: string };
}
