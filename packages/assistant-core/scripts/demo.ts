/**
 * The offline demo: no API key, no network. A scripted model plays the AI's
 * part; everything else — the mock ERP, permissions, previews, confirmation,
 * the numbers guard — is real. Shows what M.Ai does in under a second.
 *
 *   pnpm --filter @m-ai/assistant-core demo
 */
import { DEMO_TENANT, IDS, createMockErp } from '@m-ai/mock-erp';
import { createAssistant, createInProcessActionsClient } from '../src/index.js';
import type { AssistantEvent } from '../src/index.js';
import { createScriptedModel } from '../src/testing/index.js';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const erp = createMockErp();
const model = createScriptedModel();
const show = (e: AssistantEvent) => {
  if (e.type === 'tool_call') console.log(dim(`    → ERP: ${e.action} ${JSON.stringify(e.input)}`));
  if (e.type === 'tool_result') console.log(dim(`    ← ${e.ok ? 'ok' : e.code} ${e.content.length > 160 ? `${e.content.slice(0, 160)}…` : e.content}`));
  if (e.type === 'numbers_check') console.log(dim(`    ! numbers guard: ${e.unverified.join(', ')} not from the ERP${e.retrying ? ' → model must rewrite' : ''}`));
  if (e.type === 'preview') console.log(dim(`    · ERP preview of ${e.action}: ${e.ok ? 'ok' : e.code} (nothing saved)`));
  if (e.type === 'execute') console.log(dim(`    · ERP executed ${e.action}: ${e.ok ? 'ok' : e.code}`));
};
const assistant = createAssistant({ model, onEvent: show, now: () => erp.host.now() });
const actions = createInProcessActionsClient(erp.registry, () => erp.assistantCtx(IDS.owner, { actor: { clientId: 'm-ai-assistant', conversationId: 'demo' } }));

async function say(text: string, ...steps: Parameters<typeof model.push>) {
  model.push(...steps);
  console.log(`\n${bold('you  ›')} ${text}`);
  const r = await assistant.handleTurn({ conversationId: 'demo', tenantId: DEMO_TENANT, userId: IDS.owner, text, actions });
  console.log(`${bold('M.Ai ›')} ${r.reply.replace(/\n/g, '\n       ')}`);
  console.log(dim(`       [${r.status}${r.executed.length ? ` · executed ${r.executed.map((x) => x.action).join(', ')}` : ''}]`));
}

console.log(bold('\nM.Ai offline demo') + dim(' — scripted model, real mock ERP (Demo Distributors, today 2026-10-02)'));

await say('aaj ki sale kitni hui?',
  { call: { name: 'reports.sales.summary', input: { from: '2026-10-02', to: '2026-10-02', groupBy: 'booker' } } },
  'Aaj (2 October) ki sale 2,124 hai — saari Usman ki, 1 invoice.');

await say('aur total udhaar kitna hai?',
  { call: { name: 'reports.receivables.outstanding', input: {} } },
  'Kul baqaya lagbhag 90,000 hai.',
  'Kul baqaya 89,914 hai. Sab se zyada Al-Noor General Store ka hai: 52,620.');

await say('Madina ko 10 carton Pepsi bhej do',
  { call: { name: 'masters.customer.search', input: { query: 'madina' } } },
  'Do Madina hain: Madina Store (Saddar) aur Madina Traders (Korangi). Kaunsi?');

await say('Madina Store',
  { call: { name: 'masters.product.search', input: { query: 'pepsi' } } },
  { call: { name: 'sales.invoice.post', input: { customerId: IDS.madinaStore, lines: [{ productId: IDS.pepsi, quantity: 10 }] } } });

console.log(dim(`\n    (ERP invoices so far: ${erp.data.invoices.length} — nothing was created by the preview)`));

await say('haan', 'Ho gaya! Invoice INV-0005 ban gayi, Madina Store ke liye, total 5,310.');

console.log(dim(`\n    (ERP invoices now: ${erp.data.invoices.length}; outbox: ${erp.host.outbox.map((e) => e.type).join(', ')})`));

await say('Metro ko 50 carton Aquafina',
  { call: { name: 'masters.customer.search', input: { query: 'metro' } } },
  { call: { name: 'masters.product.search', input: { query: 'aquafina' } } },
  { call: { name: 'sales.invoice.post', input: { customerId: IDS.metro, lines: [{ productId: IDS.aquafina, quantity: 50 }] } } },
  'Aquafina ka stock sirf 15 carton hai, 50 nahi ho sakte. 15 laga doon?');

console.log(dim('\nEverything above except the AI\'s wording was real: ERP permissions, previews, the confirmation, the numbers guard.'));
console.log(dim('With a real model:  pnpm --filter @m-ai/assistant-core chat   (needs .env — see README)\n'));
