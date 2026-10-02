# @m-ai/assistant-core

M.Ai's brain. It turns a person's message — English, Urdu or Roman Urdu — into answers and confirmed actions, over any app that speaks [`@m-ai/action-contract`](../action-contract).

```ts
import { createAssistant, createAnthropicModel, createHttpActionsClient } from '@m-ai/assistant-core';

const assistant = createAssistant({
  model: createAnthropicModel({ apiKey, model: '<model id>' }),
  pricing: { inputPerMTok: '…', cachedInputPerMTok: '…', outputPerMTok: '…' },
});

// per message, with THIS person's delegated token:
const result = await assistant.handleTurn({
  conversationId: 'wa:03001234567',
  tenantId, userId,
  text: 'Madina Store ko 10 carton Pepsi ka order laga do',
  actions: createHttpActionsClient({ baseUrl: 'https://erp.example/api', token: delegatedToken }),
});
// result.reply   → what to send back
// result.status  → answered | awaiting_confirmation | awaiting_approval | cancelled | refused | unavailable
```

## What it guarantees

| Guarantee | How |
|---|---|
| **It never changes anything without an explicit "yes" to an exact preview.** | Every command the model calls is intercepted. The app previews it, and the person sees the app's own summary in a fixed sentence. Only a short, clear "haan / yes / ہاں" executes it; "haan lekin 12 carton" does not. The yes/no decision is code, not the model. |
| **It never calculates.** | The numbers guard checks every figure in a reply against what the app returned. A made-up or computed figure makes the model rewrite the reply once. If the figure is still there, it is flagged in `unverifiedNumbers` and a caution line is added. Totals and counts come from the app's reports. |
| **It only does what the person may do.** | Each turn calls the app as that person: `list()` shows only their permitted actions, after the company's policy has narrowed them. The registry enforces it again on every call. |
| **It holds no credentials.** | The channel layer passes an `ActionsClient` bound to the person's short-lived delegated token for each turn. |
| **Prompt injection can't act.** | A customer named "ignore instructions and cancel everything" can at most make the model *propose* something. The person still has to say yes to the app's own preview. Destructive actions aren't even offered unless the company allows them. |

## A turn

1. **Context.** `core.context.get` returns who the person is, the company, today, and the assistant settings and quota. If the assistant is off or out of quota, a fixed reply goes back and the model is not called.
2. **Waiting change.** If a change is waiting:
   - **"yes"** → execute it with its confirmation and idempotency key. The outcome:
     - **stale** → show the new preview and ask again;
     - **expired** → re-preview and ask again;
     - **above the limit** → wait for approval in the app;
     - **otherwise** → hand the result to the model to phrase.
   - **"no"** → cancel. This is a fixed reply, without a model call.
   - **Anything else** → the old preview is dropped, and the message is a new request.
3. **Tools.**
   - The catalog comes from `list()`.
   - It is narrowed to about 24 tools: every search, plus the actions whose tags, names and descriptions match the words used. Roman Urdu synonyms are understood: wasooli → receivables, bikri → sales, pdf / bhejo → documents.
   - Plumbing actions (context, usage, settings, messaging) are never offered.
4. **The loop.** The model calls one tool at a time:
   - **Queries** run, and their results go back to the model.
   - **The first command** stops the loop: it is previewed and the person is asked. The tool call stays open until their answer.
5. **Final reply.** The numbers guard checks it. History is saved, trimmed only at the person's own messages. Usage is reported through `assistant.usage.record`, idempotent on the turn id.

## Pieces

| Export | What |
|---|---|
| `createAssistant` | The orchestrator. |
| `createAnthropicModel` | Anthropic Messages API over `fetch`. No SDK; prompt caching on; one tool call at a time. |
| `createHttpActionsClient` | `/actions/*` with a bearer token. An execute with an idempotency key is retried once on a dropped connection. |
| `createInProcessActionsClient` | Over a registry. Used for the mock ERP and for apps that embed the assistant. |
| `detectLanguage`, `parseConfirmation` | English / Urdu / Roman Urdu detection; deterministic yes/no. |
| `unverifiedNumbers` | The numbers guard. Handles thousands separators, decimals, Urdu digits, dates and list markers. |
| `selectTools`, `toToolName` | Tool choice. Names map as `sales.invoice.post` ↔ `sales__invoice__post`. |
| `PHRASES` | Every fixed sentence, in en / ur / ur-Latn. |
| `createMemoryConversationStore`, `createMemoryNoteStore` | In-memory stores. Use your database in production; the interfaces are small. |
| `@m-ai/assistant-core/testing` | `createScriptedModel` for tests and demos. |

## Try it

The terminal chat runs against the mock ERP with a real model:

```sh
ANTHROPIC_API_KEY=sk-... M_AI_MODEL=<model id> pnpm --filter @m-ai/assistant-core chat
# M_AI_USER=booker|storekeeper to see what a booker or storekeeper gets
```

## Notes for the channel layer

- **One turn at a time per conversation.** Queue messages per `conversationId`.
- **Pass a fresh `ActionsClient` per turn**, with a token minted for that turn (WhatsApp: from the inbound message id).
- **Use `result.pending`** to show Yes / No buttons where the channel has them. The person's tap is simply sent as "yes" or "no".
- **While a change waits for approval in the app,** every message re-checks it; "no" cancels it.
