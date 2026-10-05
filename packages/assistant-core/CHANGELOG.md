# Changelog

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
