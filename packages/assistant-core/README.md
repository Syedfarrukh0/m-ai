# @m-ai/assistant-core

M.Ai's brain. It turns a person's message into answers and confirmed actions, over **any** software that speaks [`@m-ai/action-contract`](../action-contract). It works in any language, with any AI model.

---

## Run it in the terminal

### 1. One-time setup

You need [Node.js 20 or newer](https://nodejs.org). pnpm comes with Node through corepack.

```sh
corepack enable            # gives you pnpm
cd m-ai                    # the repo folder
pnpm install
pnpm verify                # builds and runs all tests — should end with every test passing
```

### 2. See it work without any API key (offline demo)

```sh
pnpm --filter @m-ai/assistant-core demo
```

A scripted model plays the AI's part. Everything else is real: the mock ERP, permissions, previews, the confirmation, and the numbers guard. You'll see:

- a sales question;
- the numbers guard catching a made-up figure;
- an ambiguous shop name being asked about;
- an order being previewed, confirmed and posted;
- an order refused for stock.

### 3. Chat with a real model

```sh
cp .env.example .env       # at the repo root
# open .env and fill in M_AI_PROVIDER, M_AI_MODEL, M_AI_API_KEY (see "Models" below)
pnpm --filter @m-ai/assistant-core chat
```

You are talking to a mock distributor ERP, "Demo Distributors": Karachi, today 2 Oct 2026, 5 shops (two named "Madina"), 4 products, 2 bookers.

Things to try:

| Type | What should happen |
|---|---|
| `aaj ki sale kitni hui?` | The report for 2026-10-02 → **2,124** (all Usman's) |
| `total wasooli kitni baqi hai?` | **89,914** |
| `sab se zyada udhaar kis ka hai?` | Al-Noor General Store, **52,620** |
| `Madina ko 5 carton Sprite` | It asks: Madina Store (Saddar) or Madina Traders (Korangi)? |
| `Madina Store ko 10 carton Pepsi` | A preview, total **5310.00**, and "haan / nahi?". Nothing is saved yet. |
| then `haan` | INV-0005 is posted (`/data` shows it) |
| then `nahi` (on another order) | Cancelled; nothing saved |
| `Metro ko 50 carton Aquafina` | Refused: only 15 in stock |
| `INV-0002 dikhao` | Invoice detail, total **31,860** |
| `What are today's sales?` / `آج کی سیل کتنی ہوئی؟` | The same answer, in English / in Urdu |

Commands inside the chat:

| Command | What it does |
|---|---|
| `/debug on` | Shows every step: tools offered, each ERP call and result, the numbers check, previews. **Use this to verify accuracy.** |
| `/user booker` · `/user storekeeper` | Talk as someone with fewer permissions. A booker gets no sales reports; a storekeeper gets no sales at all. |
| `/limit 5000` then order | Above the limit, the "app" must approve: type `/approve`, then `ho gaya`. |
| `/off` · `/on` · `/quota out` · `/quota ok` | The assistant switched off, or out of messages. |
| `/lang en` · `/lang auto` | The company's reply language. |
| `/yes` · `/no` | Press the Yes / No button. |
| `/data` · `/reset` · `/help` · `/quit` | |

### 4. Measure accuracy

```sh
pnpm --filter @m-ai/assistant-core eval                     # 14 scenarios, every check printed
pnpm --filter @m-ai/assistant-core eval -- --repeat 3       # each 3 times: is the model consistent?
pnpm --filter @m-ai/assistant-core eval -- --only order --verbose
```

Each scenario checks:

- which ERP actions the model called, with which dates and ids;
- the figures in the reply, compared as numbers;
- the reply language;
- what was executed or left waiting;
- that every figure came from the ERP.

Run it whenever you change the model, the prompt or a language pack. Scenarios live in `evals/scenarios.json`; add your own.

---

## Models

| `M_AI_PROVIDER` | For | Needs |
|---|---|---|
| `anthropic` | Claude models | `M_AI_MODEL`, `M_AI_API_KEY` |
| `openai` | OpenAI models | `M_AI_MODEL`, `M_AI_API_KEY` |
| `openai-compatible` | Any provider with an OpenAI-compatible API, and local servers such as Ollama | `M_AI_MODEL`, `M_AI_BASE_URL` (e.g. `http://localhost:11434/v1`), and `M_AI_API_KEY` if the provider wants one |

- **Tool calling is required.** The model must support it well. Small local models are often weak at tool use and at Urdu, so run the evals before trusting one.
- **Prices are optional.** `M_AI_PRICE_IN / _CACHED / _OUT` are USD per million tokens. They give an exact cost per reply, which is reported to the app for billing.
- **In code:** `createAnthropicModel(...)` or `createOpenAICompatibleModel(...)`. Any other provider is a ~100-line `ModelClient`.

## Languages

- **The model understands and answers in any language.** The language packs cover only what must be deterministic:
  - the fixed sentences (the confirmation question, "cancelled", "waiting for approval"…);
  - the words that mean **yes** and **no**;
  - the words that tell languages apart.
- **Built in:** English, Urdu (script), Roman Urdu.
- **Add a language** with a JSON file — no code:

  ```sh
  M_AI_LANGUAGE_PACKS=./packages/assistant-core/examples/languages   # contains pa-Latn.json (Roman Punjabi)
  ```

  Copy `examples/languages/pa-Latn.json` and translate it. Every sentence is required, and a missing one is reported when the program starts.
- **Yes / No buttons.** Where the channel has buttons (WhatsApp, web chat), they make confirmation work in every language. `result.pending.options` gives the labels; send the press back as `choice: 'yes' | 'no'`.

## Using it with any software

Per message, pass an `ActionsClient` bound to that person:

```ts
import { createAssistant, configFromEnv, createHttpActionsClient } from '@m-ai/assistant-core';

const config = configFromEnv();                       // model, prices, languages from .env
const assistant = createAssistant({
  ...config,
  instructions: 'Customers are schools. "Fees" means receivables.',  // your software, in plain words
  synonyms: { fees: ['receivables'], parents: ['customers'] },       // your users' words → your action tags
});

const result = await assistant.handleTurn({
  conversationId: 'wa:03001234567', tenantId, userId,
  text: 'is mahine ki fees kitni baqi hai?',
  actions: createHttpActionsClient({ baseUrl: 'https://your-app/api', token: delegatedToken }),
});
// result.reply · result.status · result.pending?.options · result.executed · result.usage
```

The software only needs the three `/actions/*` routes from `@m-ai/action-contract`. It can be written in another language, as long as it follows the same JSON shapes.

## What it guarantees — and what it doesn't

| Guaranteed by code (not by the AI) | How |
|---|---|
| **Nothing changes without an explicit "yes" to an exact preview.** | Every change the model asks for is intercepted. The software previews it and the person sees the software's own summary. Only a short, clear yes (or the Yes button) executes it. "haan lekin 12 carton" is a new request, not a yes. |
| **No figure is invented or calculated.** | Every number in a reply is checked against what the software returned. A wrong figure makes the model rewrite the reply once. If it is still there, it is flagged and a caution line is added. |
| **Only what this person may do.** | The software lists and enforces this person's permissions and the company's policy, on every call. |
| **No stored credentials.** | Each turn uses the person's own short-lived token. |

**What is not guaranteed:** that the AI always understands the question. It can still pick the wrong report or date range. So it is told to say which dates it used, the evals measure this, and changes always stop for the person's confirmation.

**Does it learn by itself?** No. The model is not trained by conversations. It remembers:

- the recent conversation;
- notes the person explicitly asks it to keep ("yaad rakhna…").

It gets better when **we** improve it: the evals show what it gets wrong, and we fix the prompt, the synonyms or the software's action descriptions, or switch models. That is deliberate. Learning on its own from chats would be unpredictable, and could carry one company's data into another's answers.

## A turn, inside

1. **Context.** `core.context.get` gives the person, the company, today, the settings and the quota. If the assistant is off or out of quota, a fixed reply goes back and the model is not called.
2. **A waiting change:**
   - **yes** → execute it with its confirmation and idempotency key. The outcome:
     - stale → show the new preview;
     - expired → re-preview;
     - above the limit → wait for approval in the app;
     - otherwise → the model phrases the real result.
   - **no** → a fixed "cancelled".
   - **anything else** → the change is dropped and the message is a new request.
3. **Tools.** Every search, plus the actions whose tags and names match the words used (with synonyms), about 24 in all. Plumbing actions are never offered.
4. **The loop.** One tool call at a time: queries run; the first change stops the loop for a preview and confirmation.
5. **Finish.** The numbers guard checks the reply. History is saved, cut only at the person's own messages. Usage is reported, idempotent on the turn id.
