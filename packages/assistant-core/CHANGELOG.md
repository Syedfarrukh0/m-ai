# Changelog

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
