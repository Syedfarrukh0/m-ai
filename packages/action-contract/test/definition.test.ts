import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ActionDefinitionError, checkDefinition, createActionRegistry, defineAction, defineEvent } from '../src/index.js';
import type { AnyAction } from '../src/index.js';
import { InMemoryHost } from '../src/testing/index.js';

const ok: AnyAction = {
  name: 'sales.invoice.post',
  version: 1,
  kind: 'command',
  module: 'SALES',
  description: 'Post a sales invoice for a customer.',
  tags: ['sales'],
  input: z.object({}),
  output: z.object({}),
  permissions: ['invoice:create'],
  risk: 'financial',
  requiresConfirmation: true,
  idempotent: true,
  preview: () => ({ summary: { en: 'x', ur: 'x' }, primaryAmount: '1', changes: [], warnings: [] }),
  handler: async () => ({}),
};

describe('defineAction rules', () => {
  it('accepts a valid definition', () => {
    expect(checkDefinition(ok)).toEqual([]);
    expect(() => defineAction(ok)).not.toThrow();
  });

  it.each([
    [{ name: 'Sales.Post' }, 'name matches ACTION_NAME'],
    [{ name: 'post' }, 'name matches ACTION_NAME'],
    [{ version: 0 }, 'version is an integer ≥ 1'],
    [{ module: 'sales' }, 'module matches MODULE_CODE'],
    [{ description: 'too short' }, 'description is at least 20 characters'],
    [{ tags: [] }, 'tags has at least one entry and every tag matches TAG'],
    [{ tags: ['Sales'] }, 'tags has at least one entry and every tag matches TAG'],
    [{ permissions: ['invoice.create'] }, 'every permission matches PERMISSION_KEY'],
    [{ risk: 'read' }, 'command ⇒ risk is not "read"'],
    [{ requiresConfirmation: false }, 'financial or destructive ⇒ requiresConfirmation and at least one permission'],
    [{ permissions: [] }, 'financial or destructive ⇒ requiresConfirmation and at least one permission'],
    [{ preview: undefined }, 'requiresConfirmation ⇒ preview is defined'],
    [{ paging: { defaultLimit: 10, maxLimit: 50 } }, 'paging only on queries, and 1 ≤ defaultLimit ≤ maxLimit ≤ 200'],
    [{ sensitive: [''] }, 'every sensitive path is a non-empty string'],
    [{ examples: [{ title: ' ', input: {} }] }, 'examples have a title'],
  ] as Array<[Partial<AnyAction>, string]>)('reports %j as "%s"', (patch, rule) => {
    const broken = checkDefinition({ ...ok, ...patch } as AnyAction);
    expect(broken).toContain(rule);
    expect(() => defineAction({ ...ok, ...patch } as AnyAction)).toThrow(ActionDefinitionError);
  });

  it('enforces the query shape', () => {
    const { preview: _preview, ...withoutPreview } = ok;
    const query: AnyAction = {
      ...withoutPreview,
      name: 'sales.invoice.list',
      kind: 'query',
      risk: 'read',
      requiresConfirmation: false,
      paging: { defaultLimit: 25, maxLimit: 300 },
    };
    const broken = checkDefinition(query);
    expect(broken).toContain('paging only on queries, and 1 ≤ defaultLimit ≤ maxLimit ≤ 200');
    expect(checkDefinition({ ...query, paging: { defaultLimit: 25, maxLimit: 200 } })).toEqual([]);
    expect(checkDefinition({ ...query, idempotent: false })).toContain(
      'query ⇒ risk "read", idempotent, no confirmation, no preview',
    );
  });

  it('lists every broken rule at once', () => {
    const broken = checkDefinition({ ...ok, name: 'X', module: 'x', tags: [] });
    expect(broken.length).toBe(3);
  });
});

describe('defineEvent', () => {
  it('validates type, module and audience', () => {
    expect(() =>
      defineEvent({ type: 'invoice.posted', version: 1, module: 'SALES', description: 'An invoice was posted.', payload: z.object({}) }),
    ).not.toThrow();
    expect(() =>
      defineEvent({ type: 'InvoicePosted', version: 1, module: 'SALES', description: 'An invoice was posted.', payload: z.object({}) }),
    ).toThrow(ActionDefinitionError);
    expect(() =>
      defineEvent({
        type: 'invoice.posted',
        version: 1,
        module: 'SALES',
        description: 'An invoice was posted.',
        audience: 'invoice.view',
        payload: z.object({}),
      }),
    ).toThrow(/audience/);
  });
});

describe('registry cross-rules', () => {
  const host = new InMemoryHost({ data: {}, runtime: () => ({}) });

  it('refuses a duplicate name + version', () => {
    const registry = createActionRegistry({ host, producer: { name: 't', version: '0' } });
    registry.register(ok);
    expect(() => registry.register(ok)).toThrow(/unique/);
    expect(() => registry.register({ ...ok, version: 2 })).not.toThrow();
    expect(registry.get('sales.invoice.post')?.version).toBe(2);
    expect(registry.get('sales.invoice.post', 1)?.version).toBe(1);
  });

  it('checks deprecated.useInstead', () => {
    const registry = createActionRegistry({ host, producer: { name: 't', version: '0' } });
    registry.register({ ...ok, deprecated: { since: '2026-10-01', useInstead: 'sales.invoice.post-v2' } });
    expect(() => registry.validate()).toThrow(/useInstead/);
  });

  it('refuses a malformed module error code', () => {
    const registry = createActionRegistry({ host, producer: { name: 't', version: '0' } });
    expect(() => registry.registerErrors({ CREDIT: { en: 'x', ur: 'x' } })).toThrow();
    expect(() => registry.registerErrors({ PERMISSION_DENIED: { en: 'x', ur: 'x' } })).toThrow();
    expect(() => registry.registerErrors({ 'sales.credit_limit': { en: 'x', ur: 'x' } })).not.toThrow();
  });
});
