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
cp .env.example .env       # at the repo root (PowerShell: Copy-Item .env.example .env)
# open .env and fill in M_AI_API_KEY (see "Models" below)
pnpm --filter @m-ai/assistant-core models     # lists the exact model ids your key can use
# copy one id into M_AI_MODEL in .env
pnpm --filter @m-ai/assistant-core chat
```

**No credit anywhere?** `.env.example` starts on Z.ai's free model (`zai` / `glm-4.7-flash`). Create a key at [z.ai](https://z.ai/manage-apikey/apikey-list) and put it in `M_AI_API_KEY`. Free models are slower and allow few requests at a time, so run the evals before trusting one.

Before starting, `chat` and `eval` ask the provider whether the key works and the model id exists. If something is wrong, they stop and say exactly what — see [Troubleshooting](#troubleshooting).

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
| `/model` · `/model zai:glm-4.5-flash` · `/model default` | Show the model, switch to another one **now** (the conversation carries on), or go back to the one in `.env`. |
| `/models` · `/models zai` | The model ids a provider's key can use. |
| `/data` · `/reset` · `/help` · `/quit` | |

### 4. Measure accuracy

```sh
pnpm --filter @m-ai/assistant-core eval                     # 14 scenarios, every check printed
pnpm --filter @m-ai/assistant-core eval -- --repeat 3       # each 3 times: is the model consistent?
pnpm --filter @m-ai/assistant-core eval -- --only order --verbose
pnpm --filter @m-ai/assistant-core eval -- --model zai:glm-4.5-flash   # another model, without editing .env
```

The last line also gives the average and slowest reply time, and the cost when prices are set. To compare models, run the same evals with each `--model`.

Each scenario checks:

- which ERP actions the model called, with which dates and ids;
- the figures in the reply, compared as numbers;
- the reply language;
- what was executed or left waiting;
- that every figure came from the ERP.

Run it whenever you change the model, the prompt or a language pack. Scenarios live in `evals/scenarios.json`; add your own.

### 5. Against a real ERP

The scripts sign in as a test user, ask the ERP for a delegated token for M.Ai (`POST /auth/delegate`, client `m-ai`), and call its `/actions/*` with it, as the web chat will. Put the ERP's address and the test users' password in `.env` (`M_AI_ERP_URL`, `M_AI_ERP_PASSWORD`; see `.env.example`).

```sh
pnpm --filter @m-ai/assistant-core erp                      # check the door for owner, booker and officer
pnpm --filter @m-ai/assistant-core chat -- --erp            # chat as the owner
pnpm --filter @m-ai/assistant-core chat -- --erp --as booker
pnpm --filter @m-ai/assistant-core eval -- --erp            # the conversations in evals/live.json
pnpm --filter @m-ai/assistant-core erp:e2e                  # everything around the model, with a scripted model (no AI key)
```

**What the live evals do:**

- They first read a few real records (a customer who owes money, a product, an invoice number) and talk about those.
- Figures are checked against what the ERP answers for the same query.
- They post **one receipt of 100** and, if an approval limit is set, leave **one approval waiting**. Every other change is previewed and declined.

**In the chat:** settings, the approval limit and approvals are in the ERP itself (Accounts → Assistant; Approvals).

---

## Troubleshooting

| You see | Meaning | Fix |
|---|---|---|
| `This API key is not scoped to a workspace … anthropic-workspace-id header` | The Anthropic key is not tied to a workspace. | In the Anthropic Console, create an API key **inside a workspace** (Settings → API keys) and use that one. Or put the workspace id in `M_AI_ANTHROPIC_WORKSPACE_ID`. |
| `M_AI_MODEL "haiku" did not work … 404 model: haiku` | `haiku`, `sonnet`, `gpt` are nicknames, not ids. | Run `pnpm --filter @m-ai/assistant-core models`, then copy the exact id into `M_AI_MODEL`. |
| `401` / `invalid x-api-key` / `Incorrect API key` | Wrong, revoked, or another provider's key. | Check `M_AI_API_KEY` and `M_AI_PROVIDER`. |
| `credit` / `billing` | The provider account has no balance. | Add billing in the provider's console. |
| The reply says "can't reach the system" | The model or the app failed during a turn. | The red line under the reply (`model error: …`) says which, and why. |
| `400` from an OpenAI-compatible server about `parallel_tool_calls` or `max_tokens` | That server doesn't accept the field. | Set `M_AI_PARALLEL_TOOL_CALLS_PARAM=false`, or `M_AI_MAX_COMPLETION_TOKENS=true`. |
| `429` · `High concurrency` · `rate limit` | The provider is limiting requests. Free models allow few at a time. | Wait a minute, or set `M_AI_FALLBACK_MODELS` so another model answers meanwhile. Evals mark these scenarios **NOT RUN**, since they say nothing about accuracy, and then wait 60 s (`--pause N`). On Groq's free plan a full eval takes about 20–30 minutes because of its per-minute token limit. |
| `Insufficient balance` · `no resource package` · `recharge` | That model needs credit, even if the key lists it. | Use a free model. `models` shows Z.ai's free ones. |
| `did not answer within 60 s` | A slow free or local model. | Raise `M_AI_TIMEOUT_SECONDS`. |
| Z.ai `Unknown Model` | Wrong model id. | `pnpm --filter @m-ai/assistant-core models zai` shows the ids from Z.ai's docs. |
| `… is required for provider zai` when switching | That provider's key isn't in `.env`. | Add `ZAI_API_KEY=` (or `ANTHROPIC_API_KEY=`, `OPENAI_API_KEY=`). |

**If a key is ever exposed** — pasted in a chat, committed, or shared — revoke it in the provider's console at once and create a new one. `.env` is git-ignored; run `git status` before pushing to be sure it isn't staged.

## Models

| `M_AI_PROVIDER` | For | Needs |
|---|---|---|
| `anthropic` | Claude models | `M_AI_MODEL`, `M_AI_API_KEY` |
| `openai` | OpenAI models | `M_AI_MODEL`, `M_AI_API_KEY` |
| `zai` | Z.ai GLM models. `glm-4.7-flash` and `glm-4.5-flash` are free. | `M_AI_MODEL`, `M_AI_API_KEY`. Optional `M_AI_THINKING=on` (slower). |
| `groq` | Groq. Large open models, very fast, with a free plan. | `M_AI_MODEL`, `M_AI_API_KEY` (or `GROQ_API_KEY`) |
| `gemini` | Google Gemini. Free tier for Flash models. | `M_AI_MODEL`, `M_AI_API_KEY` (or `GEMINI_API_KEY`) |
| `openrouter` | Many providers behind one key. | `M_AI_MODEL`, `M_AI_API_KEY` (or `OPENROUTER_API_KEY`) |
| `ollama` | A model on this computer, through [Ollama](https://ollama.com). Free and private. | `M_AI_MODEL` only, e.g. `qwen3.5:4b` |
| `openai-compatible` | Any provider with an OpenAI-compatible API, and local servers such as Ollama | `M_AI_MODEL`, `M_AI_BASE_URL` (e.g. `http://localhost:11434/v1`), and `M_AI_API_KEY` if the provider wants one |

- **Tool calling is required.** The model must support it well. Small local models are often weak at tool use and at Urdu, so run the evals before trusting one.
- **Prices are optional.** `M_AI_PRICE_IN / _CACHED / _OUT` are USD per million tokens. They give an exact cost per reply, which is reported to the app for billing.
- **In code:** `createModel('zai:glm-4.7-flash')`, or `createAnthropicModel(...)` / `createOpenAICompatibleModel(...)`. Any other provider is a ~100-line `ModelClient`.

### Free and local models

| Option | Cost | Good for | Watch out |
|---|---|---|---|
| `groq`: `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b` | Free plan | Development and evals. Large models, fast. **`gpt-oss-120b` passed all 14 scenarios** (5 Oct 2026). | Daily limits (about 1,000 requests and 200,000 tokens a day for these). Evals wait out the per-minute limit. |
| `gemini`: `gemini-3.5-flash` … | Free tier | Development and evals. Good at Urdu. | On the free tier Google may use the content to improve its products. Use the mock ERP, not real customer data. |
| `zai`: `glm-4.7-flash`, `glm-4.5-flash` | Free | Trying things. | Often busy (429). It was also weak on dates in the first evals. |
| `ollama` (on this computer) | Free, private | Offline use; data never leaves the computer. | Only as good and as fast as the computer allows. See below. |

**A local model, by the computer's memory (RAM).** These are Ollama's Qwen 3.5 builds. The model, its working memory and Windows must all fit in RAM.

| RAM | Model | What to expect |
|---|---|---|
| 4 GB | `qwen3.5:0.8b` (1 GB) | It runs, but it is too weak for this work: wrong reports, weak Urdu. |
| 8 GB | `qwen3.5:4b` (3.4 GB) | Usable for testing. On a CPU, a reply can take a minute or more. |
| 16 GB | `qwen3.5:9b` (6.6 GB) | The smallest size likely to come close. |
| 16 GB at the very least (24–32 GB is comfortable) | `gpt-oss:20b` (14 GB) | Built for tool use. It always reasons a little, so M.Ai asks for the "low" level. Slow on a CPU. |

There is no model that is free, small and accurate at once. Measure: `eval -- --model ollama:qwen3.5:4b`.

Setting up Ollama:

```powershell
ollama pull qwen3.5:4b
# .env:  M_AI_PROVIDER=ollama   M_AI_MODEL=qwen3.5:4b   (no key)
pnpm --filter @m-ai/assistant-core eval -- --model ollama:qwen3.5:4b
```

M.Ai talks to Ollama through Ollama's own API, not its OpenAI-compatible one, for two reasons:

- **Thinking is off by default.** On a CPU, a model's thinking can take minutes and use up the whole answer budget.
  - `M_AI_THINKING=on` turns it back on.
  - Models with levels take `low`, `medium` or `high`.
  - gpt-oss cannot stop reasoning, so "off" means `low` for it. The same applies on Groq, through `reasoning_effort`.
- **The context length is set per request** (`M_AI_NUM_CTX`, default 8192), so the prompt and tools are never cut.

### Your own machine first, then the cloud

List the models in order of preference. The first one that can answer does:

```sh
M_AI_PROVIDER=ollama
M_AI_MODEL=gpt-oss:120b
M_AI_BASE_URL=http://192.168.1.50:11434    # your machine
M_AI_MAX_CONCURRENT=1                       # one at a time; more spill over to the cloud
M_AI_FALLBACK_MODELS=groq:openai/gpt-oss-120b,groq:openai/gpt-oss-20b,zai:glm-4.7-flash
```

For each reply:

- a model that is **ready** answers, in the order given;
- a model that is **full** (`MAX_CONCURRENT` reached) is passed over, so nobody waits behind another shop's question;
- a model that **just failed** is tried last for a minute;
- a model that is **down** is skipped at once. Ollama is checked with one quick request, re-checked every 30 s.

The model that answered is in `result.usage.model`, and in the reply's last line when the footer is on.

### What the customer pays

```sh
M_AI_CURRENCY=PKR
M_AI_USD_RATE=276.35     # keep it current
M_AI_MARGIN=20%
M_AI_USAGE_FOOTER=on     # off | on | tokens
M_AI_PRICES=groq:openai/gpt-oss-120b=0.15/0.15/0.6; ollama:gpt-oss:120b=0.10/0.10/0.40
```

- **Each reply is charged** at cost (from the model's price) × the USD rate × (1 + margin), rounded up to the paisa. The arithmetic is exact, with no floating point.
- **Give your own machine a price too** (its power and hardware). Then every reply is charged the same way, whichever model answered, and a reply from your machine earns more.
- **Pass the customer's balance** with each message (`balance: '2000'`). You get back `result.balanceAfter` and `result.usage.charge`.
- **At zero balance**, the reply is a fixed "balance has run out", and no model is called.

With the footer on, a reply ends like this:

```
Aaj (2 Oct) ki sale 2,124 hai.
— gpt-oss-120b · is jawab ke PKR 0.31 · baqi PKR 1,999.69
```

In the terminal chat, `/balance 2000` simulates a customer balance.

### Changing the model at runtime

Keys for several providers can sit in `.env` together (`ZAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `M_AI_OPENAI_COMPATIBLE_BASE_URL`). A model is named `provider:model`, e.g. `zai:glm-4.5-flash` or `anthropic:claude-haiku-4-5`. Then:

| Where | How |
|---|---|
| Terminal chat | `/model zai:glm-4.5-flash`. It is checked with the provider first, and the conversation carries on. |
| Evals | `eval -- --model zai:glm-4.5-flash` |
| Automatically | `M_AI_FALLBACK_MODELS=zai:glm-4.5-flash,anthropic:claude-haiku-4-5`. When the main model fails (no credit, busy, down), the next one answers. A failed model is skipped for a minute. |
| In code, per message | `assistant.handleTurn({ ..., model: createModel('zai:glm-4.5-flash').model })`. A company's own choice of model would be passed like this. |

**Cost.** Each model call is costed at the price of the model that actually answered. Give prices with `M_AI_PRICE_*` (the main model) and `M_AI_PRICES=zai:glm-5.3-flash=0.15/0.03/0.5; …` (any model). A model without a price costs `0.0000`. It is never costed at another model's price.

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

Per message, pass an `ActionsClient` bound to that person (and, if you like, the model for this message):

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
  // model: createModel('zai:glm-4.5-flash').model,   // optional: another model for this message
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
3. **Tools.** Every search, plus the actions whose tags and names match the words used (with synonyms), about 24 in all.
   - Actions tagged `daily` are always within reach.
   - Plumbing actions and `bulk` imports are never offered (`hiddenTags`).
   - The definitions stay under `maxToolChars` (24000 by default), because they are sent with every model call.
   - A document (a PDF; intent tag `render`, no confirmation required by the app) runs straight away, and `TurnResult.documents` gives the channel its id to attach. Every other change is previewed and confirmed.
4. **The loop.** One tool call at a time: queries run; the first change stops the loop for a preview and confirmation.
5. **Finish.** The numbers guard checks the reply. History is saved, cut only at the person's own messages. Usage is reported, idempotent on the turn id.
