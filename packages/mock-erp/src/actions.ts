import { z } from 'zod';
import {
  AssistantSettings,
  AssistantUsageRecordInput,
  CoreContextOutput,
  IsoDate,
  MoneyString,
  SearchInput,
  SearchOutput,
  Uuid,
  defineAction,
  defineEvent,
  pageWithTotals,
} from '@m-ai/action-contract';
import type { ActionContext, AssistantQuota } from '@m-ai/action-contract';
import type { Customer, Invoice, MockData, Product } from './data.js';
import { formatMoney, priceLines, toScaled } from './data.js';

// ─────────────────────────────────────────────────────────────────────────────
// Runtime — what handlers use, bound to one company (the stand-in for RLS)
// ─────────────────────────────────────────────────────────────────────────────

export interface RuntimeDeps {
  settings: (tenantId: string) => AssistantSettings;
  quota: (tenantId: string) => AssistantQuota;
  today: () => string;
}

export function createRuntime(data: MockData, ctx: ActionContext, deps: RuntimeDeps) {
  const mine = <T extends { tenantId: string }>(rows: T[]) => rows.filter((r) => r.tenantId === ctx.tenantId);
  const outstanding = (c: Customer) => {
    const invoiced = mine(data.invoices)
      .filter((i) => i.customerId === c.id && i.status === 'posted')
      .reduce((s, i) => s + toScaled(i.gross), 0n);
    const received = mine(data.receipts)
      .filter((r) => r.customerId === c.id)
      .reduce((s, r) => s + toScaled(r.amount), 0n);
    return toScaled(c.openingBalance) + invoiced - received;
  };
  return {
    ctx,
    tenant: () => data.tenants.find((t) => t.id === ctx.tenantId)!,
    user: () => data.users.find((u) => u.id === ctx.userId && u.tenantId === ctx.tenantId),
    today: deps.today,
    settings: () => deps.settings(ctx.tenantId),
    quota: () => deps.quota(ctx.tenantId),
    customers: {
      all: () => mine(data.customers),
      get: (id: string) => mine(data.customers).find((c) => c.id === id),
      outstanding,
    },
    products: {
      all: () => mine(data.products),
      get: (id: string) => mine(data.products).find((p) => p.id === id),
    },
    bookers: {
      get: (id: string | null) => (id ? mine(data.bookers).find((b) => b.id === id) : undefined),
    },
    invoices: {
      all: () => mine(data.invoices),
      get: (id: string) => mine(data.invoices).find((i) => i.id === id),
      byNumber: (no: string) => mine(data.invoices).find((i) => i.invoiceNo.toLowerCase() === no.toLowerCase()),
      nextNumber: () => {
        const n = (data.counters[ctx.tenantId] ?? 0) + 1;
        data.counters[ctx.tenantId] = n;
        return `INV-${String(n).padStart(4, '0')}`;
      },
      insert: (inv: Invoice) => void data.invoices.push(inv),
    },
    receipts: { all: () => mine(data.receipts) },
    files: {
      add: (fileName: string) => {
        const id = `file-${data.files.length + 1}`;
        data.files.push({ id, tenantId: ctx.tenantId, fileName });
        return id;
      },
    },
    usage: {
      record: (turnId: string, kind: string, costUsd: string) => {
        if (!data.usage.some((u) => u.tenantId === ctx.tenantId && u.turnId === turnId))
          data.usage.push({ tenantId: ctx.tenantId, turnId, kind, costUsd });
      },
    },
  };
}
export type Runtime = ReturnType<typeof createRuntime>;

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

export interface Events {
  'invoice.posted': { invoiceId: string; invoiceNo: string; customerId: string; gross: string };
  'invoice.cancelled': { invoiceId: string; invoiceNo: string };
  'customer.updated': { customerId: string };
  'document.rendered': { fileId: string; kind: string };
}

export const EVENTS = [
  defineEvent({
    type: 'invoice.posted',
    version: 1,
    module: 'FBR',
    description: 'A sales invoice was posted.',
    audience: 'invoice:view',
    payload: z.object({ invoiceId: Uuid, invoiceNo: z.string(), customerId: Uuid, gross: MoneyString }),
  }),
  defineEvent({
    type: 'invoice.cancelled',
    version: 1,
    module: 'FBR',
    description: 'A posted sales invoice was cancelled.',
    audience: 'invoice:view',
    payload: z.object({ invoiceId: Uuid, invoiceNo: z.string() }),
  }),
  defineEvent({
    type: 'customer.updated',
    version: 1,
    module: 'CORE',
    description: "A customer's details were changed.",
    payload: z.object({ customerId: Uuid }),
  }),
  defineEvent({
    type: 'document.rendered',
    version: 1,
    module: 'FBR',
    description: 'A document was rendered to PDF.',
    payload: z.object({ fileId: z.string(), kind: z.string() }),
  }),
];

export const MODULE_ERRORS = {
  'sales.credit_limit_exceeded': { en: 'The customer would go over the credit limit.', ur: 'گاہک کی ادھار کی حد سے تجاوز ہو جائے گا۔' },
  'sales.insufficient_stock': { en: 'There is not enough stock.', ur: 'اسٹاک کافی نہیں ہے۔' },
  'documents.busy': { en: 'Many documents are printing. Try again in a moment.', ur: 'بہت سے دستاویزات پرنٹ ہو رہے ہیں۔ تھوڑی دیر بعد کوشش کریں۔', http: 503, retryable: true },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Fuzzy matching (the real ERP uses pg_trgm)
// ─────────────────────────────────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function bigrams(s: string): string[] {
  const t = s.replace(/ /g, '');
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}
export function similarity(query: string, text: string): number {
  const q = norm(query);
  const t = norm(text);
  if (!q || !t) return 0;
  if (q === t) return 1;
  if (t.startsWith(q)) return 0.9;
  if (t.includes(q)) return 0.8;
  const a = bigrams(q);
  const b = bigrams(t);
  if (a.length === 0 || b.length === 0) return 0;
  const pool = [...b];
  let hits = 0;
  for (const g of a) {
    const i = pool.indexOf(g);
    if (i >= 0) {
      hits++;
      pool.splice(i, 1);
    }
  }
  return Math.round(((2 * hits) / (a.length + b.length)) * 100) / 100;
}

function search<T>(
  rows: T[],
  query: string,
  limit: number,
  fields: (row: T) => { name: string; code: string; phone?: string },
) {
  const digits = query.replace(/\D/g, '');
  return rows
    .map((row) => {
      const f = fields(row);
      if (f.code.toLowerCase() === query.trim().toLowerCase()) return { row, score: 1, matchedOn: 'code' as const };
      if (f.phone && digits.length >= 6 && f.phone.includes(digits)) return { row, score: 0.95, matchedOn: 'phone' as const };
      return { row, score: similarity(query, f.name), matchedOn: 'name' as const };
    })
    .filter((h) => h.score >= 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

export const contextGet = defineAction<Record<string, never>, z.infer<typeof CoreContextOutput>, Runtime, Events>({
  name: 'core.context.get',
  version: 1,
  kind: 'query',
  module: 'CORE',
  description: 'Who the user is, which company, its timezone, today, the fiscal year and the assistant settings.',
  tags: ['context'],
  input: z.object({}),
  output: CoreContextOutput,
  permissions: [],
  risk: 'read',
  requiresConfirmation: false,
  idempotent: true,
  handler: async (_input, ctx) => {
    const t = ctx.runtime.tenant();
    const u = ctx.runtime.user();
    const today = ctx.runtime.today();
    const year = Number(today.slice(0, 4));
    const month = Number(today.slice(5, 7));
    const startYear = month >= t.fiscalYearStartMonth ? year : year - 1;
    const mm = String(t.fiscalYearStartMonth).padStart(2, '0');
    const endMonth = t.fiscalYearStartMonth === 1 ? 12 : t.fiscalYearStartMonth - 1;
    const endYear = t.fiscalYearStartMonth === 1 ? startYear : startYear + 1;
    const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
    return {
      user: { id: ctx.userId, displayName: u?.displayName ?? 'User', roles: u?.roles ?? [], locale: u?.locale ?? ctx.locale },
      company: {
        id: t.id,
        name: t.name,
        timezone: t.timezone,
        currency: t.currency,
        fiscalYear: { start: `${startYear}-${mm}-01`, end: `${endYear}-${String(endMonth).padStart(2, '0')}-${lastDay}` },
      },
      today,
      licensedModules: ['CORE', 'FBR', 'ASSISTANT'],
      assistant: { settings: ctx.runtime.settings(), quota: ctx.runtime.quota() },
    };
  },
});

export const customerSearch = defineAction<z.infer<typeof SearchInput>, z.infer<typeof SearchOutput>, Runtime, Events>({
  name: 'masters.customer.search',
  version: 1,
  kind: 'query',
  module: 'CORE',
  description: 'Find customers (shops) by name, code or phone. Tolerant of spelling. Returns area and phone to tell similar names apart.',
  tags: ['customers', 'search'],
  examples: [{ title: 'Find Madina Store', input: { query: 'madina' } }],
  input: SearchInput,
  output: SearchOutput,
  permissions: ['customer:view'],
  risk: 'read',
  requiresConfirmation: false,
  idempotent: true,
  paging: { defaultLimit: 5, maxLimit: 20 },
  handler: async (input, ctx) => ({
    items: search(ctx.runtime.customers.all(), input.query, input.limit ?? 5, (c) => c).map(({ row, score, matchedOn }) => ({
      id: row.id,
      display: row.name,
      disambiguation: { area: row.area, code: row.code, phone: row.phone },
      score,
      matchedOn,
    })),
  }),
});

export const productSearch = defineAction<z.infer<typeof SearchInput>, z.infer<typeof SearchOutput>, Runtime, Events>({
  name: 'masters.product.search',
  version: 1,
  kind: 'query',
  module: 'CORE',
  description: 'Find products by name or code. Returns pack size and rate to tell similar products apart.',
  tags: ['products', 'search'],
  input: SearchInput,
  output: SearchOutput,
  permissions: ['product:view'],
  risk: 'read',
  requiresConfirmation: false,
  idempotent: true,
  paging: { defaultLimit: 5, maxLimit: 20 },
  handler: async (input, ctx) => ({
    items: search(ctx.runtime.products.all(), input.query, input.limit ?? 5, (p: Product) => p).map(({ row, score, matchedOn }) => ({
      id: row.id,
      display: row.name,
      disambiguation: { code: row.code, packSize: row.packSize, rate: row.rate, stock: String(row.stock) },
      score,
      matchedOn,
    })),
  }),
});

const PostInput = z.object({
  customerId: Uuid,
  date: IsoDate.optional().describe('Defaults to today.'),
  bookerId: Uuid.optional(),
  lines: z
    .array(z.object({ productId: Uuid, quantity: z.number().int().positive().describe('Number of cartons.') }))
    .min(1),
});
const PostOutput = z.object({
  invoiceId: Uuid,
  invoiceNo: z.string(),
  date: IsoDate,
  customerName: z.string(),
  lines: z.array(z.object({ product: z.string(), quantity: z.number().int(), rate: MoneyString, amount: MoneyString })),
  net: MoneyString,
  tax: MoneyString,
  gross: MoneyString,
  balanceAfter: MoneyString,
  creditLimit: MoneyString,
});

export const invoicePost = defineAction<z.infer<typeof PostInput>, z.infer<typeof PostOutput>, Runtime, Events>({
  name: 'sales.invoice.post',
  version: 1,
  kind: 'command',
  module: 'FBR',
  description: 'Post a sales invoice (order) for a customer: prices the cartons, adds 18% sales tax, checks stock and the credit limit.',
  tags: ['sales', 'invoices', 'orders'],
  examples: [{ title: 'Ten cartons of Pepsi for a shop', input: { customerId: '0192d000-0000-7000-8000-000000000101', lines: [{ productId: '0192d000-0000-7000-8000-000000000201', quantity: 10 }] } }],
  input: PostInput,
  output: PostOutput,
  permissions: ['invoice:create'],
  risk: 'financial',
  requiresConfirmation: true,
  idempotent: true,
  handler: async (input, ctx) => {
    const customer = ctx.runtime.customers.get(input.customerId);
    if (!customer) return ctx.fail('NOT_FOUND', { en: 'Customer not found.', ur: 'گاہک نہیں ملا۔' });
    const lines: Array<[string, number, string]> = [];
    const named: Array<{ product: string; quantity: number }> = [];
    for (const l of input.lines) {
      const p = ctx.runtime.products.get(l.productId);
      if (!p) return ctx.fail('NOT_FOUND', { en: 'Product not found.', ur: 'پروڈکٹ نہیں ملی۔' });
      if (p.stock < l.quantity)
        return ctx.fail('sales.insufficient_stock', { en: `Only ${p.stock} cartons of ${p.name} in stock.`, ur: `${p.name} کے صرف ${p.stock} کارٹن اسٹاک میں ہیں۔` }, { productId: p.id, available: p.stock });
      p.stock -= l.quantity;
      lines.push([p.id, l.quantity, p.rate]);
      named.push({ product: p.name, quantity: l.quantity });
    }
    const priced = priceLines(lines);
    const balanceAfter = ctx.runtime.customers.outstanding(customer) + toScaled(priced.gross);
    if (balanceAfter > toScaled(customer.creditLimit)) {
      return ctx.fail(
        'sales.credit_limit_exceeded',
        { en: `${customer.name} would go over the credit limit of ${customer.creditLimit}.`, ur: `${customer.name} کی ادھار کی حد ${customer.creditLimit} سے تجاوز ہو جائے گا۔` },
        { creditLimit: customer.creditLimit, balanceAfter: formatMoney(balanceAfter) },
      );
    }
    const invoice: Invoice = {
      id: `0192d000-0000-7000-8000-${String(900 + ctx.runtime.invoices.all().length).padStart(12, '0')}`,
      tenantId: ctx.tenantId,
      invoiceNo: ctx.runtime.invoices.nextNumber(),
      customerId: customer.id,
      bookerId: input.bookerId ?? null,
      date: input.date ?? ctx.runtime.today(),
      status: 'posted',
      ...priced,
    };
    ctx.runtime.invoices.insert(invoice);
    await ctx.emit('invoice.posted', { invoiceId: invoice.id, invoiceNo: invoice.invoiceNo, customerId: customer.id, gross: invoice.gross });
    return {
      invoiceId: invoice.id,
      invoiceNo: invoice.invoiceNo,
      date: invoice.date,
      customerName: customer.name,
      lines: priced.lines.map((l, i) => ({ product: named[i]!.product, quantity: l.quantity, rate: l.rate, amount: l.amount })),
      net: invoice.net,
      tax: invoice.tax,
      gross: invoice.gross,
      balanceAfter: formatMoney(balanceAfter),
      creditLimit: customer.creditLimit,
    };
  },
  preview: ({ result }) => {
    const near = toScaled(result.balanceAfter) * 10n > toScaled(result.creditLimit) * 8n;
    const items = result.lines.map((l) => `${l.quantity} × ${l.product}`).join(', ');
    return {
      summary: {
        en: `Invoice ${result.invoiceNo} to ${result.customerName}: ${items}. Net ${result.net}, tax ${result.tax}, total ${result.gross}.`,
        ur: `${result.customerName} کے لیے انوائس ${result.invoiceNo}: ${items}۔ رقم ${result.net}، ٹیکس ${result.tax}، کل ${result.gross}۔`,
      },
      primaryAmount: result.gross,
      changes: [
        {
          op: 'post',
          entity: 'sales_invoice',
          ref: result.invoiceNo,
          label: { en: 'Sales invoice', ur: 'سیلز انوائس' },
          amounts: { net: result.net, tax: result.tax, gross: result.gross },
        },
      ],
      warnings: near
        ? [{ code: 'sales.near_credit_limit', message: { en: `Balance after this invoice: ${result.balanceAfter} of ${result.creditLimit} limit.`, ur: `اس انوائس کے بعد بقایا: ${result.balanceAfter}، حد ${result.creditLimit}۔` } }]
        : [],
    };
  },
});

export const invoiceCancel = defineAction<{ invoiceId: string; reason: string }, { invoiceId: string; invoiceNo: string }, Runtime, Events>({
  name: 'sales.invoice.cancel',
  version: 1,
  kind: 'command',
  module: 'FBR',
  description: 'Cancel a posted sales invoice and reverse its effect.',
  tags: ['sales', 'invoices'],
  input: z.object({ invoiceId: Uuid, reason: z.string().min(3) }),
  output: z.object({ invoiceId: Uuid, invoiceNo: z.string() }),
  permissions: ['invoice:cancel'],
  risk: 'destructive',
  requiresConfirmation: true,
  idempotent: true,
  handler: async (input, ctx) => {
    const inv = ctx.runtime.invoices.get(input.invoiceId);
    if (!inv) return ctx.fail('NOT_FOUND', { en: 'Invoice not found.', ur: 'انوائس نہیں ملی۔' });
    if (inv.status === 'cancelled') return ctx.fail('CONFLICT', { en: 'Already cancelled.', ur: 'پہلے ہی منسوخ ہے۔' });
    inv.status = 'cancelled';
    await ctx.emit('invoice.cancelled', { invoiceId: inv.id, invoiceNo: inv.invoiceNo });
    return { invoiceId: inv.id, invoiceNo: inv.invoiceNo };
  },
  preview: ({ result }) => ({
    summary: { en: `Cancel invoice ${result.invoiceNo}.`, ur: `انوائس ${result.invoiceNo} منسوخ کریں۔` },
    changes: [{ op: 'reverse', entity: 'sales_invoice', ref: result.invoiceNo, label: { en: 'Sales invoice', ur: 'سیلز انوائس' } }],
    warnings: [],
  }),
});

export const invoiceGet = defineAction({
  name: 'sales.invoice.get',
  version: 1,
  kind: 'query',
  module: 'FBR',
  description: 'Show one sales invoice by its number, e.g. INV-0003, with lines and totals.',
  tags: ['sales', 'invoices'],
  input: z.object({ invoiceNo: z.string().min(1) }),
  output: z.object({
    invoiceId: Uuid,
    invoiceNo: z.string(),
    date: IsoDate,
    customerName: z.string(),
    status: z.enum(['posted', 'cancelled']),
    lines: z.array(z.object({ product: z.string(), quantity: z.number().int(), rate: MoneyString, amount: MoneyString })),
    net: MoneyString,
    tax: MoneyString,
    gross: MoneyString,
  }),
  permissions: ['invoice:view'],
  risk: 'read',
  requiresConfirmation: false,
  idempotent: true,
  handler: async (input, ctx: { runtime: Runtime; fail: (code: string, m: { en: string; ur: string }) => never }) => {
    const inv = ctx.runtime.invoices.byNumber(input.invoiceNo);
    if (!inv) return ctx.fail('NOT_FOUND', { en: `Invoice ${input.invoiceNo} not found.`, ur: `انوائس ${input.invoiceNo} نہیں ملی۔` });
    return {
      invoiceId: inv.id,
      invoiceNo: inv.invoiceNo,
      date: inv.date,
      customerName: ctx.runtime.customers.get(inv.customerId)?.name ?? '—',
      status: inv.status,
      lines: inv.lines.map((l) => ({ product: ctx.runtime.products.get(l.productId)?.name ?? '—', quantity: l.quantity, rate: l.rate, amount: l.amount })),
      net: inv.net,
      tax: inv.tax,
      gross: inv.gross,
    };
  },
});

const SummaryRow = z.object({ key: z.string(), name: z.string(), invoices: z.number().int(), gross: MoneyString });

export const salesSummary = defineAction({
  name: 'reports.sales.summary',
  version: 1,
  kind: 'query',
  module: 'FBR',
  description: 'Sales for a date range grouped by customer, booker or product, with totals over the whole range (net, tax, gross).',
  tags: ['sales', 'reports'],
  examples: [{ title: "Today's sales by booker", input: { from: '2026-10-02', to: '2026-10-02', groupBy: 'booker' } }],
  input: z.object({
    from: IsoDate,
    to: IsoDate,
    groupBy: z.enum(['customer', 'booker', 'product']).default('customer'),
    limit: z.number().int().optional(),
  }),
  output: pageWithTotals(SummaryRow),
  permissions: ['report_sales:view'],
  risk: 'read',
  requiresConfirmation: false,
  idempotent: true,
  paging: { defaultLimit: 10, maxLimit: 50 },
  handler: async (input, ctx: { runtime: Runtime }) => {
    const rt = ctx.runtime;
    const invoices = rt.invoices.all().filter((i) => i.status === 'posted' && i.date >= input.from && i.date <= input.to);
    const groups = new Map<string, { name: string; invoices: Set<string>; gross: bigint }>();
    const add = (key: string, name: string, invoiceId: string, gross: bigint) => {
      const g = groups.get(key) ?? { name, invoices: new Set<string>(), gross: 0n };
      g.invoices.add(invoiceId);
      g.gross += gross;
      groups.set(key, g);
    };
    for (const inv of invoices) {
      if (input.groupBy === 'customer') add(inv.customerId, rt.customers.get(inv.customerId)?.name ?? '—', inv.id, toScaled(inv.gross));
      else if (input.groupBy === 'booker') add(inv.bookerId ?? 'none', rt.bookers.get(inv.bookerId)?.name ?? 'No booker', inv.id, toScaled(inv.gross));
      else
        for (const l of inv.lines)
          add(l.productId, rt.products.get(l.productId)?.name ?? '—', inv.id, (toScaled(l.amount) * 118n) / 100n);
    }
    const rows = [...groups.entries()]
      .map(([key, g]) => ({ key, name: g.name, invoices: g.invoices.size, gross: formatMoney(g.gross) }))
      .sort((a, b) => (toScaled(b.gross) > toScaled(a.gross) ? 1 : -1));
    const sum = (f: (i: Invoice) => string) => formatMoney(invoices.reduce((s, i) => s + toScaled(f(i)), 0n));
    const limit = input.limit ?? 10;
    return {
      items: rows.slice(0, limit),
      nextCursor: null,
      truncated: rows.length > limit,
      totals: { net: sum((i) => i.net), tax: sum((i) => i.tax), gross: sum((i) => i.gross), invoices: String(invoices.length) },
      count: rows.length,
    };
  },
});

const OutstandingRow = z.object({ customerId: Uuid, name: z.string(), area: z.string(), outstanding: MoneyString, creditLimit: MoneyString });

export const receivablesOutstanding = defineAction({
  name: 'reports.receivables.outstanding',
  version: 1,
  kind: 'query',
  module: 'FBR',
  description: 'How much each customer owes (recovery pending), largest first, with the total owed.',
  tags: ['receivables', 'reports'],
  input: z.object({ customerId: Uuid.optional(), limit: z.number().int().optional() }),
  output: pageWithTotals(OutstandingRow),
  permissions: ['receivable:view'],
  risk: 'read',
  requiresConfirmation: false,
  idempotent: true,
  paging: { defaultLimit: 10, maxLimit: 50 },
  handler: async (input, ctx: { runtime: Runtime }) => {
    const rt = ctx.runtime;
    const rows = rt.customers
      .all()
      .filter((c) => !input.customerId || c.id === input.customerId)
      .map((c) => ({ c, owed: rt.customers.outstanding(c) }))
      .filter((r) => r.owed !== 0n)
      .sort((a, b) => (b.owed > a.owed ? 1 : -1));
    const limit = input.limit ?? 10;
    return {
      items: rows.slice(0, limit).map(({ c, owed }) => ({ customerId: c.id, name: c.name, area: c.area, outstanding: formatMoney(owed), creditLimit: c.creditLimit })),
      nextCursor: null,
      truncated: rows.length > limit,
      totals: { outstanding: formatMoney(rows.reduce((s, r) => s + r.owed, 0n)) },
      count: rows.length,
    };
  },
});

export const invoiceRender = defineAction<{ invoiceNo: string }, { fileId: string; fileName: string; pages: number }, Runtime, Events>({
  name: 'documents.invoice.render',
  version: 1,
  kind: 'command',
  module: 'FBR',
  description: 'Render a sales invoice to PDF so it can be sent or printed.',
  tags: ['documents', 'sales', 'render'],
  input: z.object({ invoiceNo: z.string().min(1) }),
  output: z.object({ fileId: z.string(), fileName: z.string(), pages: z.number().int() }),
  permissions: ['invoice:view'],
  risk: 'write',
  requiresConfirmation: false,
  idempotent: true,
  availableWhenReadOnly: true,
  handler: async (input, ctx) => {
    const inv = ctx.runtime.invoices.byNumber(input.invoiceNo);
    if (!inv) return ctx.fail('NOT_FOUND', { en: `Invoice ${input.invoiceNo} not found.`, ur: `انوائس ${input.invoiceNo} نہیں ملی۔` });
    const fileName = `${inv.invoiceNo}.pdf`;
    const fileId = ctx.runtime.files.add(fileName);
    await ctx.emit('document.rendered', { fileId, kind: 'invoice' });
    return { fileId, fileName, pages: 1 };
  },
});

export const customerUpdate = defineAction<{ customerId: string; phone: string }, { customerId: string; name: string; phone: string }, Runtime, Events>({
  name: 'masters.customer.update',
  version: 1,
  kind: 'command',
  module: 'CORE',
  description: "Change a customer's phone number.",
  tags: ['customers'],
  input: z.object({ customerId: Uuid, phone: z.string().regex(/^03\d{9}$/) }),
  output: z.object({ customerId: Uuid, name: z.string(), phone: z.string() }),
  permissions: ['customer:update'],
  risk: 'write',
  requiresConfirmation: false,
  idempotent: true,
  handler: async (input, ctx) => {
    const c = ctx.runtime.customers.get(input.customerId);
    if (!c) return ctx.fail('NOT_FOUND', { en: 'Customer not found.', ur: 'گاہک نہیں ملا۔' });
    c.phone = input.phone;
    await ctx.emit('customer.updated', { customerId: c.id });
    return { customerId: c.id, name: c.name, phone: c.phone };
  },
});

export const settingsGet = defineAction<Record<string, never>, AssistantSettings, Runtime, Events>({
  name: 'assistant.settings.get',
  version: 1,
  kind: 'query',
  module: 'ASSISTANT',
  description: "The company's assistant settings: name, language, tone and policy.",
  tags: ['assistant'],
  input: z.object({}),
  output: AssistantSettings,
  permissions: [],
  risk: 'read',
  requiresConfirmation: false,
  idempotent: true,
  handler: async (_i, ctx) => ctx.runtime.settings(),
});

export const usageRecord = defineAction<AssistantUsageRecordInput, { recorded: true }, Runtime, Events>({
  name: 'assistant.usage.record',
  version: 1,
  kind: 'command',
  module: 'ASSISTANT',
  description: 'Record the model usage and cost of one assistant turn or alert.',
  tags: ['assistant', 'usage'],
  input: AssistantUsageRecordInput,
  output: z.object({ recorded: z.literal(true) }),
  permissions: [],
  risk: 'write',
  requiresConfirmation: false,
  idempotent: true,
  handler: async (input, ctx) => {
    if (ctx.actor?.clientId !== 'm-ai-assistant')
      return ctx.fail('PERMISSION_DENIED', { en: 'Only the assistant records usage.', ur: 'استعمال صرف اسسٹنٹ درج کرتا ہے۔' });
    ctx.runtime.usage.record(input.turnId, input.kind, input.costUsd);
    return { recorded: true as const };
  },
});

export const ACTIONS = [
  contextGet,
  customerSearch,
  productSearch,
  invoicePost,
  invoiceCancel,
  invoiceGet,
  salesSummary,
  receivablesOutstanding,
  invoiceRender,
  customerUpdate,
  settingsGet,
  usageRecord,
];
