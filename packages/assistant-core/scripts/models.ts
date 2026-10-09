/**
 * List the model ids a provider's key can use, so a model id can be copied exactly.
 * Providers: anthropic, openai, zai, groq, gemini, openrouter, ollama, openai-compatible.
 *
 *   pnpm --filter @m-ai/assistant-core models          # the provider in .env (M_AI_PROVIDER)
 *   pnpm --filter @m-ai/assistant-core models zai      # another provider whose key is in .env
 */
import { ConfigError, ModelError, PROVIDERS, PROVIDER_NAMES, defaultProvider, providerModels } from '../src/index.js';
import type { Provider } from '../src/index.js';
import { loadEnv } from './env.js';

loadEnv();
const arg = process.argv.slice(2).find((a) => !a.startsWith('-'));
const provider = (arg ?? defaultProvider(process.env)) as Provider;
if (!PROVIDER_NAMES.includes(provider)) {
  console.error(`Unknown provider "${provider}". One of: ${PROVIDER_NAMES.join(', ')}`);
  process.exit(1);
}
const configured = provider === defaultProvider(process.env) ? process.env['M_AI_MODEL']?.trim() : undefined;
const known = PROVIDERS[provider].knownModels;

try {
  const ids = await providerModels(provider, process.env);
  console.log(`\n${PROVIDERS[provider].label}: ${ids.length} model${ids.length === 1 ? '' : 's'} ${provider === 'ollama' ? 'downloaded on this computer' : 'available to this key'}\n`);
  for (const id of ids) console.log(`  ${id === configured ? '→' : ' '} ${id}`);
  const free = (PROVIDERS[provider].freeModels ?? []).filter((id) => !ids.includes(id));
  if (free.length > 0) {
    console.log(`\nFree models (${PROVIDERS[provider].label} does not list them; the others above may need credit):\n`);
    for (const id of free) console.log(`  ${id === configured ? '→' : ' '} ${id}`);
  }
  if (configured && !ids.includes(configured) && !free.includes(configured))
    console.log(`\nM_AI_MODEL is "${configured}" — not in this list. Copy one of the ids above into .env.`);
  console.log('');
} catch (e) {
  const cannotList = e instanceof ModelError && (e.status === 404 || e.status === 405);
  if (!(known && cannotList)) console.error(`\x1b[31mCould not list models: ${e instanceof ConfigError ? e.problems.join('; ') : (e as Error).message}\x1b[0m`);
  if (known && cannotList) {
    console.log(`\n${PROVIDERS[provider].label} does not list models. Model ids from its docs:\n`);
    for (const id of known) console.log(`  ${id === configured ? '→' : ' '} ${id}`);
    console.log('');
  } else process.exit(1);
}
