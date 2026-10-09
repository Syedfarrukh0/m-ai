/**
 * Live evals talk about real records: "{debtor} ka kitna udhaar hai?". This
 * reads a few from the ERP first (as the owner, read-only) and returns them
 * as the values scenarios fill in. A value that can't be found is left out,
 * and the scenarios that need it are not run.
 */
import { dateRanges } from '../src/index.js';
import type { ActionsClient } from '../src/index.js';

type Row = Record<string, unknown>;

async function query(actions: ActionsClient, action: string, input: Record<string, unknown>): Promise<Row | undefined> {
  try {
    const r = await actions.execute({ action, input });
    return r.ok && r.data && typeof r.data === 'object' ? (r.data as Row) : undefined;
  } catch {
    return undefined;
  }
}

const items = (data: Row | undefined): Row[] => (Array.isArray(data?.['items']) ? (data!['items'] as Row[]) : []);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);

export async function discoverVars(actions: ActionsClient): Promise<{ vars: Record<string, string>; notes: string[] }> {
  const vars: Record<string, string> = {};
  const notes: string[] = [];
  const set = (k: string, v: string | undefined, what: string) => {
    if (v) vars[k] = v;
    else notes.push(`no ${what} found — scenarios needing {${k}} are not run`);
  };

  const ctx = await query(actions, 'core.context.get', {});
  const today = str(ctx?.['today']);
  if (today) {
    vars['today'] = today;
    const company = ctx?.['company'] as Row | undefined;
    const fyStart = str((company?.['fiscalYear'] as Row | undefined)?.['start']);
    const month = dateRanges(today, fyStart).find((r) => r.name === 'this month');
    if (month) vars['monthFrom'] = month.from;
  } else notes.push('core.context.get gave no date');

  const limit = str(((((ctx?.['assistant'] as Row | undefined)?.['settings'] as Row | undefined)?.['policy'] as Row | undefined) ?? {})['financialLimit']);
  if (limit && Number(limit) > 0 && Number(limit) <= 1_000_000) vars['overLimit'] = String(Math.ceil(Number(limit)) + 1000);
  else notes.push('no approval limit set in Accounts → Assistant (e.g. 50,000) — the step-up scenario is not run');

  const owed = items(await query(actions, 'reports.receivables.outstanding', { limit: 5 }));
  const debtor = owed.find((r) => str(r['name']) && Number(r['outstanding']) > 0);
  set('debtor', str(debtor?.['name']), 'customer who owes money');
  if (debtor) vars['debtorId'] = String(debtor['customerId']);

  const customers = items(await query(actions, 'masters.customer.list', { limit: 50 }));
  const customer = customers.find((c) => c['isActive'] !== false && str(c['name']) && c['name'] !== vars['debtor']) ?? customers[0];
  set('customer', str(customer?.['name']), 'customer');

  // A product people really sell. The ERP's data decides what is there, so try in turn:
  // this month's best seller (sales summary) → the lines of the latest invoice → the product list.
  const invoices = items(await query(actions, 'sales.invoice.list', { limit: 1 }));
  set('invoiceNo', str(invoices[0]?.['invoiceNo']), 'invoice');
  if (invoices[0]?.['id']) vars['invoiceId'] = String(invoices[0]['id']);

  let productName: string | undefined;
  let productCode: string | undefined;
  if (vars['monthFrom'] && vars['today']) {
    const top = items(await query(actions, 'reports.sales.summary', { from: vars['monthFrom'], to: vars['today'], groupBy: 'product' }))[0];
    const label = str(top?.['label']);
    productName = label?.replace(/\s*\([^)]*\)\s*$/, '');
    productCode = label ? /\(([^)]+)\)\s*$/.exec(label)?.[1] : undefined;
  }
  if (!productName && vars['invoiceNo']) {
    const inv = await query(actions, 'sales.invoice.get', { invoiceNo: vars['invoiceNo'] });
    const line = (Array.isArray(inv?.['lines']) ? (inv!['lines'] as Row[]) : [])[0];
    productName = str(line?.['description']);
    productCode = str(line?.['productCode']);
  }
  if (!productName) {
    const products = items(await query(actions, 'masters.product.list', { limit: 50 }));
    const p = products.find((x) => x['isActive'] !== false && str(x['name'])) ?? products[0];
    productName = str(p?.['name']);
    productCode = str(p?.['code']);
  }
  set('product', productName, 'product');
  if (productCode) vars['productCode'] = productCode;

  const principals = items(await query(actions, 'masters.company.list', { limit: 20 }));
  const principal = [...principals].sort((a, b) => Number(b['usageCount'] ?? 0) - Number(a['usageCount'] ?? 0))[0];
  set('principal', str(principal?.['name']), 'principal company');

  return { vars, notes };
}
