/**
 * Start M.Ai's server.
 *
 *   pnpm --filter @m-ai/service start
 *
 * Settings from .env (the repo root's, then this folder's; the real environment wins):
 *   the model, exactly as for the terminal chat (M_AI_PROVIDER, M_AI_MODEL, keys, fallbacks, billing);
 *   M_AI_ERP_URL, M_AI_ERP_TENANT   the app the pilot sign-in goes to (and the app "erp" for delegated turns);
 *   M_AI_SERVICE_HOST               default 127.0.0.1 (this machine only);
 *   M_AI_SERVICE_PORT               default 3100;
 *   M_AI_PILOT_SIGNIN               on (default when M_AI_ERP_URL is set) | off.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, configFromEnv, createAssistant, loadEnvFile } from '@m-ai/assistant-core';
import { buildApp } from './app.js';

const here = dirname(fileURLToPath(import.meta.url));
for (const path of [resolve(process.cwd(), '.env'), resolve(here, '../.env'), resolve(here, '../../../.env')]) loadEnvFile(path);
const env = process.env;

let config;
try {
  config = configFromEnv(env, {
    onFallback: (from, to, e) => console.warn(`model ${from} failed (${e.message.slice(0, 160)}); using ${to}`),
  });
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`\n${e.message}\n\nSet the model in .env first (see .env.example).\n`);
    process.exit(1);
  }
  throw e;
}

const erpUrl = env['M_AI_ERP_URL']?.trim().replace(/\/$/, '');
const pilotOn = (env['M_AI_PILOT_SIGNIN'] ?? (erpUrl ? 'on' : 'off')).trim().toLowerCase() === 'on';
const host = env['M_AI_SERVICE_HOST']?.trim() || '127.0.0.1';
const port = Number(env['M_AI_SERVICE_PORT'] ?? 3100);

const assistant = createAssistant({
  model: config.model,
  languages: config.languages,
  ...(config.billing ? { billing: config.billing } : {}),
  ...(config.usageFooter ? { usageFooter: config.usageFooter } : {}),
  ...(config.instructions ? { instructions: config.instructions } : {}),
  onError: (e, where) => console.warn(`[${where}] ${(e as Error).message ?? e}`),
});

const app = await buildApp({
  assistant,
  ...(pilotOn && erpUrl ? { pilot: { baseUrl: erpUrl, tenantCode: env['M_AI_ERP_TENANT']?.trim() || 'DEMO' } } : {}),
  ...(erpUrl ? { apps: { erp: erpUrl } } : {}),
  logger: { level: env['M_AI_LOG_LEVEL'] ?? 'info' },
});

await app.listen({ host, port });
console.log(`\nM.Ai — ${config.primary.spec}${config.fallbacks.length ? ` (then ${config.fallbacks.map((f) => f.spec).join(', ')})` : ''}`);
console.log(`Web chat: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`);
if (pilotOn && erpUrl) console.log(`Pilot sign-in to ${erpUrl}. Keep this server on this machine: it holds the app session of whoever signs in.`);
if (host !== '127.0.0.1' && host !== 'localhost' && pilotOn) console.warn('Warning: pilot sign-in is reachable from other machines. Use HTTPS in front of it, or set M_AI_PILOT_SIGNIN=off.');
