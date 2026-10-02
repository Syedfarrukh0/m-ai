import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { createAnthropicModel } from './anthropic.js';
import type { LanguagePack } from './languages.js';
import { BUILTIN_LANGUAGES, LanguagePackSchema } from './languages.js';
import type { ModelClient } from './model.js';
import { createOpenAICompatibleModel } from './openai.js';
import type { ModelPricing } from './usage.js';

/**
 * Configuration from environment variables (a `.env` file in development).
 * Every value is checked at start-up; a missing or wrong value stops the
 * program with a message that says exactly what to fix.
 */

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`M.Ai configuration is incomplete:\n  - ${problems.join('\n  - ')}\nSee .env.example.`);
    this.name = 'ConfigError';
  }
}

const PRICE = /^\d{1,6}(?:\.\d{1,4})?$/;
const bool = (v: string | undefined, fallback: boolean) => (v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v));

export type Provider = 'anthropic' | 'openai' | 'openai-compatible';

export interface M_AI_Config {
  provider: Provider;
  modelId: string;
  model: ModelClient;
  pricing?: ModelPricing;
  languages: LanguagePack[];
  instructions?: string;
}

/**
 * Reads:
 *   M_AI_PROVIDER        anthropic | openai | openai-compatible   (default anthropic)
 *   M_AI_MODEL           the model id                              (required)
 *   M_AI_API_KEY         the provider key (or ANTHROPIC_API_KEY / OPENAI_API_KEY)
 *   M_AI_BASE_URL        required for openai-compatible (e.g. http://localhost:11434/v1)
 *   M_AI_PRICE_IN / M_AI_PRICE_CACHED / M_AI_PRICE_OUT   USD per million tokens (optional)
 *   M_AI_PARALLEL_TOOL_CALLS_PARAM   send parallel_tool_calls:false (default true; openai*)
 *   M_AI_MAX_COMPLETION_TOKENS       use max_completion_tokens (default false; openai*)
 *   M_AI_LANGUAGE_PACKS  a folder of extra language packs (*.json)
 *   M_AI_INSTRUCTIONS_FILE  a text file with the app's guidance for the model
 */
export function configFromEnv(env: Record<string, string | undefined> = process.env): M_AI_Config {
  const problems: string[] = [];
  const provider = (env['M_AI_PROVIDER'] || 'anthropic') as Provider;
  if (!['anthropic', 'openai', 'openai-compatible'].includes(provider))
    problems.push(`M_AI_PROVIDER must be anthropic, openai or openai-compatible (got "${provider}")`);
  const modelId = env['M_AI_MODEL']?.trim() ?? '';
  if (!modelId) problems.push('M_AI_MODEL is required: the model id from your provider');

  const key =
    env['M_AI_API_KEY']?.trim() ||
    (provider === 'anthropic' ? env['ANTHROPIC_API_KEY']?.trim() : provider === 'openai' ? env['OPENAI_API_KEY']?.trim() : undefined) ||
    undefined;
  if (!key && provider !== 'openai-compatible') problems.push(`M_AI_API_KEY is required for provider ${provider}`);

  const baseUrl = env['M_AI_BASE_URL']?.trim() || undefined;
  if (provider === 'openai-compatible' && !baseUrl) problems.push('M_AI_BASE_URL is required for openai-compatible (e.g. http://localhost:11434/v1)');
  if (baseUrl && !z.url().safeParse(baseUrl).success) problems.push(`M_AI_BASE_URL is not a URL: ${baseUrl}`);

  let pricing: ModelPricing | undefined;
  const pin = env['M_AI_PRICE_IN']?.trim();
  const pout = env['M_AI_PRICE_OUT']?.trim();
  const pcached = env['M_AI_PRICE_CACHED']?.trim() || pin;
  if (pin || pout) {
    for (const [name, v] of [['M_AI_PRICE_IN', pin], ['M_AI_PRICE_OUT', pout], ['M_AI_PRICE_CACHED', pcached]] as const)
      if (!v || !PRICE.test(v)) problems.push(`${name} must be a price like "3" or "0.30" (USD per million tokens)`);
    if (pin && pout && pcached && PRICE.test(pin) && PRICE.test(pout) && PRICE.test(pcached))
      pricing = { inputPerMTok: pin, cachedInputPerMTok: pcached, outputPerMTok: pout };
  }

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

  if (problems.length > 0) throw new ConfigError(problems);

  const model =
    provider === 'anthropic'
      ? createAnthropicModel({ apiKey: key!, model: modelId, ...(baseUrl ? { baseUrl } : {}) })
      : createOpenAICompatibleModel({
          model: modelId,
          baseUrl: baseUrl ?? 'https://api.openai.com/v1',
          ...(key ? { apiKey: key } : {}),
          disableParallelToolCalls: bool(env['M_AI_PARALLEL_TOOL_CALLS_PARAM'], true),
          useMaxCompletionTokens: bool(env['M_AI_MAX_COMPLETION_TOKENS'], false),
        });

  const config: M_AI_Config = { provider, modelId, model, languages };
  if (pricing) config.pricing = pricing;
  if (instructions) config.instructions = instructions;
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
