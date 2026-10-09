/**
 * A provider-neutral view of a chat model with tools. Adapters (Anthropic,
 * others later) translate to and from it; the rest of the assistant never
 * sees a provider's wire format.
 */

import type { ModelPricing } from './usage.js';

export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock;

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolCallBlock {
  type: 'tool_call';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolCallId: string;
  /** JSON or plain text the model reads. */
  content: string;
  isError?: boolean;
}

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ToolSpec {
  /** ^[a-zA-Z0-9_-]{1,64}$ — see toToolName(). */
  name: string;
  description: string;
  /** JSON Schema, type "object". */
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  tools: ToolSpec[];
  maxTokens: number;
}

export interface ModelUsage {
  /** Uncached input tokens, including tokens written to a cache. */
  inputTokens: number;
  /** Input tokens read from a cache (billed cheaper). */
  cachedInputTokens: number;
  outputTokens: number;
}

export interface ModelResponse {
  /** Text and tool calls only. */
  content: Array<TextBlock | ToolCallBlock>;
  stopReason: 'end' | 'tool_call' | 'max_tokens' | 'other';
  usage: ModelUsage;
  /** The model that answered, as the provider names it. */
  model: string;
  /**
   * The price of the model that answered, when its client knows it. The
   * assistant costs each call with it, so a switched or fallback model is
   * never costed at another model's price.
   */
  pricing?: ModelPricing;
}

/**
 * One call to a model. Implementations must ask the provider for at most one
 * tool call per response (no parallel tool use) — the assistant handles one
 * step at a time so a change can always stop for confirmation.
 */
export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
  /**
   * Optional quick check that the model can answer now (a local machine is on,
   * and has the model). Used by withFallback to skip a model that is down
   * without waiting for a timeout.
   */
  health?(): Promise<boolean>;
  /**
   * The most input tokens one request may carry (the context window less room
   * for the answer). Requests are fitted to it — fewer tools, shorter old
   * results — instead of being cut or refused. Set for local models (Ollama's
   * num_ctx); learnt from the provider's "request too large" for the others.
   */
  maxInputTokens?: number;
}

/** A model call that failed. `retryable` for rate limits, overload and network errors. */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
    /** How long the provider asked us to wait (Retry-After), when it said. */
    readonly retryAfterMs?: number,
    /** The request was too large for the model or the plan; with the numbers the provider gave. */
    readonly tooLarge?: { limit?: number; requested?: number },
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

/**
 * "Request too large … Limit 8000, Requested 9058" (Groq's free plan),
 * "maximum context length is 8192 tokens … resulted in 9000 tokens" (OpenAI),
 * "prompt is too long: 210000 tokens > 200000 maximum" (Anthropic).
 */
const TOO_LARGE =
  /request too large|reduce your message size|context length|context window|maximum context|prompt is too long|input is too long|too many tokens|context_length_exceeded/i;

export function tooLargeInfo(message: string, status?: number): { limit?: number; requested?: number } | undefined {
  if (status !== 413 && !TOO_LARGE.test(message)) return undefined;
  const num = (re: RegExp) => {
    const m = re.exec(message);
    return m ? Number(m[1]) : undefined;
  };
  const limit = num(/limit\s*:?\s*(\d+)/i) ?? num(/maximum context length is (\d+)/i) ?? num(/>\s*(\d+)\s*maximum/i);
  const requested = num(/requested\s*:?\s*(\d+)/i) ?? num(/resulted in (\d+)/i) ?? num(/(\d+)\s*tokens\s*>/i);
  return { ...(limit !== undefined ? { limit } : {}), ...(requested !== undefined ? { requested } : {}) };
}

/**
 * A rate limit: waiting helps. Checked first, because rate-limit messages often
 * mention billing or quota too (Groq: "Rate limit reached … upgrade at …/billing";
 * Gemini: "Quota exceeded for metric … Please retry in 30s").
 */
const RATE_LIMIT =
  /rate.?limit|too many requests|try again in|retry in|retry after|per minute|per day|requests per|tokens per|\b(?:rpm|tpm|rpd|tpd)\b|concurrency|overloaded|high load|temporarily/i;
/** "No credit": some providers (Z.ai) send it as a 429, but waiting won't help. */
const NO_CREDIT = /insufficient balance|no resource package|recharge|credit balance|insufficient (?:credit|funds|quota)|exceeded your current quota|payment required|余额/i;

/**
 * A DAILY limit ("tokens per day (TPD)", "requests per day"): waiting a minute
 * won't help, so the turn doesn't wait — a router moves to its next model and
 * leaves this one aside until the provider's "try again in …".
 */
const DAILY_LIMIT = /per day|\b(?:rpd|tpd)\b|daily (?:limit|quota)/i;

export function isDailyLimitMessage(message: string): boolean {
  return DAILY_LIMIT.test(message);
}

/** "Please try again in 7m12.5s" / "retry in 30s" / "1h2m" → milliseconds (at most a day). */
export function waitHintMs(message: string): number | undefined {
  const m = /(?:try again|retry) in\s+((?:\d+(?:\.\d+)?\s*(?:ms|h|m|s)\s*)+)/i.exec(message);
  if (!m) return undefined;
  let ms = 0;
  for (const [, n, unit] of m[1]!.matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s)/gi)) {
    const v = Number(n);
    ms += unit!.toLowerCase() === 'h' ? v * 3_600_000 : unit!.toLowerCase() === 'm' ? v * 60_000 : unit!.toLowerCase() === 'ms' ? v : v * 1000;
  }
  return ms > 0 ? Math.min(Math.round(ms), 86_400_000) : undefined;
}

/** True when a provider message is about a rate limit (wait and retry), not about credit. */
export function isRateLimitMessage(message: string): boolean {
  return RATE_LIMIT.test(message);
}

/** True when a provider refused for lack of credit (waiting won't help). */
export function isNoCreditMessage(message: string, status?: number): boolean {
  return !RATE_LIMIT.test(message) && (NO_CREDIT.test(message) || status === 402);
}

/**
 * The provider rejected the MODEL's own tool call (Groq checks arguments against
 * the schema: "tool_use_failed", "Tool call validation failed"). A model slip,
 * not a refusal: asking again usually works.
 */
const TOOL_CALL_REJECTED = /tool_use_failed|tool call validation failed|failed to call a function|did not match schema/i;

/** Builds the ModelError for a failed HTTP response: retryable only when waiting or asking again can help. */
export function httpModelError(prefix: string, res: Response, body: string): ModelError {
  const message = providerMessage(body);
  const noCredit = isNoCreditMessage(message, res.status);
  const modelSlip = res.status === 400 && (TOOL_CALL_REJECTED.test(message) || TOOL_CALL_REJECTED.test(body.slice(0, 2000)));
  const daily = res.status === 429 && isDailyLimitMessage(message);
  // Too large as sent: waiting won't help, a smaller request will (see withInputBudget).
  const tooLarge = tooLargeInfo(message, res.status);
  if (tooLarge) return new ModelError(`${prefix} ${res.status}: ${message}`, res.status, false, undefined, tooLarge);
  const retryable = !noCredit && !daily && (modelSlip || res.status === 408 || res.status === 429 || res.status === 529 || res.status >= 500);
  // A daily limit carries the provider's own wait (uncapped), so a router can leave the model aside that long.
  const wait = daily ? (waitHintMs(message) ?? retryAfter(res.headers)) : (retryAfter(res.headers) ?? capped(waitHintMs(message)));
  return new ModelError(`${prefix} ${res.status}: ${message}`, res.status, retryable, wait);
}

function capped(ms: number | undefined): number | undefined {
  return ms === undefined ? undefined : Math.min(ms, 120_000);
}

/** Retry-After / retry-after-ms as milliseconds, capped at 2 minutes. */
export function retryAfter(headers: Headers): number | undefined {
  const ms = Number(headers.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return Math.min(ms, 120_000);
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 120_000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.min(Math.max(0, at - Date.now()), 120_000);
}

/** The ModelError for a request that never got an answer (network, timeout). */
export function networkModelError(e: unknown, timeoutMs: number): ModelError {
  const err = e as Error;
  const timedOut = err?.name === 'AbortError' || /aborted/i.test(err?.message ?? '');
  return new ModelError(
    timedOut ? `the model did not answer within ${Math.round(timeoutMs / 1000)} s (raise M_AI_TIMEOUT_SECONDS for slow or local models)` : `model request failed: ${err?.message ?? String(e)}`,
    undefined,
    true,
  );
}

/** The provider's own error message, when the body is {"error":{"message":…}}. */
export function providerMessage(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    if (typeof body.error === 'object' && typeof body.error?.message === 'string') return body.error.message;
    if (typeof body.error === 'string') return body.error;
    if (typeof body.message === 'string') return body.message;
  } catch {
    // not JSON
  }
  return text.slice(0, 300);
}

export function textOf(content: ReadonlyArray<ContentBlock>): string {
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
