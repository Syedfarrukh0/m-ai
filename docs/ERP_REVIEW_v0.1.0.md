# M.Ai → ERP: `@m-ai/action-contract` v0.1.0 for review

## 0. Name and distribution change — read first

The assistant project is now called **M.Ai** (it was "Modstick AI"). Use the new names in every ERP doc, plan and piece of code:

| Was | Now |
|---|---|
| Modstick AI | **M.Ai** |
| `@modstick-ai/action-contract` | **`@m-ai/action-contract`** |
| GitHub organisation `modstick-ai` | None for now: a personal GitHub repo, `m-ai` |
| Public on npmjs.com (answer 3, reply §2.1) | Not for now. Each version is a **GitHub Release carrying the packed tarball**; the ERP vendors that file, pinned. This is your option (b) from §2.1. |
| Webhook headers `modstick-signature`, `modstick-delivery-id`, `modstick-event-type` | `m-ai-signature`, `m-ai-delivery-id`, `m-ai-event-type` |
| Assistant client id (example) | `m-ai-assistant` |

**What this means for the ERP**

- **Install.** Put the tarball at `vendor/m-ai-action-contract-0.1.0.tgz` and run `pnpm add ./vendor/m-ai-action-contract-0.1.0.tgz`. The lockfile pins it by integrity hash. It works offline, in CI and in on-premise Docker builds, with no token anywhere.
- **Answer 17 (CI).** No registry token and no `.npmrc` are needed.
- **D8 guard.** Allow `@m-ai/action-contract`. It replaces the old name. Every other M.Ai package stays forbidden.
- **Docs.** Use the new names in the blueprint, ADR 0012 and CONTRIBUTING. The module code `ASSISTANT` and every other decision are unchanged.
- **Later.** If the package goes to a registry, imports don't change, because the name stays `@m-ai/action-contract`.

## Status of v0.1.0

v0.1.0 is built. It implements Appendix A of `ASSISTANT_READINESS.md`, Additions 1–9, and the decisions of 30 Sep.

- **Tests:** 83, all passing.
- **Typecheck:** strict, with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
- **Build:** ESM + CJS + `.d.ts`, dependency-free apart from `zod ^4.1` as a peer.
- **Consumer check:** the packed tarball was installed into a clean project using `NodeNext` + strict with `skipLibCheck: false`; it typechecks and runs as both ESM and CJS.

The tarball comes with this document.

## Please review against the ERP

**Do not start `ErpActionHost` before replying.** Answer with gaps, or with "fits", section by section (§1–§5 below). Review these parts:

1. **`ActionHost` and `HostTransaction`** (`src/host.ts`). This is everything the ERP implements.
2. **The registry pipeline order** (`src/registry.ts`, and the "How the pipeline behaves" section of README.md).
3. **`runContractChecks`** — it replaces the ERP's planned five-check harness. The ERP implements `ContractCheckHost` over its test database: `snapshot()`, `outboxCount()`, `failNextTransaction()`.
4. **`examples/action-catalog.example.json`** — what `pnpm catalog` should produce.

## 1. Differences from Appendix A — please check

| Area | Appendix A / earlier reply | v0.1.0 | Why |
|---|---|---|---|
| Confirmation id | `<random>.<mac>` | `c1.<random>.<expUnixSeconds>.<mac>` | The expiry must be readable at execute to tell `PREVIEW_EXPIRED` from `invalid`. It is covered by the MAC. |
| `ActionHost.confirmationSecret()` | — | new | The HMAC key (≥ 16 bytes). Put it next to `SECRETS_KEY`. |
| `HostTransaction.consumeConfirmation(id, idempotencyKey)` | "stored with the idempotency row" | its own method, returning `'ok' \| 'used'` | Unique insert on `(tenant_id, confirmation_id)`; it can share the idempotency table. |
| `ActionHost.transaction(ctx, { rollback, readOnly }, work)` | `{ rollback }` | adds a `readOnly` hint | Queries may run in `READ ONLY` transactions. Their audit and metering therefore go through `auditOutside` / `meterOutside`. |
| `ActionHost.meterOutside(record, ctx)` | — | new | Metering for assistant queries. |
| `ActionHost.assistant` | — | `settings(ctx)`, `quota(ctx)`, `stepUp(ctx, req)` | Optional. Without it, every `source: 'assistant'` call → `ASSISTANT_POLICY_DENIED` with `reason: not_supported`. |
| `stepUp(ctx, req)` | "pending confirmation in the bell" | find-or-create **by `confirmationId`**, returning `approved \| declined \| pending{stepUpId, expiresAt}` | It must keep returning `approved` for an approved id, even after the execute committed, so that retries replay. |
| Where the step-up check runs | — | Before the main transaction. The registry runs one extra rolled-back preview to get `primaryAmount` and to catch a stale confirmation early. | Only when the source is the assistant, the risk is financial, and the policy has a limit. |
| `PreviewResult` | `{ preview, fingerprint, expiresAt }` | adds `confirmationId` and `stepUp: { required }` | The assistant can tell the user up front that approval in the app will be needed. |
| `ExecuteRequest.confirmation` | `{ fingerprint }` | `{ id, fingerprint }` | As agreed in 2.2. |
| Expired confirmation | — | Checked **after** the idempotency claim | A retry of a committed execute replays even after its confirmation has expired. |
| Replay before step-up | — | In the step-up path, the registry first peeks at the idempotency key in a rolled-back transaction | A retry of a committed, approved execute replays even if the data has moved on since. |
| Gate order | validate → permissions | scope → permissions → licence → assistant policy/quota → validate | A caller without access learns nothing about the input schema. |
| `list()` | `CatalogEntry[]` | `{ actions, catalogHash }` | Addition 8. |
| Queries on `LICENCE_READ_ONLY` | — | still allowed; commands refused | Matches "reading still works". |
| `EventDefinition.module` | — | required | Alert tokens are scoped to the event's module. |
| `ActionPreview.primaryAmount` | — | a runtime rule: a financial preview without it → `INTERNAL` | It can't be checked at definition time. |
| Paging | `PageInput.limit` default 25 | `limit` optional; the registry injects `paging.defaultLimit` and refuses values above `maxLimit` | The default is set per action. |
| `sensitive` | top-level paths | top-level keys **or dotted paths**; arrays are walked | For nested CNIC fields. |
| New standard codes | — | `IDEMPOTENCY_KEY_REQUIRED` (400) | The key is required for mobile, desktop, api and the assistant (C9). |
| HTTP for `ASSISTANT_QUOTA_EXCEEDED` | — | 402 | 429 stays for real rate limits. |
| Delegated token `aud` | `'erp-actions'` | `string` (the app chooses) | The contract is generic. New optional claims: `msg` (the inbound message id for token-exchange) and `scp` (`TokenScope`). |
| `TokenScope` | — | `{ allowActions?, allowReadModules? }`, enforced by the registry from `ctx.actor.scope` | Put `scp` from the token into `ctx.actor.scope`. |
| Webhooks | Addition 3 | header `m-ai-signature: t=<unix>,v1=<hex>`; HMAC over `"<t>.<rawBody>"`; 300 s tolerance; several `v1` values during rotation | Same scheme as the common webhook providers. `EventDelivery` is the envelope. |
| Emit checks | compile-time | also at runtime: an undeclared event type or an invalid payload → `INTERNAL` (only once events are registered) | Catches drift between `events.ts` and handlers. |
| `AssistantSettings.policy` | `.default({})` | `.prefault({})` | With zod 4, `.default({})` would skip the nested defaults. |

## 2. What the ERP host must do (checklist)

- [ ] `transaction`:
  - one `TenantDb` transaction with `app.tenant_id` / `app.user_id` set;
  - `rollback: true` → always roll back;
  - on throw → roll back and rethrow;
  - `readOnly` → optionally `SET TRANSACTION READ ONLY`.
- [ ] `claimIdempotency`:
  - an `idempotency_keys` row keyed by `(tenant_id, key)`, holding `input_hash` and `result`;
  - return `'running'` only when another connection holds the row. `SELECT … FOR UPDATE NOWAIT`, or rely on the unique-insert conflict.
- [ ] `consumeConfirmation`: a unique insert. On conflict → `'used'`.
- [ ] `emit`: the outbox row, in the same transaction. `afterCommit` sends the live hints (D4).
- [ ] `audit` / `auditOutside`: the new `audit_trail` columns. `input` arrives already redacted.
- [ ] `meter` / `meterOutside`: `usage_events`.
- [ ] `availability`: `MODULE_NOT_LICENSED` / `LICENCE_READ_ONLY` from the licensing tables.
- [ ] `toError`: database constraint → code mapping. Return codes from the error catalogue. Return `null` for anything unknown; it becomes `INTERNAL`.
- [ ] `assistant.settings`: `tenants.settings → 'assistant'`.
- [ ] `assistant.quota`: counter plus packs → `AssistantQuota`.
- [ ] `assistant.stepUp`: the bell approval flow (2.3.2).
- [ ] `logError`: send it to the logs, with `requestId`.

## 3. Well-known actions the ERP defines

The shapes are in the package. The ERP writes the handlers.

- `core.context.get` → `CoreContextOutput`. Include `assistant: { settings, quota }` when the licence is active.
- `masters.<entity>.search` → `SearchInput` / `SearchOutput` (`SearchItem`).
- `assistant.settings.get|update`, and `assistant.consent.accept`.
- `assistant.usage.record` → `AssistantUsageRecordInput`:
  - `permissions: []`;
  - the handler refuses unless `ctx.actor?.clientId` is the assistant client;
  - idempotent on `turnId`.
- `messaging.send` (Phase F):
  - with an alert token, only to `ctx.actor.conversationId`;
  - `documents.render` comes with invoice printing.

`core.context.get` and `assistant.usage.record` stay callable by the assistant while it is disabled or out of quota (`assistantAlwaysAllowed`). CORE is always allowed by `allowedModules` (`assistantAlwaysAllowedModules`). Tell us if the ERP's core module code is not `CORE`.

## 4. Test fixture

`test/fixtures/app.ts` in the package is a small ERP-like app: customers, invoices with 18% tax and a credit limit, a sales summary with totals, and the well-known actions. It shows every pattern the ERP needs:

- `ctx.fail` with a module code;
- previews with `primaryAmount` and warnings;
- `pageWithTotals`;
- `sensitive`;
- an actor check.

## 5. Reply with

- Gaps or objections, per section above.
- The ERP's core module code, if it isn't `CORE`.
- Anything in `ActionHost` that doesn't map onto `TenantDb`, the outbox or licensing.

Once you reply "fits", or once we've fixed what you raise, we cut the GitHub Release for v0.1.0 (or v0.1.1). The ERP then vendors that tarball and starts `ErpActionHost` on it.
