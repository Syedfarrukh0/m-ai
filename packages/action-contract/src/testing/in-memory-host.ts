import type { AssistantQuota } from '../assistant.js';
import { AssistantSettings } from '../assistant.js';
import type { CatalogEntry } from '../catalog.js';
import type { ActionContext } from '../context.js';
import type { ActionPreview } from '../definition.js';
import type { ActionError } from '../errors.js';
import type { ActionHost, AssistantHostHooks, AuditEntry, HostTransaction, IdempotencyClaim, StoredResult, UsageRecord } from '../host.js';
import type { Locale } from '../vocabulary.js';
import { canonicalJson } from '../crypto.js';
import type { ContractCheckHost } from './contract-checks.js';

export type LicenceState = 'active' | 'read-only' | 'none';

export interface OutboxRow {
  id: string;
  tenantId: string;
  type: string;
  payload: unknown;
  occurredAt: string;
  requestId: string;
}

export interface StepUpRow {
  confirmationId: string;
  stepUpId: string;
  tenantId: string;
  userId: string;
  action: string;
  preview: ActionPreview;
  expiresAt: string;
  status: 'pending' | 'approved' | 'declined';
}

interface State<D> {
  data: D;
  outbox: OutboxRow[];
  audit: AuditEntry[];
  usage: Array<UsageRecord & { tenantId: string }>;
  idempotency: Record<string, { hash: string; result?: StoredResult }>;
  confirmations: Record<string, string | null>;
}

export interface InMemoryHostOptions<D, R> {
  /** App data for all tenants. Rows should carry a tenantId; the runtime filters by it (the stand-in for row security). */
  data: D;
  /** Build the transaction-bound runtime the handlers use. */
  runtime: (data: D, ctx: ActionContext) => R;
  /** Licence state per tenant and module. Default: everything active. */
  licence?: (tenantId: string, module: string) => LicenceState;
  /** Assistant settings per tenant (raw; parsed with the AssistantSettings schema). Omit to host no assistant. */
  assistantSettings?: Record<string, unknown>;
  /** Quota per tenant. Default: state 'ok'. */
  quota?: (tenantId: string) => AssistantQuota;
  /** Map thrown domain errors to codes. Default: none (→ INTERNAL). */
  toError?: (e: unknown, locale: Locale) => ActionError | null;
  confirmationSecret?: string;
  /** Start time of the controllable clock. Default: 2026-10-01T09:00:00Z. */
  startTime?: Date;
}

/**
 * An ActionHost that keeps everything in memory, with real rollback: each
 * transaction works on the live state and restores a snapshot if it rolls
 * back or throws. Transactions run one at a time.
 *
 * For tests of an app's actions, for the contract-check harness, and as the
 * assistant's mock backend while the real app is being built.
 */
export class InMemoryHost<D, R, E extends object = Record<string, unknown>>
  implements ActionHost<R, E>, ContractCheckHost
{
  private state: State<D>;
  private lock: Promise<unknown> = Promise.resolve();
  private clock: number;
  private failNext = false;
  private seq = 0;
  readonly stepUps = new Map<string, StepUpRow>();
  readonly committed: Array<{ ctx: ActionContext; events: string[] }> = [];
  readonly errors: Array<{ error: unknown; action: string }> = [];
  readonly assistant?: AssistantHostHooks;

  constructor(private readonly options: InMemoryHostOptions<D, R>) {
    this.state = {
      data: structuredClone(options.data),
      outbox: [],
      audit: [],
      usage: [],
      idempotency: {},
      confirmations: {},
    };
    this.clock = (options.startTime ?? new Date('2026-10-01T09:00:00Z')).getTime();
    if (options.assistantSettings) this.assistant = this.assistantHooks();
  }

  // ── inspection ────────────────────────────────────────────────────────────

  get data(): D {
    return this.state.data;
  }
  get outbox(): readonly OutboxRow[] {
    return this.state.outbox;
  }
  get auditLog(): readonly AuditEntry[] {
    return this.state.audit;
  }
  get usage(): ReadonlyArray<UsageRecord & { tenantId: string }> {
    return this.state.usage;
  }

  /** Everything a transaction may change, minus the audit log and usage (which outside writes append to). */
  snapshot(): string {
    const { data, outbox, idempotency, confirmations } = this.state;
    return canonicalJson({ data, outbox, idempotency, confirmations });
  }

  outboxCount(): number {
    return this.state.outbox.length;
  }

  /** The next transaction throws after its work, before commit — so it must roll back. */
  failNextTransaction(): void {
    this.failNext = true;
  }

  advance(ms: number): void {
    this.clock += ms;
  }

  now(): Date {
    return new Date(this.clock);
  }

  setAssistantSettings(tenantId: string, settings: unknown): void {
    if (!this.options.assistantSettings) throw new Error('this host was created without assistant settings');
    this.options.assistantSettings[tenantId] = settings;
  }

  approveStepUp(confirmationId: string): void {
    this.setStepUp(confirmationId, 'approved');
  }

  declineStepUp(confirmationId: string): void {
    this.setStepUp(confirmationId, 'declined');
  }

  private setStepUp(confirmationId: string, status: 'approved' | 'declined'): void {
    const row = this.stepUps.get(confirmationId);
    if (!row) throw new Error(`no step-up request for ${confirmationId}`);
    row.status = status;
  }

  // ── ActionHost ────────────────────────────────────────────────────────────

  async availability(
    entry: CatalogEntry,
    ctx: ActionContext,
  ): Promise<{ ok: true } | { ok: false; code: 'MODULE_NOT_LICENSED' | 'LICENCE_READ_ONLY' }> {
    const state = this.options.licence?.(ctx.tenantId, entry.module) ?? 'active';
    if (state === 'active') return { ok: true };
    return { ok: false, code: state === 'none' ? 'MODULE_NOT_LICENSED' : 'LICENCE_READ_ONLY' };
  }

  transaction<T>(
    ctx: ActionContext,
    opts: { rollback: boolean; readOnly: boolean },
    work: (tx: HostTransaction<R, E>) => Promise<T>,
  ): Promise<T> {
    return this.serial(async () => {
      const before = structuredClone(this.state);
      try {
        const result = await work(this.tx(ctx));
        if (this.failNext) {
          this.failNext = false;
          throw new Error('injected failure before commit');
        }
        if (opts.rollback) this.state = before;
        return result;
      } catch (e) {
        this.state = before;
        throw e;
      }
    });
  }

  async auditOutside(entry: AuditEntry): Promise<void> {
    await this.serial(async () => {
      this.state.audit.push(structuredClone(entry));
    });
  }

  async meterOutside(record: UsageRecord, ctx: ActionContext): Promise<void> {
    await this.serial(async () => {
      this.state.usage.push({ ...record, tenantId: ctx.tenantId });
    });
  }

  toError(e: unknown, locale: Locale): ActionError | null {
    return this.options.toError?.(e, locale) ?? null;
  }

  confirmationSecret(): string {
    return this.options.confirmationSecret ?? 'in-memory-host-confirmation-secret';
  }

  afterCommit(ctx: ActionContext, events: string[]): void {
    this.committed.push({ ctx, events });
  }

  logError(error: unknown, _ctx: ActionContext, action: string): void {
    this.errors.push({ error, action });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private tx(ctx: ActionContext): HostTransaction<R, E> {
    const tenantKey = (k: string) => `${ctx.tenantId}:${k}`;
    return {
      runtime: this.options.runtime(this.state.data, ctx),
      emit: async (type, payload) => {
        this.state.outbox.push({
          id: `evt_${++this.seq}`,
          tenantId: ctx.tenantId,
          type,
          payload: structuredClone(payload),
          occurredAt: this.now().toISOString(),
          requestId: ctx.requestId,
        });
      },
      audit: async (entry) => {
        this.state.audit.push(structuredClone(entry));
      },
      claimIdempotency: async (key, hash): Promise<IdempotencyClaim> => {
        const row = this.state.idempotency[tenantKey(key)];
        if (!row) {
          this.state.idempotency[tenantKey(key)] = { hash };
          return { state: 'new' };
        }
        if (row.hash !== hash) return { state: 'mismatch' };
        if (!row.result) return { state: 'running' };
        return { state: 'done', result: structuredClone(row.result) };
      },
      storeIdempotency: async (key, hash, result) => {
        this.state.idempotency[tenantKey(key)] = { hash, result: structuredClone(result) };
      },
      consumeConfirmation: async (confirmationId, idempotencyKey) => {
        const k = tenantKey(confirmationId);
        if (k in this.state.confirmations) return 'used';
        this.state.confirmations[k] = idempotencyKey ?? null;
        return 'ok';
      },
      meter: async (record) => {
        this.state.usage.push({ ...record, tenantId: ctx.tenantId });
      },
    };
  }

  private assistantHooks(): AssistantHostHooks {
    return {
      settings: async (ctx) => AssistantSettings.parse(this.options.assistantSettings?.[ctx.tenantId] ?? {}),
      quota: async (ctx) =>
        this.options.quota?.(ctx.tenantId) ?? { included: 1000, used: 0, packsRemaining: 0, state: 'ok' },
      stepUp: async (ctx, req) => {
        let row = this.stepUps.get(req.confirmationId);
        if (!row) {
          row = {
            confirmationId: req.confirmationId,
            stepUpId: `stp_${++this.seq}`,
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            action: req.action,
            preview: structuredClone(req.preview),
            expiresAt: req.expiresAt,
            status: 'pending',
          };
          this.stepUps.set(req.confirmationId, row);
        }
        if (row.status === 'pending') return { status: 'pending', stepUpId: row.stepUpId, expiresAt: row.expiresAt };
        return { status: row.status };
      },
    };
  }
}
