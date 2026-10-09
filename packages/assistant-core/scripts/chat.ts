/**
 * Chat with M.Ai in the terminal, with a real model — against the mock ERP,
 * or through a real ERP's door with `--erp`.
 *
 *   pnpm --filter @m-ai/assistant-core chat
 *   pnpm --filter @m-ai/assistant-core chat -- --erp                 # the ERP in M_AI_ERP_URL, as the owner
 *   pnpm --filter @m-ai/assistant-core chat -- --erp http://localhost:3001 --as booker
 *
 * Settings come from .env (see .env.example at the repo root). Type /help
 * inside the chat for the commands.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { DEMO_TENANT, ENABLED_SETTINGS, IDS, createMockErp } from '@m-ai/mock-erp';
import { ConfigError, ModelError, PROVIDERS, PROVIDER_NAMES, createAssistant, createInProcessActionsClient, createModel, defaultProvider, providerModels } from '../src/index.js';
import type { AssistantEvent, ModelSetup, Provider, TurnResult } from '../src/index.js';
import { checkModel, checkOne, loadConfig } from './env.js';
import { ErpError, erpSettingsFromEnv, loginErp, userEmail } from '../src/erp-live.js';
import type { ErpSession, ErpSettings } from '../src/erp-live.js';

const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const config = loadConfig({
  onFallback: (from, to, e) => console.log(yellow(`  ! ${from} failed (${e.message.slice(0, 120)}) — using ${to}`)),
  onSkip: (label, reason) => {
    if (skippedThisTurn.has(label)) return;
    skippedThisTurn.add(label);
    console.log(yellow(`  ! ${label} skipped: ${reason === 'down' ? 'not reachable' : 'busy'}`));
  },
});
const skippedThisTurn = new Set<string>();
/** A simulated customer balance (/balance 2000): each reply's charge comes off it. */
let wallet: string | undefined;
await checkModel(config);
/** The model picked with /model; undefined = the one from .env (with its fallbacks). */
let current: ModelSetup | undefined;
const modelName = () => current?.spec ?? `${config.primary.spec}${config.fallbacks.length ? ` (fallback ${config.fallbacks.map((f) => f.spec).join(', ')})` : ''}`;
const USERS = { owner: IDS.owner, booker: IDS.booker, storekeeper: IDS.storekeeper } as const;
type Who = keyof typeof USERS;

const argv = process.argv.slice(2);
const argAfter = (name: string) => {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : undefined;
};
/** Through a real ERP's door (--erp), or the in-process mock ERP. */
let live: ErpSettings | undefined;
if (argv.includes('--erp')) {
  const s = erpSettingsFromEnv(process.env, argAfter('--erp'));
  if ('missing' in s) {
    console.error(`\x1b[31mMissing in .env: ${s.missing.join(', ')}\x1b[0m`);
    process.exit(1);
  }
  live = s;
}
const sessions = new Map<string, ErpSession>();
/** Where the chat saves the PDFs the ERP makes. */
const FILES_DIR = join(process.cwd(), 'm-ai-files');
let liveWho = argAfter('--as') ?? 'owner';

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
    case 'done_check': return console.log(dim(`  ! the reply said a change was made, but nothing was executed${e.retrying ? ' — asking the model to rewrite' : ''}`));
    case 'empty': return console.log(dim(`  ! the model gave no answer (${e.stopReason})${e.retrying ? ' — asking again' : ''}`));
  }
}

const assistant = createAssistant({
  model: config.model,
  languages: config.languages,
  ...(config.billing ? { billing: config.billing } : {}),
  ...(config.usageFooter ? { usageFooter: config.usageFooter } : {}),
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
  /model                           the model in use
  /model zai:glm-4.7-flash         switch model now — the conversation carries on (any provider:model)
  /model default                   back to the model in .env
  /models [provider]               model ids a provider's key can use (${PROVIDER_NAMES.join(', ')})
  /balance 2000 | /balance off     a customer balance: each reply's charge comes off it (needs M_AI_CURRENCY)
  /quit
Try:  aaj ki sale kitni hui? · Madina ka baqaya batao · Madina Store ko 10 carton Pepsi · INV-0002 dikhao · What do customers owe?`;

function applySettings(): void {
  erp.setSettings(DEMO_TENANT, settings);
}

function status(r: TurnResult): string {
  const parts = [r.status, `lang ${r.language}`, `${r.usage.modelCalls} model call${r.usage.modelCalls === 1 ? '' : 's'}`, `$${r.usage.costUsd}`];
  if (r.usage.charge) parts.push(`charged ${r.usage.charge.currency} ${r.usage.charge.amount}`);
  if (r.usage.model) parts.push(r.usage.model);
  if (r.executed.length) parts.push(`executed ${r.executed.map((x) => `${x.action}:${x.ok ? 'ok' : x.code}`).join(' ')}`);
  if (r.unverifiedNumbers.length) parts.push(`UNVERIFIED ${r.unverifiedNumbers.join(', ')}`);
  return dim(`  [${parts.join(' · ')}]`);
}

const LIVE_HELP = `Commands (real ERP):
  /user owner|booker|officer|<e-mail>   talk as another person (signs in as them)
  /reset                           start a new conversation
  /debug on|off                    show every tool call, result and check
  /yes  /no                        press the Yes / No button
  /model, /models, /balance        as with the mock ERP
  /quit
Settings, the approval limit and approvals are in the ERP itself (Accounts → Assistant; Approvals).`;

/** Sign in once per person; the session renews its own tokens. */
async function sessionFor(role: string): Promise<ErpSession | undefined> {
  if (!live) return undefined;
  const email = userEmail(live, role);
  if (!email) {
    console.log(yellow(`  no e-mail for "${role}" — use owner, booker, officer or an e-mail`));
    return undefined;
  }
  const known = sessions.get(email);
  if (known) return known;
  try {
    const s = await loginErp(live, email);
    sessions.set(email, s);
    return s;
  } catch (e) {
    erpProblem(e);
    return undefined;
  }
}

function erpProblem(e: unknown): void {
  if (e instanceof ErpError) {
    console.log(`\x1b[31m  ERP: ${e.message}\x1b[0m`);
    if (e.status !== undefined) console.log(dim(`  ${e.step} → HTTP ${e.status} ${e.body ?? ''}`));
  } else console.log(`\x1b[31m  ERP: ${(e as Error).message}\x1b[0m`);
}

// Sign in before reading any input, so piped lines are not lost while waiting.
const first = live ? await sessionFor(liveWho) : undefined;
if (live && !first) process.exit(1);
const rl = createInterface({ input: stdin, output: stdout });
if (live && first) {
  console.log(`\nM.Ai — ${modelName()} — the ERP at ${live.baseUrl}, company ${live.tenantCode}`);
  console.log(dim(`You are ${liveWho} (${first.email}). /help for commands, Ctrl+C to quit.\n`));
} else {
  console.log(`\nM.Ai — ${modelName()} — mock ERP "Demo Distributors" (today 2026-10-02)`);
  console.log(dim(`You are ${who}. /help for commands, Ctrl+C to quit.\n`));
}

const prompt = () => {
  rl.setPrompt(`${live ? liveWho : who} › `);
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
    if (live && ['help', 'user', 'approve', 'limit', 'lang', 'off', 'on', 'quota', 'data'].includes(cmd ?? '')) {
      if (cmd === 'help') console.log(LIVE_HELP);
      else if (cmd === 'user') {
        if (arg && (await sessionFor(arg))) { liveWho = arg; conversation++; console.log(dim(`  now ${arg}, new conversation`)); }
        else if (!arg) console.log(dim('  /user owner|booker|officer|<e-mail>'));
      } else if (cmd === 'approve') console.log(dim('  approve it in the ERP (Approvals), then type "ho gaya"'));
      else console.log(dim('  that is set in the ERP itself: Accounts → Assistant'));
      prompt();
      continue;
    }
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
      case 'model': {
        if (!arg) { console.log(dim(`  model: ${modelName()}`)); prompt(); continue; }
        if (arg === 'default') { current = undefined; console.log(dim(`  model: ${modelName()}`)); prompt(); continue; }
        try {
          const next = createModel(arg, process.env);
          if (await checkOne(next)) { current = next; console.log(dim(`  model: ${next.spec}${next.thinking ? ' (thinking on)' : ''} — same conversation`)); }
        } catch (e) {
          console.log(yellow(`  ${e instanceof ConfigError ? e.problems.join('\n  ') : (e as Error).message}`));
        }
        prompt(); continue;
      }
      case 'models': {
        const provider = (arg || current?.provider || defaultProvider(process.env)) as Provider;
        if (!PROVIDER_NAMES.includes(provider)) { console.log(dim(`  /models ${PROVIDER_NAMES.join('|')}`)); prompt(); continue; }
        try {
          const ids = await providerModels(provider, process.env);
          console.log(dim(`  ${provider}: ${ids.join(', ') || 'none'}`));
        } catch (e) {
          const known = PROVIDERS[provider].knownModels;
          const cannotList = e instanceof ModelError && (e.status === 404 || e.status === 405);
          if (cannotList && known) console.log(dim(`  ${PROVIDERS[provider].label} does not list models. From its docs: ${known.join(', ')}`));
          else console.log(yellow(`  ${e instanceof ConfigError ? e.problems.join('\n  ') : (e as Error).message}`));
        }
        prompt(); continue;
      }
      case 'balance': {
        if (arg === 'off') wallet = undefined;
        else if (arg) {
          if (!config.billing) { console.log(yellow('  set M_AI_CURRENCY and M_AI_USD_RATE (and M_AI_MARGIN) in .env first')); prompt(); continue; }
          if (!/^\d+(\.\d{1,2})?$/.test(arg)) { console.log(dim('  /balance 2000')); prompt(); continue; }
          wallet = arg;
        }
        console.log(dim(`  balance: ${wallet !== undefined ? `${config.billing?.currency ?? ''} ${wallet}` : 'off'}`));
        prompt(); continue;
      }
      case 'yes': choice = 'yes'; line = 'yes'; break;
      case 'no': choice = 'no'; line = 'no'; break;
      default: console.log(dim('  unknown command — /help')); prompt(); continue;
    }
  }

  skippedThisTurn.clear();
  let userId: string = USERS[who];
  let tenantId: string = DEMO_TENANT;
  let actions = createInProcessActionsClient(erp.registry, () =>
    erp.assistantCtx(userId, { actor: { clientId: 'm-ai', conversationId: `terminal-${conversation}` } }),
  );
  const conversationId = `terminal-${live ? liveWho.replace(/[^\w.-]/g, '') : who}-${conversation}`;
  if (live) {
    const session = await sessionFor(liveWho);
    if (!session) { prompt(); continue; }
    try {
      const claims = await session.claims(conversationId);
      userId = claims.sub;
      tenantId = claims.tid;
      actions = session.actions(conversationId);
    } catch (e) {
      erpProblem(e);
      prompt();
      continue;
    }
  }
  const r = await assistant.handleTurn({
    conversationId,
    tenantId,
    userId,
    text: line,
    actions,
    ...(choice ? { choice } : {}),
    ...(current ? { model: current.model } : {}),
    ...(wallet !== undefined ? { balance: wallet } : {}),
  });
  if (r.balanceAfter !== undefined) wallet = r.balanceAfter;
  console.log(`\nM.Ai › ${r.reply}`);
  if (r.error) console.log(`\x1b[31m  ${r.error.source === 'model' ? 'model' : 'app'} error: ${r.error.message}\x1b[0m`);
  for (const d of r.documents) {
    // Through the real door, fetch the file with the same token, as the web chat will, and save it.
    if (live) {
      const session = await sessionFor(liveWho);
      const file = session ? await session.actions(conversationId).document(d.documentId).catch((e: Error) => ({ ok: false as const, status: 0, code: 'TRANSPORT', message: e.message })) : undefined;
      if (file?.ok) {
        mkdirSync(FILES_DIR, { recursive: true });
        const path = join(FILES_DIR, (file.fileName ?? d.fileName ?? `${d.documentId}.pdf`).replace(/[\\/:*?"<>|]/g, '_'));
        writeFileSync(path, file.bytes);
        console.log(dim(`  file saved: ${path} (${file.bytes.length.toLocaleString('en')} bytes)`));
        continue;
      }
      if (file) console.log(yellow(`  file not fetched: ${file.status} ${file.code} ${file.message}`));
    }
    console.log(dim(`  file: ${d.fileName ?? d.action} (document ${d.documentId})`));
  }
  if (r.pending) console.log(dim(`  ${r.pending.options.map((o) => `[ ${o.label} ]`).join(' ')}   (type it, or /yes /no)`));
  console.log(`${status(r)}\n`);
  prompt();
}
rl.close();
