# Changelog

## 0.1.3 — 2026-10-08

This release adds the wallet API, as agreed with the ERP on 8 Oct 2026, including its six changes. Everything is additive.

### Added
- **Signed server-to-server requests:** `signRequest()`, `verifyRequest()`, `canonicalRequest()` and `REQUEST_HEADERS`.
  - The canonical string is `"<t>.<METHOD>.<path>.<body>"`: integer seconds, an upper-case method, the path and query exactly as sent, and the raw body bytes.
  - The signature is lower-case hex, with a 300 s tolerance.
  - A key id picks the secret. Each direction uses its own keys.
- **The wallet schemas:**
  - requests and replies: `TopUpRequest`, `TopUp`, `TopUpReply`, `ReversalRequest`, `ReversalReply`;
  - wallet and ledger: `Wallet`, `LedgerEntry` with its rules per type, `LedgerPage`;
  - reports: `ResellerTopUpsPage`, `PlatformTotals`;
  - building blocks: `WalletActor` (a reseller acts with its own `resellerId`), `TopUpPayment`, `PositiveMoney`, `NonNegativeMoney`, `AppId`.
- **Around the wallet:**
  - `WalletResult` and `WalletMeta`. The error is exactly an `ActionError`.
  - `WALLET_PATHS`.
  - `WALLET_ERRORS`: `wallet.unauthenticated` (401), `wallet.already_reversed` (409) and `wallet.currency_mismatch` (422). Standard codes cover the rest.
- **Balance events:** `WALLET_EVENTS` (`wallet.balance.low`, `.empty`, `.restored`) and their payload schemas.
- **The licence check** that the app serves to M.Ai: `LicenceCheckReply` (`holds` exactly for `active` and `grace`), `LicenceCheckState` and `licenceCheckPath()`.
- **`AssistantSettings.lowBalanceMark`:** optional, `MoneyString` ≥ 0.
- **Testing:** `createFakeWallet()`, an in-memory wallet that answers the API exactly as the service will.

## 0.1.2 — 2026-10-07

This release adds the assistant's wallet, as agreed with the ERP on 7 Oct 2026. Everything is additive: a 0.1.1 host and a 0.1.1 record stay valid.

### Added
- **`assistant.usage.record` can carry the wallet charge.** Two optional fields:
  - `charge: { amount, currency }` — what the company was charged for the turn from its M.Ai wallet: the cost of the model that answered, margin included;
  - `balanceAfter` — the wallet balance after the charge.

  Both are `MoneyString`. The balance can dip slightly below zero on the reply that crosses it.
- **`balanceAfter` needs `charge`**, which gives it its currency.
- **`CurrencyCode`** is an ISO 4217 code in capitals, such as `"PKR"`.

### Unchanged
- **`assistant.quota`** stays in `core.context.get`. With the wallet, apps return `state: 'ok'`; M.Ai checks the balance itself.

### Compatibility
- **A host still on 0.1.1** keeps working. Its zod object schemas drop unknown keys, so an assistant that sends the new fields to it loses them silently instead of failing.


## 0.1.1 — 2026-10-02

These changes come from the ERP's review of 0.1.0. Everything is additive. A host written for 0.1.0 still compiles.

### Added
- **Module error status (ask A).** `registerErrors` accepts `{ en, ur, http?, retryable? }`. Every `ActionError` now carries `http` and `retryable`, and the catalog exports both for every code. `httpStatusOf` uses `error.http`. `STANDARD_ERRORS` entries gain `retryable`, which is true for `RATE_LIMITED` and `IDEMPOTENCY_IN_PROGRESS`.
- **`availableWhenReadOnly` (ask B).** Lets a `write` command that only reads the books run on a read-only licence. It is exported in the catalog, where queries always show `true`.
- **Idempotency scope (ask C).** `claimIdempotency` and `storeIdempotency` receive `{ action, version }` as a last argument. `StoredResult` gains `redacted`.
- **`sensitiveOutput` (ask E).** Output paths redacted in the audit entry and the idempotency store. The first response is unchanged; a replay returns the redacted output with `meta.redacted: true`.
- **One render action per document kind (§3).** `WELL_KNOWN_ACTION_PATTERNS` (`masters.<entity>.search`, `documents.<kind>.render`) and `matchesActionPattern()`.
- `redactWithFlag()`.

### Changed
- **Examples ship (ask D).** The tarball now includes `examples/` (`action-catalog.example.json`).

### Deprecated
- `WELL_KNOWN_ACTIONS.documentsRender`. Use `documents.<kind>.render`. It will be removed in 0.2.0.

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
