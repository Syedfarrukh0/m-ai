/**
 * End to end through a real ERP's door, with a SCRIPTED model.
 *
 *   pnpm --filter @m-ai/assistant-core erp:e2e            # the ERP in M_AI_ERP_URL (.env)
 *   pnpm --filter @m-ai/assistant-core erp:e2e -- --erp http://localhost:3001
 *
 * The script plays the model's part: it makes the tool calls a good model
 * would make, built from what the ERP really answers. So this checks
 * everything AROUND the model, with no AI key and the same result every time:
 *
 * - the tools offered for everyday messages, from the person's real list;
 * - real queries, and the numbers guard on the ERP's real figures;
 * - previews, "haan" / "nahi", execute with its key;
 * - step-up: approved and declined in the ERP's Approvals, then the same execute again;
 * - PDFs: rendered without a yes/no, then fetched with the same token;
 * - a booker's permissions, the assistant switched off, the four door rules,
 *   and usage records.
 *
 * How well a REAL model does is `eval -- --erp`.
 *
 * Changes on the ERP's company: one receipt of 100, one receipt above the
 * approval limit (approved), one more declined. The switch-off test turns the
 * assistant off and on again. Everything else is previewed and declined.
 */
import { createAssistant, selectTools } from '../src/index.js';
import type { AssistantEvent, HttpActionsClient, ModelRequest, TurnResult } from '../src/index.js';
import { createScriptedModel } from '../src/testing/index.js';
import type { ScriptStep } from '../src/testing/index.js';
import { loadEnv } from './env.js';
import { discoverVars } from './erp-discover.js';
import { ErpError, erpSettingsFromEnv, loginErp, userEmail } from '../src/erp-live.js';
import type { ErpSession } from '../src/erp-live.js';

loadEnv();
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : undefined;
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
const only = flag('--only');
const verbose = args.includes('--verbose');

// ── Helpers ──────────────────────────────────────────────────────────────────
type Json = Record<string, unknown>;
const sessions = new Map<string, ErpSession>();
async function session(role: string): Promise<ErpSession> {
  const email = userEmail(settings as Exclude<typeof settings, { missing: string[] }>, role);
  if (!email) throw new Error(`no e-mail for ${role}`);
  let s = sessions.get(email);
  if (!s) {
    s = await loginErp(settings as Exclude<typeof settings, { missing: string[] }>, email);
    sessions.set(email, s);
  }
  return s;
}

/** The person's own signed-in session (not M.Ai's token): what the workbench does. */
async function ownSession(role: string): Promise<(method: string, path: string, body?: unknown) => Promise<{ status: number; json: Json }>> {
  const s = settings as Exclude<typeof settings, { missing: string[] }>;
  const email = userEmail(s, role)!;
  const login = await fetch(`${s.baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantCode: s.tenantCode, email, password: s.password }),
  });
  const { accessToken } = (await login.json()) as { accessToken: string };
  return async (method, path, body) => {
    const r = await fetch(`${s.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { 'content-type': 'application/json', 'idempotency-key': `e2e-${Date.now()}-${Math.random()}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json: Json = {};
    try {
      json = JSON.parse(text) as Json;
    } catch {
      json = { text };
    }
    return { status: r.status, json };
  };
}

/** The last tool result the model was shown, parsed. */
function lastResult(req: ModelRequest): Json {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const blocks = req.messages[i]!.content;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j]!;
      if (b.type === 'tool_result') {
        try {
          return JSON.parse(b.content.replace(/…\(truncated\)$/, '')) as Json;
        } catch {
          return { raw: b.content };
        }
      }
    }
  }
  return {};
}
const call = (name: string, input: unknown): ScriptStep => ({ call: { name, input } });
const firstId = (req: ModelRequest) => ((lastResult(req)['items'] as Json[] | undefined)?.[0]?.['id'] as string | undefined) ?? 'missing';
const money = (v: unknown) => {
  const [i = '0', f = ''] = String(v).split('.');
  const two = (f + '00').slice(0, 2);
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${two}`;
};

interface Check {
  scenario: string;
  check: string;
  ok: boolean;
  detail?: string;
}
const checks: Check[] = [];
const codes = new Map<string, number>();
const truncated = new Set<string>();
const errors: string[] = [];
let scenario = '';
function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ scenario, check: name, ok, ...(detail !== undefined ? { detail } : {}) });
}

/** One conversation: a fresh assistant, the person's token, a script. */
async function conversation(role: string, steps: ScriptStep[]) {
  const s = await session(role);
  const cid = `e2e-${scenario}-${Date.now().toString(36)}`;
  const claims = await s.claims(cid);
  const actions = s.actions(cid);
  const model = createScriptedModel(steps);
  let events: AssistantEvent[] = [];
  const assistant = createAssistant({
    model,
    onEvent: (e) => {
      events.push(e);
      if (e.type === 'tool_result') {
        if (!e.ok && e.code) codes.set(e.code, (codes.get(e.code) ?? 0) + 1);
        if (e.content.endsWith('…(truncated)')) truncated.add(e.action);
      }
      if ((e.type === 'preview' || e.type === 'execute') && !e.ok && e.code) codes.set(e.code, (codes.get(e.code) ?? 0) + 1);
    },
    onError: (e, where) => errors.push(`${scenario} [${where}] ${(e as Error).message}`),
  });
  const say = async (text: string): Promise<TurnResult & { events: AssistantEvent[] }> => {
    events = [];
    const r = await assistant.handleTurn({ conversationId: cid, tenantId: claims.tid, userId: claims.sub, text, actions });
    if (verbose) console.log(dim(`     ${role} › ${text}\n     M.Ai › ${r.reply.replace(/\n/g, '\n            ')}`));
    return { ...r, events };
  };
  return { say, actions, model, cid };
}
const offered = (r: { events: AssistantEvent[] }) => (r.events.find((e) => e.type === 'tools') as { offered: string[] } | undefined)?.offered ?? [];

/** The records each scenario talks about; without them it is skipped, not failed. */
const NEEDS: Record<string, string[]> = {
  'tools-for-everyday-messages': ['debtor', 'product', 'invoiceNo'],
  'today-sales-roman-urdu': ['today'],
  'today-sales-urdu': ['today'],
  'invoice-by-number': ['invoiceNo'],
  'who-owes': ['debtor'],
  'receipt-100-yes': ['debtor'],
  'invoice-preview-then-no': ['customer', 'product'],
  'switch-off-a-customer-who-owes': ['debtor'],
  'step-up-approved': ['debtor'],
  'step-up-declined': ['debtor'],
  'statement-pdf': ['debtor'],
  'invoice-pdf-by-number': ['invoiceNo'],
  'customer-account-as-data': ['debtor'],
  'pdf-door-refusals': ['invoiceId'],
  'door-rules': ['debtorId'],
};
const skipped: string[] = [];
/** Thrown by a scenario that cannot run on this ERP (an older one). */
class Skip extends Error {}
async function run(name: string, body: () => Promise<void>): Promise<void> {
  if (only && !name.includes(only)) return;
  const lacking = (NEEDS[name] ?? []).filter((k) => !vars[k]);
  if (lacking.length > 0) {
    skipped.push(name);
    console.log(`${yellow('SKIP')} ${name} ${dim(`— nothing found in the ERP for ${lacking.map((k) => `{${k}}`).join(', ')}`)}`);
    return;
  }
  scenario = name;
  const before = checks.length;
  try {
    await body();
  } catch (e) {
    if (e instanceof Skip) {
      skipped.push(name);
      console.log(`${yellow('SKIP')} ${name} ${dim(`— ${e.message}`)}`);
      return;
    }
    check('ran without error', false, e instanceof ErpError ? `${e.message} (${e.step} ${e.status ?? ''} ${e.body ?? ''})` : (e as Error).stack);
  }
  const mine = checks.slice(before);
  const failed = mine.filter((c) => !c.ok);
  console.log(`${failed.length === 0 ? green('PASS') : red('FAIL')} ${name} ${dim(`(${mine.length} checks)`)}`);
  for (const f of failed) console.log(red(`     ✗ ${f.check}`) + dim(f.detail ? ` — ${f.detail.slice(0, 300)}` : ''));
}

// ── What we talk about: real records ─────────────────────────────────────────
const owner = await session('owner').catch((e) => {
  console.error(red(`ERP: ${(e as Error).message}`));
  process.exit(1);
});
const probe = owner.actions(`e2e-probe-${Date.now()}`);
const q = async (action: string, input: Json = {}) => {
  const r = await probe.execute({ action, input });
  if (!r.ok) throw new Error(`${action}: ${r.error.code} ${r.error.message}`);
  return r.data as Json;
};
const ctx = await q('core.context.get');
const policy = (((ctx['assistant'] as Json | undefined)?.['settings'] as Json | undefined)?.['policy'] as Json | undefined) ?? {};
const limit = String(policy['financialLimit'] ?? '');
// The records to talk about, found the same way the live evals find them. A missing one skips its scenarios.
const { vars, notes } = await discoverVars(probe);
const today = vars['today'] ?? String(ctx['today']);
const debtorName = vars['debtor'] ?? '';
const debtorWord = debtorName.split(/\s+/)[0] ?? '';
const debtorId = vars['debtorId'] ?? '';
const invoiceNo = vars['invoiceNo'] ?? '';
const invoiceId = vars['invoiceId'] ?? '';
const customer = { name: vars['customer'] ?? '' };
const customerWord = customer.name.split(/\s+/)[0] ?? '';
const product = { name: vars['product'] ?? '' };
const productWord = vars['productCode'] ?? product.name.split(/\s+/)[0] ?? '';

console.log(`\nM.Ai end to end — ${settings.baseUrl}, company ${settings.tenantCode}, today ${today}`);
console.log(dim(`records: debtor "${debtorName}", invoice ${invoiceNo}, customer "${customer.name}", product "${product.name}", approval limit ${limit || 'none'}`));
for (const n of notes) console.log(yellow(`  ${n}`));
console.log('');

// ── 1. The tools offered ─────────────────────────────────────────────────────
await run('tools-for-everyday-messages', async () => {
  const ownerList = (await probe.list()).actions;
  const booker = await session('booker');
  const bookerList = (await booker.actions(`e2e-list-${Date.now()}`).list()).actions;
  const cases: Array<[string, string[], typeof ownerList]> = [
    [`${debtorName} ko 10 carton ${product.name}`, ['sales.invoice.post', 'masters.customer.search', 'masters.product.search'], ownerList],
    [`${debtorName} se 5000 rupay wasool hue cash`, ['receivables.receipt.post', 'masters.customer.search'], ownerList],
    [`${invoiceNo} dikhao`, ['sales.invoice.get'], ownerList],
    [`${debtorName} ka phone number badal do 03001234567`, ['masters.customer.update', 'masters.customer.search'], ownerList],
    ['aaj ki sale kitni hui?', ['reports.sales.summary'], ownerList],
    ['kis kis ka udhaar baqi hai', ['reports.receivables.outstanding'], ownerList],
    [`${debtorName} ka statement bhejo is mahine ka`, ['documents.statement.render', 'masters.customer.search'], ownerList],
    [`${invoiceNo} ka pdf bhejo`, ['documents.invoice.render', 'sales.invoice.get'], ownerList],
    ['آج کی سیل کتنی ہوئی', ['reports.sales.summary'], ownerList],
    [`${debtorName} ko 10 carton ${product.name}`, ['sales.invoice.post', 'masters.customer.search', 'masters.product.search'], bookerList],
    [`${debtorName} se 5000 wasool hue`, ['receivables.receipt.post'], bookerList],
  ];
  for (const [text, wanted, list] of cases) {
    const names = selectTools(list, text, 24, undefined, { maxChars: 24_000 }).map((e) => e.name);
    const missing = wanted.filter((w) => !names.includes(w));
    check(`"${text.slice(0, 40)}" (${list === bookerList ? 'booker' : 'owner'})`, missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : undefined);
  }
  check('booker is never offered masters.customer.create', !bookerList.some((e) => e.name === 'masters.customer.create'));
});

await run('every-master-list-and-get-answers', async () => {
  for (const kind of ['customer', 'vendor', 'product', 'company', 'category', 'salesperson', 'warehouse']) {
    const list = await probe.execute({ action: `masters.${kind}.list`, input: { limit: 2 } });
    check(`masters.${kind}.list`, list.ok, list.ok ? undefined : `${list.error.code}: ${list.error.message}`);
    const found = await probe.execute({ action: `masters.${kind}.search`, input: { query: kind === 'product' && productWord ? productWord : 'a' } });
    const id = found.ok ? ((found.data as Json)['items'] as Json[])[0]?.['id'] : undefined;
    if (typeof id === 'string') {
      const got = await probe.execute({ action: `masters.${kind}.get`, input: { id } });
      check(`masters.${kind}.get`, got.ok, got.ok ? undefined : `${got.error.code}: ${got.error.message}`);
    }
  }
});

// ── 2. Queries and the numbers guard ─────────────────────────────────────────
await run('today-sales-roman-urdu', async () => {
  const c = await conversation('owner', [
    call('reports.sales.summary', { from: today, to: today }),
    (req) => `Aaj (${today}) ki sale PKR ${money((lastResult(req)['totals'] as Json)['total'])} hai, ${(lastResult(req)['totals'] as Json)['invoices']} invoices.`,
  ]);
  const r = await c.say('aaj ki sale kitni hui?');
  check('answered', r.status === 'answered', r.status);
  check('Roman Urdu', r.language === 'ur-Latn', r.language);
  check('summary was offered', offered(r).includes('reports.sales.summary'));
  check('every figure verified', r.unverifiedNumbers.length === 0, `${r.unverifiedNumbers.join(', ')} — ${r.reply}`);
});

await run('today-sales-urdu', async () => {
  // The script first forgets "to": the ERP's validation comes back as a result the model reads, and it tries again.
  const c = await conversation('owner', [
    call('reports.sales.summary', { from: today }),
    (req) => (lastResult(req)['error'] ? call('reports.sales.summary', { from: today, to: today }) : 'غلطی'),
    (req) => `آج (${today}) کی سیل PKR ${money((lastResult(req)['totals'] as Json)['total'])} ہے۔`,
  ]);
  const r = await c.say('آج کی سیل کتنی ہوئی؟');
  check('Urdu', r.language === 'ur', r.language);
  const results = r.events.filter((e) => e.type === 'tool_result') as Array<{ ok: boolean; code?: string }>;
  check('a missing "to" comes back as VALIDATION_FAILED, readable by the model', results[0]?.ok === false && results[0].code === 'VALIDATION_FAILED', JSON.stringify(results[0]));
  check('the second try answers', results[1]?.ok === true && r.status === 'answered', `${r.status}: ${r.reply}`);
  check('every figure verified', r.unverifiedNumbers.length === 0, `${r.unverifiedNumbers.join(', ')} — ${r.reply}`);
});

await run('invoice-by-number', async () => {
  const c = await conversation('owner', [
    call('sales.invoice.get', { invoiceNo: invoiceNo.toLowerCase() }),
    (req) => `${lastResult(req)['invoiceNo']}: ${lastResult(req)['customerName']}, total PKR ${money(lastResult(req)['totalAmount'])}, baqi PKR ${money(lastResult(req)['outstandingAmount'])}.`,
  ]);
  const r = await c.say(`${invoiceNo} dikhao`);
  check('"dikhao" does not offer a PDF', !offered(r).includes('documents.invoice.render'), offered(r).join(', '));
  check('found by number, in lower case', r.reply.includes(invoiceNo), r.reply);
  check('every figure verified', r.unverifiedNumbers.length === 0, `${r.unverifiedNumbers.join(', ')} — ${r.reply}`);
});

await run('who-owes', async () => {
  const c = await conversation('owner', [
    call('reports.receivables.outstanding', {}),
    (req) => {
      const top = (lastResult(req)['items'] as Json[])[0]!;
      return `Sab se zyada ${top['name']} par PKR ${money(top['outstanding'])} hai. Kul PKR ${money((lastResult(req)['totals'] as Json)['outstanding'])}.`;
    },
  ]);
  const r = await c.say('kis kis ka udhaar baqi hai?');
  check('names the top debtor', r.reply.includes(debtorName), r.reply);
  check('every figure verified', r.unverifiedNumbers.length === 0, `${r.unverifiedNumbers.join(', ')} — ${r.reply}`);
});

// ── 3. Changes: preview, yes / no ────────────────────────────────────────────
await run('receipt-100-yes', async () => {
  const c = await conversation('owner', [
    call('masters.customer.search', { query: debtorWord }),
    (req) => call('receivables.receipt.post', { receiptDate: today, customerId: firstId(req), amount: '100' }),
    (req) => `Receipt ${lastResult(req)['receiptNo']} darj ho gayi.`,
  ]);
  const r1 = await c.say(`${debtorName} se 100 rupay cash wasool hue`);
  check('awaits confirmation', r1.status === 'awaiting_confirmation', `${r1.status}: ${r1.reply}`);
  check('the preview names the customer and the amount', r1.reply.includes(debtorName) && r1.reply.includes('100'), r1.reply);
  const r2 = await c.say('haan');
  check('executed', r2.executed.some((x) => x.action === 'receivables.receipt.post' && x.ok), JSON.stringify(r2.executed));
  check('answered after', r2.status === 'answered', `${r2.status}: ${r2.reply}`);
});

await run('invoice-preview-then-no', async () => {
  const before = (await q('reports.sales.summary', { from: today, to: today }))['totals'] as Json;
  let customerId = '';
  const c = await conversation('owner', [
    call('masters.customer.search', { query: customerWord }),
    (req) => {
      customerId = firstId(req);
      return call('masters.product.search', { query: productWord });
    },
    (req) => call('sales.invoice.post', { invoiceDate: today, customerId, lines: [{ productId: firstId(req), quantity: '2' }] }),
  ]);
  const r1 = await c.say(`${customer.name} ko 2 carton ${product.name} ka bill bana do`);
  check('awaits confirmation', r1.status === 'awaiting_confirmation', `${r1.status}: ${r1.reply}`);
  const r2 = await c.say('nahi');
  check('cancelled', r2.status === 'cancelled', r2.status);
  const after = (await q('reports.sales.summary', { from: today, to: today }))['totals'] as Json;
  check('nothing was posted', before['invoices'] === after['invoices'], `${before['invoices']} → ${after['invoices']}`);
});

await run('switch-off-a-customer-who-owes', async () => {
  const c = await conversation('owner', [
    call('masters.customer.search', { query: debtorWord }),
    (req) => call('masters.customer.update', { id: firstId(req), changes: { isActive: false } }),
  ]);
  const r1 = await c.say(`${debtorName} ko band kar do`);
  check('awaits confirmation', r1.status === 'awaiting_confirmation', `${r1.status}: ${r1.reply}`);
  check('the preview warns what is left', /owes|still|واجب|baqi/i.test(r1.reply), r1.reply);
  const r2 = await c.say('nahi');
  check('cancelled', r2.status === 'cancelled', r2.status);
});

// ── 4. Step-up ───────────────────────────────────────────────────────────────
async function stepUp(decision: 'approve' | 'decline', amount: string) {
  const c = await conversation('owner', [
    call('masters.customer.search', { query: debtorWord }),
    (req) => call('receivables.receipt.post', { receiptDate: today, customerId: firstId(req), amount }),
    (req) => (lastResult(req)['error'] ? 'Approval nahi mili, kuch darj nahi hua.' : `Receipt ${lastResult(req)['receiptNo']} darj ho gayi.`),
  ]);
  const r1 = await c.say(`${debtorName} se ${amount} rupay cash wasool hue`);
  check('awaits confirmation, saying approval is needed', r1.status === 'awaiting_confirmation' && /approv|منظور|manzoor/i.test(r1.reply), `${r1.status}: ${r1.reply}`);
  const r2 = await c.say('haan');
  check('waits for approval in the app', r2.status === 'awaiting_approval', `${r2.status}: ${r2.reply}`);
  const me = await ownSession('owner');
  const list = await me('GET', '/me/approvals');
  const pending = ((list.json['approvals'] as Json[] | undefined) ?? []).filter((a) => a['status'] === 'pending');
  check('the owner sees it in Approvals', pending.length > 0, JSON.stringify(list.json).slice(0, 300));
  const target = pending.find((a) => JSON.stringify(a).includes(amount)) ?? pending[0];
  if (target) {
    const d = await me('POST', `/me/approvals/${target['id']}/${decision}`);
    check(`${decision}d in the app`, d.status === 200, JSON.stringify(d.json).slice(0, 300));
  }
  return { c, r2, say: c.say };
}

await run('step-up-approved', async () => {
  const amount = String(Math.floor(Number(limit)) + 1000);
  if (!(Number(limit) > 0)) return check('an approval limit is set', false, 'set one in Accounts → Assistant');
  const { say } = await stepUp('approve', amount);
  const r3 = await say('ho gaya');
  check('the same execute now goes through', r3.executed.some((x) => x.action === 'receivables.receipt.post' && x.ok), JSON.stringify(r3.executed));
});

await run('step-up-declined', async () => {
  const amount = String(Math.floor(Number(limit)) + 2000);
  if (!(Number(limit) > 0)) return check('an approval limit is set', false);
  const { say } = await stepUp('decline', amount);
  const r3 = await say('ho gaya');
  const x = r3.executed.find((e) => e.action === 'receivables.receipt.post');
  check('refused as step_up_declined', x?.ok === false && x.code === 'ASSISTANT_POLICY_DENIED', JSON.stringify(r3.executed));
  check('nothing claimed as done', !/darj ho gayi/.test(r3.reply), r3.reply);
});

// ── 5. PDFs ──────────────────────────────────────────────────────────────────
async function pdf(actions: HttpActionsClient, r: TurnResult) {
  check('runs without a yes/no', r.status === 'answered' && !r.pending, `${r.status}: ${r.reply}`);
  check('one file handed to the channel', r.documents.length === 1, JSON.stringify(r.documents));
  const d = r.documents[0];
  if (!d) return;
  const file = await actions.document(d.documentId);
  check('fetched with the same token', file.ok && file.contentType === 'application/pdf' && Buffer.from(file.bytes.slice(0, 5)).toString() === '%PDF-', file.ok ? `${file.contentType} ${file.bytes.length} bytes` : `${file.status} ${file.code}`);
  if (file.ok) console.log(dim(`     file: ${file.fileName} — ${file.bytes.length.toLocaleString('en')} bytes`));
}

await run('statement-pdf', async () => {
  const c = await conversation('owner', [
    call('masters.customer.search', { query: debtorWord }),
    (req) => call('documents.statement.render', { customerId: firstId(req) }),
    'Statement ki PDF tayyar hai.',
  ]);
  const r = await c.say(`${debtorName} ka statement PDF bana do`);
  await pdf(c.actions, r);
});

await run('invoice-pdf-by-number', async () => {
  // Renders take the number since the ERP's 8 Oct fix; an older ERP needs the id, found with .get first.
  const c = await conversation('owner', [
    call('documents.invoice.render', { invoiceNo }),
    (req) => (lastResult(req)['error'] ? call('sales.invoice.get', { invoiceNo }) : 'Invoice ki PDF tayyar hai.'),
    (req) => (lastResult(req)['id'] ? call('documents.invoice.render', { invoiceId: lastResult(req)['id'] }) : 'PDF nahi ban saki.'),
    'Invoice ki PDF tayyar hai.',
  ]);
  const r = await c.say(`${invoiceNo} ka pdf bhejo`);
  const first = r.events.find((e) => e.type === 'tool_result') as { ok: boolean; code?: string } | undefined;
  console.log(dim(`     render by number: ${first?.ok ? 'yes' : `not yet (${first?.code}) — rendered by id`}`));
  await pdf(c.actions, r);
});

// ── E1: the statement as data, money in hand (only on an ERP that has them) ──
await run('customer-account-as-data', async () => {
  const list = (await probe.list()).actions.map((e) => e.name);
  if (!list.includes('receivables.statement.get')) throw new Skip('this ERP has no receivables.statement.get yet (before E1)');
  const c = await conversation('owner', [
    call('masters.customer.search', { query: debtorWord }),
    (req) => call('receivables.statement.get', { customerId: firstId(req) }),
    (req) => `${debtorName}: shuru mein PKR ${money(lastResult(req)['opening'])}, ab PKR ${money(lastResult(req)['closing'])} baqi.`,
  ]);
  const r = await c.say(`${debtorName} ka is mahine ka hisaab dikhao`);
  check('the statement query was offered, the PDF was not', offered(r).includes('receivables.statement.get') && !offered(r).includes('documents.statement.render'), offered(r).join(', '));
  check('answered from the statement', r.status === 'answered' && r.executed.length === 0, `${r.status}: ${r.reply}`);
  check('every figure verified', r.unverifiedNumbers.length === 0, `${r.unverifiedNumbers.join(', ')} — ${r.reply}`);
});

await run('money-in-hand', async () => {
  const list = (await probe.list()).actions.map((e) => e.name);
  if (!list.includes('accounts.cash-account.list')) throw new Skip('this ERP has no accounts.cash-account.list yet (before E1)');
  const c = await conversation('owner', [
    call('accounts.cash-account.list', {}),
    (req) => `Kul PKR ${money((lastResult(req)['totals'] as Json)['balance'])}, ${(lastResult(req)['totals'] as Json)['accounts']} accounts mein.`,
  ]);
  const r = await c.say('bank aur cash mein kitna paisa hai?');
  check('the cash and bank accounts were offered', offered(r).includes('accounts.cash-account.list'), offered(r).join(', '));
  check('every figure verified', r.unverifiedNumbers.length === 0, `${r.unverifiedNumbers.join(', ')} — ${r.reply}`);
});

await run('pdf-door-refusals', async () => {
  const s = await session('owner');
  const a = s.actions(`e2e-pdf-${Date.now()}`);
  const missing = await a.document('01a11add-0000-7000-8000-000000000000');
  check('an unknown file is 404', !missing.ok && missing.status === 404, JSON.stringify(missing));
  const st = settings as Exclude<typeof settings, { missing: string[] }>;
  const printRoute = await fetch(`${st.baseUrl}/documents/invoices/${invoiceId}/pdf`, { headers: { authorization: `Bearer ${await s.token(`e2e-pdf-x`)}` } });
  check('the print routes stay closed to the token', printRoute.status === 401, String(printRoute.status));
});

// ── 6. People, policy and the door ───────────────────────────────────────────
await run('booker-cannot-add-a-customer', async () => {
  const c = await conversation('booker', [call('masters.customer.create', { name: 'Test Traders' }), 'Ye aap ke ikhtiyar mein nahi.']);
  const r = await c.say('naya customer banao Test Traders, Karachi');
  check('create was not offered', !offered(r).includes('masters.customer.create'), offered(r).join(', '));
  check('nothing executed', r.executed.length === 0 && r.status === 'answered', `${r.status} ${JSON.stringify(r.executed)}`);
  const direct = await c.actions.execute({ action: 'masters.customer.create', idempotencyKey: `e2e-${Date.now()}`, input: { name: 'Test Traders' } });
  check('the door itself refuses it', !direct.ok && ['PERMISSION_DENIED', 'UNKNOWN_ACTION'].includes(direct.error.code), direct.ok ? 'ok?!' : direct.error.code);
});

await run('assistant-switched-off', async () => {
  const me = await ownSession('owner');
  const off = await me('POST', '/actions/execute', { action: 'assistant.settings.update', input: { enabled: false } });
  check('switched off by the owner', off.status === 200, JSON.stringify(off.json).slice(0, 200));
  try {
    const c = await conversation('owner', ['should not be called']);
    const r = await c.say('aaj ki sale kitni hui?');
    check('refused with the plain sentence', r.status === 'refused' && /band|off/i.test(r.reply), `${r.status}: ${r.reply}`);
    check('no model call', c.model.requests.length === 0, String(c.model.requests.length));
  } finally {
    const on = await me('POST', '/actions/execute', { action: 'assistant.settings.update', input: { enabled: true } });
    check('switched on again', on.status === 200, JSON.stringify(on.json).slice(0, 200));
  }
});

await run('door-rules', async () => {
  const s = await session('owner');
  const st = settings as Exclude<typeof settings, { missing: string[] }>;
  const token = await s.token(`e2e-door-${Date.now()}`);
  const withSource = await fetch(`${st.baseUrl}/actions/list`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-erp-source': 'web' },
    body: '{}',
  });
  check('X-Erp-Source on a delegated call is 400', withSource.status === 400, String(withSource.status));
  const other = await fetch(`${st.baseUrl}/me/approvals`, { headers: { authorization: `Bearer ${token}` } });
  check('the token cannot reach Approvals', other.status === 401 || other.status === 403, String(other.status));
  const again = await fetch(`${st.baseUrl}/auth/delegate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'm-ai', conversationId: 'x' }),
  });
  check('the token cannot ask for another token', again.status === 401 || again.status === 403, String(again.status));
  const noKey = await s.actions('e2e-nokey').execute({ action: 'receivables.receipt.post', input: { receiptDate: today, customerId: debtorId, amount: '1' } });
  check('a command without its key is refused', !noKey.ok && ['IDEMPOTENCY_KEY_REQUIRED', 'CONFIRMATION_REQUIRED'].includes(noKey.error.code), noKey.ok ? 'ok?!' : noKey.error.code);
});

await run('usage-records', async () => {
  const s = await session('owner');
  const a = s.actions(`e2e-usage-${Date.now()}`);
  const turnId = `e2e-${Date.now()}`;
  const input = { turnId, kind: 'reply', conversationId: 'e2e', model: 'scripted', inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, costUsd: '0.0001', occurredAt: new Date().toISOString(), charge: { amount: '0.03', currency: 'PKR' }, balanceAfter: '1999.97' };
  const first = await a.execute({ action: 'assistant.usage.record', idempotencyKey: `u1-${turnId}`, input });
  const again = await a.execute({ action: 'assistant.usage.record', idempotencyKey: `u2-${turnId}`, input });
  check('recorded once', first.ok && (first.data as Json)['recorded'] === true, JSON.stringify(first).slice(0, 200));
  check('the same turn again: recorded false', again.ok && (again.data as Json)['recorded'] === false, JSON.stringify(again).slice(0, 200));
  check('no usage record failed during the run', !errors.some((e) => e.includes('[usage]')), errors.filter((e) => e.includes('[usage]')).join('; '));
});

// ── Summary ──────────────────────────────────────────────────────────────────
const failed = checks.filter((c) => !c.ok);
const scenarios = [...new Set(checks.map((c) => c.scenario))];
const passedScenarios = scenarios.filter((s) => !failed.some((f) => f.scenario === s));
console.log(`\n${passedScenarios.length}/${scenarios.length} scenarios · ${checks.length - failed.length}/${checks.length} checks passed${skipped.length ? yellow(` · ${skipped.length} skipped`) : ''}`);
if (codes.size) console.log(dim(`codes the ERP answered: ${[...codes].map(([k, n]) => `${k} ×${n}`).join(', ')}`));
if (truncated.size) console.log(yellow(`results cut at 6000 characters for the model: ${[...truncated].join(', ')}`));
for (const e of errors) console.log(yellow(`  ${e}`));
process.exit(failed.length === 0 ? 0 : 1);
