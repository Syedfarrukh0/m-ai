# M.Ai → ERP: action-contract 0.1.3 — the wallet API, with your six changes

Thank you. All six changes are in. So are the four settled answers, and the order of work: Phase D first, the catalog after it, then Phase E.

## 0.1.3 — attached

| | |
|---|---|
| File | `m-ai-action-contract-0.1.3.tgz` |
| sha256 | `ec2b72a0ceff1669e5fa26a3bcc265a0ad8fc8156ffdbbc393bd4604118b7794` (the build is reproducible) |
| Built from | commit `a0a2d07` |
| Tests | 124, all passing |

It is additive over 0.1.2, and adds no dependencies; zod is still the only peer.

## Your six changes

1. **The canonical string.** `signRequest()`, `verifyRequest()` and `canonicalRequest()` build exactly `"<t>.<METHOD>.<path>.<body>"`:
   - `t` is integer seconds;
   - the method is upper case;
   - the path and query are exactly as sent;
   - the body is raw bytes;
   - the hex is lower case.

   The README's "Signed requests between servers" section says so in one sentence, with a client and a server example. A test shows that a re-ordered query fails.
2. **One error shape.** Every wallet reply is a `WalletResult`: `{ ok, data | error, meta: { requestId, replayed } }`. The `error` is exactly an `ActionError`, with `message` in the caller's language from `Accept-Language`.

   **Three names changed from draft 1**, so the same meaning has the same code everywhere:

   | Draft 1 | Now | HTTP |
   |---|---|---|
   | `IDEMPOTENCY_MISMATCH` | `IDEMPOTENCY_KEY_REUSED` (standard) | 409 |
   | `NOT_LICENSED` | `MODULE_NOT_LICENSED` (standard) | 403 |
   | `FORBIDDEN` | `PERMISSION_DENIED` (standard) | 403 |

   - `PERMISSION_DENIED` gives `details.reason`: either `not_own_top_up` or `reversal_window_closed`.
   - The wallet's own codes are in `WALLET_ERRORS`: `wallet.unauthenticated` (401), `wallet.already_reversed` (409) and `wallet.currency_mismatch` (422).
   - The rest are standard codes: `VALIDATION_FAILED`, `IDEMPOTENCY_KEY_REQUIRED`, `NOT_FOUND`, `RATE_LIMITED` and `INTERNAL`.
3. **A wallet before its first top-up.** `GET /v1/wallets/{tenantId}` answers `{ balance: "0", currency: null, state: "empty", lowBalanceMark: null, updatedAt: null }` for any tenant.
4. **Keys in both directions.**
   - The ERP signs its calls with the app's keys.
   - M.Ai signs **all** its calls to the ERP with its own, separate keys: the licence check (`GET`) and the balance events (`POST`, body = `EventDelivery`). Both use `signRequest()`, and `m-ai-key-id` picks the key.
   - Each side holds up to two keys per direction, for rotation.
5. **The licence check.** `LicenceCheckReply` and `licenceCheckPath(tenantId, module)` follow your shape, `/m-ai/v1/tenants/{tenantId}/licences/ASSISTANT`. The schema refuses `holds` unless it is true exactly for `active` and `grace`.
6. **Building before the service exists.** The schemas are all in `@m-ai/action-contract`:
   - `TopUpRequest`/`TopUpReply`, `ReversalRequest`/`ReversalReply`;
   - `Wallet`, `LedgerEntry` (with its rules per type) and `LedgerPage`;
   - `ResellerTopUpsPage` and `PlatformTotals`;
   - `WALLET_EVENTS` with payload schemas, and `WALLET_PATHS`.

   **You don't have to build your own fake:** `@m-ai/action-contract/testing` exports `createFakeWallet()`. It answers the API in memory, as the service will: signatures, idempotency, the reversal rules, the ledger with totals and pages, both reports, and the balance events. Pass `fake.fetch` to your HTTP client. A sandbox app with test keys follows when the service runs.

## Two small additions

- **A reseller acts as itself.** `WalletActor` is `{ as: 'platform', userId }` or `{ as: 'reseller', userId, resellerId }`.
  - A top-up entered by a reseller must name that same `resellerId`, and the schema refuses anything else.
  - On a reversal, the wallet uses it to check "its own top-up".
- **The rate is kept with each top-up.** `TopUp.resellerRate` stores the rate in force beside `resellerCut`, so later rate changes never rewrite history.
- **`AssistantSettings.lowBalanceMark`** is in: an optional `MoneyString`, ≥ 0.

## How the balance events behave (as in the fake)

- **An event goes out when the state changes:**
  - into `low` → `wallet.balance.low`;
  - into `empty` → `wallet.balance.empty`;
  - back to `ok` → `wallet.balance.restored`.
- **A company's first top-up sends nothing**, because no alert was outstanding.
- **Coming up from empty to still-low** sends `low`.

## Your order of work: agreed

- Converting everything to actions first is the right call.
- When `action-catalog.json` comes after Phase D, we'll cross-check it against the contract, and also run our accuracy tests on it.
- **One request while you write ~110 actions:** for each message, the assistant picks about 24 of them, by their tags and descriptions. So please give each action:
  - a one-sentence plain description of what it answers or does;
  - an area tag plus an intent tag from your vocabulary.

  That is what lets it pick the right action from 110.

## Next on our side

- Building the M.Ai service, the wallet first, to this contract.
- Then the sandbox app and keys for you.
