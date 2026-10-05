import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEMO_TENANT, IDS, createMockErp } from '@m-ai/mock-erp';
import {
  BUILTIN_LANGUAGES,
  ConfigError,
  ENGLISH,
  ModelError,
  configFromEnv,
  createAssistant,
  createInProcessActionsClient,
  createLanguages,
  createMemoryConversationStore,
  createOpenAICompatibleModel,
  fromChatResponse,
  loadEnvFile,
  loadLanguagePacks,
  selectTools,
  toChatBody,
} from '../src/index.js';
import type { LanguagePack, ModelClient, ModelRequest, ModelResponse } from '../src/index.js';
import { createScriptedModel } from '../src/testing/index.js';
import { runScenario } from '../scripts/eval-runner.js';
import type { Scenario } from '../scripts/eval-runner.js';

const PUNJABI_ROMAN: LanguagePack = {
  code: 'pa-Latn',
  name: 'Roman Punjabi',
  markers: ['kinni', 'kinna', 'tusi', 'tuhada', 'sadda', 'hoyi', 'hoya', 'ajj', 'dasso', 'karo ji', 'kithe'],
  yes: ['haanji', 'aho', 'theek ae'],
  no: ['nai ji', 'rehn do'],
  replyRule: 'Reply in Roman Punjabi.',
  phrases: { ...ENGLISH.phrases, confirmQuestion: 'Kar dewan? "aho" ya "nai ji" likho.', yesLabel: 'Aho', noLabel: 'Nai' },
};

describe('language packs', () => {
  it('adds a language without code: detection, phrases, yes/no', () => {
    const langs = createLanguages([...BUILTIN_LANGUAGES, PUNJABI_ROMAN]);
    expect(langs.codes).toEqual(['en', 'ur', 'ur-Latn', 'pa-Latn']);
    expect(langs.detect('ajj di sale kinni hoyi tusi dasso', 'en')).toBe('pa-Latn');
    expect(langs.detect('aaj ki sale kitni hui?', 'en')).toBe('ur-Latn');
    expect(langs.phrase('confirmQuestion', 'pa-Latn')).toContain('aho');
    expect(langs.parseConfirmation('aho')).toBe('yes');
    expect(langs.parseConfirmation('haan')).toBe('yes');
    expect(langs.parseConfirmation('rehn do')).toBe('no');
    // an unknown code falls back to English sentences and a generic reply rule
    expect(langs.phrase('cancelled', 'sd')).toBe(ENGLISH.phrases.cancelled);
    expect(langs.replyRule('sd')).toContain('sd');
  });

  it('drops a word that is "yes" in one pack and "no" in another', () => {
    const odd: LanguagePack = { ...PUNJABI_ROMAN, code: 'xx-Latn', yes: ['na'], no: ['ok'] };
    const langs = createLanguages([...BUILTIN_LANGUAGES, odd]);
    expect(langs.parseConfirmation('na')).toBe('other');
    expect(langs.parseConfirmation('ok')).toBe('other');
    expect(langs.parseConfirmation('haan')).toBe('yes');
  });

  it('refuses an incomplete pack and duplicate codes', () => {
    const { phrases: _p, ...noPhrases } = PUNJABI_ROMAN;
    expect(() => createLanguages([{ ...noPhrases, phrases: { yesLabel: 'x' } } as unknown as LanguagePack])).toThrow();
    expect(() => createLanguages([ENGLISH, ENGLISH])).toThrow(/unique/);
  });

  it('loads packs from a folder and names the bad file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'packs-'));
    writeFileSync(join(dir, 'pa.json'), JSON.stringify(PUNJABI_ROMAN));
    expect(loadLanguagePacks(dir).map((p) => p.code)).toEqual(['pa-Latn']);
    writeFileSync(join(dir, 'zz-bad.json'), JSON.stringify({ code: 'zz' }));
    expect(() => loadLanguagePacks(dir)).toThrow(/zz-bad\.json/);
  });
});

function harness(model: ModelClient, extra: Parameters<typeof createAssistant>[0] extends infer O ? Partial<O> : never = {}) {
  const erp = createMockErp();
  const conversations = createMemoryConversationStore();
  const assistant = createAssistant({ model, conversations, now: () => erp.host.now(), retryDelayMs: 1, ...extra });
  const actions = createInProcessActionsClient(erp.registry, () => erp.assistantCtx(IDS.owner, { actor: { clientId: 'm-ai-assistant' } }));
  const turn = (text: string, choice?: 'yes' | 'no') =>
    assistant.handleTurn({ conversationId: 'c1', tenantId: DEMO_TENANT, userId: IDS.owner, text, actions, ...(choice ? { choice } : {}) });
  return { erp, turn, conversations };
}

const ORDER = { customerId: IDS.madinaStore, lines: [{ productId: IDS.pepsi, quantity: 10 }] };

describe('buttons', () => {
  it('offers Yes/No labels in the reply language and accepts a button press', async () => {
    const model = createScriptedModel([{ call: { name: 'sales.invoice.post', input: ORDER } }, 'Ho gaya.']);
    const t = harness(model);
    const asked = await t.turn('Madina Store ko 10 carton Pepsi bhej do');
    expect(asked.pending?.options).toEqual([
      { value: 'yes', label: 'Haan' },
      { value: 'no', label: 'Nahi' },
    ]);
    const done = await t.turn('[button]', 'yes');
    expect(done.executed).toEqual([{ action: 'sales.invoice.post', ok: true }]);
  });
});

describe('one step at a time', () => {
  it('keeps only the first of several tool calls, so history stays valid', async () => {
    let n = 0;
    const requests: ModelRequest[] = [];
    const model: ModelClient = {
      async complete(req): Promise<ModelResponse> {
        requests.push(structuredClone(req));
        n++;
        if (n === 1)
          return {
            content: [
              { type: 'tool_call', id: 'a', name: 'reports__sales__summary', input: { from: '2026-10-02', to: '2026-10-02' } },
              { type: 'tool_call', id: 'b', name: 'reports__receivables__outstanding', input: {} },
            ],
            stopReason: 'tool_call',
            usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 },
            model: 'm',
          };
        return { content: [{ type: 'text', text: 'Aaj ki sale 2,124 hai.' }], stopReason: 'end', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, model: 'm' };
      },
    };
    const t = harness(model);
    const r = await t.turn('aaj ki sale?');
    expect(r.reply).toBe('Aaj ki sale 2,124 hai.');
    const assistantMsg = requests[1]!.messages[1]!;
    expect(assistantMsg.content.filter((b) => b.type === 'tool_call').map((b) => (b as { id: string }).id)).toEqual(['a']);
    expect(requests[1]!.messages[2]!.content[0]).toMatchObject({ type: 'tool_result', toolCallId: 'a' });
  });
});

describe('model failures', () => {
  it('retries a retryable error, then answers', async () => {
    let calls = 0;
    const model: ModelClient = {
      async complete() {
        calls++;
        if (calls === 1) throw new ModelError('overloaded', 529, true);
        return { content: [{ type: 'text', text: 'Salam!' }], stopReason: 'end', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, model: 'm' };
      },
    };
    const r = await harness(model).turn('salam bhai kya haal hai');
    expect(r).toMatchObject({ status: 'answered', reply: 'Salam!' });
    expect(calls).toBe(2);
  });

  it('says unavailable on a hard failure and keeps the conversation usable', async () => {
    const model: ModelClient = { complete: async () => { throw new ModelError('bad key', 401, false); } };
    const t = harness(model);
    const r = await t.turn('aaj ki sale kitni hui?');
    expect(r.status).toBe('unavailable');
    const state = await t.conversations.get('c1');
    expect(state!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

describe('app-neutral configuration', () => {
  it('uses the app\'s own words and instructions', async () => {
    const erp = createMockErp();
    const catalog = (await erp.registry.list(erp.assistantCtx())).actions;
    // a school might call its customers "parents"
    expect(selectTools(catalog, 'parents ki fees', 3, { parents: ['customers'], fees: ['receivables'] }).map((e) => e.name)).toContain(
      'reports.receivables.outstanding',
    );
    const model = createScriptedModel(['Ji.']);
    await harness(model, { instructions: 'Customers are schools. "Fees" means receivables.' }).turn('fees batao');
    expect(model.requests[0]!.system).toContain('Customers are schools');
    // the name 'Munshi' comes from the company's settings; the prompt itself carries no trade wording
    expect(model.requests[0]!.system).not.toMatch(/shop owner|trusted munshi/i);
  });
});

describe('OpenAI-compatible adapter', () => {
  const request: ModelRequest = {
    system: 'sys',
    maxTokens: 300,
    tools: [{ name: 'masters__customer__search', description: 'Find', inputSchema: { type: 'object', properties: {} } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'madina' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Checking' }, { type: 'tool_call', id: 'c1', name: 'masters__customer__search', input: { query: 'madina' } }] },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c1', content: '{"items":[]}' }, { type: 'text', text: 'haan' }] },
    ],
  };

  it('turns tool results into "tool" messages before the person\'s text', () => {
    const body = toChatBody({ model: 'gpt-x' }, request) as { messages: Array<Record<string, unknown>>; [k: string]: unknown };
    expect(body.messages.map((m) => m['role'])).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(body.messages[2]).toMatchObject({
      content: 'Checking',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'masters__customer__search', arguments: '{"query":"madina"}' } }],
    });
    expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"items":[]}' });
    expect(body).toMatchObject({ model: 'gpt-x', max_tokens: 300, tool_choice: 'auto', parallel_tool_calls: false });
    expect(toChatBody({ model: 'm', disableParallelToolCalls: false, useMaxCompletionTokens: true }, request)).toMatchObject({ max_completion_tokens: 300 });
    expect(toChatBody({ model: 'm', disableParallelToolCalls: false }, request)).not.toHaveProperty('parallel_tool_calls');
  });

  it('reads tool calls, bad JSON arguments and cached tokens', () => {
    const r = fromChatResponse(
      {
        model: 'gpt-x',
        choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 't1', function: { name: 'a__b', arguments: '{"q":1}' } }, { id: 't2', function: { name: 'a__c', arguments: '{oops' } }] } }],
        usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } },
      },
      'fallback',
    );
    expect(r.content).toEqual([
      { type: 'tool_call', id: 't1', name: 'a__b', input: { q: 1 } },
      { type: 'tool_call', id: 't2', name: 'a__c', input: { _unparsedArguments: '{oops' } },
    ]);
    expect(r).toMatchObject({ stopReason: 'tool_call', usage: { inputTokens: 200, cachedInputTokens: 800, outputTokens: 50 }, model: 'gpt-x' });
  });

  it('posts to /chat/completions with the key, and works without one (local servers)', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), headers: init!.headers as Record<string, string> });
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Salam' } }] }), { status: 200 });
    };
    await createOpenAICompatibleModel({ model: 'm', baseUrl: 'https://api.openai.com/v1/', apiKey: 'sk-1', fetch }).complete(request);
    await createOpenAICompatibleModel({ model: 'llama', baseUrl: 'http://localhost:11434/v1', fetch }).complete(request);
    expect(seen[0]).toMatchObject({ url: 'https://api.openai.com/v1/chat/completions', headers: { authorization: 'Bearer sk-1' } });
    expect(seen[1]!.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(seen[1]!.headers).not.toHaveProperty('authorization');
  });
});

describe('configuration from the environment', () => {
  it('lists every problem at once', () => {
    try {
      configFromEnv({ M_AI_PROVIDER: 'openai-compatible', M_AI_PRICE_IN: 'cheap' });
      throw new Error('should have failed');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const problems = (e as ConfigError).problems.join('\n');
      expect(problems).toContain('M_AI_MODEL is required');
      expect(problems).toContain('M_AI_BASE_URL is required');
      expect(problems).toContain('M_AI_PRICE_IN');
    }
  });

  it('builds each provider', () => {
    expect(configFromEnv({ M_AI_MODEL: 'x', ANTHROPIC_API_KEY: 'k' })).toMatchObject({ provider: 'anthropic', modelId: 'x' });
    expect(configFromEnv({ M_AI_PROVIDER: 'openai', M_AI_MODEL: 'x', OPENAI_API_KEY: 'k' }).provider).toBe('openai');
    const local = configFromEnv({ M_AI_PROVIDER: 'openai-compatible', M_AI_MODEL: 'llama3.1', M_AI_BASE_URL: 'http://localhost:11434/v1' });
    expect(local.pricing).toBeUndefined();
    const priced = configFromEnv({ M_AI_MODEL: 'x', M_AI_API_KEY: 'k', M_AI_PRICE_IN: '3', M_AI_PRICE_OUT: '15' });
    expect(priced.pricing).toEqual({ inputPerMTok: '3', cachedInputPerMTok: '3', outputPerMTok: '15' });
    expect(() => configFromEnv({ M_AI_MODEL: 'x' })).toThrow(/M_AI_API_KEY/);
  });

  it('reads .env files without overriding the real environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-'));
    const path = join(dir, '.env');
    writeFileSync(path, '# comment\nM_AI_MODEL="from-file"\nexport M_AI_API_KEY=abc # trailing\nM_AI_PROVIDER=anthropic\n');
    const env: Record<string, string | undefined> = { M_AI_PROVIDER: 'openai' };
    expect(loadEnvFile(path, env)).toBe(true);
    expect(env).toEqual({ M_AI_PROVIDER: 'openai', M_AI_MODEL: 'from-file', M_AI_API_KEY: 'abc' });
    expect(loadEnvFile(join(dir, 'missing.env'), env)).toBe(false);
  });
});

describe('eval runner', () => {
  const scenario: Scenario = {
    name: 'sales today',
    turns: [
      {
        say: 'aaj ki sale kitni hui?',
        expect: {
          status: 'answered',
          language: 'ur-Latn',
          calls: ['reports.sales.summary'],
          callInput: { 'reports.sales.summary': { from: '2026-10-02' } },
          figures: ['2124'],
        },
      },
    ],
    after: { invoices: 4 },
  };

  it('passes a model that does the right thing', async () => {
    const model = createScriptedModel([{ call: { name: 'reports.sales.summary', input: { from: '2026-10-02', to: '2026-10-02' } } }, 'Aaj ki sale 2,124 hai.']);
    const { results } = await runScenario(scenario, { model });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.length).toBe(8); // 5 expectations + availability + numbers + the after-check
  });

  it('fails a model that uses the wrong date or figure', async () => {
    const model = createScriptedModel([{ call: { name: 'reports.sales.summary', input: { from: '2026-10-01', to: '2026-10-01' } } }, 'Aaj ki sale 0 hai.']);
    const failed = (await runScenario(scenario, { model })).results.filter((r) => !r.ok).map((r) => r.check);
    expect(failed).toEqual(['reports.sales.summary input ⊇ {"from":"2026-10-02"}', 'reply has 2124']);
  });
});
