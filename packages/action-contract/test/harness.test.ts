import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineAction, moneyToScaled } from '../src/index.js';
import { runContractChecks } from '../src/testing/index.js';
import { MADINA, TENANT_B, ctxFor, formatMoney, madinaInvoice, makeApp } from './fixtures/app.js';
import type { Runtime } from './fixtures/app.js';

describe('runContractChecks', () => {
  it('passes for well-behaved commands', async () => {
    const { host, registry } = makeApp();
    const report = await runContractChecks(registry, host, [
      {
        action: 'sales.invoice.post',
        ctx: ctxFor(),
        input: madinaInvoice,
        isolation: { ctx: ctxFor({ tenantId: TENANT_B }) },
      },
      {
        action: 'masters.customer.update',
        ctx: ctxFor(),
        input: { customerId: MADINA, phone: '03005556666' },
        isolation: { ctx: ctxFor({ tenantId: TENANT_B }) },
      },
    ]);
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(new Set(report.results.map((r) => r.check))).toEqual(
      new Set([
        'is-command',
        'permission-denied',
        'preview-leaves-no-trace',
        'preview-is-stable',
        'preview-equals-commit',
        'outbox-in-transaction',
        'idempotent-replay',
        'rollback-on-failure',
        'tenant-isolation',
      ]),
    );
  });

  it('catches a preview that does not match the commit', async () => {
    const { host, registry } = makeApp();
    let calls = 0;
    registry.register(
      defineAction<{ customerId: string }, { fee: string }, Runtime>({
        name: 'sales.fee.charge',
        version: 1,
        kind: 'command',
        module: 'SALES',
        description: 'Charges a fee that changes on every run — a broken action.',
        tags: ['sales'],
        input: z.object({ customerId: z.string() }),
        output: z.object({ fee: z.string() }),
        permissions: ['invoice:create'],
        risk: 'financial',
        requiresConfirmation: true,
        idempotent: true,
        handler: async (input, ctx) => {
          const customer = ctx.runtime.customers.get(input.customerId)!;
          const fee = formatMoney(BigInt(++calls) * 10_000n);
          customer.balance = formatMoney(moneyToScaled(customer.balance) + moneyToScaled(fee));
          return { fee };
        },
        preview: ({ result }) => ({
          summary: { en: `Fee ${result.fee}`, ur: `فیس ${result.fee}` },
          primaryAmount: result.fee,
          changes: [{ op: 'post', entity: 'fee', label: { en: 'Fee', ur: 'فیس' }, amounts: { fee: result.fee } }],
          warnings: [],
        }),
      }),
    );
    const report = await runContractChecks(registry, host, [
      { action: 'sales.fee.charge', ctx: ctxFor(), input: { customerId: MADINA } },
    ]);
    expect(report.passed).toBe(false);
    expect(report.failures.map((f) => f.check)).toEqual(
      expect.arrayContaining(['preview-is-stable', 'preview-equals-commit']),
    );
  });

  it('reports a query given as a command fixture', async () => {
    const { host, registry } = makeApp();
    const report = await runContractChecks(registry, host, [
      { action: 'masters.customer.search', ctx: ctxFor(), input: { query: 'x' } },
    ]);
    expect(report.failures).toEqual([{ action: 'masters.customer.search', check: 'is-command', ok: false, detail: 'kind is query' }]);
  });
});
