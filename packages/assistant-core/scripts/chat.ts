/**
 * Chat with M.Ai in the terminal, against the mock ERP, with a real model.
 *
 *   ANTHROPIC_API_KEY=sk-...  M_AI_MODEL=<model id>  pnpm --filter @m-ai/assistant-core chat
 *
 * Optional: M_AI_USER=owner|booker|storekeeper (default owner),
 *           M_AI_PRICE_IN / M_AI_PRICE_CACHED / M_AI_PRICE_OUT (USD per million tokens).
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { DEMO_TENANT, IDS, createMockErp } from '@m-ai/mock-erp';
import { createAnthropicModel, createAssistant, createInProcessActionsClient } from '../src/index.js';
import type { ModelPricing } from '../src/index.js';

const apiKey = process.env['ANTHROPIC_API_KEY'];
const modelId = process.env['M_AI_MODEL'];
if (!apiKey || !modelId) {
  console.error('Set ANTHROPIC_API_KEY and M_AI_MODEL (a model id from your Anthropic account) to chat.');
  process.exit(1);
}

const users = { owner: IDS.owner, booker: IDS.booker, storekeeper: IDS.storekeeper } as const;
const who = (process.env['M_AI_USER'] ?? 'owner') as keyof typeof users;
const userId = users[who] ?? IDS.owner;

const pricing: ModelPricing | undefined =
  process.env['M_AI_PRICE_IN'] && process.env['M_AI_PRICE_OUT']
    ? {
        inputPerMTok: process.env['M_AI_PRICE_IN'],
        cachedInputPerMTok: process.env['M_AI_PRICE_CACHED'] ?? process.env['M_AI_PRICE_IN'],
        outputPerMTok: process.env['M_AI_PRICE_OUT'],
      }
    : undefined;

const erp = createMockErp();
const assistant = createAssistant({
  model: createAnthropicModel({ apiKey, model: modelId, ...(process.env['M_AI_ANTHROPIC_URL'] ? { baseUrl: process.env['M_AI_ANTHROPIC_URL'] } : {}) }),
  ...(pricing ? { pricing } : {}),
  onError: (e, where) => console.error(`  [${where}]`, e),
});
const actions = createInProcessActionsClient(erp.registry, () =>
  erp.assistantCtx(userId, { actor: { clientId: 'm-ai-assistant', conversationId: 'terminal' } }),
);

const rl = createInterface({ input: stdin, output: stdout });
console.log(`M.Ai (mock ERP "Demo Distributors", you are ${who}). Type a message; Ctrl+C to quit.\n`);
let closed = false;
rl.on('close', () => {
  closed = true;
});
while (!closed) {
  let text: string;
  try {
    text = (await rl.question('you › ')).trim();
  } catch {
    break; // input ended
  }
  if (!text) continue;
  const r = await assistant.handleTurn({ conversationId: 'terminal', tenantId: DEMO_TENANT, userId, text, actions });
  console.log(`\nM.Ai › ${r.reply}`);
  console.log(`       [${r.status}${r.executed.length ? `, executed ${r.executed.map((e) => `${e.action}:${e.ok ? 'ok' : e.code}`).join(' ')}` : ''}, ${r.usage.modelCalls} model calls, $${r.usage.costUsd}]\n`);
}
