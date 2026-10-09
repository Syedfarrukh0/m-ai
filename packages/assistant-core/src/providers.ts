import { withInputBudget } from './fit.js';
import { z } from 'zod';
import { createAnthropicModel, listAnthropicModels } from './anthropic.js';
import type { ModelClient } from './model.js';
import { ModelError } from './model.js';
import { createOllamaModel, listOllamaModels } from './ollama.js';
import { createOpenAICompatibleModel, listOpenAICompatibleModels } from './openai.js';
import type { ModelPricing } from './usage.js';
import { isPrice } from './usage.js';

/**
 * Model providers, and building a model from a "provider:model" spec at any
 * time — at start-up from .env, or at runtime (a company's chosen model, the
 * terminal's /model command). Keys for several providers can sit in .env at
 * once; the one used is picked by the spec.
 */

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`M.Ai configuration is incomplete:\n  - ${problems.join('\n  - ')}\nSee .env.example.`);
    this.name = 'ConfigError';
  }
}

/** M_AI_THINKING: off (default), on, or a level for models that have levels. */
export type ThinkingLevel = 'off' | 'on' | 'low' | 'medium' | 'high';

function thinkingLevel(raw: string | undefined): ThinkingLevel {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'low' || v === 'medium' || v === 'high') return v;
  return bool(v, false) ? 'on' : 'off';
}

export type Provider = 'anthropic' | 'openai' | 'zai' | 'groq' | 'gemini' | 'openrouter' | 'ollama' | 'openai-compatible';

export interface ProviderPreset {
  /** The wire format: Anthropic Messages, OpenAI Chat Completions, or Ollama's own /api/chat. */
  api: 'anthropic' | 'openai' | 'ollama';
  label: string;
  baseUrl?: string;
  /** Other environment variables that may hold the key. */
  keyAliases: string[];
  keyRequired: boolean;
  /** Where to create a key. */
  keyUrl?: string;
  /** Send `parallel_tool_calls: false` (OpenAI wire format only). */
  parallelToolCallsParam: boolean;
  /** Request fields for a thinking level (M_AI_THINKING), for this model. */
  thinking?: (level: ThinkingLevel, modelId: string) => Record<string, unknown>;
  /** Model ids from the provider's docs, shown when it cannot list them. */
  knownModels?: string[];
  /** Free models the provider may not list. */
  freeModels?: string[];
  /** Output tokens each call may use at least — for models that think before they answer. */
  minMaxTokens?: number;
  /** Request timeout. Default 60 s. */
  timeoutMs?: number;
  /** One line for people choosing a provider. */
  note?: string;
}

export const PROVIDERS: Record<Provider, ProviderPreset> = {
  anthropic: {
    api: 'anthropic',
    label: 'Anthropic',
    keyAliases: ['ANTHROPIC_API_KEY'],
    keyRequired: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    parallelToolCallsParam: false,
  },
  openai: {
    api: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyAliases: ['OPENAI_API_KEY'],
    keyRequired: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    parallelToolCallsParam: true,
  },
  zai: {
    api: 'openai',
    label: 'Z.ai (GLM)',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    keyAliases: ['ZAI_API_KEY'],
    keyRequired: true,
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    // Z.ai documents tool_choice "auto" only and does not document parallel_tool_calls.
    parallelToolCallsParam: false,
    thinking: (level) => ({ thinking: { type: level === 'off' ? 'disabled' : 'enabled' } }),
    // From docs.z.ai, Oct 2026. The free ones are not in the key's model list.
    knownModels: ['glm-4.7-flash', 'glm-4.5-flash', 'glm-5.3-flash', 'glm-4.7-flashx', 'glm-4.5-air', 'glm-4.7', 'glm-5', 'glm-5.3'],
    freeModels: ['glm-4.7-flash', 'glm-4.5-flash'],
    timeoutMs: 120_000,
    note: 'Free flash models; tight rate limits.',
  },
  groq: {
    api: 'openai',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyAliases: ['GROQ_API_KEY'],
    keyRequired: true,
    keyUrl: 'https://console.groq.com/keys',
    parallelToolCallsParam: false,
    // Its free models (gpt-oss, qwen) reason before answering: reasoning_effort sets how much.
    thinking: (level, modelId) =>
      /gpt-oss/i.test(modelId)
        ? { reasoning_effort: level === 'off' ? 'low' : level === 'on' ? 'medium' : level }
        : /qwen/i.test(modelId)
          ? { reasoning_effort: level === 'off' ? 'none' : level === 'on' ? 'default' : level }
          : {},
    // At "low" effort gpt-oss reasons briefly. Kept modest: Groq's free plan counts requested tokens against its per-minute limit.
    minMaxTokens: 2048,
    note: 'Free plan with daily limits; very fast.',
  },
  gemini: {
    api: 'openai',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyAliases: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    keyRequired: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    parallelToolCallsParam: false,
    minMaxTokens: 4096,
    note: 'Free tier for Flash models; on the free tier Google may use the content to improve its products.',
  },
  openrouter: {
    api: 'openai',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyAliases: ['OPENROUTER_API_KEY'],
    keyRequired: true,
    keyUrl: 'https://openrouter.ai/keys',
    parallelToolCallsParam: false,
    minMaxTokens: 4096,
    note: 'Many providers behind one key; ":free" models have small daily limits.',
  },
  ollama: {
    // Ollama's own API: it can switch thinking off and set the context length per request.
    api: 'ollama',
    label: 'Ollama (on this computer)',
    baseUrl: 'http://localhost:11434',
    keyAliases: [],
    keyRequired: false,
    parallelToolCallsParam: false,
    // gpt-oss cannot stop reasoning; "off" gives it the lowest level.
    thinking: (level, modelId) => ({ think: level === 'off' ? (/gpt-oss/i.test(modelId) ? 'low' : false) : level === 'on' ? true : level }),
    // A CPU can take minutes for one answer.
    timeoutMs: 300_000,
    note: 'Free and private; as good and as fast as the computer allows.',
  },
  'openai-compatible': {
    api: 'openai',
    label: 'OpenAI-compatible server',
    keyAliases: [],
    keyRequired: false,
    parallelToolCallsParam: true,
  },
};

export const PROVIDER_NAMES = Object.keys(PROVIDERS) as Provider[];

type Env = Record<string, string | undefined>;

const bool = (v: string | undefined, fallback: boolean) => (v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v));

/** The provider used when a spec doesn't name one: M_AI_PROVIDER, default anthropic. */
export function defaultProvider(env: Env = process.env): Provider {
  const p = env['M_AI_PROVIDER']?.trim() || 'anthropic';
  return (PROVIDER_NAMES as string[]).includes(p) ? (p as Provider) : 'anthropic';
}

/**
 * "zai:glm-4.7-flash" → zai / glm-4.7-flash. Without a known provider in
 * front, the whole text is the model id for the default provider — so
 * Ollama ids such as "qwen3:4b" work as they are.
 */
export function parseModelSpec(spec: string, fallbackProvider: Provider): { provider: Provider; modelId: string } {
  const s = spec.trim();
  const i = s.indexOf(':');
  if (i > 0) {
    const head = s.slice(0, i).trim();
    if ((PROVIDER_NAMES as string[]).includes(head)) return { provider: head as Provider, modelId: s.slice(i + 1).trim() };
  }
  return { provider: fallbackProvider, modelId: s };
}

/**
 * A provider's setting. M_AI_<PROVIDER>_<NAME> always works (M_AI_ZAI_API_KEY,
 * M_AI_OPENAI_COMPATIBLE_BASE_URL); the short M_AI_<NAME> works for the
 * default provider (M_AI_PROVIDER).
 */
function settingName(provider: Provider, name: string): string {
  return `M_AI_${provider.toUpperCase().replace(/-/g, '_')}_${name}`;
}
function setting(env: Env, provider: Provider, isDefault: boolean, name: string): string | undefined {
  const specific = env[settingName(provider, name)]?.trim();
  if (specific) return specific;
  return isDefault ? env[`M_AI_${name}`]?.trim() || undefined : undefined;
}

export interface ModelSetup {
  provider: Provider;
  modelId: string;
  /** "provider:model". */
  spec: string;
  model: ModelClient;
  /** The model ids the key may use, from the provider. */
  listModels(): Promise<string[]>;
  pricing?: ModelPricing;
  /** Model ids from the provider's docs, for when it cannot list them. */
  knownModels?: string[];
  /** Thinking switched on (providers that have the switch). */
  thinking?: boolean;
  /** The level asked for (M_AI_THINKING): off, on, low, medium or high. */
  thinkingLevel?: ThinkingLevel;
  /** Requests it may run at once (M_AI_<PROVIDER>_MAX_CONCURRENT); more spill over to the next model. */
  maxConcurrent?: number;
}

interface Access {
  provider: Provider;
  listModels(): Promise<string[]>;
  create(modelId: string, pricing: ModelPricing | undefined): { model: ModelClient; thinking?: ThinkingLevel };
}

/** Everything a provider needs except the model id. Problems are collected, not thrown. */
function providerAccess(provider: Provider, env: Env, problems: string[]): Access | undefined {
  const preset = PROVIDERS[provider];
  const isDefault = provider === defaultProvider(env);
  const before = problems.length;

  const key = setting(env, provider, isDefault, 'API_KEY') || preset.keyAliases.map((k) => env[k]?.trim()).find(Boolean) || undefined;
  if (!key && preset.keyRequired) {
    const name = isDefault ? 'M_AI_API_KEY' : (preset.keyAliases[0] ?? settingName(provider, 'API_KEY'));
    problems.push(`${name} is required for provider ${provider}${preset.keyUrl ? ` (create one at ${preset.keyUrl})` : ''}`);
  }

  const baseVar = isDefault ? 'M_AI_BASE_URL' : settingName(provider, 'BASE_URL');
  const baseUrl = setting(env, provider, isDefault, 'BASE_URL') || preset.baseUrl;
  if (!baseUrl && preset.api === 'openai') problems.push(`${baseVar} is required for ${provider} (e.g. http://localhost:11434/v1)`);
  if (baseUrl && !z.url().safeParse(baseUrl).success) problems.push(`${baseVar} is not a URL: ${baseUrl}`);

  let extraBody: Record<string, unknown> | undefined;
  const extraRaw = setting(env, provider, isDefault, 'EXTRA_BODY');
  if (extraRaw) {
    try {
      const parsed: unknown = JSON.parse(extraRaw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      extraBody = parsed as Record<string, unknown>;
    } catch {
      problems.push(`${isDefault ? 'M_AI_EXTRA_BODY' : settingName(provider, 'EXTRA_BODY')} must be a JSON object, e.g. {"think":false}`);
    }
  }

  const thinkingRaw = setting(env, provider, isDefault, 'THINKING');
  if (thinkingRaw && !/^(on|off|true|false|1|0|yes|no|low|medium|high)$/i.test(thinkingRaw))
    problems.push(`${isDefault ? 'M_AI_THINKING' : settingName(provider, 'THINKING')} must be off, on, low, medium or high`);
  // Thinking is off unless asked for: replies come faster, and the thinking can't eat the reply's token budget.
  const thinking: ThinkingLevel | undefined = preset.thinking ? thinkingLevel(thinkingRaw) : undefined;

  const timeoutRaw = setting(env, provider, isDefault, 'TIMEOUT_SECONDS');
  if (timeoutRaw && !/^\d{1,4}$/.test(timeoutRaw)) problems.push(`${isDefault ? 'M_AI_TIMEOUT_SECONDS' : settingName(provider, 'TIMEOUT_SECONDS')} must be a number of seconds`);
  const timeoutMs = timeoutRaw && /^\d{1,4}$/.test(timeoutRaw) ? Number(timeoutRaw) * 1000 : (preset.timeoutMs ?? 60_000);

  const numCtxCheck = preset.api === 'ollama' ? setting(env, provider, isDefault, 'NUM_CTX') : undefined;
  if (numCtxCheck && !/^\d{3,6}$/.test(numCtxCheck)) problems.push(`${isDefault ? 'M_AI_NUM_CTX' : settingName(provider, 'NUM_CTX')} must be a number of tokens, e.g. 8192`);

  if (problems.length > before) return undefined;

  if (preset.api === 'ollama') {
    const numCtxRaw = setting(env, provider, isDefault, 'NUM_CTX');
    const numCtx = numCtxRaw && /^\d{3,6}$/.test(numCtxRaw) ? Number(numCtxRaw) : undefined;
    const o = { ...(baseUrl ? { baseUrl } : {}) };
    return {
      provider,
      listModels: () => listOllamaModels(o),
      create: (modelId, pricing) => {
        const level = thinking ?? 'off';
        const think = (preset.thinking!(level, modelId) as { think: boolean | 'low' | 'medium' | 'high' }).think;
        const inner = createOllamaModel({ ...o, model: modelId, think, timeoutMs, ...(numCtx ? { numCtx } : {}), ...(pricing ? { pricing } : {}) });
        // A model that thinks spends tokens before it answers: give it room so the answer isn't cut off.
        const model: ModelClient =
          think !== false ? { complete: (r) => inner.complete({ ...r, maxTokens: Math.max(r.maxTokens, 4096) }), health: () => inner.health!() } : inner;
        // Ollama cuts what doesn't fit its window from the START (the system prompt goes first): keep requests inside it.
        model.maxInputTokens = (numCtx ?? 8192) - (think !== false ? 2048 : 1024) - 256;
        return { model, thinking: level };
      },
    };
  }

  if (preset.api === 'anthropic') {
    const workspaceId = setting(env, provider, isDefault, 'WORKSPACE_ID') || env['M_AI_ANTHROPIC_WORKSPACE_ID']?.trim() || undefined;
    const o = { apiKey: key!, ...(baseUrl ? { baseUrl } : {}), ...(workspaceId ? { workspaceId } : {}) };
    return {
      provider,
      listModels: () => listAnthropicModels(o),
      create: (modelId, pricing) => ({ model: createAnthropicModel({ ...o, model: modelId, timeoutMs, ...(pricing ? { pricing } : {}) }) }),
    };
  }

  const o = { baseUrl: baseUrl!, ...(key ? { apiKey: key } : {}) };
  return {
    provider,
    listModels: () => listOpenAICompatibleModels(o),
    create: (modelId, pricing) => {
      const body = { ...(preset.thinking && thinking !== undefined ? preset.thinking(thinking, modelId) : {}), ...extraBody };
      const inner = createOpenAICompatibleModel({
        ...o,
        model: modelId,
        timeoutMs,
        disableParallelToolCalls: bool(setting(env, provider, isDefault, 'PARALLEL_TOOL_CALLS_PARAM'), preset.parallelToolCallsParam),
        useMaxCompletionTokens: bool(setting(env, provider, isDefault, 'MAX_COMPLETION_TOKENS'), false),
        ...(Object.keys(body).length > 0 ? { extraBody: body } : {}),
        ...(pricing ? { pricing } : {}),
      });
      // A model that thinks spends tokens before it answers: give it room so the reply isn't cut off.
      const floor = thinking && thinking !== 'off' ? Math.max(4096, preset.minMaxTokens ?? 0) : (preset.minMaxTokens ?? 0);
      const model: ModelClient = floor > 0 ? { complete: (r) => inner.complete({ ...r, maxTokens: Math.max(r.maxTokens, floor) }) } : inner;
      return { model, ...(thinking !== undefined ? { thinking } : {}) };
    },
  };
}

/** The problems with a provider's settings in the environment (key, base URL, switches). */
export function checkProviderSettings(provider: Provider, env: Env = process.env): string[] {
  const problems: string[] = [];
  providerAccess(provider, env, problems);
  return problems;
}

/** Lists a provider's model ids with the keys in the environment. */
export function providerModels(provider: Provider, env: Env = process.env): Promise<string[]> {
  const problems: string[] = [];
  const access = providerAccess(provider, env, problems);
  if (!access) throw new ConfigError(problems);
  return access.listModels();
}

// ─────────────────────────────────────────────────────────────────────────────
// Prices
// ─────────────────────────────────────────────────────────────────────────────

/**
 * M_AI_PRICES — prices for any model, USD per million tokens:
 *   zai:glm-4.7-flash=0/0/0; anthropic:claude-haiku-4-5=1/0.1/5
 * Each entry is spec=input/cached/output, or spec=input/output (cached = input).
 */
export function parsePrices(text: string | undefined, fallbackProvider: Provider, problems: string[] = []): Map<string, ModelPricing> {
  const prices = new Map<string, ModelPricing>();
  for (const entry of (text ?? '').split(/[;,\n]/).map((e) => e.trim()).filter(Boolean)) {
    const eq = entry.lastIndexOf('=');
    const parts = eq > 0 ? entry.slice(eq + 1).split('/').map((p) => p.trim()) : [];
    const [pin, a, b] = parts;
    const pout = parts.length === 3 ? b : a;
    const pcached = parts.length === 3 ? a : pin;
    if (eq <= 0 || parts.length < 2 || parts.length > 3 || ![pin, pout, pcached].every((v) => v !== undefined && isPrice(v))) {
      problems.push(`M_AI_PRICES entry "${entry}" must look like zai:glm-4.7-flash=0.15/0.03/0.5`);
      continue;
    }
    const { provider, modelId } = parseModelSpec(entry.slice(0, eq), fallbackProvider);
    prices.set(`${provider}:${modelId}`, { inputPerMTok: pin!, cachedInputPerMTok: pcached!, outputPerMTok: pout! });
  }
  return prices;
}

/** M_AI_PRICE_IN / _CACHED / _OUT: the price of the main model (M_AI_MODEL). */
export function mainPricing(env: Env, problems: string[] = []): ModelPricing | undefined {
  const pin = env['M_AI_PRICE_IN']?.trim();
  const pout = env['M_AI_PRICE_OUT']?.trim();
  const pcached = env['M_AI_PRICE_CACHED']?.trim() || pin;
  if (!pin && !pout) return undefined;
  let ok = true;
  for (const [name, v] of [['M_AI_PRICE_IN', pin], ['M_AI_PRICE_OUT', pout], ['M_AI_PRICE_CACHED', pcached]] as const)
    if (!v || !isPrice(v)) {
      problems.push(`${name} must be a price like "3" or "0.30" (USD per million tokens)`);
      ok = false;
    }
  return ok ? { inputPerMTok: pin!, cachedInputPerMTok: pcached!, outputPerMTok: pout! } : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Building a model
// ─────────────────────────────────────────────────────────────────────────────

/** Like createModel(), but collects problems instead of throwing. */
export function buildModel(spec: string, env: Env, problems: string[]): ModelSetup | undefined {
  const fallbackProvider = defaultProvider(env);
  const { provider, modelId } = parseModelSpec(spec, fallbackProvider);
  const access = providerAccess(provider, env, problems);
  if (!modelId) {
    problems.push(`"${spec}" names no model id`);
    return undefined;
  }
  const isMain = provider === fallbackProvider && modelId === env['M_AI_MODEL']?.trim();
  const pricing = parsePrices(env['M_AI_PRICES'], fallbackProvider, problems).get(`${provider}:${modelId}`) ?? (isMain ? mainPricing(env, problems) : undefined);
  if (!access) return undefined;
  const created = access.create(modelId, pricing);
  const { thinking } = created;
  // Every request is fitted to what the model takes: a set limit (M_AI_<PROVIDER>_MAX_INPUT_TOKENS, or Ollama's
  // window), or what the provider's "request too large" says, learnt on the first refusal.
  const isDefaultProvider = provider === fallbackProvider;
  const maxInputRaw = setting(env, provider, isDefaultProvider, 'MAX_INPUT_TOKENS');
  if (maxInputRaw && !/^\d{3,7}$/.test(maxInputRaw))
    problems.push(`${isDefaultProvider ? 'M_AI_MAX_INPUT_TOKENS' : settingName(provider, 'MAX_INPUT_TOKENS')} must be a number of tokens, e.g. 6000`);
  const model = withInputBudget(created.model, maxInputRaw && /^\d{3,7}$/.test(maxInputRaw) ? Number(maxInputRaw) : undefined);
  const setup: ModelSetup = { provider, modelId, spec: `${provider}:${modelId}`, model, listModels: access.listModels };
  if (pricing) setup.pricing = pricing;
  const known = PROVIDERS[provider].knownModels;
  if (known) setup.knownModels = known;
  if (thinking !== undefined) {
    setup.thinking = thinking !== 'off';
    setup.thinkingLevel = thinking;
  }
  const isDefault = provider === fallbackProvider;
  const maxRaw = setting(env, provider, isDefault, 'MAX_CONCURRENT');
  if (maxRaw) {
    if (/^[1-9]\d{0,3}$/.test(maxRaw)) setup.maxConcurrent = Number(maxRaw);
    else problems.push(`${isDefault ? 'M_AI_MAX_CONCURRENT' : settingName(provider, 'MAX_CONCURRENT')} must be a whole number, e.g. 1`);
  }
  return setup;
}

/**
 * Build a model from a spec, with the keys and settings in the environment:
 *
 *   createModel('zai:glm-4.7-flash')
 *   createModel('anthropic:claude-haiku-4-5')
 *   createModel('openai-compatible:qwen3:4b')   // needs M_AI_OPENAI_COMPATIBLE_BASE_URL
 *   createModel('glm-4.7-flash')                // the default provider (M_AI_PROVIDER)
 *
 * Throws ConfigError, listing every problem, when a key or setting is missing.
 */
export function createModel(spec: string, env: Env = process.env): ModelSetup {
  const problems: string[] = [];
  const setup = buildModel(spec, env, problems);
  if (!setup || problems.length > 0) throw new ConfigError(problems);
  return setup;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fallback
// ─────────────────────────────────────────────────────────────────────────────

export interface FallbackOptions {
  /** Told each time a model failed and the next one is tried. */
  onFallback?: (from: string, to: string, error: ModelError) => void;
  /** Told when a model is passed over without being called: its health check failed, or it is full. */
  onSkip?: (label: string, reason: 'down' | 'busy') => void;
  /** A model that failed is tried last for this long. Default 60 s. */
  cooldownMs?: number;
  /** How long a health check's answer is trusted. Default 30 s. */
  healthTtlMs?: number;
  now?: () => number;
}

export interface RouteEntry {
  label: string;
  model: ModelClient;
  /** Requests this model may have running at once; more spill over to the next model. E.g. 1 for a single local machine. */
  maxConcurrent?: number;
}

/**
 * One ModelClient over several, in order of preference — e.g. your own
 * machine first, then paid providers. For each call:
 *  1. models that are ready come first, in the order given;
 *  2. then models that are full (`maxConcurrent` reached) — a local machine
 *     busy with another shop's question doesn't make this one wait;
 *  3. then models that failed in the last minute;
 *  4. last, models whose health check says they are down (a local machine
 *     that is switched off is skipped at once, not after a timeout).
 * The first model that answers wins. Errors that are not provider errors
 * (bugs) are thrown at once.
 */
export function withFallback(models: RouteEntry[], options: FallbackOptions = {}): ModelClient {
  if (models.length === 0) throw new TypeError('withFallback needs at least one model');
  if (models.length === 1 && !models[0]!.maxConcurrent) return models[0]!.model;
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? 60_000;
  const healthTtlMs = options.healthTtlMs ?? 30_000;
  const downUntil = new Map<number, number>();
  const inFlight = models.map(() => 0);
  const health = new Map<number, { ok: boolean; at: number }>();

  async function isUp(i: number): Promise<boolean> {
    const check = models[i]!.model.health;
    if (!check) return true;
    const cached = health.get(i);
    if (cached && now() - cached.at < healthTtlMs) return cached.ok;
    const ok = await check.call(models[i]!.model).catch(() => false);
    health.set(i, { ok, at: now() });
    return ok;
  }

  return {
    async complete(request) {
      const t = now();
      const all = models.map((_, i) => i);
      const up = await Promise.all(all.map(isUp));
      const ready: number[] = [];
      const busy: number[] = [];
      const cooling: number[] = [];
      const down: number[] = [];
      for (const i of all) {
        if (!up[i]) down.push(i);
        else if ((downUntil.get(i) ?? 0) > t) cooling.push(i);
        else if (models[i]!.maxConcurrent && inFlight[i]! >= models[i]!.maxConcurrent!) busy.push(i);
        else ready.push(i);
      }
      for (const i of busy) options.onSkip?.(models[i]!.label, 'busy');
      for (const i of down) options.onSkip?.(models[i]!.label, 'down');
      const order = [...ready, ...busy, ...cooling, ...down];
      const failures: Array<{ label: string; error: ModelError }> = [];
      for (const [k, i] of order.entries()) {
        const entry = models[i]!;
        inFlight[i]!++;
        try {
          const response = await entry.model.complete(request);
          downUntil.delete(i);
          return response;
        } catch (e) {
          if (!(e instanceof ModelError)) throw e;
          failures.push({ label: entry.label, error: e });
          // Set aside for the cooldown, or as long as the provider said when it is a daily limit.
          downUntil.set(i, now() + (e.retryable ? cooldownMs : Math.max(cooldownMs, e.retryAfterMs ?? 0)));
          if (entry.model.health) health.set(i, { ok: false, at: now() });
          const next = order[k + 1];
          if (next !== undefined) options.onFallback?.(entry.label, models[next]!.label, e);
        } finally {
          inFlight[i]!--;
        }
      }
      const last = failures.at(-1)!.error;
      throw new ModelError(
        failures.length === 1 ? last.message : `every model failed — ${failures.map((f) => `${f.label}: ${f.error.message}`).join(' | ')}`,
        last.status,
        failures.some((f) => f.error.retryable),
        last.retryAfterMs,
      );
    },
  };
}
