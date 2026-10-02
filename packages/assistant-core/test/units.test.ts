import { describe, expect, it } from 'vitest';
import type { CatalogEntry } from '@m-ai/action-contract';
import { createMockErp } from '@m-ai/mock-erp';
import {
  costUsd,
  createHttpActionsClient,
  createAnthropicModel,
  detectLanguage,
  fromAnthropicResponse,
  fromToolName,
  ModelError,
  normalizeNumber,
  parseConfirmation,
  selectTools,
  toAnthropicBody,
  toToolName,
  toToolSpec,
  TransportError,
  trimHistory,
  unverifiedNumbers,
} from '../src/index.js';
import type { ModelMessage } from '../src/index.js';

describe('language', () => {
  it.each([
    ['aaj ki sale kitni hui?', 'ur-Latn'],
    ['Madina store ko 10 carton pepsi bhejo', 'ur-Latn'],
    ['mujhe Ali ki recovery batao', 'ur-Latn'],
    ['آج کی سیل کتنی ہوئی؟', 'ur'],
    ["What are today's sales?", 'en'],
    ['Show me the outstanding report please', 'en'],
  ])('%s → %s', (text, lang) => {
    expect(detectLanguage(text)).toBe(lang);
  });

  it('falls back when the message gives no clue', () => {
    expect(detectLanguage('Madina Store', 'ur-Latn')).toBe('ur-Latn');
    expect(detectLanguage('INV-0004', 'en')).toBe('en');
  });
});

describe('confirmation parsing', () => {
  it.each([
    ['haan', 'yes'],
    ['Haan ji', 'yes'],
    ['han kar do', 'yes'],
    ['ji haan kar do bhai', 'yes'],
    ['ok', 'yes'],
    ['theek hai', 'yes'],
    ['ہاں', 'yes'],
    ['جی ہاں', 'yes'],
    ['yes!', 'yes'],
    ['nahi', 'no'],
    ['nhi rehne do', 'no'],
    ['cancel', 'no'],
    ['نہیں', 'no'],
    ['haan lekin 12 carton karo', 'other'],
    ['haan nahi', 'other'],
    ['12', 'other'],
    ['Sprite bhi daal do', 'other'],
    ['', 'other'],
  ])('%j → %s', (text, expected) => {
    expect(parseConfirmation(text)).toBe(expected);
  });
});

describe('numbers guard', () => {
  const sources = ['{"totals":{"gross":"5310.00","outstanding":"89914.00"},"count":2,"invoiceNo":"INV-0005"}', '2026-10-02'];

  it('accepts figures that tools returned, however they are written', () => {
    expect(unverifiedNumbers('Total 5,310 hai. Baqaya 89,914.00. INV-0005 ban gayi. Aaj 2 October 2026.', sources)).toEqual([]);
    expect(unverifiedNumbers('کل ۵۳۱۰ روپے', sources)).toEqual([]);
    expect(unverifiedNumbers('1. Madina\n2. Metro', sources)).toEqual([]);
  });

  it('flags anything the model made up or worked out', () => {
    expect(unverifiedNumbers('Total 5,300 hai', sources)).toEqual(['5,300']);
    expect(unverifiedNumbers('Average 2,655 per invoice, 18% tax', sources)).toEqual(['2,655', '18']);
  });

  it('normalizes', () => {
    expect(normalizeNumber('5,310.00')).toBe('5310');
    expect(normalizeNumber('0.50')).toBe('0.5');
    expect(normalizeNumber('0005')).toBe('5');
    expect(normalizeNumber('۱۲۳')).toBe('123');
  });
});

describe('tools', () => {
  it('maps action names to tool names and back', () => {
    for (const name of ['sales.invoice.post', 'reports.receivables.outstanding', 'documents.invoice.render', 'invoice.email-requested.x']) {
      const tool = toToolName(name);
      expect(tool).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(fromToolName(tool)).toBe(name);
    }
  });

  it('offers searches always, ranks by the words used, hides plumbing', async () => {
    const erp = createMockErp();
    const catalog: CatalogEntry[] = (await erp.registry.list(erp.assistantCtx())).actions;
    const recovery = selectTools(catalog, 'Ali ki wasooli kitni baqi hai?', 5).map((e) => e.name);
    expect(recovery).toContain('reports.receivables.outstanding');
    expect(recovery).toContain('masters.customer.search');
    expect(recovery).not.toContain('core.context.get');
    expect(recovery).not.toContain('assistant.usage.record');
    const print = selectTools(catalog, 'INV-0003 ka pdf bhejo', 4).map((e) => e.name);
    expect(print).toContain('documents.invoice.render');
  });

  it('turns a catalog entry into a tool with an object schema', async () => {
    const erp = createMockErp();
    const entry = erp.registry.catalog().actions.find((a) => a.name === 'sales.invoice.post')!;
    const spec = toToolSpec(entry);
    expect(spec.name).toBe('sales__invoice__post');
    expect(spec.inputSchema).toMatchObject({ type: 'object', required: ['customerId', 'lines'] });
    expect(spec.inputSchema).not.toHaveProperty('$schema');
    expect(spec.description).toContain('confirm');
  });
});

describe('usage cost', () => {
  const pricing = { inputPerMTok: '3', cachedInputPerMTok: '0.30', outputPerMTok: '15' };
  it('is exact and rounds up', () => {
    expect(costUsd({ inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 }, pricing)).toBe('0.0045');
    expect(costUsd({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 }, pricing)).toBe('0.0001');
    expect(costUsd({ inputTokens: 2_000_000, cachedInputTokens: 1_000_000, outputTokens: 100_000 }, pricing)).toBe('7.8000');
    expect(costUsd({ inputTokens: 5, cachedInputTokens: 0, outputTokens: 5 }, undefined)).toBe('0.0000');
  });
});

describe('history trimming', () => {
  it('never cuts between a tool call and its result', () => {
    const m: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'tool_call', id: '1', name: 't', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: '1', content: '{}' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      { role: 'user', content: [{ type: 'text', text: 'c' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'd' }] },
    ];
    expect(trimHistory(m, 3)[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'c' }] });
    expect(trimHistory(m, 5)[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'c' }] });
    expect(trimHistory(m, 10)).toHaveLength(6);
  });
});

describe('Anthropic adapter', () => {
  const request = {
    system: 'You are Munshi.',
    maxTokens: 500,
    tools: [{ name: 'reports__sales__summary', description: 'Sales', inputSchema: { type: 'object', properties: {} } }],
    messages: [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'aaj ki sale?' }] },
      { role: 'assistant' as const, content: [{ type: 'tool_call' as const, id: 'tu_1', name: 'reports__sales__summary', input: { from: '2026-10-02' } }] },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, toolCallId: 'tu_1', content: '{"x":1}', isError: true }, { type: 'text' as const, text: 'haan' }] },
    ],
  };

  it('builds a Messages API body: cached system and tools, one tool call at a time', () => {
    const body = toAnthropicBody('the-model', request, true) as Record<string, any>;
    expect(body).toMatchObject({
      model: 'the-model',
      max_tokens: 500,
      system: [{ type: 'text', text: 'You are Munshi.', cache_control: { type: 'ephemeral' } }],
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    });
    expect(body.tools[0]).toMatchObject({ name: 'reports__sales__summary', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } });
    expect(body.messages[1].content[0]).toEqual({ type: 'tool_use', id: 'tu_1', name: 'reports__sales__summary', input: { from: '2026-10-02' } });
    expect(body.messages[2].content[0]).toEqual({ type: 'tool_result', tool_use_id: 'tu_1', content: '{"x":1}', is_error: true });
  });

  it('reads a response, counting cache writes as input and cache reads separately', () => {
    const r = fromAnthropicResponse({
      model: 'the-model',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 'tu_9', name: 'masters__customer__search', input: { query: 'madina' } },
      ],
      usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 50, cache_read_input_tokens: 900 },
    });
    expect(r).toEqual({
      model: 'the-model',
      stopReason: 'tool_call',
      content: [
        { type: 'text', text: 'Checking.' },
        { type: 'tool_call', id: 'tu_9', name: 'masters__customer__search', input: { query: 'madina' } },
      ],
      usage: { inputTokens: 150, cachedInputTokens: 900, outputTokens: 20 },
    });
  });

  it('calls the API with the right headers and reports retryable failures', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const ok = createAnthropicModel({
      apiKey: 'sk-test',
      model: 'the-model',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return new Response(JSON.stringify({ model: 'the-model', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Salam' }], usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 });
      },
    });
    const res = await ok.complete(request);
    expect(res.content).toEqual([{ type: 'text', text: 'Salam' }]);
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]!.init.headers).toMatchObject({ 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' });

    const busy = createAnthropicModel({ apiKey: 'k', model: 'm', fetch: async () => new Response('overloaded', { status: 529 }) });
    await expect(busy.complete(request)).rejects.toMatchObject({ name: 'ModelError', status: 529, retryable: true });
    const bad = createAnthropicModel({ apiKey: 'k', model: 'm', fetch: async () => new Response('bad', { status: 400 }) });
    await expect(bad.complete(request)).rejects.toBeInstanceOf(ModelError);
    await expect(bad.complete(request)).rejects.toMatchObject({ retryable: false });
  });
});

describe('HTTP actions client', () => {
  it('posts to /actions/*, carries the token and idempotency key, and returns the ActionResult whatever the status', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    let fail = 1;
    const client = createHttpActionsClient({
      baseUrl: 'https://erp.example/api/',
      token: async () => 'delegated-token',
      fetch: async (url, init) => {
        seen.push({ url: String(url), headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) });
        if (String(url).endsWith('/execute') && fail-- > 0) throw new Error('socket hang up');
        if (String(url).endsWith('/preview'))
          return new Response(JSON.stringify({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'no', messages: { en: 'no', ur: 'نہیں' }, http: 403 }, meta: {} }), { status: 403 });
        return new Response(JSON.stringify({ ok: true, data: { done: true }, meta: {} }), { status: 200 });
      },
    });
    const denied = await client.preview({ action: 'sales.invoice.post', input: {} });
    expect(denied.ok).toBe(false);
    const done = await client.execute({ action: 'sales.invoice.post', input: {}, idempotencyKey: 'k-1' });
    expect(done.ok).toBe(true);
    expect(seen.map((s) => s.url)).toEqual([
      'https://erp.example/api/actions/preview',
      'https://erp.example/api/actions/execute',
      'https://erp.example/api/actions/execute',
    ]);
    expect(seen[1]!.headers).toMatchObject({ authorization: 'Bearer delegated-token', 'idempotency-key': 'k-1' });
  });

  it('does not retry an execute without an idempotency key, and rejects a refused token', async () => {
    const down = createHttpActionsClient({ baseUrl: 'https://erp', token: 't', fetch: async () => { throw new Error('down'); } });
    await expect(down.execute({ action: 'a.b', input: {} })).rejects.toBeInstanceOf(TransportError);
    const expired = createHttpActionsClient({
      baseUrl: 'https://erp',
      token: 't',
      fetch: async () => new Response(JSON.stringify({ error: 'expired' }), { status: 401 }),
    });
    await expect(expired.list()).rejects.toMatchObject({ status: 401 });
  });
});
