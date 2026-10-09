/** Shared start-up for the terminal tools: load .env files, read the config, explain problems plainly. */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ConfigError, configFromEnv, loadEnvFile, preflight } from '../src/index.js';
import type { FallbackOptions, M_AI_Config, ModelSetup, PreflightResult } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));

/** .env in the current folder, then packages/assistant-core, then the repo root. The real environment wins. */
export function loadEnv(): void {
  for (const path of [resolve(process.cwd(), '.env'), resolve(here, '../.env'), resolve(here, '../../../.env')]) loadEnvFile(path);
}

export function loadConfig(options: FallbackOptions = {}): M_AI_Config {
  loadEnv();
  try {
    return configFromEnv(process.env, options);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`\n${e.message}\n`);
      console.error('Quick start: copy .env.example to .env at the repo root and fill in M_AI_MODEL and M_AI_API_KEY.');
      console.error('No key yet? Run the offline demo:  pnpm --filter @m-ai/assistant-core demo\n');
      process.exit(1);
    }
    throw e;
  }
}

const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const skipped = () => /^(1|true|yes)$/i.test(process.env['M_AI_SKIP_PREFLIGHT'] ?? '');

function printProblems(title: string, r: PreflightResult, colour: (s: string) => string): void {
  console.error(colour(`\n${title}`));
  for (const p of r.problems) console.error(colour(`  - ${p}`));
  if (r.suggestions.length > 0) console.error(`\nModel ids to try:\n  ${r.suggestions.join('\n  ')}`);
}

/**
 * Ask the provider whether the key works and the model id exists, before
 * anything else. Fallback models are checked too. If the main model fails but
 * a fallback works, it says so and carries on; if nothing works, it stops with
 * a plain explanation. Skip with M_AI_SKIP_PREFLIGHT=true.
 */
export async function checkModel(config: M_AI_Config): Promise<void> {
  if (skipped()) return;
  const [main, ...fallbacks] = await Promise.all([
    preflight(config.primary),
    ...config.fallbacks.map((f) => preflight(f, `fallback "${f.spec}"`)),
  ]);
  for (const w of [main!, ...fallbacks].flatMap((r) => r.warnings)) console.error(yellow(`note: ${w}`));
  config.fallbacks.forEach((f, i) => {
    if (!fallbacks[i]!.ok) printProblems(`The fallback model ${f.spec} does not work:`, fallbacks[i]!, yellow);
  });
  if (main!.ok) return;
  const working = config.fallbacks.find((_, i) => fallbacks[i]!.ok);
  if (working) {
    // E.g. your own machine is off: normal in a local-first setup. Replies come from the next model until it is back.
    printProblems(`${config.primary.spec} can't answer right now:`, main!, yellow);
    console.error(yellow(`\nReplies will come from ${working.spec} until it is back (checked again every 30 s).\n`));
    return;
  }
  printProblems(`The AI model is not set up correctly (${config.primary.spec}):`, main!, red);
  console.error('\nFix .env and run again. To list every model id:  pnpm --filter @m-ai/assistant-core models\n');
  process.exit(1);
}

/** Pre-flight for one model chosen at runtime (/model). True when it may be used. */
export async function checkOne(setup: ModelSetup): Promise<boolean> {
  if (skipped()) return true;
  const r = await preflight(setup, `"${setup.spec}"`);
  for (const w of r.warnings) console.error(yellow(`note: ${w}`));
  if (!r.ok) printProblems(`${setup.spec} cannot be used:`, r, red);
  return r.ok;
}
