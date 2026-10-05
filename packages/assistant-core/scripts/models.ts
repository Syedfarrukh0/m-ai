/**
 * List the model ids your key can use, so M_AI_MODEL can be copied exactly.
 *
 *   pnpm --filter @m-ai/assistant-core models
 */
import { loadConfig } from './env.js';

const config = loadConfig();
try {
  const ids = await config.listModels();
  console.log(`\n${config.provider}: ${ids.length} models available to this key\n`);
  for (const id of ids) console.log(`  ${id === config.modelId ? '→' : ' '} ${id}`);
  if (!ids.includes(config.modelId)) console.log(`\nM_AI_MODEL is "${config.modelId}" — not in this list. Copy one of the ids above into .env.`);
  console.log('');
} catch (e) {
  console.error(`\x1b[31mCould not list models: ${(e as Error).message}\x1b[0m\n`);
  process.exit(1);
}
