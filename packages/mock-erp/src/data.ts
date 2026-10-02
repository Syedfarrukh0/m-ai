/**
 * Seed data: one Karachi distributor with customers, products, bookers,
 * invoices and receipts for September–October 2026, plus a second company so
 * tenant isolation is visible.
 */

export interface Tenant {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  fiscalYearStartMonth: number;
}

export interface User {
  id: string;
  tenantId: string;
  displayName: string;
  roles: string[];
  permissions: string[];
  locale: 'en' | 'ur' | 'ur-Latn';
}

export interface Customer {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  area: string;
  phone: string;
  creditLimit: string;
  openingBalance: string;
}

export interface Product {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  packSize: string;
  rate: string;
  stock: number;
}

export interface Booker {
  id: string;
  tenantId: string;
  name: string;
}

export interface InvoiceLine {
  productId: string;
  quantity: number;
  rate: string;
  amount: string;
}

export interface Invoice {
  id: string;
  tenantId: string;
  invoiceNo: string;
  customerId: string;
  bookerId: string | null;
  date: string;
  lines: InvoiceLine[];
  net: string;
  tax: string;
  gross: string;
  status: 'posted' | 'cancelled';
}

export interface Receipt {
  id: string;
  tenantId: string;
  customerId: string;
  collectedById: string | null;
  date: string;
  amount: string;
}

export interface RenderedFile {
  id: string;
  tenantId: string;
  fileName: string;
}

export interface MockData {
  tenants: Tenant[];
  users: User[];
  customers: Customer[];
  products: Product[];
  bookers: Booker[];
  invoices: Invoice[];
  receipts: Receipt[];
  files: RenderedFile[];
  counters: Record<string, number>;
  usage: Array<{ tenantId: string; turnId: string; kind: string; costUsd: string }>;
}

export const DEMO_TENANT = '0192d000-0000-7000-8000-00000000000a';
export const OTHER_TENANT = '0192d000-0000-7000-8000-00000000000b';

const id = (tenant: 'a' | 'b', n: number) => `0192d000-0000-7000-8${tenant === 'a' ? '0' : '1'}00-${String(n).padStart(12, '0')}`;

export const IDS = {
  owner: 'user-owner',
  booker: 'user-ali',
  storekeeper: 'user-store',
  otherOwner: 'user-other-owner',
  madinaStore: id('a', 101),
  madinaTraders: id('a', 102),
  metro: id('a', 103),
  alNoor: id('a', 104),
  bismillah: id('a', 105),
  pepsi: id('a', 201),
  sprite: id('a', 202),
  sevenUp: id('a', 203),
  aquafina: id('a', 204),
  ali: id('a', 301),
  usman: id('a', 302),
  otherCustomer: id('b', 101),
} as const;

const ALL_PERMISSIONS = [
  'customer:view',
  'customer:update',
  'product:view',
  'invoice:create',
  'invoice:view',
  'invoice:cancel',
  'receivable:view',
  'report_sales:view',
  'tenant_settings:view',
];

export function seed(): MockData {
  const A = DEMO_TENANT;
  return {
    tenants: [
      { id: A, name: 'Demo Distributors', timezone: 'Asia/Karachi', currency: 'PKR', fiscalYearStartMonth: 7 },
      { id: OTHER_TENANT, name: 'Other Company', timezone: 'Asia/Karachi', currency: 'PKR', fiscalYearStartMonth: 7 },
    ],
    users: [
      { id: IDS.owner, tenantId: A, displayName: 'Farrukh', roles: ['Owner'], permissions: ALL_PERMISSIONS, locale: 'ur-Latn' },
      {
        id: IDS.booker,
        tenantId: A,
        displayName: 'Ali',
        roles: ['Booker'],
        permissions: ['customer:view', 'product:view', 'invoice:create', 'invoice:view'],
        locale: 'ur-Latn',
      },
      { id: IDS.storekeeper, tenantId: A, displayName: 'Rashid', roles: ['Storekeeper'], permissions: ['product:view'], locale: 'ur' },
      { id: IDS.otherOwner, tenantId: OTHER_TENANT, displayName: 'Other Owner', roles: ['Owner'], permissions: ALL_PERMISSIONS, locale: 'en' },
    ],
    customers: [
      { id: IDS.madinaStore, tenantId: A, code: 'C-001', name: 'Madina Store', area: 'Saddar', phone: '03001234567', creditLimit: '100000', openingBalance: '15000' },
      { id: IDS.madinaTraders, tenantId: A, code: 'C-002', name: 'Madina Traders', area: 'Korangi', phone: '03111234567', creditLimit: '50000', openingBalance: '0' },
      { id: IDS.metro, tenantId: A, code: 'C-003', name: 'Metro Cash & Carry', area: 'Gulshan', phone: '03009876543', creditLimit: '5000000', openingBalance: '0' },
      { id: IDS.alNoor, tenantId: A, code: 'C-004', name: 'Al-Noor General Store', area: 'Nazimabad', phone: '03212223344', creditLimit: '80000', openingBalance: '42000' },
      { id: IDS.bismillah, tenantId: A, code: 'C-005', name: 'Bismillah Kiryana', area: 'Malir', phone: '03334445566', creditLimit: '60000', openingBalance: '8000' },
      { id: IDS.otherCustomer, tenantId: OTHER_TENANT, code: 'C-001', name: 'Madina Store Lahore', area: 'Lahore', phone: '03220000000', creditLimit: '100000', openingBalance: '0' },
    ],
    products: [
      { id: IDS.pepsi, tenantId: A, code: 'P-001', name: 'Pepsi 1.5L', packSize: 'carton of 6', rate: '450', stock: 400 },
      { id: IDS.sprite, tenantId: A, code: 'P-002', name: 'Sprite 1.5L', packSize: 'carton of 6', rate: '430', stock: 250 },
      { id: IDS.sevenUp, tenantId: A, code: 'P-003', name: '7Up 500ml', packSize: 'carton of 24', rate: '980', stock: 120 },
      { id: IDS.aquafina, tenantId: A, code: 'P-004', name: 'Aquafina 1.5L', packSize: 'carton of 6', rate: '360', stock: 15 },
    ],
    bookers: [
      { id: IDS.ali, tenantId: A, name: 'Ali' },
      { id: IDS.usman, tenantId: A, name: 'Usman' },
    ],
    invoices: [
      invoice(A, 1, IDS.madinaStore, IDS.ali, '2026-09-28', [[IDS.pepsi, 10, '450']]),
      invoice(A, 2, IDS.metro, IDS.usman, '2026-09-30', [[IDS.sprite, 40, '430'], [IDS.sevenUp, 10, '980']]),
      invoice(A, 3, IDS.alNoor, IDS.ali, '2026-10-01', [[IDS.pepsi, 20, '450']]),
      invoice(A, 4, IDS.bismillah, IDS.usman, '2026-10-02', [[IDS.aquafina, 5, '360']]),
    ],
    receipts: [
      { id: id('a', 501), tenantId: A, customerId: IDS.madinaStore, collectedById: IDS.ali, date: '2026-09-30', amount: '5000' },
      { id: id('a', 502), tenantId: A, customerId: IDS.metro, collectedById: IDS.usman, date: '2026-10-01', amount: '20000' },
    ],
    files: [],
    counters: { [A]: 4 },
    usage: [],
  };
}

// The app's own arithmetic — the assistant never does this.
const SCALE = 10_000n;
export function toScaled(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const scaled = BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, '0').slice(0, 4));
  return negative ? -scaled : scaled;
}
export function formatMoney(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  return `${negative ? '-' : ''}${abs / SCALE}.${((abs % SCALE) / 100n).toString().padStart(2, '0')}`;
}

export function priceLines(lines: Array<[string, number, string]>) {
  const priced = lines.map(([productId, quantity, rate]) => ({
    productId,
    quantity,
    rate,
    amount: formatMoney(toScaled(rate) * BigInt(quantity)),
  }));
  const net = priced.reduce((s, l) => s + toScaled(l.amount), 0n);
  const tax = (net * 18n) / 100n;
  return { lines: priced, net: formatMoney(net), tax: formatMoney(tax), gross: formatMoney(net + tax) };
}

function invoice(
  tenantId: string,
  n: number,
  customerId: string,
  bookerId: string,
  date: string,
  lines: Array<[string, number, string]>,
): Invoice {
  return {
    id: id('a', 400 + n),
    tenantId,
    invoiceNo: `INV-${String(n).padStart(4, '0')}`,
    customerId,
    bookerId,
    date,
    status: 'posted',
    ...priceLines(lines),
  };
}
