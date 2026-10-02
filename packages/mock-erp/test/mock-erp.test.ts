import { describe, expect, it } from 'vitest';
import { runContractChecks } from '@m-ai/action-contract/testing';
import { IDS, OTHER_TENANT, createMockErp, similarity } from '../src/index.js';

describe('mock ERP', () => {
  it('passes the contract checks for its commands', async () => {
    const erp = createMockErp();
    const other = erp.webCtx(IDS.otherOwner);
    const report = await runContractChecks(erp.registry, erp.host, [
      {
        action: 'sales.invoice.post',
        ctx: erp.webCtx(),
        input: { customerId: IDS.metro, lines: [{ productId: IDS.pepsi, quantity: 2 }] },
        isolation: { ctx: other },
      },
      {
        action: 'masters.customer.update',
        ctx: erp.webCtx(),
        input: { customerId: IDS.metro, phone: '03001112233' },
        isolation: { ctx: other },
      },
      { action: 'documents.invoice.render', ctx: erp.webCtx(), input: { invoiceNo: 'INV-0001' }, isolation: { ctx: other } },
    ]);
    expect(report.failures).toEqual([]);
    expect(other.tenantId).toBe(OTHER_TENANT);
  });

  it('answers context, search and reports with app-computed totals', async () => {
    const erp = createMockErp();
    const ctx = erp.assistantCtx();
    const context = await erp.registry.execute(ctx, { action: 'core.context.get', input: {} });
    expect(context.ok && context.data).toMatchObject({
      today: '2026-10-02',
      company: { name: 'Demo Distributors', fiscalYear: { start: '2026-07-01', end: '2027-06-30' } },
      assistant: { settings: { enabled: true, name: 'Munshi' }, quota: { state: 'ok' } },
    });

    const found = await erp.registry.execute(ctx, { action: 'masters.customer.search', input: { query: 'madina' } });
    expect(found.ok && (found.data as { items: Array<{ display: string }> }).items.map((i) => i.display)).toEqual([
      'Madina Store',
      'Madina Traders',
    ]);

    const today = await erp.registry.execute(ctx, {
      action: 'reports.sales.summary',
      input: { from: '2026-10-02', to: '2026-10-02', groupBy: 'booker' },
    });
    expect(today.ok && today.data).toMatchObject({ totals: { gross: '2124.00', invoices: '1' }, items: [{ name: 'Usman' }] });

    const owed = await erp.registry.execute(ctx, { action: 'reports.receivables.outstanding', input: {} });
    // openings 65000 + invoiced 49914 − received 25000
    expect(owed.ok && (owed.data as { totals: { outstanding: string } }).totals.outstanding).toBe('89914.00');
  });

  it('matches misspelt names', () => {
    expect(similarity('madina', 'Madina Store')).toBe(0.9);
    expect(similarity('medina stor', 'Madina Store')).toBeGreaterThan(0.4);
    expect(similarity('pepsi', 'Aquafina 1.5L')).toBeLessThan(0.4);
  });

  it('keeps the storekeeper out of sales', async () => {
    const erp = createMockErp();
    const names = (await erp.registry.list(erp.assistantCtx(IDS.storekeeper))).actions.map((a) => a.name);
    expect(names).toContain('masters.product.search');
    expect(names).not.toContain('sales.invoice.post');
    expect(names).not.toContain('documents.invoice.render');
  });
});
