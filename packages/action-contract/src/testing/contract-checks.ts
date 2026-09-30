import type { ActionContext } from '../context.js';
import type { ActionRegistry } from '../registry.js';
import type { ExecuteRequest } from '../results.js';

/** What the harness needs from a host besides the registry. An app implements it over its test database. */
export interface ContractCheckHost {
  /** A stable string of all state a transaction may change (data, outbox, idempotency, confirmations). */
  snapshot(): string | Promise<string>;
  outboxCount(): number | Promise<number>;
  /** Make the next transaction fail after its work and before commit. */
  failNextTransaction(): void;
}

export interface CommandFixture {
  action: string;
  version?: number;
  /** A context whose user holds the action's permissions. Use a UI source such as 'web'. */
  ctx: ActionContext;
  input: unknown;
  /** Same input from another company: must fail (default code NOT_FOUND) and change nothing. */
  isolation?: { ctx: ActionContext; expectCode?: string };
}

export type ContractCheckName =
  | 'is-command'
  | 'permission-denied'
  | 'preview-leaves-no-trace'
  | 'preview-is-stable'
  | 'preview-equals-commit'
  | 'outbox-in-transaction'
  | 'idempotent-replay'
  | 'rollback-on-failure'
  | 'tenant-isolation';

export interface ContractCheckResult {
  action: string;
  check: ContractCheckName;
  ok: boolean;
  detail?: string;
}

export interface ContractCheckReport {
  passed: boolean;
  results: ContractCheckResult[];
  failures: ContractCheckResult[];
}

let keySeq = 0;
const freshKey = (action: string) => `contract-check:${action}:${Date.now()}:${++keySeq}`;

/**
 * The five-check harness from the readiness plan, run against real commands:
 * permission denied, tenant isolation, preview === commit (and preview leaves
 * no trace, and is stable), idempotent retry, outbox written in the same
 * transaction (and rolled back with it).
 *
 * Each fixture's command is executed for real, so run it on a disposable
 * database or an in-memory host.
 */
export async function runContractChecks(
  registry: ActionRegistry,
  host: ContractCheckHost,
  fixtures: readonly CommandFixture[],
): Promise<ContractCheckReport> {
  const results: ContractCheckResult[] = [];

  for (const f of fixtures) {
    const record = (check: ContractCheckName, ok: boolean, detail?: string) => {
      const r: ContractCheckResult = { action: f.action, check, ok };
      if (detail !== undefined) r.detail = detail;
      results.push(r);
      return ok;
    };

    const def = registry.get(f.action, f.version);
    if (!record('is-command', def?.kind === 'command', def ? `kind is ${def.kind}` : 'not registered') || !def) continue;
    const base = { action: def.name, version: def.version, input: f.input };

    // 1. permission denied — and nothing changes
    if (def.permissions.length > 0) {
      const before = await host.snapshot();
      const denied = await registry.execute(
        { ...f.ctx, permissions: [], requestId: `${f.ctx.requestId}:denied` },
        { ...base, idempotencyKey: freshKey(def.name) },
      );
      const unchanged = (await host.snapshot()) === before;
      record(
        'permission-denied',
        !denied.ok && denied.error.code === 'PERMISSION_DENIED' && unchanged,
        denied.ok ? 'executed without permissions' : `${denied.error.code}${unchanged ? '' : ', state changed'}`,
      );
    }

    // 2. preview leaves no trace, and 3. is stable
    let confirmation: ExecuteRequest['confirmation'];
    if (def.preview) {
      const before = await host.snapshot();
      const p1 = await registry.preview(f.ctx, base);
      const afterFirst = await host.snapshot();
      record(
        'preview-leaves-no-trace',
        p1.ok && afterFirst === before,
        p1.ok ? (afterFirst === before ? undefined : 'state changed after preview') : `preview failed: ${p1.error.code}`,
      );
      const p2 = await registry.preview(f.ctx, base);
      const stable = p1.ok && p2.ok && p1.data.fingerprint === p2.data.fingerprint;
      record('preview-is-stable', stable, stable ? undefined : 'two previews of the same input differ');
      if (p1.ok) confirmation = { id: p1.data.confirmationId, fingerprint: p1.data.fingerprint };
    }

    // 4. preview === commit, and 5. outbox in the same transaction
    const key = freshKey(def.name);
    const outboxBefore = await host.outboxCount();
    const req: ExecuteRequest = { ...base, idempotencyKey: key };
    if (confirmation) req.confirmation = confirmation;
    const executed = await registry.execute(f.ctx, req);
    record(
      'preview-equals-commit',
      executed.ok,
      executed.ok ? undefined : `execute failed: ${executed.error.code} ${executed.error.message}`,
    );
    if (!executed.ok) continue;
    const outboxAfter = await host.outboxCount();
    record(
      'outbox-in-transaction',
      outboxAfter === outboxBefore + executed.meta.events.length,
      `outbox grew by ${outboxAfter - outboxBefore}, meta.events has ${executed.meta.events.length}`,
    );

    // 6. idempotent retry — same key, same result, no second effect
    const beforeRetry = await host.snapshot();
    const retry = await registry.execute(f.ctx, req);
    const retryUnchanged = (await host.snapshot()) === beforeRetry;
    record(
      'idempotent-replay',
      retry.ok && retry.meta.replayed && retryUnchanged,
      retry.ok ? `replayed=${retry.meta.replayed}${retryUnchanged ? '' : ', state changed'}` : retry.error.code,
    );

    // 7. a failure before commit rolls everything back, outbox included
    {
      let failConfirmation: ExecuteRequest['confirmation'];
      if (def.preview) {
        const p = await registry.preview(f.ctx, base);
        if (p.ok) failConfirmation = { id: p.data.confirmationId, fingerprint: p.data.fingerprint };
      }
      const before = await host.snapshot();
      host.failNextTransaction();
      const failReq: ExecuteRequest = { ...base, idempotencyKey: freshKey(def.name) };
      if (failConfirmation) failReq.confirmation = failConfirmation;
      const failed = await registry.execute(f.ctx, failReq);
      const unchanged = (await host.snapshot()) === before;
      record(
        'rollback-on-failure',
        !failed.ok && unchanged,
        failed.ok ? 'injected failure did not surface' : unchanged ? undefined : 'state changed despite rollback',
      );
    }

    // 8. tenant isolation
    if (f.isolation) {
      const before = await host.snapshot();
      const other = await registry.execute(f.isolation.ctx, { ...base, idempotencyKey: freshKey(def.name) });
      const expected = f.isolation.expectCode ?? 'NOT_FOUND';
      const unchanged = (await host.snapshot()) === before;
      record(
        'tenant-isolation',
        !other.ok && other.error.code === expected && unchanged,
        other.ok ? 'another company executed it' : `${other.error.code}${unchanged ? '' : ', state changed'}`,
      );
    }
  }

  const failures = results.filter((r) => !r.ok);
  return { passed: failures.length === 0, results, failures };
}
