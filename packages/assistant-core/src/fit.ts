/**
 * Fitting a request to what a model can take.
 *
 * A local model has a small context window (Ollama's num_ctx, 8192 by
 * default) and cuts what doesn't fit from the START, which silently drops the
 * system prompt. A free cloud plan refuses a request above its per-minute
 * tokens (Groq: "Request too large … Limit 8000, Requested 9058"). Either way
 * the answer is a smaller request: older tool results shortened first, then
 * the least likely tools left out (they are offered best first). Tools the
 * conversation already used, and "remember", always stay.
 */
import type { ContentBlock, ModelClient, ModelMessage, ModelRequest } from './model.js';
import { ModelError } from './model.js';
import { REMEMBER_TOOL } from './prompt.js';

/** JSON and English run about 3.2 characters a token; erring a little high keeps a fitted request under the limit. */
export function estimateTokens(request: Pick<ModelRequest, 'system' | 'tools' | 'messages'>): number {
  return Math.ceil((request.system.length + JSON.stringify(request.tools).length + JSON.stringify(request.messages).length) / 3.2);
}

const OLD_RESULT_CHARS = 1200;
const MIN_TOOLS = 4;
const FLOOR_TOKENS = 1500;

export function fitRequest(request: ModelRequest, budget: number): ModelRequest {
  if (estimateTokens(request) <= budget) return request;

  // 1. Older tool results, shortened (the latest message stays whole: the model is answering it).
  const last = request.messages.length - 1;
  const messages: ModelMessage[] = request.messages.map((m, i) =>
    i === last
      ? m
      : {
          ...m,
          content: m.content.map((b): ContentBlock =>
            b.type === 'tool_result' && b.content.length > OLD_RESULT_CHARS ? { ...b, content: `${b.content.slice(0, OLD_RESULT_CHARS)}…(shortened)` } : b,
          ),
        },
  );
  let fitted: ModelRequest = { ...request, messages };
  if (estimateTokens(fitted) <= budget) return fitted;

  // 2. The least likely tools left out, from the end of the list.
  const used = new Set<string>([REMEMBER_TOOL]);
  for (const m of request.messages) for (const b of m.content) if (b.type === 'tool_call') used.add(b.name);
  const tools = [...fitted.tools];
  for (let i = tools.length - 1; i >= 0 && estimateTokens({ ...fitted, tools }) > budget; i--) {
    if (tools.filter((t) => !used.has(t.name)).length <= MIN_TOOLS) break;
    if (!used.has(tools[i]!.name)) tools.splice(i, 1);
  }
  fitted = { ...fitted, tools };
  return fitted;
}

/**
 * Wraps a model so every request fits it: to `maxInputTokens` when known, and
 * after a "too large" refusal, to what the provider's numbers allow — learnt
 * once and kept for the next requests. The refused request is retried once,
 * smaller, straight away.
 */
export function withInputBudget(model: ModelClient, maxInputTokens?: number): ModelClient {
  const cap = maxInputTokens ?? model.maxInputTokens;
  let learnt: number | undefined;
  const budget = () => (learnt !== undefined && cap !== undefined ? Math.min(learnt, cap) : (learnt ?? cap));
  const wrapped: ModelClient = {
    async complete(request) {
      const first = budget() !== undefined ? fitRequest(request, budget()!) : request;
      try {
        return await model.complete(first);
      } catch (e) {
        if (!(e instanceof ModelError) || !e.tooLarge) throw e;
        const sent = estimateTokens(first);
        const { limit, requested } = e.tooLarge;
        const target =
          limit !== undefined && requested !== undefined
            ? sent - (requested - Math.floor(limit * 0.9))
            : limit !== undefined
              ? Math.floor(limit * 0.8)
              : Math.floor(sent * 0.7);
        learnt = Math.max(FLOOR_TOKENS, Math.min(target, sent - 1));
        return model.complete(fitRequest(request, budget()!));
      }
    },
  };
  if (model.health) wrapped.health = () => model.health!();
  if (cap !== undefined) wrapped.maxInputTokens = cap;
  return wrapped;
}
