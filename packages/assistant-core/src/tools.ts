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

/** Actions the model never sees: the assistant's own plumbing, and settings it must not change. */
export const HIDDEN_ACTIONS = new Set<string>([
  WELL_KNOWN_ACTIONS.contextGet,
  WELL_KNOWN_ACTIONS.usageRecord,
  WELL_KNOWN_ACTIONS.settingsGet,
  WELL_KNOWN_ACTIONS.settingsUpdate,
  WELL_KNOWN_ACTIONS.consentAccept,
  WELL_KNOWN_ACTIONS.messagingSend,
]);

export function toToolSpec(entry: CatalogEntry): ToolSpec {
  const { $schema: _schema, ...schema } = entry.input as Record<string, unknown>;
  const notes: string[] = [];
  if (entry.kind === 'command') notes.push('Changes data: the person is always asked to confirm first, by the system.');
  if (entry.risk === 'financial') notes.push('Financial.');
  return {
    name: toToolName(entry.name),
    description: [entry.description, ...notes].join(' '),
    inputSchema: schema.type === 'object' ? schema : { type: 'object', properties: {}, ...schema },
  };
}

/**
 * Words people use (English, Roman Urdu, Urdu) → the tags and name parts
 * apps use. Extend per app vocabulary.
 */
export const SYNONYMS: Record<string, string[]> = {
  sale: ['sales'], sales: ['sales'], bikri: ['sales'], sell: ['sales'], sold: ['sales'], 'بکری': ['sales'], 'سیل': ['sales'],
  order: ['orders', 'sales', 'invoices'], orders: ['orders', 'sales', 'invoices'], 'آرڈر': ['orders', 'sales'],
  invoice: ['invoices'], invoices: ['invoices'], bill: ['invoices'], 'انوائس': ['invoices'], 'بل': ['invoices'],
  recovery: ['receivables'], wasooli: ['receivables'], wasoli: ['receivables'], udhaar: ['receivables'], udhar: ['receivables'],
  baqaya: ['receivables'], baqi: ['receivables'], owe: ['receivables'], owes: ['receivables'], outstanding: ['receivables'],
  'وصولی': ['receivables'], 'ادھار': ['receivables'], 'بقایا': ['receivables'],
  customer: ['customers'], customers: ['customers'], gahak: ['customers'], dukaan: ['customers'], dukan: ['customers'],
  shop: ['customers'], store: ['customers'], party: ['customers'], 'گاہک': ['customers'], 'دکان': ['customers'],
  product: ['products'], products: ['products'], item: ['products'], maal: ['products'], carton: ['products'],
  stock: ['products', 'inventory'], 'مال': ['products'], 'اسٹاک': ['products', 'inventory'],
  report: ['reports'], reports: ['reports'], summary: ['reports'], hisaab: ['reports'], hisab: ['reports'], 'رپورٹ': ['reports'],
  booker: ['sales', 'reports'], bookers: ['sales', 'reports'], 'بکر': ['sales'],
  print: ['documents', 'render'], pdf: ['documents', 'render'], bhejo: ['documents', 'render'], send: ['documents', 'render'],
  copy: ['documents', 'render'], 'پرنٹ': ['documents', 'render'],
  phone: ['customers'], number: ['customers'],
  cancel: ['invoices'],
};

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Pick the tools for this turn: every search action (the model resolves
 * names to ids with them), then the actions whose tags, name or description
 * best match the conversation's recent words, up to `max`.
 */
export function selectTools(catalog: readonly CatalogEntry[], recentText: string, max = 24): CatalogEntry[] {
  const visible = catalog.filter((e) => !HIDDEN_ACTIONS.has(e.name) && !e.deprecated);
  const words = tokens(recentText);
  const wanted = new Set<string>();
  for (const w of words) {
    wanted.add(w);
    for (const s of SYNONYMS[w] ?? []) wanted.add(s);
  }
  const scored = visible.map((e) => {
    let score = 0;
    if (e.tags.includes('search')) score += 100;
    for (const t of e.tags) if (wanted.has(t)) score += 10;
    for (const part of e.name.split(/[.-]/)) if (wanted.has(part)) score += 6;
    for (const w of tokens(e.description)) if (wanted.has(w)) score += 1;
    if (e.kind === 'query') score += 0.5;
    return { e, score };
  });
  scored.sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));
  return scored.slice(0, max).map((s) => s.e);
}
