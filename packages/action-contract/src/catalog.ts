import { z } from 'zod';
import type { ActionExample, AnyAction, AnyEvent } from './definition.js';
import type { ActionKind, LocalizedText, RiskLevel } from './vocabulary.js';
import { CONTRACT_VERSION } from './vocabulary.js';
import { canonicalJson, sha256Hex } from './crypto.js';

/** JSON Schema 2020-12, produced by z.toJSONSchema(). */
export type JsonSchema = Record<string, unknown>;

export interface CatalogEntry {
  name: string;
  version: number;
  kind: ActionKind;
  module: string;
  description: string;
  examples: ActionExample<unknown>[];
  tags: string[];
  permissions: string[];
  risk: RiskLevel;
  requiresConfirmation: boolean;
  idempotent: boolean;
  hasPreview: boolean;
  deprecated?: { since: string; useInstead?: string };
  paging?: { defaultLimit: number; maxLimit: number };
  input: JsonSchema;
  output: JsonSchema;
}

export interface CatalogEvent {
  type: string;
  version: number;
  module: string;
  description: string;
  audience?: string;
  payload: JsonSchema;
}

export interface ActionCatalog {
  contractVersion: typeof CONTRACT_VERSION;
  producer: { name: string; version: string };
  actions: CatalogEntry[];
  events: CatalogEvent[];
  errors: Array<{ code: string; messages: LocalizedText }>;
}

export interface ListResponse {
  actions: CatalogEntry[];
  /** Hash of the full catalog. Cache the catalog until it changes. */
  catalogHash: string;
}

function toSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  return z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as JsonSchema;
}

export function catalogEntry(def: AnyAction): CatalogEntry {
  const entry: CatalogEntry = {
    name: def.name,
    version: def.version,
    kind: def.kind,
    module: def.module,
    description: def.description,
    examples: (def.examples ?? []).map((e: ActionExample<unknown>) => ({ title: e.title, input: e.input })),
    tags: [...def.tags],
    permissions: [...def.permissions],
    risk: def.risk,
    requiresConfirmation: def.requiresConfirmation,
    idempotent: def.idempotent,
    hasPreview: typeof def.preview === 'function',
    input: toSchema(def.input, 'input'),
    output: toSchema(def.output, 'output'),
  };
  if (def.deprecated) entry.deprecated = { ...def.deprecated };
  if (def.paging) entry.paging = { ...def.paging };
  return entry;
}

export function catalogEvent(def: AnyEvent): CatalogEvent {
  const event: CatalogEvent = {
    type: def.type,
    version: def.version,
    module: def.module,
    description: def.description,
    payload: toSchema(def.payload, 'output'),
  };
  if (def.audience) event.audience = def.audience;
  return event;
}

/** sha-256 of the canonical catalog. Changes whenever anything in it changes. */
export async function catalogHash(catalog: ActionCatalog): Promise<string> {
  return sha256Hex(canonicalJson(catalog));
}
