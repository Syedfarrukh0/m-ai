/**
 * Accuracy evals: run scripted conversations against the mock ERP with a
 * real model and check what it did — which actions it called with which
 * input, the figures it quoted, the language, what got executed.
 */
import { DEMO_TENANT, IDS, createMockErp } from '@m-ai/mock-erp';
import type { MockErp } from '@m-ai/mock-erp';
import { createAssistant, createInProcessActionsClient, numbersIn, normalizeNumber } from '../src/index.js';
import type { AssistantEvent, AssistantOptions, TurnResult } from '../src/index.js';

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
}

export interface Scenario {
  name: string;
  /** owner | booker | storekeeper. Default owner. */
  user?: 'owner' | 'booker' | 'storekeeper';
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

const USERS = { owner: IDS.owner, booker: IDS.booker, storekeeper: IDS.storekeeper } as const;

function subset(actual: unknown, expected: Record<string, unknown>): boolean {
  if (!actual || typeof actual !== 'object') return false;
  return Object.entries(expected).every(([k, v]) => JSON.stringify((actual as Record<string, unknown>)[k]) === JSON.stringify(v));
}

export async function runScenario(
  scenario: Scenario,
  options: Pick<AssistantOptions, 'model'> & Partial<AssistantOptions>,
): Promise<{ results: CheckResult[]; transcript: string[]; erp: MockErp }> {
  const erp = createMockErp();
  const results: CheckResult[] = [];
  const transcript: string[] = [];
  let events: AssistantEvent[] = [];
  const assistant = createAssistant({ ...options, onEvent: (e) => events.push(e), now: () => erp.host.now() });
  const userId = USERS[scenario.user ?? 'owner'];
  const actions = createInProcessActionsClient(erp.registry, () =>
    erp.assistantCtx(userId, { actor: { clientId: 'm-ai-assistant', conversationId: 'eval' } }),
  );

  for (const [i, turn] of scenario.turns.entries()) {
    events = [];
    const r = await assistant.handleTurn({
      conversationId: `eval-${scenario.name}`,
      tenantId: DEMO_TENANT,
      userId,
      text: turn.say,
      actions,
      ...(turn.choice ? { choice: turn.choice } : {}),
    });
    transcript.push(`you › ${turn.say}`, `M.Ai › ${r.reply}`);
    const e = turn.expect ?? {};
    const check = (name: string, ok: boolean, detail?: string) =>
      results.push({ scenario: scenario.name, turn: i + 1, check: name, ok, ...(detail !== undefined ? { detail } : {}) });

    const called = events.filter((x): x is Extract<AssistantEvent, { type: 'tool_call' }> => x.type === 'tool_call');
    const replyNumbers = numbersIn(r.reply);

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
  }
  if (scenario.after?.invoices !== undefined) {
    results.push({
      scenario: scenario.name,
      turn: scenario.turns.length,
      check: `ERP has ${scenario.after.invoices} invoices`,
      ok: erp.data.invoices.length === scenario.after.invoices,
      detail: String(erp.data.invoices.length),
    });
  }
  return { results, transcript, erp };
}
