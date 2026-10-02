/**
 * Chat with M.Ai in the terminal, against the mock ERP, with a real model.
 *
 *   pnpm --filter @m-ai/assistant-core chat
 *
 * Settings come from .env (see .env.example at the repo root). Type /help
 * inside the chat for the commands.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { DEMO_TENANT, ENABLED_SETTINGS, IDS, createMockErp } from '@m-ai/mock-erp';
import { createAssistant, createInProcessActionsClient } from '../src/index.js';
import type { AssistantEvent, TurnResult } from '../src/index.js';
import { loadConfig } from './env.js';

const config = loadConfig();
const USERS = { owner: IDS.owner, booker: IDS.booker, storekeeper: IDS.storekeeper } as const;
type Who = keyof typeof USERS;

const erp = createMockErp();
let who: Who = ((process.env['M_AI_USER'] as Who) in USERS ? process.env['M_AI_USER'] : 'owner') as Who;
let conversation = 1;
let debug = /^(1|true|on)$/i.test(process.env['M_AI_DEBUG'] ?? '');
let settings: Record<string, unknown> = { ...ENABLED_SETTINGS };

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const short = (v: unknown, n = 300) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

function show(e: AssistantEvent): void {
  if (!debug) return;
  switch (e.type) {
    case 'language': return console.log(dim(`  · language ${e.code}`));
    case 'tools': return console.log(dim(`  · tools offered: ${e.offered.join(', ')}`));
    case 'model': return console.log(dim(`  · model call ${e.step + 1} (${e.inputTokens} in / ${e.outputTokens} out)`));
    case 'tool_call': return console.log(dim(`  → ${e.action} ${short(e.input)}`));
    case 'tool_result': return console.log(dim(`  ← ${e.action} ${e.ok ? 'ok' : e.code} ${short(e.content)}`));
    case 'numbers_check': return console.log(dim(`  ! figures not from the app: ${e.unverified.join(', ')}${e.retrying ? ' — asking the model to rewrite' : ''}`));
    case 'preview': return console.log(dim(`  · preview ${e.action}: ${e.ok ? `ok${e.stepUp ? ', needs approval in the app' : ''}` : e.code}`));
    case 'execute': return console.log(dim(`  · execute ${e.action}: ${e.ok ? 'ok' : e.code}`));
    case 'remember': return console.log(dim(`  · remembered: ${e.note}`));
  }
}

const assistant = createAssistant({
  model: config.model,
  languages: config.languages,
  ...(config.pricing ? { pricing: config.pricing } : {}),
  ...(config.instructions ? { instructions: config.instructions } : {}),
  onEvent: show,
  onError: (e, where) => console.error(dim(`  [${where}] ${(e as Error).message ?? e}`)),
});

const HELP = `Commands:
  /user owner|booker|storekeeper   talk as another person (each sees different tools)
  /reset                           start a new conversation
  /debug on|off                    show every tool call, result and check
  /yes  /no                        press the Yes / No button
  /approve                         approve the waiting change in the "app" (step-up)
  /limit 5000 | /limit off         the company's limit above which the app must approve
  /lang auto|en|ur|ur-Latn         the company's reply language
  /off  /on                        switch the assistant off / on for the company
  /quota out | /quota ok           simulate the monthly message limit
  /data                            today's invoices in the mock ERP
  /quit
Try:  aaj ki sale kitni hui? · Madina ka baqaya batao · Madina Store ko 10 carton Pepsi · INV-0002 dikhao · What do customers owe?`;

function applySettings(): void {
  erp.setSettings(DEMO_TENANT, settings);
}

function status(r: TurnResult): string {
  const parts = [r.status, `lang ${r.language}`, `${r.usage.modelCalls} model call${r.usage.modelCalls === 1 ? '' : 's'}`, `$${r.usage.costUsd}`];
  if (r.executed.length) parts.push(`executed ${r.executed.map((x) => `${x.action}:${x.ok ? 'ok' : x.code}`).join(' ')}`);
  if (r.unverifiedNumbers.length) parts.push(`UNVERIFIED ${r.unverifiedNumbers.join(', ')}`);
  return dim(`  [${parts.join(' · ')}]`);
}

const rl = createInterface({ input: stdin, output: stdout });
console.log(`\nM.Ai — ${config.provider} / ${config.modelId} — mock ERP "Demo Distributors" (today 2026-10-02)`);
console.log(dim(`You are ${who}. /help for commands, Ctrl+C to quit.\n`));

const prompt = () => {
  rl.setPrompt(`${who} › `);
  rl.prompt();
};
prompt();

// `for await` buffers lines, so pasted or piped input is never lost while a turn is running.
chat: for await (const raw of rl) {
  let line = raw.trim();
  if (!line) {
    prompt();
    continue;
  }

  let choice: 'yes' | 'no' | undefined;
  if (line.startsWith('/')) {
    const [cmd, arg = ''] = line.slice(1).split(/\s+/, 2);
    switch (cmd) {
      case 'help': console.log(HELP); prompt(); continue;
      case 'quit': case 'exit': break chat;
      case 'user':
        if (arg in USERS) { who = arg as Who; conversation++; console.log(dim(`  now ${who}, new conversation`)); }
        else console.log(dim('  /user owner|booker|storekeeper'));
        prompt(); continue;
      case 'reset': conversation++; console.log(dim('  new conversation')); prompt(); continue;
      case 'debug': debug = arg !== 'off'; console.log(dim(`  debug ${debug ? 'on' : 'off'}`)); prompt(); continue;
      case 'approve': {
        const waiting = [...erp.host.stepUps.values()].filter((s) => s.status === 'pending');
        if (waiting.length === 0) console.log(dim('  nothing is waiting for approval'));
        for (const s of waiting) { erp.host.approveStepUp(s.confirmationId); console.log(dim(`  approved ${s.action} (${s.preview.primaryAmount}) — now send "ho gaya"`)); }
        prompt(); continue;
      }
      case 'limit': {
        const policy = { ...(settings['policy'] as object | undefined) } as Record<string, unknown>;
        if (arg === 'off' || !arg) delete policy['financialLimit'];
        else policy['financialLimit'] = arg;
        settings = { ...settings, policy };
        applySettings();
        console.log(dim(`  financial limit ${policy['financialLimit'] ?? 'off'}`));
        prompt(); continue;
      }
      case 'lang':
        if (!['auto', 'en', 'ur', 'ur-Latn'].includes(arg || 'auto')) { console.log(dim('  /lang auto|en|ur|ur-Latn')); prompt(); continue; }
        settings = { ...settings, language: arg || 'auto' };
        applySettings();
        console.log(dim(`  language ${arg || 'auto'}`));
        prompt(); continue;
      case 'off': settings = { ...settings, enabled: false }; applySettings(); console.log(dim('  assistant off')); prompt(); continue;
      case 'on': settings = { ...settings, enabled: true }; applySettings(); console.log(dim('  assistant on')); prompt(); continue;
      case 'quota':
        erp.setQuota(arg === 'out' ? { included: 1000, used: 1100, packsRemaining: 0, state: 'exhausted' } : { included: 1000, used: 120, packsRemaining: 0, state: 'ok' });
        console.log(dim(`  quota ${arg === 'out' ? 'used up' : 'ok'}`));
        prompt(); continue;
      case 'data':
        for (const i of erp.data.invoices) console.log(dim(`  ${i.invoiceNo} ${i.date} ${erp.data.customers.find((c) => c.id === i.customerId)?.name} ${i.gross} ${i.status}`));
        prompt(); continue;
      case 'yes': choice = 'yes'; line = 'yes'; break;
      case 'no': choice = 'no'; line = 'no'; break;
      default: console.log(dim('  unknown command — /help')); prompt(); continue;
    }
  }

  const userId = USERS[who];
  const actions = createInProcessActionsClient(erp.registry, () =>
    erp.assistantCtx(userId, { actor: { clientId: 'm-ai-assistant', conversationId: `terminal-${conversation}` } }),
  );
  const r = await assistant.handleTurn({
    conversationId: `terminal-${who}-${conversation}`,
    tenantId: DEMO_TENANT,
    userId,
    text: line,
    actions,
    ...(choice ? { choice } : {}),
  });
  console.log(`\nM.Ai › ${r.reply}`);
  if (r.pending) console.log(dim(`  ${r.pending.options.map((o) => `[ ${o.label} ]`).join(' ')}   (type it, or /yes /no)`));
  console.log(`${status(r)}\n`);
  prompt();
}
rl.close();
