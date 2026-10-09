/**
 * 0.3.5 — from the full Groq runs: gpt-oss-120b passed 14/14; gpt-oss-20b once
 * produced a tool call Groq rejected against the schema (a 400), which stopped
 * the eval. Such a rejection is a model slip: ask again. Schemas sent to models
 * drop what trips them up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockErp } from '@m-ai/mock-erp';
import { createInProcessActionsClient, createModel, modelSchema, toToolSpec } from '../src/index.js';

afterEach(() => vi.unstubAllGlobals());

describe("Groq's rejection of a model's tool call", () => {
  it('is retryable: a model slip, not a refusal', async () => {
    const body = {
      error: {
        message: 'Tool call validation failed: tool call validation failed: parameters for tool reports__receivables__outstanding did not match schema: errors: [`/customerId`: does not match pattern]',
        type: 'invalid_request_error',
        code: 'tool_use_failed',
        failed_generation: '{"name":"reports__receivables__outstanding","arguments":{"customerId":"all"}}',
      },
    };
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status: 400 }));
    await expect(
      createModel('groq:openai/gpt-oss-20b', { GROQ_API_KEY: 'g' }).model.complete({ system: 's', messages: [], tools: [], maxTokens: 1 }),
    ).rejects.toMatchObject({ status: 400, retryable: true });
  });

  it('other 400s stay final', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'messages: field required' } }), { status: 400 }));
    await expect(createModel('groq:x', { GROQ_API_KEY: 'g' }).model.complete({ system: 's', messages: [], tools: [], maxTokens: 1 })).rejects.toMatchObject({ retryable: false });
  });
});

describe('schemas as models see them', () => {
  it('drop a pattern that a format already states, and the ±2^53 bounds of plain integers', () => {
    expect(
      modelSchema({
        $schema: 'x',
        type: 'object',
        properties: {
          customerId: { type: 'string', format: 'uuid', pattern: '^([0-9a-f]{8}-…)$' },
          code: { type: 'string', pattern: '^C-\\d+$' },
          limit: { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 },
          qty: { type: 'integer', minimum: 1, maximum: 1000 },
          pattern: { type: 'string' },
        },
      }),
    ).toEqual({
      type: 'object',
      properties: {
        customerId: { type: 'string', format: 'uuid' },
        code: { type: 'string', pattern: '^C-\\d+$' },
        limit: { type: 'integer' },
        qty: { type: 'integer', minimum: 1, maximum: 1000 },
        pattern: { type: 'string' },
      },
    });
  });

  it('the receivables tool, as sent', async () => {
    const erp = createMockErp();
    const list = await createInProcessActionsClient(erp.registry, () => erp.assistantCtx()).list();
    const entry = list.actions.find((a) => a.name === 'reports.receivables.outstanding')!;
    expect(toToolSpec(entry).inputSchema).toEqual({
      type: 'object',
      properties: { customerId: { type: 'string', format: 'uuid' }, limit: { type: 'integer' } },
    });
  });
});
