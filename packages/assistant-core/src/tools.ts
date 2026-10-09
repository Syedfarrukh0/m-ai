import type { CatalogEntry } from '@m-ai/action-contract';
import { WELL_KNOWN_ACTIONS } from '@m-ai/action-contract';
import type { ToolSpec } from './model.js';

/**
 * Action names use dots (`sales.invoice.post`); model tool names may not.
 * Action names never contain "_", so "__" maps back unambiguously.
 */
export function toToolName(action: string): string {
  return action.replace(/\./g, '__');
}

export function fromToolName(tool: string): string {
  return tool.replace(/__/g, '.');
}

/**
 * Every `assistant.*` action is the assistant's own plumbing (its settings,
 * terms, usage), never something to offer the person's model.
 */
const ASSISTANT_PREFIX = 'assistant.';

/** Actions the model never sees: the assistant's own plumbing, and settings it must not change. */
export const HIDDEN_ACTIONS = new Set<string>([
  WELL_KNOWN_ACTIONS.contextGet,
  WELL_KNOWN_ACTIONS.usageRecord,
  WELL_KNOWN_ACTIONS.settingsGet,
  WELL_KNOWN_ACTIONS.settingsUpdate,
  WELL_KNOWN_ACTIONS.consentAccept,
  WELL_KNOWN_ACTIONS.messagingSend,
]);

/**
 * A command the app says needs no confirmation and that only makes a document
 * (intent tag `render`, e.g. an invoice PDF) runs straight away, like a query:
 * asking "yes?" before printing helps nobody. Every other change is previewed.
 */
export function runsWithoutAsking(entry: CatalogEntry): boolean {
  return (
    entry.kind === 'command' &&
    !entry.requiresConfirmation &&
    entry.tags.includes('render') &&
    entry.risk !== 'financial' &&
    entry.risk !== 'destructive'
  );
}

export function toToolSpec(entry: CatalogEntry): ToolSpec {
  const { $schema: _schema, ...schema } = entry.input as Record<string, unknown>;
  const notes: string[] = [];
  if (runsWithoutAsking(entry))
    notes.push('Makes a PDF file for the person. Use it ONLY when they ask for a PDF, a print or a file to send; to show or tell what a document says, use a query tool.');
  else if (entry.kind === 'command') notes.push('Changes data: the person is always asked to confirm first, by the system.');
  if (entry.risk === 'financial') notes.push('Financial.');
  const clean = modelSchema(schema) as Record<string, unknown>;
  return {
    name: toToolName(entry.name),
    description: [entry.description, ...notes].join(' '),
    inputSchema: clean.type === 'object' ? clean : { type: 'object', properties: {}, ...clean },
  };
}

const SAFE_INT = 9007199254740991;

/**
 * The input schema as a model should see it. The app still validates every
 * input in full; this only removes what trips models up:
 *  - a `pattern` where a `format` already says it (a uuid's long regex),
 *  - the ±2^53 bounds a plain integer gets.
 * Some providers (Groq) check tool calls against the schema themselves and
 * reject the whole reply on a mismatch; a mismatch the APP reports instead
 * comes back as a tool result the model can read and fix.
 */
export function modelSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(modelSchema);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === '$schema') continue;
    if (k === 'pattern' && typeof (node as Record<string, unknown>)['format'] === 'string') continue;
    if ((k === 'minimum' && v === -SAFE_INT) || (k === 'maximum' && v === SAFE_INT)) continue;
    out[k] = modelSchema(v);
  }
  return out;
}

/**
 * Everyday business words people use (English, Roman Urdu, Urdu) → the tags
 * and name parts apps commonly use, in both conventions (an area tag like
 * "receivables" and a name part like "receipt"; singular and plural), plus
 * the intent tags (post, create, update, get, list, summarise, render).
 * Apps add their own with the assistant's `synonyms` option (or replace
 * these with `replaceSynonyms`).
 */
const ORDER = ['orders', 'sales', 'invoice', 'invoices', 'post'];
const POST = ['post'];
const INVOICE = ['invoice', 'invoices', 'sales'];
const RECEIPT = ['receivables', 'receipt', 'receipts', 'post'];
const OWED = ['receivables', 'outstanding', 'reports'];
const CUSTOMER = ['customer', 'customers'];
const PRODUCT = ['product', 'products'];
const REPORT = ['reports', 'summarise'];
const DOCUMENT = ['documents', 'render'];
const CREATE = ['create'];
const UPDATE = ['update'];
const SHOW = ['get', 'list'];
const BOOKER = ['salesperson', 'booker', 'bookers', 'sales', 'reports'];

const words = (list: string, to: string[]) => Object.fromEntries(list.split(' ').map((w) => [w, to]));

export const DEFAULT_SYNONYMS: Record<string, string[]> = {
  ...words('sale sales bikri sell sold بکری سیل', ['sales', 'invoice', 'invoices']),
  ...words('order orders آرڈر carton cartons ctn ctns peti petti dabba dabbe pcs piece pieces packet packets crate crates bori کارٹن پیٹی', ORDER),
  ...words('laga lagao lagado lagana bhejdo book post daal dalo لگا لگاؤ', POST),
  ...words('bhej bhejo bhejna بھیجو', [...POST, ...DOCUMENT]),
  ...words('invoice invoices bill bills inv انوائس بل', INVOICE),
  ...words('wasool wasul received receive receipt receipts payment payments jama mila mile mili وصول رسید', RECEIPT),
  ...words('wasooli wasoli recovery udhaar udhar baqaya baqi owe owes owed outstanding due وصولی ادھار بقایا', OWED),
  ...words('customer customers gahak dukaan dukan shop store party گاہک دکان', CUSTOMER),
  ...words('product products item items maal sku rate price qeemat مال', PRODUCT),
  ...words('stock اسٹاک', ['stock', 'inventory', ...PRODUCT]),
  ...words('vendor vendors supplier suppliers', ['vendor', 'vendors', 'payables']),
  ...words('principal principals brand brands', ['company', 'companies']),
  ...words('booker bookers salesman salesmen salesperson بکر', BOOKER),
  ...words('report reports summary total kitni kitna رپورٹ', REPORT),
  // A customer's account: the statement as data. "hisaab" is also a total, so it brings both.
  ...words('hisaab hisab حساب', [...REPORT, 'statement', 'receivables']),
  ...words('statement khata khaata ledger کھاتہ', ['statement', 'receivables']),
  // Asking for a file: only these bring the document (PDF) actions.
  ...words('print pdf copy send file download chhap چھاپ پرنٹ', DOCUMENT),
  // Money in hand: cash counters, banks and wallets.
  ...words('bank banks cash paisa paise paisay raqam rakam jazzcash easypaisa wallet بینک پیسے رقم', ['accounting', 'accounts', 'cash', 'account', 'money']),
  ...words('naya nayi naye new add banao نیا', CREATE),
  ...words('badal badlo badlein change update edit theek sahi', UPDATE),
  // Switching a record off is an update too ("Madina ko band kar do").
  ...words('band bund deactivate inactive disable بند', UPDATE),
  ...words('dikhao dikha show list دکھاؤ', SHOW),
  ...words('phone number mobile', CUSTOMER),
  cancel: ['invoices', 'cancel'],
};

/** Tags never offered to the model by default: bulk imports need a file, not a chat. */
export const HIDDEN_TAGS = new Set<string>(['bulk']);

/** Document numbers in the text say which records are meant ("INV-0002", "RCPT 17"). */
const DOCUMENT_NUMBERS: Array<[RegExp, string[]]> = [
  // Invoices, and credit and debit notes (INV-2026-001442, SI-000123, CN-2026-000009)
  [/\b(?:inv|si|cn|dn)[-\s]?\d+/i, ['invoice', 'sales', 'get']],
  // Receipts (RC-2026-000412, RCPT 17)
  [/\b(?:rcpt|rcp|rc|rv)[-\s]?\d+/i, ['receipt', 'receivables', 'get']],
];

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Pick the tools for this turn: every search action (the model resolves
 * names to ids with them), then the actions whose tags, name or description
 * best match the conversation's recent words, up to `max`.
 */
export function selectTools(
  catalog: readonly CatalogEntry[],
  recentText: string,
  max = 24,
  synonyms: Record<string, string[]> = DEFAULT_SYNONYMS,
  options: { hiddenTags?: ReadonlySet<string>; maxChars?: number } = {},
): CatalogEntry[] {
  const hiddenTags = options.hiddenTags ?? HIDDEN_TAGS;
  const visible = catalog.filter(
    (e) => !HIDDEN_ACTIONS.has(e.name) && !e.name.startsWith(ASSISTANT_PREFIX) && !e.deprecated && !e.tags.some((t) => hiddenTags.has(t)),
  );
  const words = tokens(recentText);
  const wanted = new Set<string>();
  for (const w of words) {
    wanted.add(w);
    for (const s of synonyms[w] ?? []) wanted.add(s);
  }
  for (const [re, add] of DOCUMENT_NUMBERS) if (re.test(recentText)) for (const t of add) wanted.add(t);
  // A document (PDF) is made only when one is asked for ("pdf", "print", "bhejo"): "INV-0002 dikhao" means show it.
  const renderAsked = wanted.has('render');
  const scored = visible
    .filter((e) => renderAsked || !e.tags.includes('render'))
    .map((e) => {
      let score = 0;
      if (e.tags.includes('search')) score += 100;
      // The everyday postings (an order, a payment received) are always within reach.
      if (e.tags.includes('daily')) score += 15;
      for (const t of e.tags) if (wanted.has(t)) score += 10;
      for (const part of e.name.split(/[.-]/)) if (wanted.has(part)) score += 6;
      for (const w of tokens(e.description)) if (wanted.has(w)) score += 1;
      if (e.kind === 'query') score += 0.5;
      return { e, score };
    });
  scored.sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));
  // Stop at `max` tools, or when the tools' definitions would pass `maxChars` (each one is sent with every call).
  const out: CatalogEntry[] = [];
  let chars = 0;
  for (const { e } of scored) {
    if (out.length >= max) break;
    const size = JSON.stringify(toToolSpec(e)).length;
    if (options.maxChars !== undefined && out.length > 0 && chars + size > options.maxChars) continue;
    out.push(e);
    chars += size;
  }
  return out;
}
