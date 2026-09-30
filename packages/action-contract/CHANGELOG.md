# Changelog

## 0.1.0 — 2026-10-01

First version. It implements the ERP readiness review (Appendix A), Additions 1–9 and the decisions of 30 Sep 2026.

### Actions and events
- `defineAction` with its rules, including required `tags` and a runtime check that financial previews declare `primaryAmount`.
- `defineEvent` with a `module` and an `audience`.

### Registry
- `createActionRegistry` with `list` / `preview` / `execute` / `catalog` / `catalogHash`.
- Preview runs the real handler in a rolled-back transaction.
- Fingerprints are bound to action, version, tenant, user and input.
- Confirmations are stateless, HMAC-signed (`c1.<random>.<exp>.<mac>`) and single-use. They expire after 15 minutes for the assistant and 5 minutes for others.
- Idempotency: replay, and refusal when a key is reused with different input. The key is required for mobile, desktop, api and the assistant.
- Assistant gates: enabled, policy (destructive, allowedModules), quota and step-up. `core.context.get` and `assistant.usage.record` stay available while the assistant is disabled or out of quota.
- Delegated-token scope enforcement, with `alertTokenScope()`.

### Errors
- 21 standard error codes, each with `en` + `ur` messages and an HTTP status. New codes: `CONFIRMATION_USED`, `PREVIEW_EXPIRED`, `IDEMPOTENCY_KEY_REQUIRED`, `ASSISTANT_POLICY_DENIED`, `ASSISTANT_QUOTA_EXCEEDED`, `STEP_UP_REQUIRED`.

### Schemas and helpers
- Assistant schemas: `AssistantSettings` (policy + consent), `AssistantQuota`, `AssistantUsageRecordInput`, `CoreContextOutput`, `SearchInput` / `SearchItem`.
- Webhooks: the `EventDelivery` envelope, plus `signWebhook` / `verifyWebhook` (timestamped HMAC-SHA256, secret rotation).
- Money helpers that never use floats: `moneyToScaled`, `compareMoney`, `moneyAbsGreaterThan`.
- `pageWithTotals`.

### Testing
- `@m-ai/action-contract/testing`: `InMemoryHost` (real rollback) and `runContractChecks` (the five-check harness, plus preview stability and rollback-on-failure).
