/**
 * 0.4.8 — the owner's fourth run: Groq's free plan refused two requests as
 * "Request too large … Limit 8000, Requested 9058". Requests are now fitted
 * to what a model takes: a set limit, a local model's window, or what the
 * provider's refusal says.
 */
import { describe, expect, it } from 'vitest';
import { ModelError, createModel, estimateTokens, fitRequest, httpModelError, tooLargeInfo, withInputBudget } from '../src/index.js';
import type { ModelRequest, ToolSpec } from '../src/index.js';

const tool = (name: string, size = 2000): ToolSpec => ({ name, description: 'x'.repeat(size), inputSchema: { type: 'object', properties: {} } });
const request = (tools: ToolSpec[], resultChars = 6000): ModelRequest => ({
  system: 's'.repeat(3000),
  tools,
  maxTokens: 1024,
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'kis kis ka udhaar baqi hai?' }] },
    { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'reports__receivables__outstanding', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c1', content: 'r'.repeat(resultChars) }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Metro par sab se zyada hai.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Metro ki unpaid invoices dikhao' }] },
  ],
});
const TOOLS = [
  tool('masters__customer__search'),
  tool('sales__invoice__list'),
  tool('reports__receivables__outstanding'),
  ...Array.from({ length: 12 }, (_, i) => tool(`other_${i}`)),
  tool('assistant_remember', 200),
];

describe('fitting a request', () => {
  it('leaves a request that fits alone', () => {
    const r = request(TOOLS);
    expect(fitRequest(r, estimateTokens(r) + 1)).toBe(r);
  });

  it('shortens older results first, keeping the latest message whole', () => {
    const r = request(TOOLS.slice(0, 3), 20_000);
    const fitted = fitRequest(r, estimateTokens(r) - 3000);
    const old = fitted.messages[2]!.content[0]!;
    expect(old.type === 'tool_result' && old.content.length).toBeLessThan(1300);
    expect(fitted.messages[4]).toEqual(r.messages[4]);
    expect(fitted.tools).toHaveLength(3);
  });

  it('then leaves out the least likely tools, never the ones already used or the remember tool', () => {
    const r = request(TOOLS);
    const fitted = fitRequest(r, 5000);
    const names = fitted.tools.map((t) => t.name);
    expect(estimateTokens(fitted)).toBeLessThanOrEqual(5000);
    expect(names).toContain('reports__receivables__outstanding');
    expect(names).toContain('assistant_remember');
    expect(names.slice(0, 2)).toEqual(['masters__customer__search', 'sales__invoice__list']);
    expect(names).not.toContain('other_11');
  });

  it('keeps at least a few tools even when the budget is tiny', () => {
    const fitted = fitRequest(request(TOOLS), 100);
    expect(fitted.tools.filter((t) => t.name !== 'assistant_remember' && t.name !== 'reports__receivables__outstanding').length).toBeGreaterThanOrEqual(4);
  });
});

describe('a provider’s "request too large"', () => {
  const groq413 =
    'Request too large for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 9058, please reduce your message size and try again.';

  it('is read with its numbers, and is not waited for', () => {
    const e = httpModelError('groq', new Response(null, { status: 413 }), JSON.stringify({ error: { message: groq413 } }));
    expect(e.retryable).toBe(false);
    expect(e.tooLarge).toEqual({ limit: 8000, requested: 9058 });
    expect(tooLargeInfo("This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.")).toEqual({ limit: 8192, requested: 9000 });
    expect(tooLargeInfo('prompt is too long: 210000 tokens > 200000 maximum')).toEqual({ limit: 200000, requested: 210000 });
    expect(tooLargeInfo('Rate limit reached … tokens per minute', 429)).toBeUndefined();
  });

  it('is answered with one smaller request at once, and the size is kept for the next ones', async () => {
    const seen: number[] = [];
    const model = withInputBudget({
      async complete(r) {
        const size = estimateTokens(r);
        seen.push(size);
        if (size > 6000) throw new ModelError('groq 413: Request too large', 413, false, undefined, { limit: 8000, requested: size + 2048 });
        return { content: [{ type: 'text', text: 'ok' }], stopReason: 'end', usage: { inputTokens: size, cachedInputTokens: 0, outputTokens: 1 }, model: 'm' };
      },
    });
    const r = request(TOOLS);
    expect(estimateTokens(r)).toBeGreaterThan(6000);
    await model.complete(r);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeLessThanOrEqual(6000);
    await model.complete(r);
    expect(seen).toHaveLength(3); // fitted before sending: no second refusal
    expect(seen[2]).toBeLessThanOrEqual(6000);
  });

  it('other errors pass through untouched', async () => {
    const model = withInputBudget({
      async complete() {
        throw new ModelError('groq 429: busy', 429, true);
      },
    });
    await expect(model.complete(request(TOOLS))).rejects.toMatchObject({ status: 429, retryable: true });
  });
});

describe('limits from settings', () => {
  it('an Ollama model keeps inside its window', () => {
    const m = createModel('ollama:qwen3.5:4b', { M_AI_PROVIDER: 'ollama', M_AI_MODEL: 'qwen3.5:4b' } as never);
    expect(m.model.maxInputTokens).toBe(8192 - 1024 - 256);
    const big = createModel('ollama:gpt-oss:20b', { M_AI_PROVIDER: 'ollama', M_AI_MODEL: 'gpt-oss:20b', M_AI_NUM_CTX: '16384' } as never);
    expect(big.model.maxInputTokens).toBe(16384 - 2048 - 256); // gpt-oss always thinks a little
  });

  it('a cloud model can be given one (M_AI_<PROVIDER>_MAX_INPUT_TOKENS)', () => {
    const m = createModel('groq:openai/gpt-oss-120b', { GROQ_API_KEY: 'k', M_AI_GROQ_MAX_INPUT_TOKENS: '5500' } as never);
    expect(m.model.maxInputTokens).toBe(5500);
    expect(() => createModel('groq:openai/gpt-oss-120b', { GROQ_API_KEY: 'k', M_AI_GROQ_MAX_INPUT_TOKENS: 'lots' } as never)).toThrow(/MAX_INPUT_TOKENS/);
  });
});

describe('start-up check on a used-up day', () => {
  it('says the daily limit is the problem, and when to try again', async () => {
    const { preflight } = await import('../src/index.js');
    const target = {
      provider: 'groq' as const,
      modelId: 'openai/gpt-oss-120b',
      listModels: async () => ['openai/gpt-oss-120b'],
      model: {
        complete: async () => {
          throw new ModelError('groq 429: Rate limit reached … on tokens per day (TPD): Limit 200000, Used 199988, Requested 316. Please try again in 2m11.328s.', 429, false, 131_328);
        },
      },
    };
    const r = await preflight(target);
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/DAILY limit is used up; the provider says try again in 3 min/);
  });
});

describe('a named record gets an answer about that record (the owner’s run 6)', () => {
  it('the prompt says so, with hisaab and khata as a customer’s statement', async () => {
    const { buildSystemPrompt } = await import('../src/index.js');
    const settings = { enabled: true, name: 'M.Ai', language: 'auto', tone: 'friendly', policy: { allowDestructive: false, stepUp: 'app' } } as never;
    const prompt = buildSystemPrompt({ settings, context: undefined, replyRule: 'x', notes: [] });
    expect(prompt).toMatch(/13\. When the person names a particular customer.*hisaab.*statement of account.*Never answer with a company-wide total/);
  });
});
