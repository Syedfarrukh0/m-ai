import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { LanguagePack } from './languages.js';
import { BUILTIN_LANGUAGES, LanguagePackSchema } from './languages.js';
import type { ModelClient } from './model.js';
import { ModelError, isDailyLimitMessage, isNoCreditMessage, isRateLimitMessage, waitHintMs } from './model.js';
import type { FallbackOptions, ModelSetup, Provider } from './providers.js';
import type { Billing } from './usage.js';
import { checkBilling } from './usage.js';
import { ConfigError, PROVIDERS, PROVIDER_NAMES, buildModel, checkProviderSettings, mainPricing, parsePrices, withFallback } from './providers.js';

export { ConfigError } from './providers.js';
export type { Provider } from './providers.js';

/**
 * Configuration from environment variables (a `.env` file in development).
 * Every value is checked at start-up; a missing or wrong value stops the
 * program with a message that says exactly what to fix.
 */

export interface M_AI_Config {
  /** The main model's provider and id (M_AI_PROVIDER, M_AI_MODEL). */
  provider: Provider;
  modelId: string;
  /** The main model, followed by the fallback models when there are any. Pass it to createAssistant. */
  model: ModelClient;
  /** The model ids the main provider's key may use. */
  listModels(): Promise<string[]>;
  /** The main model alone, with its price. */
  primary: ModelSetup;
  /** M_AI_FALLBACK_MODELS, in order. */
  fallbacks: ModelSetup[];
  languages: LanguagePack[];
  instructions?: string;
  /** M_AI_CURRENCY, M_AI_USD_RATE, M_AI_MARGIN: how a reply's cost becomes the customer's charge. */
  billing?: Billing;
  /** M_AI_USAGE_FOOTER: off | on | tokens. */
  usageFooter?: 'off' | 'on' | 'tokens';
}

/**
 * Reads:
 *   M_AI_PROVIDER        anthropic | openai | zai | openai-compatible   (default anthropic)
 *   M_AI_MODEL           the model id                                    (required)
 *   M_AI_API_KEY         the provider key (or ANTHROPIC_API_KEY / OPENAI_API_KEY / ZAI_API_KEY)
 *   M_AI_BASE_URL        required for openai-compatible (e.g. http://localhost:11434/v1)
 *   M_AI_FALLBACK_MODELS models tried in order when the main one fails, e.g. "zai:glm-4.5-flash"
 *   M_AI_THINKING        on | off (default off) for models with a thinking switch (Z.ai)
 *   M_AI_ANTHROPIC_WORKSPACE_ID  only for Anthropic keys that are not scoped to a workspace
 *   M_AI_PRICE_IN / M_AI_PRICE_CACHED / M_AI_PRICE_OUT   the main model's price, USD per million tokens
 *   M_AI_PRICES          prices of other models: "zai:glm-4.7-flash=0/0/0; anthropic:x=1/0.1/5"
 *   M_AI_PARALLEL_TOOL_CALLS_PARAM / M_AI_MAX_COMPLETION_TOKENS / M_AI_EXTRA_BODY   OpenAI-format switches
 *   M_AI_LANGUAGE_PACKS  a folder of extra language packs (*.json)
 *   M_AI_INSTRUCTIONS_FILE  a text file with the app's guidance for the model
 * Settings of a provider other than M_AI_PROVIDER: M_AI_<PROVIDER>_API_KEY, _BASE_URL, _THINKING…
 * (e.g. M_AI_OPENAI_COMPATIBLE_BASE_URL), or the usual ZAI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY.
 */
export function configFromEnv(env: Record<string, string | undefined> = process.env, options: FallbackOptions = {}): M_AI_Config {
  const problems: string[] = [];
  const rawProvider = env['M_AI_PROVIDER']?.trim() || 'anthropic';
  const providerOk = (PROVIDER_NAMES as string[]).includes(rawProvider);
  if (!providerOk) problems.push(`M_AI_PROVIDER must be one of ${PROVIDER_NAMES.join(', ')} (got "${rawProvider}")`);
  const provider = (providerOk ? rawProvider : 'anthropic') as Provider;
  const modelId = env['M_AI_MODEL']?.trim() ?? '';

  let primary: ModelSetup | undefined;
  if (!modelId) {
    problems.push('M_AI_MODEL is required: the model id from your provider');
    if (providerOk) problems.push(...checkProviderSettings(provider, env));
    mainPricing(env, problems);
  } else if (providerOk) {
    primary = buildModel(`${provider}:${modelId}`, env, problems);
  }

  const fallbacks: ModelSetup[] = [];
  for (const spec of (env['M_AI_FALLBACK_MODELS'] ?? '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)) {
    const setup = buildModel(spec, env, problems);
    if (setup) fallbacks.push(setup);
  }
  parsePrices(env['M_AI_PRICES'], provider, problems);

  let languages: LanguagePack[] = [...BUILTIN_LANGUAGES];
  const packsDir = env['M_AI_LANGUAGE_PACKS']?.trim();
  if (packsDir) {
    try {
      languages = [...languages, ...loadLanguagePacks(packsDir)];
    } catch (e) {
      problems.push((e as Error).message);
    }
  }

  let instructions: string | undefined;
  const instructionsFile = env['M_AI_INSTRUCTIONS_FILE']?.trim();
  if (instructionsFile) {
    if (existsSync(instructionsFile)) instructions = readFileSync(instructionsFile, 'utf8');
    else problems.push(`M_AI_INSTRUCTIONS_FILE not found: ${instructionsFile}`);
  }

  let billing: Billing | undefined;
  const currency = env['M_AI_CURRENCY']?.trim().toUpperCase();
  if (currency) {
    const usdRate = env['M_AI_USD_RATE']?.trim() || (currency === 'USD' ? '1' : '');
    const margin = env['M_AI_MARGIN']?.trim() || undefined;
    if (!usdRate) problems.push(`M_AI_USD_RATE is required with M_AI_CURRENCY=${currency}: how many ${currency} one US dollar buys, e.g. 276.35`);
    else {
      billing = { currency, usdRate, ...(margin ? { margin } : {}) };
      problems.push(...checkBilling(billing).map((p) => `M_AI_CURRENCY / M_AI_USD_RATE / M_AI_MARGIN: ${p}`));
    }
  }
  const footer = env['M_AI_USAGE_FOOTER']?.trim().toLowerCase();
  if (footer && !['off', 'on', 'tokens'].includes(footer)) problems.push('M_AI_USAGE_FOOTER must be off, on or tokens');

  if (problems.length > 0 || !primary) throw new ConfigError([...new Set(problems)]);

  const model = withFallback(
    [primary, ...fallbacks].map((m) => ({ label: m.spec, model: m.model, ...(m.maxConcurrent ? { maxConcurrent: m.maxConcurrent } : {}) })),
    options,
  );
  const config: M_AI_Config = { provider, modelId, model, listModels: primary.listModels, primary, fallbacks, languages };
  if (instructions) config.instructions = instructions;
  if (billing) config.billing = billing;
  if (footer === 'on' || footer === 'tokens') config.usageFooter = footer;
  return config;
}

/** Every *.json in a folder, each checked against LanguagePackSchema. */
export function loadLanguagePacks(dir: string): LanguagePack[] {
  if (!existsSync(dir)) throw new Error(`M_AI_LANGUAGE_PACKS folder not found: ${dir}`);
  const packs: LanguagePack[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (e) {
      throw new Error(`language pack ${file} is not valid JSON: ${(e as Error).message}`);
    }
    const parsed = LanguagePackSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`language pack ${file}: ${z.prettifyError(parsed.error).replace(/\n/g, ' ')}`);
    packs.push(raw as LanguagePack);
  }
  return packs;
}

/**
 * Read KEY=VALUE lines from a .env file into an object (comments, quotes and
 * `export` allowed). Variables already set in `into` are kept: the real
 * environment always wins over the file.
 */
export function loadEnvFile(path: string, into: Record<string, string | undefined> = process.env): boolean {
  if (!existsSync(path)) return false;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const [, k = '', rawValue = ''] = m;
    let v = rawValue;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (into[k] === undefined) into[k] = v;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-flight: is the key accepted, and does the model id exist?
// ─────────────────────────────────────────────────────────────────────────────

export interface PreflightResult {
  ok: boolean;
  /** What is wrong, in plain words, with the provider's own message. */
  problems: string[];
  /** Model ids close to the one configured, when it was not found. */
  suggestions: string[];
  /** Notes that don't stop anything. */
  warnings: string[];
}

/** What pre-flight checks: one model of one provider. An M_AI_Config is checked through its main model. */
export type PreflightTarget = Pick<ModelSetup, 'provider' | 'modelId' | 'model' | 'listModels'> & { knownModels?: string[] };

const HINTS: Array<[RegExp, string]> = [
  [/workspace/i, 'Create a key inside a workspace (Console → API keys), or set M_AI_ANTHROPIC_WORKSPACE_ID.'],
  [/invalid x-api-key|invalid api key|incorrect api key|authentication|unauthori[sz]ed|api key/i, 'The key is wrong, revoked or for another provider. Check the key in .env and M_AI_PROVIDER.'],
  [/credit|billing|balance|insufficient|recharge|resource package|余额/i, 'The account has no credit for this model. Add billing in the provider console, or use a free model (pnpm --filter @m-ai/assistant-core models).'],
  [/rate.?limit|too many|concurren/i, 'The provider is limiting requests (free models allow few at a time). Wait a minute, or set M_AI_FALLBACK_MODELS.'],
  [/not found.*(pull|try pulling)|try pulling/i, 'Download the model first: ollama pull <model id>. Then: pnpm --filter @m-ai/assistant-core models ollama'],
  [/model/i, 'Check the model id: it must be the exact id from the list below (run: pnpm --filter @m-ai/assistant-core models).'],
];

function explain(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const status = e instanceof ModelError ? e.status : undefined;
  const noCredit = !isRateLimitMessage(msg) && (HINTS[2]![0].test(msg) || status === 402);
  const daily = isDailyLimitMessage(msg);
  const wait = daily ? waitHintMs(msg) : undefined;
  const hint = daily
    ? `This model's DAILY limit is used up${wait ? `; the provider says try again in ${Math.ceil(wait / 60_000)} min` : ''}. Use another model (--model, or M_AI_FALLBACK_MODELS), or a paid plan.`
    : noCredit
    ? HINTS[2]![1]
    : status === 401 || status === 403
      ? HINTS[1]![1]
      : status === 429
        ? HINTS[3]![1]
        : HINTS.find(([re]) => re.test(msg))?.[1];
  return hint ? `${msg}\n    → ${hint}` : msg;
}

/** Busy for now (rate limit), as opposed to refused (no credit, wrong key). */
const busy = (e: unknown) => e instanceof ModelError && e.status === 429 && e.retryable;

/**
 * Checks a model against its provider before anything else runs: lists the
 * models the key may use, then makes one tiny call (a few tokens) — a listed
 * model can still be refused, e.g. for lack of credit.
 * `label` names the model in problems (default: M_AI_MODEL "<id>").
 */
export async function preflight(target: PreflightTarget | M_AI_Config, label?: string): Promise<PreflightResult> {
  const t: PreflightTarget = 'primary' in target ? target.primary : target;
  const name = label ?? `M_AI_MODEL "${t.modelId}"`;
  const result: PreflightResult = { ok: true, problems: [], suggestions: [], warnings: [] };
  let ids: string[] | undefined;
  try {
    ids = await t.listModels();
  } catch (e) {
    const status = e instanceof ModelError ? e.status : undefined;
    if (status === 404 || status === 405) {
      result.warnings.push(`${t.provider} does not list its models; the model id is checked with a test call instead.`);
    } else if (busy(e)) {
      result.warnings.push(`${t.provider} is busy (429); the model id is checked with a test call instead.`);
    } else {
      result.ok = false;
      result.problems.push(explain(e));
      return result;
    }
  }
  // Always one tiny call: a listed model can still be refused (no credit for it, plan limits).
  try {
    await t.model.complete({ system: 'Reply with OK.', messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }], tools: [], maxTokens: 1 });
    const free = PROVIDERS[t.provider]?.freeModels?.includes(t.modelId);
    if (ids && !ids.includes(t.modelId) && !free) result.warnings.push(`"${t.modelId}" is not in the provider's model list, but the test call worked (probably an alias).`);
    return result;
  } catch (e) {
    if (busy(e)) {
      result.warnings.push(`${t.provider} is busy right now (429); "${t.modelId}" could not be checked. Continuing.`);
      return result;
    }
    result.ok = false;
    result.problems.push(`${name} did not work: ${explain(e)}`);
    // Refused for lack of credit: the useful suggestions are the free models.
    const free = PROVIDERS[t.provider]?.freeModels ?? [];
    if (isNoCreditMessage(e instanceof Error ? e.message : String(e)) && free.length > 0) {
      result.suggestions = free.filter((id) => id !== t.modelId);
      return result;
    }
    const pool = ids && ids.length > 0 ? ids : (t.knownModels ?? []);
    if (pool.length > 0) {
      const needle = t.modelId.toLowerCase();
      const close = pool.filter((id) => id.toLowerCase().includes(needle));
      result.suggestions = (close.length > 0 ? close : pool).slice(0, 15);
    }
    return result;
  }
}
