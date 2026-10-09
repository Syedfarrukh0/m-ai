# Changelog

## 0.4.10 — 2026-10-09

**The owner's run 6** (`gpt-oss-120b`, real ERP):

- **The question:** "Metro Cash & Carry ka is mahine ka hisaab dikhao" (Metro's account for this month).
- **The answer:** this month's **company-wide** sales. The figures were correct, but they answered a different question.
- **Why:** `receivables.statement.get` was offered (8th of 24), but the model picked `reports.sales.summary`.
- **New prompt rule 13:** when the person names a particular customer, supplier, product or document, answer about that one. Find it with a search tool, and use a tool that takes its id. A customer's "hisaab" or "khata" means their statement of account. Never answer with a company-wide total instead.


## 0.4.9 — 2026-10-09

- **`loginErp`, `erpSettingsFromEnv`, `ErpError`, `decodeJwt` and `userEmail` are now part of the package**, moved from the scripts. The new `@m-ai/service` uses them for its pilot sign-in.
- **The start-up check names a daily limit for what it is.** It says "this model's DAILY limit is used up; the provider says try again in N min", instead of "wait a minute".


## 0.4.8 — 2026-10-09

**The owner's fourth run, on the E1 DEMO:**

- `erp:e2e`: **20 of 20 scenarios, 86 of 86 checks.**
- `eval -- --erp` with **`openai/gpt-oss-120b`**: **13 of 13 scenarios, 68 of 68 checks (100%).**
  - 2 conversations were refused by Groq's free plan as **"Request too large … Limit 8000, Requested 9058"**.
  - 1 was stopped by the daily limit.

### Requests fitted to the model
- **New `fit.ts`:** `estimateTokens`, `fitRequest` and `withInputBudget`.
- **How a request too large for a model is made smaller:**
  - older tool results are shortened first, and the latest message stays whole;
  - then the least likely tools are left out, from the end of the best-first list;
  - tools the conversation already used, the remember tool, and at least 4 others always stay.
- **Where the limit comes from:**
  - **Set:** `M_AI_<PROVIDER>_MAX_INPUT_TOKENS` (e.g. `M_AI_GROQ_MAX_INPUT_TOKENS=5500`).
  - **Local:** Ollama's window (`num_ctx`), less room for the answer. Ollama cuts an over-long prompt from the start, which silently dropped the system prompt.
  - **Learnt:** a provider's "request too large" (Groq, OpenAI, Anthropic wording) is read with its numbers. The request is sent again at once, smaller, and later requests are fitted before sending.
- **`ModelError.tooLarge`** carries `{ limit, requested }`, and `tooLargeInfo()` reads them. A too-large error is not waited for.
- **Every model built from settings is wrapped** (`createModel`, `configFromEnv`).
- **`.env.example`:** for gpt-oss on your own machine, `M_AI_OLLAMA_NUM_CTX=16384` gives the assistant all its tools.


## 0.4.7 — 2026-10-08

**The owner's third run, on the ERP's E1 DEMO:**

- `erp:e2e`: **20 of 20 scenarios, 86 of 86 checks**, including the statement as data and the money in hand.
- `eval -- --erp` with Groq **`openai/gpt-oss-20b`**: **13 of 14 scenarios, 72 of 73 checks**, then the model's free daily limit (200,000 tokens) stopped it.

### The one failed check was the test's, not the model's
- **"Metro Cash & Carry ka kitna udhaar hai?"** The model read the outstanding report directly and found Metro in it, so it never searched for the customer.
- **The answer was right:** PKR 2,008,519.16, checked against the ERP.
- `one-customer-owes` now checks only the figure.

### Carrying on after a daily limit
- **New `eval --from <scenario>`:** it starts at that scenario. When a daily limit stops a run, the stop message names the scenario to carry on from.
- **Why runs get stopped:** a full run of 17 conversations takes roughly 200,000 tokens, which is a day's free allowance for one model. To finish in a day, split the run across `openai/gpt-oss-120b` and `openai/gpt-oss-20b` (each has its own allowance), or use a paid plan.


## 0.4.6 — 2026-10-08

**The owner's second run, on the ERP's fixed DEMO:**

- `erp:e2e`: **18 of 18 scenarios, 80 of 80 checks.**
- `eval -- --erp`: 7 of 8 scenarios and 36 of 38 checks before Groq's free plan ran out of tokens for the day.

### Found on that run, fixed here
- **"INV-2026-001424 dikhao" made a PDF instead of showing the invoice.** The renders take the number since the ERP's fix, so the model reached for one.
  - **A PDF is now offered only when one is asked for:** "pdf", "print", "file", "copy", "send", "bhejo", "chhap".
  - The render tools say so in their description, and so does prompt rule 12: "dikhao", "show" and "batao" mean read the document with a query.
- **A provider's DAILY limit ("tokens per day") is no longer waited out in the turn.** It is not retryable, and it carries the provider's own "try again in …".
  - The router sets that model aside for that long, not just 60 s, and uses the next one.
  - The evals stop at once and say when to try again.
- **Long provider messages** are shown up to 320 characters, so you can see which limit was hit.

### The ERP's E1 batch (catalog `8b6766a6…`, 60 actions)
- **"bank", "cash", "paisa", "raqam", "JazzCash", "Easypaisa"** offer the cash and bank accounts (`accounts.cash-account.list`).
- **"hisaab", "khata", "statement"** offer the statement as data (`receivables.statement.get`). The PDF comes only when asked for.
- **New live evals:**
  - a customer's account as data;
  - money in the bank;
  - "dikhao" must not make a PDF.
- **New `erp:e2e` scenarios** for the same. They are skipped on an ERP from before E1.


## 0.4.5 — 2026-10-08

**The owner's first real-model run on the real ERP** (Groq `openai/gpt-oss-120b`, his DEMO): **13 of 13 scenarios, 69 of 69 checks.** Two were not run because our script found no product on his DEMO.

### Found on that run, fixed here
- **`erp:e2e` crashed when this month had no sales by product.** It and the live evals now share one way of finding records (`erp-discover.ts`):
  - this month's best seller;
  - else the first line of the latest invoice;
  - else the product list.

  A scenario whose records can't be found is **skipped** with a reason, and the run continues.
- **The eval summary called those "provider errors".** They now show as "skipped (records not found)", and they don't fail the run.
- **The eval now counts model calls that waited out a rate limit.** A free plan's per-minute token limit was most of the 60-second average reply time.

### The ERP's latest catalog (hash `a6c672f3…`)
- The renders take the document's number: `documents.invoice.render { invoiceNo }` and `documents.receipt.render { receiptNo }`. A number in the text now also points to receipts (`RC-2026-…`) and to credit and debit notes (`CN-…`, `DN-…`).
- `erp:e2e` renders an invoice by its number. On an older ERP it falls back to the id.


## 0.4.4 — 2026-10-08

First run against the real ERP. The ERP's own code ran in a sandbox, with its DEMO company and a year of data. **The model's part was scripted**, so this checked everything around the model: 17 of 18 scenarios passed, and 78 of 80 checks. The two that failed are the ERP's: `masters.product.list` and `.get` answer `INTERNAL`.

### Found on the run, fixed here
- **Roman Urdu around English names:** "Metro Cash & Carry se 100 rupay cash wasool hue" was read as English, so the preview came in English.
  - New Roman Urdu markers: wasool, hue/hua/hui, rupay, diya, mila, jama, band, badal, bhej…
- **"band kar do" (switch it off) now offers the update action.**

### PDFs reach the chat
- **New: the HTTP client's `document(documentId)`.** It does `GET /documents/{id}` with the same delegated token, as the ERP now allows.
  - On success it returns the bytes, the content type and the file name.
  - On a refusal it returns the ERP's REST error: status, code and message.
- **The terminal chat (`--erp`)** saves each PDF in `m-ai-files/`, which git ignores.

### New script: `pnpm erp:e2e`
- End to end through the real door, with a scripted model. It needs no AI key, and it gives the same result every time.
- **It checks:**
  - the tools offered for everyday messages (owner and booker);
  - every master list and get;
  - real queries and the numbers guard on real figures;
  - previews with "haan" / "nahi";
  - step-up, approved and declined in the ERP's Approvals;
  - PDFs, rendered and fetched;
  - a booker's permissions;
  - the assistant switched off;
  - the door's rules;
  - usage records.
- **Changes on the company:** a receipt of 100, one receipt above the limit (approved), and one more (declined). `--verbose` prints every conversation.

### Live evals
- The product to talk about is now the month's best seller, from the sales summary. The product list fails on the ERP for now.


## 0.4.3 — 2026-10-08

Ready to run through the ERP's real door. The ERP's cross-checked catalog (56 actions, hash `afb6b51c…`) replaces the Phase D one in the tests. All 15 everyday cases still get every action they need: on average 23 tools in about 17,600 characters.

### Documents without a yes/no
- A command the app marks `requiresConfirmation: false` with the intent tag `render` runs straight away, with its own Idempotency-Key. Examples: an invoice or statement PDF.
- It shows in `executed`, so "PDF tayyar hai" is not taken as a false "done".
- **New `TurnResult.documents`:** each file made in the turn, as `{ action, documentId, fileName?, contentType? }`, for the channel to attach.
- Prompt rule 12: say the document is ready, and never write its id or a link.
- Every other change is still previewed and confirmed.

### Hidden
- Every `assistant.*` action is the assistant's own plumbing. The ERP's new `assistant.terms.get` is never offered to the model.

### The HTTP client
- A list wrapped in an `ActionResult` is accepted.
- Errors carry the HTTP status and the start of the body.

### Scripts for a real ERP
- **`erp-live.ts`:**
  - signs in (`/auth/login`) and renews the session (`/auth/refresh`);
  - gets a delegated token per conversation (`/auth/delegate`, client `m-ai`), kept until 30 s before it expires;
  - errors name the step and the HTTP status. A company without ASSISTANT gets the ERP's fix (`pnpm demo:assistant`).
- **`pnpm erp`:** checks the door for each test user. It shows the token's claims, how many actions the person has, the company, whether the assistant is on, the approval limit and the terms' standing. It also warns if the ERP's catalog hash differs from ours.
- **`chat -- --erp [url] [--as booker]`:** the terminal chat through the real door. `/user` signs in as another person.
- **`eval -- --erp`:** `evals/live.json`, 15 conversations.
  - They first read real records from the ERP: a customer who owes, a product, an invoice number, a principal and the approval limit.
  - New checks: `figuresFrom` and `textFrom` (read back from the ERP after the turn) and `documents`.
  - A scenario whose records can't be found is NOT RUN.
  - They post one receipt of 100 and may leave one approval waiting. Every other change is declined.

### Mock ERP
- `documents.invoice.render` returns `documentId`, `fileName` and `contentType`, like the ERP's.


## 0.4.2 — 2026-10-08

Ready for the ERP's real catalog (Phase D: 55 actions, contract 0.1.3). A test now runs selection on that catalog file, and checks that its hash matches the one the ERP sent.

### Picking tools
- **The everyday words cover the ERP's names:**
  - quantities ("carton", "peti", "dabba", "ctn", "pcs") mean an order;
  - "wasool", "jama", "mila" mean a receipt;
  - "udhaar", "baqaya", "wasooli" mean what is owed;
  - "badal do", "change" mean an update; "phone", "number" mean a customer;
  - principal and brand mean company.
- **An action tagged `daily` is always within reach** (an invoice, a receipt).
- **A document number in the text** ("INV-0002", "RCPT 17") brings that document's actions.
- **Bulk imports are never offered:** they need a file, not a chat. `hiddenTags` changes this; the default is `['bulk']`.
- **A size budget:** `maxToolChars`, default 24000 characters (about 7K tokens). Tool definitions are sent with every model call, so the lowest-scored tools are left out once the budget is reached.
  - On the ERP catalog, all 15 everyday cases still get every action they need.
  - Average: 21–23 tools, about 17K characters.

### A licence that ends mid-token
- If `core.context.get` answers `MODULE_NOT_LICENSED`, the person gets a plain answer in their language (new optional phrase `notLicensed`).
- No model is called and nothing is recorded.

### Mock ERP
- **The client id is `m-ai`**, as the ERP issues it.
- **`assistant.usage.record` behaves like the ERP's:** the same turn again answers `{ recorded: false }`.

## 0.4.1 — 2026-10-07

- **`assistant.usage.record` now sends the wallet charge** (action-contract 0.1.2). When a turn has `billing`, the record includes `charge: { amount, currency }`, plus `balanceAfter` when a balance was given. Without a wallet nothing extra is sent. A 0.1.1 app drops the new fields.
- **`balanceAfter` is worked out before the record is sent**, so the app stores the same balance the person sees.


## 0.4.0 — 2026-10-06

This release follows the owner's design for running models on his own machine and charging customers.

### Your own machine first, then the cloud
`withFallback` is now a router. Models are listed in order of preference:

- **ready** models answer first, in order;
- **full** ones next: `maxConcurrent` per model, `M_AI_<PROVIDER>_MAX_CONCURRENT`. A busy local machine spills over to the cloud instead of queueing;
- then models that **just failed** (a 60 s cooldown);
- **down** ones last. A down model is skipped without a call.

**Health checks:**
- `ModelClient.health()` is a new, optional method. Ollama implements it as one `/api/tags` request (at most 1.5 s) that checks the machine is up and has the model.
- The router trusts a result for 30 s (`healthTtlMs`).
- New `onSkip` event.

**Terminal:** if the main model is down but a fallback works, start-up says so gently (a machine that is off is normal in this setup). The chat shows each skip once per turn.

### What the customer pays
- **New `billing` option:**
  - set from `M_AI_CURRENCY`, `M_AI_USD_RATE` and `M_AI_MARGIN` (`20%` or `0.20`);
  - each turn gets `usage.charge`: cost × rate × (1 + margin), in the currency, rounded up to 2 decimals. The arithmetic is exact (`chargeFor`, `toCents`, `formatCents`, `groupThousands`).
- **`TurnInput.balance`** gives `TurnResult.balanceAfter`. At zero or below, the reply is the fixed `noBalance` sentence, and no model is called.
- **`usageFooter`** (`M_AI_USAGE_FOOTER`: off | on | tokens) adds a last line: the model, this reply's charge, and the balance left, in the reply's language. It is added after every check and is never stored in the history.
- New optional phrases: `noBalance`, `usageCharge`, `usageBalance`, `usageTokens`. Built-in text exists for English, Urdu and Roman Urdu; English is used where a pack has none.
- Terminal chat: `/balance 2000`.


## 0.3.5 — 2026-10-05

This release follows the first full runs on Groq's free plan.

- `openai/gpt-oss-120b` passed **14/14 scenarios** and 83/83 checks. Its average reply took 35.7 s, mostly time spent waiting out Groq's per-minute token limit; a reply that hit no limit took about 1 s.
- `openai/gpt-oss-20b` passed its first 3 scenarios. Then Groq rejected one of its tool calls with a 400 ("Tool call validation failed … did not match schema"), and the eval stopped.

### A rejected tool call is a model slip, not a refusal
- When a provider rejects the model's own tool call (Groq `tool_use_failed`, "Tool call validation failed", "did not match schema"), the call is now **retried**. Asking again usually works.
- Evals stop early only when nothing can work: a refused key (401/403), no credit (402 or a credit message), or an unknown model (404). Other one-off rejections mark the scenario NOT RUN, and the run carries on.

### Schemas as models see them (`modelSchema`)
- A `pattern` is dropped where a `format` already says the same thing, such as a uuid's long regex. The ±2^53 bounds that plain integers get are dropped too.
- The app still validates every input in full. A mismatch the app reports comes back as a tool result, which the model can read and fix. A mismatch a provider finds instead rejects the whole reply.


## 0.3.4 — 2026-10-05

This fixes a bug the owner hit in the first Groq runs (`gpt-oss-20b`, `gpt-oss-120b`). Each passed its first scenario in under 2 seconds. Then the eval **stopped with "no credit"**, although the limit was only per minute.

- **The cause:** Groq's rate-limit message ends with ".../settings/billing". The word "billing" made it look like a "no credit" refusal, so it wasn't retried.
- **The fix:** rate-limit wording is checked **first** ("rate limit", "try again in", "retry in", "per minute", TPM/RPM…), and "billing" alone no longer means "no credit". This also fixes Gemini's "Quota exceeded … retry in 30s", which is a rate limit. `isRateLimitMessage` and `isNoCreditMessage` are exported.
- **Groq output budget:** the minimum is now 2,048 tokens (was 4,096). gpt-oss at "low" needs less, and Groq's free plan counts requested tokens against its 8,000-a-minute limit.
- **Evals:** after a rate-limited scenario, the run waits 60 s (set with `--pause N`) so the provider's per-minute window can reset.


## 0.3.3 — 2026-10-05

These fixes came from the second local run: `qwen3.5:4b` with thinking off.
- **Result:** 7 of 14 scenarios passed, and 73.5% of checks.
- **Speed:** an average of 98 s per reply, half of the first run's; the slowest was 199 s.
- **New failure:** with thinking off, the model often described what it would do ("pehle main ID dhundhta hoon…") or asked needless questions, instead of calling a tool.
- **Safety finding:** after "nahi rehne do", with nothing pending, it replied "✅ Metro ko 2 carton 7Up bill kiya gaya hai". Nothing was posted.

### A change claimed when none was made
- Language packs have **`doneClaims`**: phrases that say a change was made ("order laga diya", "bill kiya gaya", "has been posted", "آرڈر لگا دیا"). A ✅ counts too.
- When a model reply makes such a claim and no change was executed in that turn:
  1. The model is asked once to fix it. The correction says to call the action tool, so the change can be previewed and confirmed.
  2. If the claim is still there, the fixed note **`notSaved`** is added: "abhi kuch bhi save ya tabdeel nahi hua".
- **Done claims stay allowed** after a real, executed change.
- A `done_check` event appears in `/debug`.
- `notSaved` is optional in custom packs; the English text is used when it is missing.

### Two new prompt rules
- **Act, don't narrate.** When a tool can do it, call it straight away. Look up ids, codes and prices with the search tools instead of asking the person.
- **Use defaults instead of asking.** Ask the person only when the tools cannot settle it.

### Thinking levels
- `M_AI_THINKING` takes `off | on | low | medium | high`. Per provider, use `M_AI_<PROVIDER>_THINKING`.
- **Ollama:** `think` gets the level. gpt-oss cannot stop reasoning, so "off" sends `low`.
- **Groq:** `reasoning_effort` is set for gpt-oss (`low` when off) and for Qwen (`none` when off).


## 0.3.2 — 2026-10-05

These fixes came from the first local run: Ollama `qwen3.5:4b` on the owner's PC.
That run passed 6 of 14 scenarios and 88% of checks, with an average reply time of 191 s (the slowest 574 s).

### Ollama through its own API
- Most failures were "couldn't finish that" (no answer). The model thought for its whole 4,096-token budget on the CPU and never answered. The OpenAI-compatible endpoint has no reliable way to switch thinking off.
- The `ollama` provider now uses Ollama's own `/api/chat` (`createOllamaModel`):
  - **thinking off** (`think: false`), unless `M_AI_THINKING=on`;
  - the **context length set per request** (`M_AI_NUM_CTX`, default 8192);
  - the model kept loaded for 30 minutes;
  - tool results named as Ollama expects.
- A model with no thinking switch is asked again without the field.
- "Ollama is not running" and "model not found → `ollama pull …`" are said plainly.
- An old `…:11434/v1` address still works.

### Also
- A model that returns nothing usable is asked once more before the "couldn't finish" reply. The new `empty` event shows this in `/debug`.
- The numbers guard's correction tells the model to leave unverified figures out entirely, rather than guess codes, rates or totals. In that run, `qwen3.5:4b` invented invoice numbers and an "18%" tax rate; the guard caught both.


## 0.3.1 — 2026-10-05

These fixes came from the first evals on Z.ai.

### Dates worked out in code
- The model often got the date range wrong:
  - `glm-4.7-flash` read "aaj" (today) as 1–2 Oct;
  - it read "is mahine" (this month) as September.
- The prompt now lists the ranges, already worked out:
  - today, yesterday, this week, last week, the last 7 days;
  - this month, last month, the last 30 days;
  - this year, last year, this fiscal year.

  The model only copies them (`dateRanges()`).
- A reply may state the dates it used without the numbers guard objecting. Dates from the ranges and from the tool's input count as sources.

### "No credit" is not "busy"
- Z.ai answers "Insufficient balance … recharge" with a **429**.
  - It is no longer retried as a rate limit.
  - Pre-flight reports it as a credit problem and suggests the free models.
- Pre-flight always makes one tiny test call. A model can be in the key's list and still be refused.
- `Retry-After` is honoured (`ModelError.retryAfterMs`). The assistant waits as long as the provider asks, up to a minute.
- `TurnResult.error` now has `status` and `retryable`.
- Timeouts say so: "did not answer within 60 s". `M_AI_TIMEOUT_SECONDS` sets the limit (Z.ai 120 s, Ollama 300 s by default).

### Evals
- While a scenario runs, its name is shown.
- A scenario whose model call failed at the provider (busy, no credit) is **NOT RUN**, not FAIL, and is left out of the accuracy figure.
- The run stops at once when waiting won't help (no credit, wrong key or model), or after 3 such scenarios in a row.

### Free and local model presets
- New providers:
  - `groq` and `gemini`, which have free plans;
  - `openrouter`;
  - `ollama`, for a model on this computer, with no key and a long timeout.
- Each new provider has its own key variable: `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`.
- Models that reason before answering get room for it: at least 4,096 output tokens.
- `models zai` shows the free models Z.ai doesn't list. Gemini's `models/` prefix is removed from its ids.


## 0.3.0 — 2026-10-05

### Z.ai
- New provider `zai` (Z.ai GLM, OpenAI format, `https://api.z.ai/api/paas/v4`). `glm-4.7-flash` and `glm-4.5-flash` are free.
- Thinking is off by default for speed; `M_AI_THINKING=on` switches it on and leaves room for the reply.
- `parallel_tool_calls` is not sent: Z.ai does not document it.
- When Z.ai can't list its models, the `models` command and the pre-flight use the ids from its docs.

### Changing the model at runtime
- **`provider:model` specs** and `createModel(spec)`. Keys for several providers can sit in one `.env`. `M_AI_API_KEY` belongs to `M_AI_PROVIDER`; the others use `ZAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `M_AI_<PROVIDER>_<SETTING>`.
- **`TurnInput.model`:** any message can use another model. The conversation carries on, because the history is provider-neutral. Tool ids from another provider are made acceptable to Anthropic.
- **Fallback models:** `M_AI_FALLBACK_MODELS` and `withFallback()`. The first model that answers wins. A failed model is skipped for a minute.
- **Terminal:**
  - chat: `/model <spec>` (checked first) · `/model default` · `/models [provider]`;
  - evals: `--model <spec>`. They also print the average and slowest reply time and the total cost;
  - `models <provider>`.

### Cost per model
- Clients attach their price to each response (`ModelResponse.pricing`). Each call is costed at the price of the model that answered, summed exactly and rounded once.
- New: `M_AI_PRICES` for any model; `costUnits`, `formatCost`.
- **Breaking (private package):** `M_AI_Config.pricing` is now `config.primary.pricing`. `config.model` includes the fallbacks; `config.primary` / `config.fallbacks` are the single models.

### Also
- Thinking text (`<think>…</think>`) is removed from replies, and `reasoning_content` is ignored. This matters for Qwen, DeepSeek and GLM models on other servers.
- Pre-flight:
  - checks the main model, then the fallbacks. If the main model fails but a fallback works, it warns and continues;
  - a busy provider (429) is a note, not a failure;
  - hints follow the HTTP status, so they work in any language.


## 0.2.1 — 2026-10-05

These fixes came from the first run with a real key.

### Pre-flight check
- Before `chat` and `eval` start, they check the configuration with the provider:
  - the model list (free);
  - one tiny test call, if the id is not listed (it may be an alias).
- On failure they stop and print the provider's own message, a hint, and the model ids close to the one configured.
- Skip it with `M_AI_SKIP_PREFLIGHT=true`.

### Model setup
- **`models` command:** lists the exact model ids the key can use.
- **Workspace header:** `M_AI_ANTHROPIC_WORKSPACE_ID`, sent as `anthropic-workspace-id`, for Anthropic keys that are not scoped to a workspace.
- **Model listing:** `listAnthropicModels`, `listOpenAICompatibleModels`, `config.listModels()`, `preflight()`.

### Clearer errors
- Provider errors carry the provider's message (`providerMessage`).
- `TurnResult.error` says why a turn was `unavailable` (`model` or `app`). The terminal chat prints it in red.

### Evals
- A scenario no longer passes when the assistant could not work at all. Every turn checks "assistant was available".

## 0.2.0 — 2026-10-03

### Works with any software
- **App-neutral prompt.** No trade wording.
- **`instructions` option.** The app's own guidance for the model.
- **`synonyms` / `replaceSynonyms` options.** The app's own words mapped to its tags.

### Any model
- `createOpenAICompatibleModel` — for OpenAI, OpenAI-compatible providers and local servers (Ollama, vLLM). It maps tool results to `tool` messages, handles bad JSON arguments and reads cached tokens.
- Model calls retry retryable errors (rate limit, overload, network), with backoff.
- A hard failure gives an "unavailable" reply and keeps the conversation valid.

### Any language
- **Language packs.** Fixed sentences, yes/no words and detection words live in JSON-checkable packs.
- **Built in:** English, Urdu, Roman Urdu. Add more with `languages` or `M_AI_LANGUAGE_PACKS`. An example Roman Punjabi pack is in `examples/languages`.
- **Detection is generic:** by script first, then by marker words.
- **Yes/no comes from every pack.** A word that means yes in one pack and no in another counts as neither.
- **Buttons.** `TurnInput.choice` and `TurnResult.pending.options`.

### Configuration
- `configFromEnv`, `loadEnvFile`, `loadLanguagePacks`, `ConfigError`, which lists every problem at once.
- `.env.example` at the repo root.

### Safety
- Only the first tool call of a model message is kept: one step at a time, always.

### Observability
- The `onEvent` hook reports the language, tools offered, model calls, tool calls and results, number checks, previews, executes and notes.

### Terminal
- `chat`:
  - providers come from `.env`;
  - `/debug` shows every step;
  - `/user`, `/limit`, `/approve`, `/lang`, `/off`, `/on`, `/quota`, `/yes`, `/no`, `/data`, `/reset`;
  - piped input is buffered.
- `demo`: offline, no key.
- `eval`: 14 accuracy scenarios with `--repeat`, `--only`, `--verbose`; exits 1 on any failed check.

## 0.1.0 — 2026-10-02

First version, built against `@m-ai/action-contract` 0.1.1 and the mock ERP.

### The orchestrator
- `createAssistant().handleTurn()` runs a turn in this order: context and quota → a waiting change → tool selection → a one-tool-at-a-time loop → command interception with preview → confirm → execute.
- It handles stale and expired confirmations, approval in the app (step-up), and cancelling.

### Language
- Deterministic yes/no parsing in English, Urdu and Roman Urdu.
- Language detection.
- Every fixed sentence in three languages.

### Safety and accounting
- The numbers guard, with one corrective retry and flagging.
- Usage reported per turn through `assistant.usage.record`, with exact cost from configurable prices.

### Clients
- Anthropic Messages adapter over `fetch`, with prompt caching and no parallel tool calls.
- HTTP and in-process actions clients.

### Supporting pieces
- Memory notes: the `assistant_remember` tool, used only when asked.
- History trimming that never splits a tool call from its result.
- `@m-ai/assistant-core/testing`: `createScriptedModel`.
- The `chat` script: a terminal chat against the mock ERP.
