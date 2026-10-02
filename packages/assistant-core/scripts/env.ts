/** Shared start-up for the terminal tools: load .env files, read the config, explain problems plainly. */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ConfigError, configFromEnv, loadEnvFile } from '../src/index.js';
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
