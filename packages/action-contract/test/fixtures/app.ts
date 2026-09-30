/**
 * A tiny ERP-like app used by the tests: customers, invoices, a sales report,
 * the well-known context and usage actions. Handlers only see their own
 * company's rows (the stand-in for row security).
 */
import { z } from 'zod';
import {
  AssistantUsageRecordInput,
  CoreContextOutput,
  IsoDate,
  MoneyString,
  SearchInput,
  SearchOutput,
  Uuid,
  createActionRegistry,
  defineAction,
  defineEvent,
  moneyToScaled,
  pageWithTotals,
} from '../../src/index.js';
import type { ActionContext, ActionRegistry, RegistryOptions } from '../../src/index.js';
import { InMemoryHost } from '../../src/testing/index.js';
import type { InMemoryHostOptions } from '../../src/testing/index.js';

// ── data ────────────────────────────────────────────────────────────────────

export interface Customer {
  id: string;
  tenantId: string;
  name: string;
  area: string;
  phone: string;
  creditLimit: string;
  balance: string;
}

export interface Invoice {
  id: string;
  tenantId: string;
  invoiceNo: string;
  customerId: string;
  date: string;
  net: string;
  tax: string;
  gross: string;
  status: 'posted' | 'cancelled';
}

export interface Data {
  customers: Customer[];
  invoices: Invoice[];
  counters: Record<string, number>;
  usage: Array<{ tenantId: string; turnId: string; costUsd: string }>;
}

export const TENANT_A = '0192a000-0000-7000-8000-00000000000a';
export const TENANT_B = '0192b000-0000-7000-8000-00000000000b';
export const MADINA = '0192a000-0000-7000-8000-0000000000c1';
export const METRO = '0192a000-0000-7000-8000-0000000000c2';
export const OTHER_CO_CUSTOMER = '0192b000-0000-7000-8000-0000000000c9';

export function seed(): Data {
  return {
    customers: [
      { id: MADINA, tenantId: TENANT_A, name: 'Madina Store', area: 'Saddar', phone: '03001234567', creditLimit: '100000', balance: '20000' },
      { id: METRO, tenantId: TENANT_A, name: 'Metro Cash & Carry', area: 'Gulshan', phone: '03009876543', creditLimit: '5000000', balance: '0' },
      { id: '0192a000-0000-7000-8000-0000000000c3', tenantId: TENANT_A, name: 'Madina Traders', area: 'Korangi', phone: '03111111111', creditLimit: '50000', balance: '0' },
      { id: OTHER_CO_CUSTOMER, tenantId: TENANT_B, name: 'Other Company Customer', area: 'Lahore', phone: '03220000000', creditLimit: '100000', balance: '0' },
    ],
    invoices: [],
    counters: {},
    usage: [],
  };
}

// ── money (the app's own arithmetic; the assistant never does this) ─────────

const SCALE = 10_000n;
export function formatMoney(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / SCALE;
  const cents = (abs % SCALE) / 100n;
  return `${negative ? '-' : ''}${whole}.${cents.toString().padStart(2, '0')}`;
}

// ── runtime: what handlers use, bound to one company ────────────────────────

export function runtime(data: Data, ctx: ActionContext) {
  const mine = <T extends { tenantId: string }>(rows: T[]) => rows.filter((r) => r.tenantId === ctx.tenantId);
  return {
    customers: {
      all: () => mine(data.customers),
      get: (id: string) => mine(data.customers).find((c) => c.id === id),
    },
    invoices: {
      all: () => mine(data.invoices),
      get: (id: string) => mine(data.invoices).find((i) => i.id === id),
      nextNumber: () => {
        const n = (data.counters[ctx.tenantId] ?? 0) + 1;
        data.counters[ctx.tenantId] = n;
        return `INV-${String(n).padStart(4, '0')}`;
      },
      insert: (inv: Invoice) => {
        data.invoices.push(inv);
      },
    },
    usage: {
      record: (turnId: string, costUsd: string) => {
        const existing = data.usage.find((u) => u.tenantId === ctx.tenantId && u.turnId === turnId);
        if (!existing) data.usage.push({ tenantId: ctx.tenantId, turnId, costUsd });
      },
    },
  };
}
export type Runtime = ReturnType<typeof runtime>;

// ── events ──────────────────────────────────────────────────────────────────

export interface Events {
  'invoice.posted': { invoiceId: string; invoiceNo: string; customerId: string; gross: string };
  'invoice.cancelled': { invoiceId: string; invoiceNo: string };
  'customer.updated': { customerId: string };
}

export const invoicePosted = defineEvent({
  type: 'invoice.posted',
  version: 1,
  module: 'SALES',
  description: 'A sales invoice was posted to the ledger.',
  audience: 'invoice:view',
  payload: z.object({ invoiceId: Uuid, invoiceNo: z.string(), customerId: Uuid, gross: MoneyString }),
});
export const invoiceCancelled = defineEvent({
  type: 'invoice.cancelled',
  version: 1,
  module: 'SALES',
  description: 'A posted sales invoice was cancelled.',
  audience: 'invoice:view',
  payload: z.object({ invoiceId: Uuid, invoiceNo: z.string() }),
});
export const customerUpdated = defineEvent({
  type: 'customer.updated',
  version: 1,
  module: 'CORE',
  description: "A customer's details were changed.",
  payload: z.object({ customerId: Uuid }),
});

// ── actions ─────────────────────────────────────────────────────────────────

let idSeq = 0;
const newId = () => `0192a000-0000-7000-8000-${String(++idSeq).padStart(12, '0')}`;

export const contextGet = defineAction<unknown, z.infer<typeof CoreContextOutput>, Runtime, Events>({
  name: 'core.context.get',
  version: 1,
  kind: 'query',
  module: 'CORE',
  description: 'Who the user is, which company, its timezone, today and the fiscal year.',
  tags: ['context'],
  input: z.object({}),
  output: CoreContextOutput,
  permissions: [],
  risk: 'read',
  requiresConfirmation: false,
  idempotent: true,
  handler: async (_input, ctx) => ({
    user: { id: ctx.userId, displayName: 'Farrukh', roles: ['Owner'], locale: ctx.locale },
    company: {
      id: ctx.tenantId,
      name: 'Demo Distributors',
      timezone: 'Asia/Karachi',
      currency: 'PKR',
      fiscalYear: { start: '2026-07-01', end: '2027-06-30' },
    },
    today: '2026-10-01',
    licensedModules: ['CORE', 'SALES', 'ASSISTANT'],
  }),
});

export const customerSearch = defineAction({
  name: 'masters.customer.search',
  version: 1,
  kind: 'query',
  module: 'CORE',
  description: 'Find customers by name, code or phone, tolerant of spelling variations.',
  tags: ['customers', 'search'],
  examples: [{ title: 'Find Madina Store', input: { query: 'madina' } }],
  input: SearchInput,
  output: SearchOutput,
  permissions: ['customer:view'],
  risk: 'read',
  requiresConfirmation: false,
  idempotent: true,
  paging: { defaultLimit: 10, maxLimit: 50 },
  handler: async (input, ctx: { runtime: Runtime }) => {
    const q = input.query.toLowerCase();
    const items = ctx.runtime.customers
      .all()
      .filter((c) => c.name.toLowerCase().includes(q) || c.phone.includes(q))
      .slice(0, input.limit ?? 10)
      .map((c) => ({
        id: c.id,
        display: c.name,
        disambiguation: { area: c.area, phone: c.phone },
        score: c.name.toLowerCase().startsWith(q) ? 0.9 : 0.6,
        matchedOn: c.phone.includes(q) ? ('phone' as const) : ('name' as const),
      }));
    return { items };
  },
});

export const customerUpdate = defineAction<
  { customerId: string; phone: string; cnic?: string | undefined },
  { customerId: string; phone: string },
  Runtime,
  Events
>({
  name: 'masters.customer.update',
  version: 1,
  kind: 'command',
  module: 'CORE',
  description: "Change a customer's phone number.",
  tags: ['customers'],
  input: z.object({ customerId: Uuid, phone: z.string().regex(/^03\d{9}$/), cnic: z.string().optional() }),
  output: z.object({ customerId: Uuid, phone: z.string() }),
  permissions: ['customer:update'],
  risk: 'write',
  requiresConfirmation: false,
  idempotent: true,
  sensitive: ['cnic'],
  handler: async (input, ctx) => {
    const c = ctx.runtime.customers.get(input.customerId);
    if (!c) return ctx.fail('NOT_FOUND', { en: 'Customer not found.', ur: 'گاہک نہیں ملا۔' });
    c.phone = input.phone;
    await ctx.emit('customer.updated', { customerId: c.id });
    return { customerId: c.id, phone: c.phone };
  },
});

const InvoiceLine = z.object({ description: z.string().min(1), quantity: z.number().int().positive(), rate: MoneyString });
const InvoicePostInput = z.object({ customerId: Uuid, date: IsoDate, lines: z.array(InvoiceLine).min(1) });
const InvoicePostOutput = z.object({
  invoiceId: Uuid,
  invoiceNo: z.string(),
  customerName: z.string(),
  net: MoneyString,
  tax: MoneyString,
  gross: MoneyString,
  balanceAfter: MoneyString,
  creditLimit: MoneyString,
});

export const invoicePost = defineAction<
  z.infer<typeof InvoicePostInput>,
  z.infer<typeof InvoicePostOutput>,
  Runtime,
  Events
>({
  name: 'sales.invoice.post',
  version: 1,
  kind: 'command',
  module: 'SALES',
  description: 'Post a sales invoice for a customer: numbers it, adds 18% sales tax and updates the balance.',
  tags: ['sales', 'invoices'],
  examples: [
    {
      title: 'Ten cartons to Madina Store',
      input: { customerId: MADINA, date: '2026-10-01', lines: [{ description: 'Pepsi 1.5L carton', quantity: 10, rate: '450' }] },
    },
  ],
  input: InvoicePostInput,
  output: InvoicePostOutput,
  permissions: ['invoice:create'],
  risk: 'financial',
  requiresConfirmation: true,
  idempotent: true,
  handler: async (input, ctx) => {
    const customer = ctx.runtime.customers.get(input.customerId);
    if (!customer) return ctx.fail('NOT_FOUND', { en: 'Customer not found.', ur: 'گاہک نہیں ملا۔' });
    const net = input.lines.reduce((sum, l) => sum + moneyToScaled(l.rate) * BigInt(l.quantity), 0n);
    const tax = (net * 18n) / 100n;
    const gross = net + tax;
    const balanceAfter = moneyToScaled(customer.balance) + gross;
    if (balanceAfter > moneyToScaled(customer.creditLimit)) {
      return ctx.fail(
        'sales.credit_limit_exceeded',
        { en: `${customer.name} would go over the credit limit.`, ur: `${customer.name} کی ادھار کی حد سے تجاوز ہو جائے گا۔` },
        { creditLimit: customer.creditLimit, balanceAfter: formatMoney(balanceAfter) },
      );
    }
    const invoice: Invoice = {
      id: newId(),
      tenantId: ctx.tenantId,
      invoiceNo: ctx.runtime.invoices.nextNumber(),
      customerId: customer.id,
      date: input.date,
      net: formatMoney(net),
      tax: formatMoney(tax),
      gross: formatMoney(gross),
      status: 'posted',
    };
    ctx.runtime.invoices.insert(invoice);
    customer.balance = formatMoney(balanceAfter);
    await ctx.emit('invoice.posted', {
      invoiceId: invoice.id,
      invoiceNo: invoice.invoiceNo,
      customerId: customer.id,
      gross: invoice.gross,
    });
    return {
      invoiceId: invoice.id,
      invoiceNo: invoice.invoiceNo,
      customerName: customer.name,
      net: invoice.net,
      tax: invoice.tax,
      gross: invoice.gross,
      balanceAfter: customer.balance,
      creditLimit: customer.creditLimit,
    };
  },
  preview: ({ result }) => {
    const nearLimit = moneyToScaled(result.balanceAfter) * 10n > moneyToScaled(result.creditLimit) * 8n;
    return {
      summary: {
        en: `Invoice ${result.invoiceNo} to ${result.customerName} for ${result.gross}`,
        ur: `${result.customerName} کے لیے انوائس ${result.invoiceNo}، رقم ${result.gross}`,
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
      warnings: nearLimit
        ? [{ code: 'sales.near_credit_limit', message: { en: 'Customer is near the credit limit.', ur: 'گاہک ادھار کی حد کے قریب ہے۔' } }]
        : [],
    };
  },
});

export const invoiceCancel = defineAction<{ invoiceId: string; reason: string }, { invoiceId: string; invoiceNo: string }, Runtime, Events>({
  name: 'sales.invoice.cancel',
  version: 1,
  kind: 'command',
  module: 'SALES',
  description: 'Cancel a posted sales invoice and reverse its effect on the balance.',
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
    if (inv.status === 'cancelled')
      return ctx.fail('CONFLICT', { en: 'Invoice is already cancelled.', ur: 'انوائس پہلے ہی منسوخ ہو چکی ہے۔' });
    inv.status = 'cancelled';
    const customer = ctx.runtime.customers.get(inv.customerId);
    if (customer) customer.balance = formatMoney(moneyToScaled(customer.balance) - moneyToScaled(inv.gross));
    await ctx.emit('invoice.cancelled', { invoiceId: inv.id, invoiceNo: inv.invoiceNo });
    return { invoiceId: inv.id, invoiceNo: inv.invoiceNo };
  },
  preview: ({ result }) => ({
    summary: { en: `Cancel invoice ${result.invoiceNo}`, ur: `انوائس ${result.invoiceNo} منسوخ کریں` },
    changes: [
      { op: 'reverse', entity: 'sales_invoice', ref: result.invoiceNo, label: { en: 'Sales invoice', ur: 'سیلز انوائس' } },
    ],
    warnings: [],
  }),
});

const SalesSummaryRow = z.object({ customerId: Uuid, customerName: z.string(), invoices: z.number().int(), gross: MoneyString });

export const salesSummary = defineAction({
  name: 'reports.sales.summary',
  version: 1,
  kind: 'query',
  module: 'SALES',
  description: 'Sales totals per customer for a date range, with grand totals over the whole range.',
  tags: ['sales', 'reports'],
  input: z.object({ from: IsoDate, to: IsoDate, limit: z.number().int().optional(), cursor: z.string().optional() }),
  output: pageWithTotals(SalesSummaryRow),
  permissions: ['report_sales:view'],
  risk: 'read',
  requiresConfirmation: false,
  idempotent: true,
  paging: { defaultLimit: 25, maxLimit: 100 },
  handler: async (input, ctx: { runtime: Runtime }) => {
    const invoices = ctx.runtime.invoices
      .all()
      .filter((i) => i.status === 'posted' && i.date >= input.from && i.date <= input.to);
    const byCustomer = new Map<string, { count: number; gross: bigint }>();
    for (const inv of invoices) {
      const row = byCustomer.get(inv.customerId) ?? { count: 0, gross: 0n };
      row.count += 1;
      row.gross += moneyToScaled(inv.gross);
      byCustomer.set(inv.customerId, row);
    }
    const rows = [...byCustomer.entries()].map(([customerId, r]) => ({
      customerId,
      customerName: ctx.runtime.customers.get(customerId)?.name ?? '—',
      invoices: r.count,
      gross: formatMoney(r.gross),
    }));
    const total = invoices.reduce((s, i) => s + moneyToScaled(i.gross), 0n);
    const limit = input.limit ?? 25;
    return {
      items: rows.slice(0, limit),
      nextCursor: null,
      truncated: rows.length > limit,
      totals: { gross: formatMoney(total) },
      count: rows.length,
    };
  },
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
    ctx.runtime.usage.record(input.turnId, input.costUsd);
    return { recorded: true as const };
  },
});

export const ALL_ACTIONS = [contextGet, customerSearch, customerUpdate, invoicePost, invoiceCancel, salesSummary, usageRecord];
export const ALL_EVENTS = [invoicePosted, invoiceCancelled, customerUpdated];

// ── contexts ────────────────────────────────────────────────────────────────

export const ALL_PERMISSIONS = [
  'customer:view',
  'customer:update',
  'invoice:create',
  'invoice:cancel',
  'invoice:view',
  'report_sales:view',
];

let requestSeq = 0;
export function ctxFor(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    tenantId: TENANT_A,
    userId: 'user-owner',
    roles: ['owner'],
    permissions: ALL_PERMISSIONS,
    locale: 'en',
    source: 'web',
    requestId: `req-${++requestSeq}`,
    ...overrides,
  };
}

export function assistantCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return ctxFor({ source: 'assistant', actor: { clientId: 'm-ai-assistant', conversationId: 'cnv-1' }, ...overrides });
}

// ── assembly ────────────────────────────────────────────────────────────────

export const ENABLED_ASSISTANT = {
  enabled: true,
  consent: { termsVersion: '2026-10', acceptedAt: '2026-09-30T10:00:00Z', acceptedBy: 'user-owner' },
};

export function makeApp(
  hostOptions: Partial<InMemoryHostOptions<Data, Runtime>> = {},
  registryOptions: Partial<RegistryOptions<Runtime, Events>> = {},
): { host: InMemoryHost<Data, Runtime, Events>; registry: ActionRegistry } {
  const host = new InMemoryHost<Data, Runtime, Events>({
    data: seed(),
    runtime,
    assistantSettings: { [TENANT_A]: { ...ENABLED_ASSISTANT }, [TENANT_B]: {} },
    ...hostOptions,
  });
  const registry = createActionRegistry<Runtime, Events>({
    host,
    producer: { name: 'demo-erp', version: '1.0.0' },
    ...registryOptions,
  });
  registry.register(...ALL_ACTIONS);
  registry.registerEvents(...ALL_EVENTS);
  registry.registerErrors({
    'sales.credit_limit_exceeded': { en: 'The customer would go over the credit limit.', ur: 'گاہک کی ادھار کی حد سے تجاوز ہو جائے گا۔' },
    'sales.near_credit_limit': { en: 'The customer is near the credit limit.', ur: 'گاہک ادھار کی حد کے قریب ہے۔' },
  });
  registry.validate();
  return { host, registry };
}

export const madinaInvoice = {
  customerId: MADINA,
  date: '2026-10-01',
  lines: [{ description: 'Pepsi 1.5L carton', quantity: 10, rate: '450' }],
};
