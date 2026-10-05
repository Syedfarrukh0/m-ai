/**
 * 0.2.1 — setting up a model: workspace-scoped Anthropic keys, listing the
 * model ids a key may use, the pre-flight check, and errors that say what is
 * wrong instead of "can't reach the system".
 */
import { describe, expect, it } from 'vitest';
import { DEMO_TENANT, IDS, createMockErp } from '@m-ai/mock-erp';
import {
  ModelError,
  configFromEnv,
  createAnthropicModel,
  createAssistant,
  createInProcessActionsClient,
  listAnthropicModels,
  listOpenAICompatibleModels,
  preflight,
  providerMessage,
} from '../src/index.js';
import type { M_AI_Config, ModelClient } from '../src/index.js';
import { runScenario } from '../scripts/eval-runner.js';

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };
function fakeFetch(handler: (c: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const c: Call = { url: String(url), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string> };
    if (init?.body) c.body = JSON.parse(String(init.body));
    calls.push(c);
    const r = handler(c);
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status });
  };
  return { fetch, calls };
}

const WORKSPACE_ERROR = {
  type: 'error',
  error: { type: 'invalid_request_error', message: 'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header.' },
};

describe('provider errors', () => {
  it('extracts the provider message', () => {
    expect(providerMessage(JSON.stringify(WORKSPACE_ERROR))).toContain('not scoped to a workspace');
    expect(providerMessage(JSON.stringify({ error: 'nope' }))).toBe('nope');
    expect(providerMessage('<html>bad gateway</html>')).toBe('<html>bad gateway</html>');
  });

  it('sends the workspace header when configured', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } }));
    await createAnthropicModel({ apiKey: 'k', model: 'm', workspaceId: 'wrkspc_1', fetch }).complete({ system: 's', messages: [], tools: [], maxTokens: 1 });
    expect(calls[0]!.headers).toMatchObject({ 'anthropic-workspace-id': 'wrkspc_1', 'x-api-key': 'k' });
  });
});

describe('listing model ids', () => {
  it('Anthropic: follows pages', async () => {
    const { fetch, calls } = fakeFetch((c) =>
      c.url.includes('after_id')
        ? { status: 200, body: { data: [{ id: 'model-c' }], has_more: false, last_id: 'model-c' } }
        : { status: 200, body: { data: [{ id: 'model-a' }, { id: 'model-b' }], has_more: true, last_id: 'model-b' } },
    );
    expect(await listAnthropicModels({ apiKey: 'k', fetch })).toEqual(['model-a', 'model-b', 'model-c']);
    expect(calls[1]!.url).toBe('https://api.anthropic.com/v1/models?limit=100&after_id=model-b');
  });

  it('Anthropic: a refused key becomes a ModelError with the provider message', async () => {
    const { fetch } = fakeFetch(() => ({ status: 400, body: WORKSPACE_ERROR }));
    await expect(listAnthropicModels({ apiKey: 'k', fetch })).rejects.toMatchObject({ name: 'ModelError', status: 400, message: expect.stringContaining('workspace') });
  });

  it('OpenAI-compatible: /models', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { data: [{ id: 'gpt-x' }, { id: 'llama' }] } }));
    expect(await listOpenAICompatibleModels({ baseUrl: 'http://localhost:11434/v1/', fetch })).toEqual(['gpt-x', 'llama']);
    expect(calls[0]!.url).toBe('http://localhost:11434/v1/models');
  });
});

function fakeConfig(listModels: () => Promise<string[]>, complete: ModelClient['complete'], modelId = 'haiku', provider: M_AI_Config['provider'] = 'anthropic'): M_AI_Config {
  return { provider, modelId, model: { complete }, listModels, languages: [] };
}
const ok: ModelClient['complete'] = async () => ({ content: [{ type: 'text', text: 'OK' }], stopReason: 'end', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, model: 'm' });

describe('pre-flight', () => {
  it('passes when the id is listed, without spending a model call', async () => {
    let called = false;
    const r = await preflight(fakeConfig(async () => ['claude-x', 'haiku'], async (q) => ((called = true), ok(q))));
    expect(r).toEqual({ ok: true, problems: [], suggestions: [], warnings: [] });
    expect(called).toBe(false);
  });

  it('explains a key that needs a workspace', async () => {
    const r = await preflight(fakeConfig(async () => { throw new ModelError('Anthropic answered 400: This API key is not scoped to a workspace', 400, false); }, ok));
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain('M_AI_ANTHROPIC_WORKSPACE_ID');
  });

  it('suggests close ids for a wrong model id', async () => {
    const r = await preflight(
      fakeConfig(async () => ['some-sonnet-1', 'some-haiku-2', 'some-haiku-3'], async () => { throw new ModelError('Anthropic answered 404: model: haiku', 404, false); }),
    );
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain('M_AI_MODEL "haiku" did not work');
    expect(r.suggestions).toEqual(['some-haiku-2', 'some-haiku-3']);
  });

  it('accepts an alias that is not listed but works', async () => {
    const r = await preflight(fakeConfig(async () => ['some-haiku-2'], ok, 'haiku-latest'));
    expect(r.ok).toBe(true);
    expect(r.warnings[0]).toContain('alias');
  });

  it('tests the model directly on servers that cannot list models', async () => {
    const r = await preflight(fakeConfig(async () => { throw new ModelError('the provider answered 404: not found', 404, false); }, ok, 'llama', 'openai-compatible'));
    expect(r.ok).toBe(true);
    expect(r.warnings[0]).toContain('does not list');
  });

  it('is wired to the configured provider', async () => {
    const config = configFromEnv({ M_AI_MODEL: 'x', M_AI_API_KEY: 'k', M_AI_ANTHROPIC_WORKSPACE_ID: 'wrkspc_9' });
    expect(typeof config.listModels).toBe('function');
  });
});

describe('telling the developer what went wrong', () => {
  const broken: ModelClient = { complete: async () => { throw new ModelError('Anthropic answered 404: model: haiku', 404, false); } };

  it('puts the model error in TurnResult.error', async () => {
    const erp = createMockErp();
    const assistant = createAssistant({ model: broken });
    const r = await assistant.handleTurn({
      conversationId: 'c',
      tenantId: DEMO_TENANT,
      userId: IDS.owner,
      text: 'aaj ki sale?',
      actions: createInProcessActionsClient(erp.registry, () => erp.assistantCtx()),
    });
    expect(r).toMatchObject({ status: 'unavailable', error: { source: 'model', message: 'Anthropic answered 404: model: haiku' } });
  });

  it('fails every eval scenario when the assistant could not work — none pass by accident', async () => {
    const { results } = await runScenario(
      { name: 'booker', user: 'booker', turns: [{ say: 'is mahine ki sale?', expect: { noCalls: ['reports.sales.summary'] } }] },
      { model: broken },
    );
    expect(results.find((r) => r.check === 'assistant was available')).toMatchObject({ ok: false, detail: 'Anthropic answered 404: model: haiku' });
  });
});
