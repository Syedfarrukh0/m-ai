import { z } from 'zod';
import type { AssistantSettings } from './assistant.js';
import { AssistantSettings as AssistantSettingsSchema, WELL_KNOWN_ACTIONS, policyAllows, stepUpRequired } from './assistant.js';
import type { ActionCatalog, CatalogEntry, ListResponse } from './catalog.js';
import { catalogEntry, catalogEvent, catalogHash as hashCatalog } from './catalog.js';
import { computeFingerprint, inputHash, issueConfirmation, verifyConfirmation } from './confirmation.js';
import type { ActionContext, HandlerContext } from './context.js';
import type { ActionPreview, AnyAction, AnyEvent } from './definition.js';
import { ActionDefinitionError, checkDefinition } from './definition.js';
import { scopeAllows } from './delegation.js';
import type { ActionError, StandardErrorCode } from './errors.js';
import { ActionFailure, STANDARD_ERRORS, isValidErrorCode, makeError, standardError } from './errors.js';
import type { ActionHost, AuditEntry, HostTransaction } from './host.js';
import type { ActionResult, ExecuteRequest, ListRequest, PreviewRequest, PreviewResult, ResultMeta } from './results.js';
import { MoneyString } from './schemas.js';
import type { ActionSource, LocalizedText } from './vocabulary.js';
import { CONTRACT_VERSION } from './vocabulary.js';

export interface RegistryOptions<R, E extends object> {
  host: ActionHost<R, E>;
  /** Written into the catalog: which app and which version produced it. */
  producer: { name: string; version: string };
  /** Confirmation lifetime per source. Default: assistant 900 s, everything else 300 s. */
  confirmationTtlSeconds?: Partial<Record<ActionSource, number>>;
  /** Commands from these sources must carry an idempotency key. Default: mobile, desktop, assistant, api. */
  requireIdempotencyKeyFor?: readonly ActionSource[];
  /** Queries from these sources are audited (plus any action tagged 'export'). Default: assistant, api. */
  auditQuerySources?: readonly ActionSource[];
  /** Actions the assistant may call even when disabled or out of quota. Default: core.context.get, assistant.usage.record. */
  assistantAlwaysAllowed?: readonly string[];
  /** Modules the assistant may always use, whatever `policy.allowedModules` says. Default: CORE. */
  assistantAlwaysAllowedModules?: readonly string[];
}

export interface ActionRegistry {
  register(...defs: AnyAction[]): void;
  registerEvents(...events: AnyEvent[]): void;
  /** The app's module error catalogue (code → en/ur), exported in the catalog. */
  registerErrors(errors: Record<string, LocalizedText>): void;
  /** Cross-definition rules. Throws ActionDefinitionError. */
  validate(): void;
  get(name: string, version?: number): AnyAction | undefined;
  list(ctx: ActionContext, req?: ListRequest): Promise<ListResponse>;
  preview(ctx: ActionContext, req: PreviewRequest): Promise<ActionResult<PreviewResult>>;
  execute(ctx: ActionContext, req: ExecuteRequest): Promise<ActionResult<unknown>>;
  /** Everything registered, unfiltered — for `action-catalog.json`. */
  catalog(): ActionCatalog;
  catalogHash(): Promise<string>;
}

/** A refusal raised inside the pipeline; becomes an ActionResult error. */
class Refusal extends Error {
  constructor(
    readonly error: ActionError,
    readonly outcome: 'denied' | 'error',
  ) {
    super(error.code);
  }
}

const DENIAL_CODES = new Set<string>([
  'PERMISSION_DENIED',
  'MODULE_NOT_LICENSED',
  'LICENCE_READ_ONLY',
  'ASSISTANT_POLICY_DENIED',
  'ASSISTANT_QUOTA_EXCEEDED',
  'CONFIRMATION_REQUIRED',
  'STEP_UP_REQUIRED',
  'IDEMPOTENCY_KEY_REQUIRED',
]);

export function createActionRegistry<R, E extends object>(options: RegistryOptions<R, E>): ActionRegistry {
  const host = options.host;
  const ttl = { default: 300, assistant: 900, ...options.confirmationTtlSeconds } as Record<string, number>;
  const requireKeyFor = options.requireIdempotencyKeyFor ?? ['mobile', 'desktop', 'assistant', 'api'];
  const auditQuerySources = options.auditQuerySources ?? ['assistant', 'api'];
  const alwaysAllowed = options.assistantAlwaysAllowed ?? [WELL_KNOWN_ACTIONS.contextGet, WELL_KNOWN_ACTIONS.usageRecord];
  const alwaysModules = options.assistantAlwaysAllowedModules ?? ['CORE'];

  const byName = new Map<string, AnyAction[]>(); // versions ascending
  const entries = new Map<AnyAction, CatalogEntry>();
  const events = new Map<string, AnyEvent>();
  const moduleErrors = new Map<string, LocalizedText>();
  let cachedHash: string | undefined;

  const now = () => (host.now ? host.now() : new Date());

  // ── registration ──────────────────────────────────────────────────────────

  function register(...defs: AnyAction[]): void {
    for (const def of defs) {
      const broken = checkDefinition(def);
      if (broken.length > 0) throw new ActionDefinitionError(String(def.name), broken);
      const versions = byName.get(def.name) ?? [];
      if (versions.some((v) => v.version === def.version))
        throw new ActionDefinitionError(def.name, ['(registry) name + version is unique']);
      versions.push(def);
      versions.sort((a, b) => a.version - b.version);
      byName.set(def.name, versions);
      entries.set(def, catalogEntry(def));
    }
    cachedHash = undefined;
  }

  function registerEvents(...defs: AnyEvent[]): void {
    for (const def of defs) {
      if (events.has(def.type)) throw new ActionDefinitionError(`event ${def.type}`, ['event type is unique']);
      events.set(def.type, def);
    }
    cachedHash = undefined;
  }

  function registerErrors(errors: Record<string, LocalizedText>): void {
    for (const [code, messages] of Object.entries(errors)) {
      if (!isValidErrorCode(code) || STANDARD_ERRORS[code as StandardErrorCode] !== undefined)
        throw new TypeError(`module error code "${code}" must look like "<area>.<snake_case>"`);
      moduleErrors.set(code, messages);
    }
    cachedHash = undefined;
  }

  function validate(): void {
    for (const versions of byName.values()) {
      for (const def of versions) {
        const target = def.deprecated?.useInstead;
        if (target !== undefined && !byName.has(target))
          throw new ActionDefinitionError(def.name, ['(registry) deprecated.useInstead names a registered action']);
      }
    }
  }

  function get(name: string, version?: number): AnyAction | undefined {
    const versions = byName.get(name);
    if (!versions) return undefined;
    return version === undefined ? versions[versions.length - 1] : versions.find((v) => v.version === version);
  }

  function allDefs(): AnyAction[] {
    return [...byName.values()].flat();
  }

  function catalog(): ActionCatalog {
    validate();
    return {
      contractVersion: CONTRACT_VERSION,
      producer: { ...options.producer },
      actions: allDefs()
        .map((d) => entries.get(d) as CatalogEntry)
        .sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version),
      events: [...events.values()].map(catalogEvent).sort((a, b) => a.type.localeCompare(b.type)),
      errors: [
        ...Object.entries(STANDARD_ERRORS).map(([code, spec]) => ({ code, messages: { ...spec.messages } })),
        ...[...moduleErrors.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([code, messages]) => ({ code, messages })),
      ],
    };
  }

  async function catalogHash(): Promise<string> {
    cachedHash ??= await hashCatalog(catalog());
    return cachedHash;
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  const refuse = (ctx: ActionContext, code: StandardErrorCode, details?: unknown): Refusal =>
    new Refusal(standardError(code, ctx.locale, details), DENIAL_CODES.has(code) ? 'denied' : 'error');

  function resolve(ctx: ActionContext, name: string, version: number | undefined): AnyAction {
    const versions = byName.get(name);
    if (!versions) throw refuse(ctx, 'UNKNOWN_ACTION', { action: name });
    const def = version === undefined ? versions[versions.length - 1] : versions.find((v) => v.version === version);
    if (!def)
      throw refuse(ctx, 'VERSION_NOT_SUPPORTED', { action: name, version, available: versions.map((v) => v.version) });
    return def;
  }

  function deprecationWarnings(def: AnyAction): LocalizedText[] | undefined {
    if (!def.deprecated) return undefined;
    const { since, useInstead } = def.deprecated;
    return [
      {
        en: `${def.name} v${def.version} is deprecated since ${since}${useInstead ? `; use ${useInstead}` : ''}.`,
        ur: `${def.name} v${def.version} ${since} سے متروک ہے${useInstead ? `؛ اس کی جگہ ${useInstead} استعمال کریں` : ''}۔`,
      },
    ];
  }

  function meta(ctx: ActionContext, def: AnyAction | undefined, req: { action: string; version?: number }): ResultMeta {
    const m: ResultMeta = {
      requestId: ctx.requestId,
      action: def?.name ?? req.action,
      version: def?.version ?? req.version ?? 0,
      replayed: false,
      events: [],
    };
    const warnings = def ? deprecationWarnings(def) : undefined;
    if (warnings) m.warnings = warnings;
    return m;
  }

  function isAudited(def: AnyAction, ctx: ActionContext): boolean {
    return def.kind === 'command' || auditQuerySources.includes(ctx.source) || def.tags.includes('export');
  }

  function auditEntry(
    ctx: ActionContext,
    def: AnyAction,
    input: unknown,
    outcome: AuditEntry['outcome'],
    started: number,
    extra: { result?: unknown; errorCode?: string; idempotencyKey?: string | undefined } = {},
  ): AuditEntry {
    const entry: AuditEntry = {
      action: def.name,
      version: def.version,
      kind: def.kind,
      risk: def.risk,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      source: ctx.source,
      requestId: ctx.requestId,
      input: redact(input, def.sensitive),
      outcome,
      durationMs: Math.max(0, now().getTime() - started),
    };
    if (ctx.actor) {
      entry.actor = { clientId: ctx.actor.clientId };
      if (ctx.actor.conversationId !== undefined) entry.actor.conversationId = ctx.actor.conversationId;
    }
    if (extra.idempotencyKey !== undefined) entry.idempotencyKey = extra.idempotencyKey;
    if (extra.result !== undefined) entry.result = def.kind === 'query' ? { rowCount: rowCount(extra.result) } : extra.result;
    if (extra.errorCode !== undefined) entry.errorCode = extra.errorCode;
    return entry;
  }

  async function safeAuditOutside(ctx: ActionContext, entry: AuditEntry): Promise<void> {
    try {
      await host.auditOutside(entry);
    } catch (e) {
      host.logError?.(e, ctx, entry.action);
    }
  }

  async function assistantSettings(ctx: ActionContext): Promise<AssistantSettings | undefined> {
    if (ctx.source !== 'assistant' || !host.assistant) return undefined;
    return AssistantSettingsSchema.parse(await host.assistant.settings(ctx));
  }

  /**
   * Scope → permissions → licence → assistant policy and quota → input.
   * Who-may-call checks come first, so a caller without access learns nothing
   * about the input schema. Returns the parsed input.
   */
  async function gate(
    ctx: ActionContext,
    def: AnyAction,
    rawInput: unknown,
  ): Promise<{ input: unknown; settings: AssistantSettings | undefined }> {
    if (ctx.actor?.scope && !scopeAllows(ctx.actor.scope, def)) throw refuse(ctx, 'PERMISSION_DENIED', { reason: 'token_scope' });

    const missing = def.permissions.filter((p: string) => !ctx.permissions.includes(p));
    if (missing.length > 0) throw refuse(ctx, 'PERMISSION_DENIED', { missing });

    const availability = await host.availability(entries.get(def) as CatalogEntry, ctx);
    if (!availability.ok && !(availability.code === 'LICENCE_READ_ONLY' && def.kind === 'query'))
      throw refuse(ctx, availability.code);

    let settings: AssistantSettings | undefined;
    if (ctx.source === 'assistant') {
      if (!host.assistant) throw refuse(ctx, 'ASSISTANT_POLICY_DENIED', { reason: 'not_supported' });
      settings = await assistantSettings(ctx);
      if (settings && !alwaysAllowed.includes(def.name)) {
        const allowed = policyAllows(settings, def, alwaysModules);
        if (!allowed.ok) throw refuse(ctx, 'ASSISTANT_POLICY_DENIED', { reason: allowed.reason });
        const quota = await host.assistant.quota(ctx);
        if (quota.state === 'exhausted') throw refuse(ctx, 'ASSISTANT_QUOTA_EXCEEDED', { quota });
      }
    }

    const parsed = def.input.safeParse(rawInput);
    if (!parsed.success) {
      throw refuse(ctx, 'VALIDATION_FAILED', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), code: i.code, message: i.message })),
      });
    }
    let input: unknown = parsed.data;
    if (def.paging && isRecord(input)) {
      const limit = input['limit'];
      if (limit === undefined) input = { ...input, limit: def.paging.defaultLimit };
      else if (typeof limit === 'number' && limit > def.paging.maxLimit)
        throw refuse(ctx, 'VALIDATION_FAILED', {
          issues: [{ path: 'limit', code: 'too_big', message: `limit may be at most ${def.paging.maxLimit}` }],
        });
    }
    return { input, settings };
  }

  async function runHandler(
    tx: HostTransaction<R, E>,
    ctx: ActionContext,
    def: AnyAction,
    input: unknown,
    mode: 'execute' | 'preview',
  ): Promise<{ result: unknown; events: string[] }> {
    const emitted: string[] = [];
    const hctx: HandlerContext<R, E> = {
      ...ctx,
      mode,
      runtime: tx.runtime,
      emit: async (type, payload) => {
        if (def.kind === 'query') throw new Error(`query ${def.name} tried to emit "${type}"; only commands emit events`);
        const ev = events.get(type);
        if (events.size > 0 && !ev) throw new Error(`action ${def.name} emitted undeclared event "${type}"`);
        if (ev) {
          const check = ev.payload.safeParse(payload);
          if (!check.success) throw new Error(`event "${type}" payload is invalid: ${z.prettifyError(check.error)}`);
        }
        await tx.emit(type, payload);
        emitted.push(type);
      },
      fail: (code: string, message: LocalizedText, details?: unknown): never => {
        throw new ActionFailure(code, message, details);
      },
    };
    const raw: unknown = await def.handler(input, hctx);
    const out = def.output.safeParse(raw);
    if (!out.success)
      throw new Error(`action ${def.name} returned output that does not match its schema: ${z.prettifyError(out.error)}`);
    return { result: out.data, events: emitted };
  }

  async function describe(def: AnyAction, input: unknown, result: unknown, ctx: ActionContext): Promise<ActionPreview> {
    if (typeof def.preview !== 'function') throw new Error(`action ${def.name} has no preview`);
    const preview = await def.preview({ input, result, ctx });
    if (def.risk === 'financial') {
      if (preview.primaryAmount === undefined)
        throw new Error(`financial action ${def.name}: preview must declare primaryAmount`);
      if (!MoneyString.safeParse(preview.primaryAmount).success)
        throw new Error(`action ${def.name}: primaryAmount is not a MoneyString`);
    }
    return preview;
  }

  /** Run the real handler in a transaction that always rolls back, and describe its output. */
  async function rolledBackPreview(ctx: ActionContext, def: AnyAction, input: unknown): Promise<ActionPreview> {
    return host.transaction(ctx, { rollback: true, readOnly: false }, async (tx) => {
      const { result } = await runHandler(tx, ctx, def, input, 'preview');
      return describe(def, input, result, ctx);
    });
  }

  async function previewResult(
    ctx: ActionContext,
    def: AnyAction,
    input: unknown,
    preview: ActionPreview,
    settings: AssistantSettings | undefined,
    fingerprint?: string,
  ): Promise<PreviewResult> {
    const fp =
      fingerprint ??
      (await computeFingerprint({
        action: def.name,
        version: def.version,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        input,
        preview,
      }));
    const seconds = ttl[ctx.source] ?? ttl['default'] ?? 300;
    const { confirmationId, expiresAt } = await issueConfirmation(
      await host.confirmationSecret(),
      { fingerprint: fp, tenantId: ctx.tenantId, userId: ctx.userId, action: def.name, version: def.version },
      new Date(now().getTime() + seconds * 1000),
    );
    const required = settings ? stepUpRequired(settings, def, preview.primaryAmount, ctx) : false;
    return { preview, fingerprint: fp, confirmationId, expiresAt, stepUp: { required } };
  }

  function fingerprintOf(ctx: ActionContext, def: AnyAction, input: unknown, preview: ActionPreview): Promise<string> {
    return computeFingerprint({
      action: def.name,
      version: def.version,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      input,
      preview,
    });
  }

  async function toFailure(
    e: unknown,
    ctx: ActionContext,
    def: AnyAction | undefined,
    input: unknown,
    started: number,
    m: ResultMeta,
    idempotencyKey: string | undefined,
  ): Promise<ActionResult<never>> {
    let error: ActionError;
    let outcome: 'denied' | 'error' = 'error';
    if (e instanceof Refusal) {
      error = e.error;
      outcome = e.outcome;
    } else if (e instanceof ActionFailure) {
      error = e.toActionError(ctx.locale);
    } else {
      const mapped = safeToError(e, ctx);
      if (mapped) error = mapped;
      else {
        host.logError?.(e, ctx, m.action);
        error = standardError('INTERNAL', ctx.locale, { requestId: ctx.requestId });
      }
    }
    if (def && isAudited(def, ctx)) {
      await safeAuditOutside(
        ctx,
        auditEntry(ctx, def, input, outcome, started, { errorCode: error.code, idempotencyKey }),
      );
    }
    return { ok: false, error, meta: m };
  }

  function safeToError(e: unknown, ctx: ActionContext): ActionError | null {
    try {
      const mapped = host.toError(e, ctx.locale);
      if (mapped && !isValidErrorCode(mapped.code)) return null;
      return mapped ? makeError(mapped.code, mapped.messages, ctx.locale, mapped.details) : null;
    } catch {
      return null;
    }
  }

  // ── list ──────────────────────────────────────────────────────────────────

  async function list(ctx: ActionContext, req: ListRequest = {}): Promise<ListResponse> {
    const out: CatalogEntry[] = [];
    let settings: AssistantSettings | undefined;
    if (ctx.source === 'assistant') {
      if (!host.assistant) return { actions: [], catalogHash: await catalogHash() };
      settings = await assistantSettings(ctx);
    }
    const availabilityByModule = new Map<string, Awaited<ReturnType<typeof host.availability>>>();

    for (const def of allDefs()) {
      if (def.deprecated && !req.includeDeprecated) continue;
      if (req.module !== undefined && def.module !== req.module) continue;
      if (req.kind !== undefined && def.kind !== req.kind) continue;
      if (req.tags && !req.tags.every((t) => def.tags.includes(t))) continue;
      if (!def.permissions.every((p: string) => ctx.permissions.includes(p))) continue;
      if (ctx.actor?.scope && !scopeAllows(ctx.actor.scope, def)) continue;
      if (settings && !alwaysAllowed.includes(def.name) && !policyAllows(settings, def, alwaysModules).ok) continue;

      const entry = entries.get(def) as CatalogEntry;
      let availability = availabilityByModule.get(def.module);
      if (!availability) {
        availability = await host.availability(entry, ctx);
        availabilityByModule.set(def.module, availability);
      }
      if (!availability.ok && !(availability.code === 'LICENCE_READ_ONLY' && def.kind === 'query')) continue;
      out.push(entry);
    }
    out.sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version);
    return { actions: out, catalogHash: await catalogHash() };
  }

  // ── preview ───────────────────────────────────────────────────────────────

  async function preview(ctx: ActionContext, req: PreviewRequest): Promise<ActionResult<PreviewResult>> {
    const started = now().getTime();
    let def: AnyAction | undefined;
    let input: unknown = req.input;
    try {
      def = resolve(ctx, req.action, req.version);
      if (def.kind === 'query' || typeof def.preview !== 'function') throw refuse(ctx, 'PREVIEW_NOT_SUPPORTED');
      const gated = await gate(ctx, def, req.input);
      input = gated.input;
      const described = await rolledBackPreview(ctx, def, input);
      const result = await previewResult(ctx, def, input, described, gated.settings);
      if (auditQuerySources.includes(ctx.source)) {
        await safeAuditOutside(ctx, auditEntry(ctx, def, input, 'previewed', started));
      }
      return { ok: true, data: result, meta: meta(ctx, def, req) };
    } catch (e) {
      return toFailure(e, ctx, def, input, started, meta(ctx, def, req), undefined);
    }
  }

  // ── execute ───────────────────────────────────────────────────────────────

  async function execute(ctx: ActionContext, req: ExecuteRequest): Promise<ActionResult<unknown>> {
    const started = now().getTime();
    let def: AnyAction | undefined;
    let input: unknown = req.input;
    const key = ctx.idempotencyKey ?? req.idempotencyKey;
    try {
      def = resolve(ctx, req.action, req.version);
      const d = def;
      const gated = await gate(ctx, d, req.input);
      input = gated.input;

      // ── queries ──
      if (d.kind === 'query') {
        const { result } = await host.transaction(ctx, { rollback: false, readOnly: true }, (tx) =>
          runHandler(tx, ctx, d, input, 'execute'),
        );
        if (isAudited(d, ctx)) await safeAuditOutside(ctx, auditEntry(ctx, d, input, 'ok', started, { result }));
        if (ctx.source === 'assistant') {
          await host.meterOutside(
            { meter: 'assistant.actions', quantity: 1, unit: 'call', module: d.module, source: ctx.source, requestId: ctx.requestId },
            ctx,
          );
        }
        return { ok: true, data: result, meta: meta(ctx, d, req) };
      }

      // ── commands ──
      if (key === undefined && requireKeyFor.includes(ctx.source)) throw refuse(ctx, 'IDEMPOTENCY_KEY_REQUIRED');

      // Confirmation: invalid or missing refuse now; expired is refused inside the
      // transaction unless the call turns out to be a replay of a committed execute.
      let confirmation: { id: string; fingerprint: string; expiresAt: Date } | undefined;
      let expired = false;
      if (d.requiresConfirmation) {
        if (!req.confirmation) {
          if (ctx.source === 'assistant') throw refuse(ctx, 'CONFIRMATION_REQUIRED');
        } else {
          const check = await verifyConfirmation(
            await host.confirmationSecret(),
            req.confirmation.id,
            {
              fingerprint: req.confirmation.fingerprint,
              tenantId: ctx.tenantId,
              userId: ctx.userId,
              action: d.name,
              version: d.version,
            },
            now(),
          );
          if (!check.ok && check.reason === 'invalid') throw refuse(ctx, 'CONFIRMATION_REQUIRED', { reason: 'invalid' });
          if (!check.ok) expired = true;
          else confirmation = { ...req.confirmation, expiresAt: check.expiresAt };
        }
      }

      const hash = key !== undefined ? await inputHash(d.name, d.version, input) : undefined;

      // Step-up: the assistant, a financial action, and a policy with a limit.
      const settings = gated.settings;
      if (
        confirmation &&
        settings &&
        d.risk === 'financial' &&
        settings.policy.financialLimit !== undefined &&
        settings.policy.stepUp !== 'none' &&
        host.assistant
      ) {
        // A retry of an execute that already committed replays, whatever the data looks like now.
        if (key !== undefined && hash !== undefined) {
          const peek = await host.transaction(ctx, { rollback: true, readOnly: false }, (tx) =>
            tx.claimIdempotency(key, hash),
          );
          if (peek.state === 'done') {
            const m = meta(ctx, d, req);
            m.replayed = true;
            m.events = [...peek.result.events];
            await safeAuditOutside(ctx, auditEntry(ctx, d, input, 'replayed', started, { idempotencyKey: key }));
            return { ok: true, data: peek.result.data, meta: m };
          }
        }
        const fresh = await rolledBackPreview(ctx, d, input);
        const fp = await fingerprintOf(ctx, d, input, fresh);
        if (fp !== confirmation.fingerprint) {
          throw new Refusal(
            standardError('PREVIEW_STALE', ctx.locale, await previewResult(ctx, d, input, fresh, settings, fp)),
            'error',
          );
        }
        if (stepUpRequired(settings, d, fresh.primaryAmount, ctx)) {
          const state = await host.assistant.stepUp(ctx, {
            confirmationId: confirmation.id,
            action: d.name,
            version: d.version,
            preview: fresh,
            expiresAt: confirmation.expiresAt.toISOString(),
          });
          if (state.status === 'pending')
            throw refuse(ctx, 'STEP_UP_REQUIRED', { stepUpId: state.stepUpId, expiresAt: state.expiresAt });
          if (state.status === 'declined')
            throw refuse(ctx, 'ASSISTANT_POLICY_DENIED', { reason: 'step_up_declined' });
        }
      }

      const outcome = await host.transaction(ctx, { rollback: false, readOnly: false }, async (tx) => {
        if (key !== undefined && hash !== undefined) {
          const claim = await tx.claimIdempotency(key, hash);
          if (claim.state === 'done') return { replayed: true, data: claim.result.data, events: claim.result.events };
          if (claim.state === 'running') throw refuse(ctx, 'IDEMPOTENCY_IN_PROGRESS');
          if (claim.state === 'mismatch') throw refuse(ctx, 'IDEMPOTENCY_KEY_REUSED');
        }
        if (expired) throw refuse(ctx, 'PREVIEW_EXPIRED');
        if (confirmation && (await tx.consumeConfirmation(confirmation.id, key)) === 'used')
          throw refuse(ctx, 'CONFIRMATION_USED');

        const { result, events: emitted } = await runHandler(tx, ctx, d, input, 'execute');

        if (confirmation) {
          const described = await describe(d, input, result, ctx);
          const fp = await fingerprintOf(ctx, d, input, described);
          if (fp !== confirmation.fingerprint) {
            throw new Refusal(
              standardError('PREVIEW_STALE', ctx.locale, await previewResult(ctx, d, input, described, settings, fp)),
              'error',
            );
          }
        }

        await tx.audit(auditEntry(ctx, d, input, 'ok', started, { result, idempotencyKey: key }));
        if (key !== undefined && hash !== undefined) await tx.storeIdempotency(key, hash, { data: result, events: emitted });
        if (ctx.source === 'assistant') {
          await tx.meter({
            meter: 'assistant.actions',
            quantity: 1,
            unit: 'call',
            module: d.module,
            source: ctx.source,
            requestId: ctx.requestId,
          });
        }
        return { replayed: false, data: result, events: emitted };
      });

      const m = meta(ctx, d, req);
      m.replayed = outcome.replayed;
      m.events = [...outcome.events];
      if (outcome.replayed) {
        await safeAuditOutside(ctx, auditEntry(ctx, d, input, 'replayed', started, { idempotencyKey: key }));
      } else if (outcome.events.length > 0) {
        try {
          host.afterCommit?.(ctx, [...outcome.events]);
        } catch (e) {
          host.logError?.(e, ctx, d.name);
        }
      }
      return { ok: true, data: outcome.data, meta: m };
    } catch (e) {
      return toFailure(e, ctx, def, input, started, meta(ctx, def, req), key);
    }
  }

  return {
    register,
    registerEvents,
    registerErrors,
    validate,
    get,
    list,
    preview,
    execute,
    catalog,
    catalogHash,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function rowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  if (isRecord(result) && Array.isArray(result['items'])) return (result['items'] as unknown[]).length;
  return 1;
}

/** Copy `input` with each sensitive path (top-level key or dotted path) replaced by "[redacted]". */
export function redact(input: unknown, paths: readonly string[] | undefined): unknown {
  if (!paths || paths.length === 0) return input;
  const copy: unknown = input === undefined ? undefined : JSON.parse(JSON.stringify(input));
  for (const path of paths) redactPath(copy, path.split('.'));
  return copy;
}

function redactPath(node: unknown, segments: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) redactPath(item, segments);
    return;
  }
  if (!isRecord(node) || segments.length === 0) return;
  const [head, ...rest] = segments as [string, ...string[]];
  if (!(head in node)) return;
  if (rest.length === 0) node[head] = '[redacted]';
  else redactPath(node[head], rest);
}
