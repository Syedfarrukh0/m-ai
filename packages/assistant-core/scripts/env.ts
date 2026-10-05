/** Shared start-up for the terminal tools: load .env files, read the config, explain problems plainly. */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ConfigError, configFromEnv, loadEnvFile, preflight } from '../src/index.js';
import type { M_AI_Config } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));

/** .env in the current folder, then packages/assistant-core, then the repo root. The real environment wins. */
export function loadConfig(): M_AI_Config {
  for (const path of [resolve(process.cwd(), '.env'), resolve(here, '../.env'), resolve(here, '../../../.env')]) loadEnvFile(path);
  try {
    return configFromEnv(process.env);
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

/**
 * Ask the provider whether the key works and the model id exists, before
 * anything else. Stops with a plain explanation if not. Skip with
 * M_AI_SKIP_PREFLIGHT=true.
 */
export async function checkModel(config: M_AI_Config): Promise<void> {
  if (/^(1|true|yes)$/i.test(process.env['M_AI_SKIP_PREFLIGHT'] ?? '')) return;
  const r = await preflight(config);
  for (const w of r.warnings) console.error(yellow(`note: ${w}`));
  if (r.ok) return;
  console.error(red(`\nThe AI model is not set up correctly (${config.provider} / ${config.modelId}):`));
  for (const p of r.problems) console.error(red(`  - ${p}`));
  if (r.suggestions.length > 0) console.error(`\nModel ids this key can use:\n  ${r.suggestions.join('\n  ')}`);
  console.error('\nFix .env and run again. To list every model id:  pnpm --filter @m-ai/assistant-core models\n');
  process.exit(1);
}
