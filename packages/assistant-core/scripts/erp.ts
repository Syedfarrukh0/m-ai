/**
 * Check the door to a real ERP, for each test user, before chatting or
 * running evals against it.
 *
 *   pnpm --filter @m-ai/assistant-core erp                       # owner, booker, officer from .env
 *   pnpm --filter @m-ai/assistant-core erp -- --erp http://localhost:3001 --as owner
 *
 * For each user it signs in, asks for a delegated token, lists the actions,
 * and reads the company's context and the AI terms. Nothing is changed.
 */
import { readFileSync } from 'node:fs';
import { catalogHash } from '@m-ai/action-contract';
import type { ActionCatalog } from '@m-ai/action-contract';
import { selectTools } from '../src/index.js';
import { ErpError, erpSettingsFromEnv, loginErp, userEmail } from '../src/erp-live.js';
import { loadEnv } from './env.js';

loadEnv();
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const settings = erpSettingsFromEnv(process.env, flag('--erp'));
if ('missing' in settings) {
  console.error(red(`Missing in .env: ${settings.missing.join(', ')}`));
  process.exit(1);
}
const who = flag('--as');
const roles = who ? [who] : Object.keys(settings.users);

/** The catalog our tests were run on, to spot a newer one. */
let knownHash: string | undefined;
try {
  const file = new URL('../../../docs/erp-catalog/action-catalog.json', import.meta.url);
  knownHash = await catalogHash(JSON.parse(readFileSync(file, 'utf8')) as ActionCatalog);
} catch {
  knownHash = undefined;
}

console.log(`\nThe ERP's door — ${settings.baseUrl}, company ${settings.tenantCode}\n`);
let failed = 0;
for (const role of roles) {
  const email = userEmail(settings, role);
  if (!email) {
    console.log(red(`✗ ${role}: no e-mail (set M_AI_ERP_${role.toUpperCase()})`));
    failed++;
    continue;
  }
  const head = `${role} (${email})`;
  try {
    const t0 = Date.now();
    const session = await loginErp(settings, email);
    const cid = `door-check-${Date.now()}`;
    const claims = await session.claims(cid);
    const actions = session.actions(cid);
    const list = await actions.list();
    const offered = selectTools(list.actions, 'aaj ki sale kitni hui', 200, undefined, { maxChars: 1e9 }).length;
    const ctx = await actions.execute({ action: 'core.context.get', input: {} });
    console.log(`${green('✓')} ${head} ${dim(`${Date.now() - t0} ms`)}`);
    console.log(dim(`    token: sub ${claims.sub}, company ${claims.tid}, aud ${claims.aud}, client ${claims.act?.sub}`));
    console.log(dim(`    actions: ${list.actions.length} for this person; ${offered} could be offered to the model`));
    if (knownHash && list.catalogHash && list.catalogHash !== knownHash)
      console.log(yellow(`    catalog: the ERP's hash is ${list.catalogHash.slice(0, 12)}…, ours is ${knownHash.slice(0, 12)}… — the catalog changed: ask the ERP for its action-catalog.json`));
    if (ctx.ok) {
      const c = ctx.data as {
        company: { name: string; currency: string };
        today: string;
        licensedModules: string[];
        assistant?: { settings: { enabled: boolean; language: string; policy?: { financialLimit?: string | null } } };
      };
      const a = c.assistant?.settings;
      console.log(dim(`    company: ${c.company.name}, today ${c.today}, ${c.company.currency}`));
      console.log(
        `    assistant: ${a?.enabled ? green('on') : yellow('off — switch it on in Accounts → Assistant')}` +
          dim(`, language ${a?.language ?? '?'}, approval limit ${a?.policy?.financialLimit ?? 'none'}`) +
          (c.licensedModules.includes('ASSISTANT') ? '' : yellow(' · ASSISTANT not in licensedModules')),
      );
    } else {
      console.log(yellow(`    context: ${ctx.error.code} — ${ctx.error.message}`));
    }
    const terms = await actions.execute({ action: 'assistant.terms.get', input: {} });
    if (terms.ok) {
      const t = terms.data as { version: string; standing: string; acceptBy: string | null };
      const ok = t.standing === 'current';
      console.log(`    terms: version ${t.version}, ${ok ? green(t.standing) : yellow(t.standing)}${t.acceptBy ? dim(`, accept by ${t.acceptBy}`) : ''}`);
    } else if (terms.error.code !== 'PERMISSION_DENIED') {
      console.log(dim(`    terms: ${terms.error.code}`));
    }
  } catch (e) {
    failed++;
    if (e instanceof ErpError) {
      console.log(`${red('✗')} ${head}: ${e.message}`);
      if (e.status !== undefined) console.log(dim(`    ${e.step} → HTTP ${e.status} ${e.body ?? ''}`));
    } else {
      console.log(`${red('✗')} ${head}: ${(e as Error).message}`);
    }
  }
  console.log('');
}
process.exit(failed === 0 ? 0 : 1);
