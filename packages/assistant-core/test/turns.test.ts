/**
 * Whole turns: a scripted model, the real registry pipeline, the mock ERP.
 * The model is scripted; everything else — permissions, previews,
 * confirmations, step-up, quota, numbers — is real.
 */
import { describe, expect, it } from 'vitest';
import { DEMO_TENANT, ENABLED_SETTINGS, IDS, createMockErp } from '@m-ai/mock-erp';
import type { MockErpOptions } from '@m-ai/mock-erp';
import {
  createAssistant,
  createInProcessActionsClient,
  createMemoryConversationStore,
  createMemoryNoteStore,
  PHRASES,
} from '../src/index.js';
import type { ActionsClient, ModelMessage } from '../src/index.js';
import { createScriptedModel } from '../src/testing/index.js';
import type { ScriptStep } from '../src/testing/index.js';

const PRICING = { inputPerMTok: '3', cachedInputPerMTok: '0.30', outputPerMTok: '15' };

function setup(erpOptions: MockErpOptions = {}, steps: ScriptStep[] = []) {
  const erp = createMockErp(erpOptions);
  const model = createScriptedModel(steps);
  const conversations = createMemoryConversationStore();
  const notes = createMemoryNoteStore();
  let ids = 0;
  const assistant = createAssistant({
    model,
    conversations,
    notes,
    pricing: PRICING,
    now: () => erp.host.now(),
    newId: () => `id-${++ids}`,
  });
  const actionsFor = (userId: string): ActionsClient =>
    createInProcessActionsClient(erp.registry, () =>
      erp.assistantCtx(userId, { actor: { clientId: 'm-ai', conversationId: 'wa:03001234567' } }),
    );
  const turn = (text: string, userId: string = IDS.owner, conversationId = 'wa:03001234567') =>
    assistant.handleTurn({ conversationId, tenantId: DEMO_TENANT, userId, text, actions: actionsFor(userId) });
  const history = async (id = 'wa:03001234567'): Promise<ModelMessage[]> => (await conversations.get(id))?.messages ?? [];
  return { erp, model, turn, history, notes, conversations };
}

const lastToolResult = (messages: ModelMessage[]) => {
  for (let i = messages.length - 1; i >= 0; i--)
    for (const b of messages[i]!.content) if (b.type === 'tool_result') return b;
  return undefined;
};

const ORDER = { customerId: IDS.madinaStore, lines: [{ productId: IDS.pepsi, quantity: 10 }] };

async function proposeOrder(t: ReturnType<typeof setup>, input: unknown = ORDER) {
  t.model.push(
    { call: { name: 'masters.customer.search', input: { query: 'madina store' } } },
    { call: { name: 'masters.product.search', input: { query: 'pepsi' } } },
    { call: { name: 'sales.invoice.post', input } },
  );
  return t.turn('Madina Store ko 10 carton Pepsi ka order laga do');
}

describe('answering questions', () => {
  it("answers today's sales in Roman Urdu from the app's own totals, and records usage", async () => {
    const t = setup({}, [
      { call: { name: 'reports.sales.summary', input: { from: '2026-10-02', to: '2026-10-02', groupBy: 'booker' } } },
      'Aaj ki sale 2,124 hai, saari Usman ki.',
    ]);
    const r = await t.turn('aaj ki sale kitni hui?');
    expect(r).toMatchObject({ status: 'answered', language: 'ur-Latn', reply: 'Aaj ki sale 2,124 hai, saari Usman ki.', unverifiedNumbers: [] });
    const first = t.model.requests[0]!;
    expect(first.system).toContain('Roman Urdu');
    expect(first.system).toContain('Today is Friday 2026-10-02');
    expect(first.system).toContain('You are Munshi');
    expect(first.tools.map((x) => x.name)).toEqual(expect.arrayContaining(['reports__sales__summary', 'masters__customer__search']));
    expect(first.tools.map((x) => x.name)).not.toContain('core__context__get');
    expect(lastToolResult(await t.history())?.content).toContain('"gross":"2124.00"');
    expect(r.usage).toMatchObject({ modelCalls: 2, inputTokens: 2000, outputTokens: 200, costUsd: '0.0090' });
    expect(t.erp.data.usage).toEqual([{ tenantId: DEMO_TENANT, turnId: r.turnId, kind: 'reply', costUsd: '0.0090' }]);
  });

  it('makes the model rewrite a figure it invented, and drops the bad draft', async () => {
    const t = setup({}, [
      { call: { name: 'reports.sales.summary', input: { from: '2026-10-02', to: '2026-10-02' } } },
      'Aaj ki sale lagbhag 2,500 hai.',
      'Aaj ki sale 2,124 hai.',
    ]);
    const r = await t.turn('aaj ki sale kitni hai');
    expect(r.reply).toBe('Aaj ki sale 2,124 hai.');
    expect(r.unverifiedNumbers).toEqual([]);
    const retry = t.model.requests[2]!;
    expect(JSON.stringify(retry.messages.at(-1))).toContain('2,500');
    const texts = (await t.history()).flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text));
    expect(texts.join('|')).not.toContain('2,500');
    expect(texts.join('|')).not.toContain('system check');
  });

  it('flags a figure that survives the retry', async () => {
    const t = setup({}, [
      { call: { name: 'reports.sales.summary', input: { from: '2026-10-02', to: '2026-10-02' } } },
      'Average 1,062 per invoice.',
      'Average 1,062 per invoice.',
    ]);
    const r = await t.turn('average invoice today?');
    expect(r.unverifiedNumbers).toEqual(['1,062']);
    expect(r.reply).toContain(PHRASES.unverified.en);
  });

  it('asks which shop when the name is ambiguous', async () => {
    const t = setup({}, [
      { call: { name: 'masters.customer.search', input: { query: 'madina' } } },
      'Do Madina hain: Madina Store (Saddar) aur Madina Traders (Korangi). Kaunsi?',
    ]);
    const r = await t.turn('Madina ka baqaya batao');
    expect(r.status).toBe('answered');
    expect(lastToolResult(await t.history())?.content).toContain('Madina Traders');
  });

  it('answers in Urdu script to an Urdu message', async () => {
    const t = setup({}, [
      { call: { name: 'reports.receivables.outstanding', input: {} } },
      'کل بقایا 89,914 روپے ہے۔',
    ]);
    const r = await t.turn('کل کتنی وصولی باقی ہے؟');
    expect(r).toMatchObject({ language: 'ur', unverifiedNumbers: [] });
    expect(t.model.requests[0]!.system).toContain('Urdu script');
  });

  it('remembers what the person asks it to', async () => {
    const t = setup({}, [{ call: { name: 'assistant_remember', input: { note: 'Ali is my main booker in Saddar' } } }, 'Yaad rakh liya.', 'Ji.']);
    await t.turn('yaad rakhna Ali mera Saddar ka booker hai');
    expect(await t.notes.list(DEMO_TENANT, IDS.owner)).toEqual(['Ali is my main booker in Saddar']);
    await t.turn('theek hai bhai shukriya');
    expect(t.model.requests.at(-1)!.system).toContain('Ali is my main booker in Saddar');
  });
});

describe('changing things: preview → confirm → execute', () => {
  it('previews an order, asks, and creates nothing until "haan"', async () => {
    const t = setup();
    const r = await proposeOrder(t);
    expect(r.status).toBe('awaiting_confirmation');
    expect(r.reply).toContain('Ye hoga:');
    expect(r.reply).toContain('Invoice INV-0005 to Madina Store: 10 × Pepsi 1.5L. Net 4500.00, tax 810.00, total 5310.00.');
    expect(r.reply).toContain(PHRASES.confirmQuestion['ur-Latn']);
    expect(r.pending).toMatchObject({ action: 'sales.invoice.post', stage: 'confirm' });
    expect(t.erp.data.invoices).toHaveLength(4);
    expect(t.erp.host.outboxCount()).toBe(0);

    t.model.push('Ho gaya. Invoice INV-0005 ban gayi, total 5,310.');
    const done = await t.turn('haan');
    expect(done).toMatchObject({ status: 'answered', executed: [{ action: 'sales.invoice.post', ok: true }], unverifiedNumbers: [] });
    expect(t.erp.data.invoices).toHaveLength(5);
    expect(t.erp.host.outbox.map((e) => e.type)).toEqual(['invoice.posted']);
    // The model phrased the real result: the open tool call was answered with it.
    const sent = t.model.requests.at(-1)!.messages.at(-1)!;
    expect(sent.content[0]).toMatchObject({ type: 'tool_result' });
    expect((sent.content[0] as { content: string }).content).toContain('"invoiceNo":"INV-0005"');
    expect(sent.content[1]).toEqual({ type: 'text', text: 'haan' });
  });

  it('cancels on "nahi", and tells the model nothing happened', async () => {
    const t = setup();
    await proposeOrder(t);
    const r = await t.turn('nahi rehne do');
    expect(r).toMatchObject({ status: 'cancelled', reply: PHRASES.cancelled['ur-Latn'] });
    expect(t.erp.data.invoices).toHaveLength(4);
    expect(JSON.stringify(await t.history())).toContain('The person declined. Nothing was executed.');
    expect(t.model.requests).toHaveLength(3); // no model call to cancel
  });

  it('treats "haan lekin 12 carton" as a new request, never executing the old preview', async () => {
    const t = setup();
    await proposeOrder(t);
    t.model.push({ call: { name: 'sales.invoice.post', input: { ...ORDER, lines: [{ productId: IDS.pepsi, quantity: 12 }] } } });
    const r = await t.turn('haan lekin 12 carton karo');
    expect(r.status).toBe('awaiting_confirmation');
    expect(r.reply).toContain('12 × Pepsi 1.5L');
    expect(t.erp.data.invoices).toHaveLength(4);
    const told = t.model.requests.at(-1)!.messages.at(-1)!.content[0] as { content: string };
    expect(told.content).toContain('NOTHING was executed');
  });

  it('shows the new figures when the data changed after the preview', async () => {
    const t = setup();
    await proposeOrder(t);
    // Someone else sells to Madina meanwhile, so she ends up near her limit.
    t.erp.data.customers.find((c) => c.id === IDS.madinaStore)!.openingBalance = '79000';
    const r = await t.turn('haan');
    expect(r.status).toBe('awaiting_confirmation');
    expect(r.reply).toContain(PHRASES.changed['ur-Latn']);
    expect(r.reply).toContain(PHRASES.warnings['ur-Latn']);
    expect(t.erp.data.invoices).toHaveLength(4);
    t.model.push('Ho gaya, INV-0005 ban gayi.');
    const done = await t.turn('ji haan');
    expect(done.executed).toEqual([{ action: 'sales.invoice.post', ok: true }]);
    expect(t.erp.data.invoices).toHaveLength(5);
  });

  it('re-previews when the confirmation expired', async () => {
    const t = setup();
    await proposeOrder(t);
    t.erp.host.advance(16 * 60_000);
    const r = await t.turn('haan');
    expect(r.status).toBe('awaiting_confirmation');
    expect(r.reply).toContain(PHRASES.expired['ur-Latn']);
    t.model.push('Ho gaya.');
    expect((await t.turn('haan')).executed).toEqual([{ action: 'sales.invoice.post', ok: true }]);
  });

  it('waits for approval in the app above the company limit', async () => {
    const t = setup({ settings: { [DEMO_TENANT]: { ...ENABLED_SETTINGS, policy: { financialLimit: '5000' } } } });
    const asked = await proposeOrder(t);
    expect(asked.reply).toContain(PHRASES.stepUpAhead['ur-Latn']);

    const r = await t.turn('haan');
    expect(r).toMatchObject({ status: 'awaiting_approval', reply: PHRASES.stepUpWaiting['ur-Latn'], pending: { stage: 'step-up' } });
    expect(t.erp.host.stepUps.size).toBe(1);

    const still = await t.turn('ho gaya');
    expect(still).toMatchObject({ status: 'awaiting_approval', reply: PHRASES.stepUpStillWaiting['ur-Latn'] });

    const [confirmationId] = [...t.erp.host.stepUps.keys()];
    t.erp.host.approveStepUp(confirmationId!);
    t.model.push('Approve ho gaya, INV-0005 ban gayi.');
    const done = await t.turn('ho gaya');
    expect(done.executed).toEqual([{ action: 'sales.invoice.post', ok: true }]);
    expect(t.erp.data.invoices).toHaveLength(5);
  });

  it('lets the model explain a refusal from the app (credit limit)', async () => {
    const t = setup({}, [
      { call: { name: 'sales.invoice.post', input: { customerId: IDS.madinaTraders, lines: [{ productId: IDS.sevenUp, quantity: 60 }] } } },
      'Madina Traders ki credit limit 50,000 hai, ye order us se zyada ho jayega.',
    ]);
    const r = await t.turn('Madina Traders ko 60 carton 7up');
    expect(r).toMatchObject({ status: 'answered', unverifiedNumbers: [] });
    expect(r.pending).toBeUndefined();
    expect(lastToolResult(await t.history())).toMatchObject({ isError: true });
  });

  it('asks before a change that has no preview, showing the readable parts', async () => {
    const t = setup({}, [{ call: { name: 'masters.customer.update', input: { customerId: IDS.metro, phone: '03001112233' } } }]);
    const r = await t.turn('Metro ka number 03001112233 kar do');
    expect(r.status).toBe('awaiting_confirmation');
    expect(r.reply).toContain("Change a customer's phone number. (phone: 03001112233)");
    expect(r.reply).not.toContain(IDS.metro);
    t.model.push('Number update ho gaya.');
    expect((await t.turn('haan')).executed).toEqual([{ action: 'masters.customer.update', ok: true }]);
    expect(t.erp.data.customers.find((c) => c.id === IDS.metro)!.phone).toBe('03001112233');
  });
});

describe('who may do what', () => {
  it('never offers what the company policy or the person may not do', async () => {
    const t = setup({}, ['Ji.', 'Ji.', 'Ji.']);
    await t.turn('invoice cancel karna hai');
    expect(t.model.requests[0]!.tools.map((x) => x.name)).not.toContain('sales__invoice__cancel');
    await t.turn('stock batao', IDS.storekeeper, 'wa:store');
    const store = t.model.requests[1]!.tools.map((x) => x.name);
    expect(store).toContain('masters__product__search');
    expect(store).not.toContain('sales__invoice__post');
    await t.turn('sale report', IDS.booker, 'wa:ali');
    expect(t.model.requests[2]!.tools.map((x) => x.name)).not.toContain('reports__sales__summary');
  });

  it('refuses without calling the model when the assistant is off', async () => {
    const t = setup({ settings: { [DEMO_TENANT]: { enabled: false } } });
    const r = await t.turn('aaj ki sale?');
    expect(r).toMatchObject({ status: 'refused', reply: PHRASES.disabled['ur-Latn'] });
    expect(t.model.requests).toHaveLength(0);
    expect(t.erp.data.usage).toHaveLength(0);
  });

  it('refuses without calling the model when the quota is used up', async () => {
    const t = setup({ quota: () => ({ included: 1000, used: 1100, packsRemaining: 0, state: 'exhausted' }) });
    const r = await t.turn('aaj ki sale?');
    expect(r).toMatchObject({ status: 'refused', reply: PHRASES.quota['ur-Latn'] });
    expect(t.model.requests).toHaveLength(0);
  });

  it('starts fresh when a conversation id now belongs to someone else', async () => {
    const t = setup({}, ['Salam!', 'Salam!']);
    await t.turn('salam bhai kya haal hai', IDS.owner, 'wa:shared');
    await t.turn('salam bhai kya haal hai', IDS.booker, 'wa:shared');
    expect(t.model.requests[1]!.messages).toHaveLength(1);
  });

  it('says the system is unavailable when the app cannot be reached', async () => {
    const t = setup();
    const down: ActionsClient = {
      list: async () => { throw new Error('down'); },
      preview: async () => { throw new Error('down'); },
      execute: async () => { throw new Error('down'); },
    };
    const assistant = createAssistant({ model: t.model });
    const r = await assistant.handleTurn({ conversationId: 'x', tenantId: DEMO_TENANT, userId: IDS.owner, text: 'aaj ki sale?', actions: down });
    expect(r).toMatchObject({ status: 'unavailable', reply: PHRASES.unavailable['ur-Latn'] });
  });
});
