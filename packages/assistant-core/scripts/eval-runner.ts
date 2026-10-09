/**
 * Accuracy evals: run scripted conversations against the mock ERP — or a
 * real ERP through its door — with a real model, and check what it did:
 * which actions it called with which input, the figures it quoted, the
 * language, what got executed.
 */
import { DEMO_TENANT, IDS, createMockErp } from '@m-ai/mock-erp';
import type { MockErp } from '@m-ai/mock-erp';
import { createAssistant, createInProcessActionsClient, numbersIn, normalizeNumber } from '../src/index.js';
import type { ActionsClient, AssistantEvent, AssistantOptions, TurnResult } from '../src/index.js';

/** A query whose answer the reply must quote: run with the same person's token, right after the turn. */
export interface FromAction {
  action: string;
  input?: Record<string, unknown>;
  /** Where the value is in the result's data, e.g. "totals.total" or "items.0.name". */
  path: string;
}

export interface Expect {
  status?: TurnResult['status'];
  language?: string;
  /** Actions that must have been called (queries run, or changes previewed). */
  calls?: string[];
  /** For a called action: fields its input must contain (any one call may match). */
  callInput?: Record<string, Record<string, unknown>>;
  /** Actions that must NOT have been called. */
  noCalls?: string[];
  /** Changes that must have been executed successfully in this turn. */
  executed?: string[];
  /** The change waiting for confirmation after this turn. */
  pending?: string;
  /** Figures the reply must contain (compared as numbers: "5,310.00" = "5310"). */
  figures?: string[];
  /** Figures the reply must NOT contain. */
  noFigures?: string[];
  /** Text the reply must contain, case-insensitive. Use "a|b" for alternatives. */
  includes?: string[];
  /** No figure in the reply may be missing from the ERP's results. Default true. */
  verifiedNumbers?: boolean;
  /** Real ERP: figures the reply must contain, read from the ERP after the turn. */
  figuresFrom?: FromAction[];
  /** Real ERP: text the reply must contain (a name), read from the ERP after the turn. */
  textFrom?: FromAction[];
  /** Files (PDFs) the turn must have made. */
  documents?: number;
}

export interface Scenario {
  name: string;
  /** Mock ERP: owner | booker | storekeeper. Real ERP: owner | booker | officer. Default owner. */
  user?: string;
  /** Real ERP: values found in the ERP's data ({debtor}, {invoiceNo}…) this scenario needs. Without them it is not run. */
  requires?: string[];
  turns: Array<{ say: string; choice?: 'yes' | 'no'; expect?: Expect }>;
  /** Checked after the last turn. */
  after?: { invoices?: number };
}

export interface CheckResult {
  scenario: string;
  turn: number;
  check: string;
  ok: boolean;
  detail?: string;
}

const USERS: Record<string, string> = { owner: IDS.owner, booker: IDS.booker, storekeeper: IDS.storekeeper };

/** A real ERP: a client for a person and a conversation, and the values found in its data. */
export interface LiveTarget {
  connect(user: string, conversationId: string): Promise<{ actions: ActionsClient; tenantId: string; userId: string }>;
  vars: Record<string, string>;
}

/** "{debtor} ka udhaar" → "Madina Store ka udhaar", in strings at any depth. */
export function fill<T>(value: T, vars: Record<string, string>): T {
  if (typeof value === 'string') return value.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m) as T;
  if (Array.isArray(value)) return value.map((v) => fill(v, vars)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)])) as T;
  return value;
}

export function at(data: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), data);
}

function subset(actual: unknown, expected: Record<string, unknown>): boolean {
  if (!actual || typeof actual !== 'object') return false;
  return Object.entries(expected).every(([k, v]) => JSON.stringify((actual as Record<string, unknown>)[k]) === JSON.stringify(v));
}

export async function runScenario(
  scenario: Scenario,
  options: Pick<AssistantOptions, 'model'> & Partial<AssistantOptions>,
  liveTarget?: LiveTarget,
): Promise<{ results: CheckResult[]; transcript: string[]; erp: MockErp | undefined; turns: Array<{ ms: number; result: TurnResult }> }> {
  const erp = liveTarget ? undefined : createMockErp();
  const results: CheckResult[] = [];
  const transcript: string[] = [];
  const turns: Array<{ ms: number; result: TurnResult }> = [];
  let events: AssistantEvent[] = [];
  const assistant = createAssistant({ ...options, onEvent: (e) => events.push(e), ...(erp ? { now: () => erp.host.now() } : {}) });
  const conversationId = `eval-${scenario.name}${liveTarget ? `-${Date.now().toString(36)}` : ''}`;
  let userId: string;
  let tenantId: string;
  let actions: ActionsClient;
  if (liveTarget) {
    const c = await liveTarget.connect(scenario.user ?? 'owner', conversationId);
    ({ userId, tenantId, actions } = c);
  } else {
    const id = USERS[scenario.user ?? 'owner'];
    if (!id) throw new Error(`no mock user "${scenario.user}"`);
    userId = id;
    tenantId = DEMO_TENANT;
    actions = createInProcessActionsClient(erp!.registry, () => erp!.assistantCtx(id, { actor: { clientId: 'm-ai', conversationId: 'eval' } }));
  }
  const vars = liveTarget?.vars ?? {};

  for (const [i, rawTurn] of scenario.turns.entries()) {
    const turn = fill(rawTurn, vars);
    events = [];
    const started = Date.now();
    const r = await assistant.handleTurn({
      conversationId,
      tenantId,
      userId,
      text: turn.say,
      actions,
      ...(turn.choice ? { choice: turn.choice } : {}),
    });
    turns.push({ ms: Date.now() - started, result: r });
    transcript.push(`you › ${turn.say}`, `M.Ai › ${r.reply}`);
    const e = turn.expect ?? {};
    const check = (name: string, ok: boolean, detail?: string) =>
      results.push({ scenario: scenario.name, turn: i + 1, check: name, ok, ...(detail !== undefined ? { detail } : {}) });

    const called = events.filter((x): x is Extract<AssistantEvent, { type: 'tool_call' }> => x.type === 'tool_call');
    const replyNumbers = numbersIn(r.reply);

    // Nothing passes by default when the assistant could not work at all.
    if (e.status !== 'unavailable') check('assistant was available', r.status !== 'unavailable', r.error?.message ?? r.status);
    if (e.status) check(`status ${e.status}`, r.status === e.status, r.status);
    if (e.language) check(`language ${e.language}`, r.language === e.language, r.language);
    for (const a of e.calls ?? []) check(`calls ${a}`, called.some((c) => c.action === a), called.map((c) => c.action).join(', ') || 'none');
    for (const [a, fields] of Object.entries(e.callInput ?? {}))
      check(`${a} input ⊇ ${JSON.stringify(fields)}`, called.some((c) => c.action === a && subset(c.input, fields)), JSON.stringify(called.filter((c) => c.action === a).map((c) => c.input)));
    for (const a of e.noCalls ?? []) check(`does not call ${a}`, !called.some((c) => c.action === a));
    for (const a of e.executed ?? []) check(`executes ${a}`, r.executed.some((x) => x.action === a && x.ok), JSON.stringify(r.executed));
    if (e.pending) check(`awaits confirmation of ${e.pending}`, r.pending?.action === e.pending, r.pending?.action ?? 'nothing pending');
    for (const f of e.figures ?? []) check(`reply has ${f}`, replyNumbers.has(normalizeNumber(f)), r.reply);
    for (const f of e.noFigures ?? []) check(`reply lacks ${f}`, !replyNumbers.has(normalizeNumber(f)), r.reply);
    for (const t of e.includes ?? [])
      check(`reply mentions ${t}`, t.split('|').some((alt) => r.reply.toLowerCase().includes(alt.toLowerCase())), r.reply);
    if (e.verifiedNumbers !== false) check('every figure came from the ERP', r.unverifiedNumbers.length === 0, r.unverifiedNumbers.join(', '));
    if (e.documents !== undefined) check(`makes ${e.documents} file(s)`, r.documents.length >= e.documents, JSON.stringify(r.documents));
    for (const [kind, list] of [['figure', e.figuresFrom], ['text', e.textFrom]] as const) {
      for (const f of list ?? []) {
        const got = await actions.execute({ action: f.action, input: f.input ?? {} });
        const value = got.ok ? at(got.data, f.path) : undefined;
        const name = `reply has ${f.action} ${f.path}`;
        if (value === undefined || value === null) {
          check(name, false, got.ok ? `nothing at ${f.path}` : `${got.error.code}: ${got.error.message}`);
        } else if (kind === 'figure') {
          check(`${name} (${String(value)})`, replyNumbers.has(normalizeNumber(String(value))), r.reply);
        } else {
          check(`${name} (${String(value)})`, r.reply.toLowerCase().includes(String(value).toLowerCase()), r.reply);
        }
      }
    }
  }
  if (scenario.after?.invoices !== undefined && erp) {
    results.push({
      scenario: scenario.name,
      turn: scenario.turns.length,
      check: `ERP has ${scenario.after.invoices} invoices`,
      ok: erp.data.invoices.length === scenario.after.invoices,
      detail: String(erp.data.invoices.length),
    });
  }
  return { results, transcript, erp, turns };
}
