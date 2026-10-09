# M.Ai → ERP: the wallet API — draft 1, plus our answers

Thank you, and congratulations on finishing bulk import and opening balances. Short answers first, then the API.

## Answers

1. **One-time `ASSISTANT` licence, with all use paid from the wallet:** noted. M.Ai charges nothing for the licence and never sees it.
2. **Top-ups only for licensed companies.**
   - **Top-ups the ERP writes:** M.Ai trusts the ERP's check.
   - **Direct top-ups** (M.Ai's own console, later): M.Ai checks the licence through the check you'll expose in Phase D, and refuses with `NOT_LICENSED` if the company doesn't hold it.
3. **When a licence ends: agreed, the balance stays, untouched, and works again when the licence returns.**
   - M.Ai never removes a balance by itself, and a balance never expires.
   - If the owner ever refunds one, it is an `adjustment` entry in the ledger, entered by the platform, with a reason.
4. **Negative charges: confirmed, M.Ai will never send one.** A charge is always ≥ 0. Refunds and corrections are credits in the wallet ledger, never negative turns.

---

## The API

### Basics

| | |
|---|---|
| Base URL | `https://<m-ai host>/v1` |
| Callers | Server to server only. Each app (one ERP deployment) is an M.Ai **app** with its own `appId`. |
| Company | The app's own tenant id, used as-is. A wallet is keyed by (`appId`, `tenantId`). |
| Money | Always `MoneyString` with an ISO `currency`. A wallet has one currency, fixed by its first top-up. |
| Times | ISO 8601 with an offset. |
| Errors | `{ ok: false, error: { code, message: { en, ur }, retryable } }`, the same shape as `ActionResult`. |
| Paging | `?limit=` (default 50, max 200) and `?cursor=`. A reply carries `nextCursor`, or `null` on the last page. |

### Authentication: signed requests

We propose the same HMAC scheme as the webhooks, in the other direction. There is no token endpoint, and the ERP already has the code.

- **`m-ai-key-id`:** which app key signed the request. Each app has up to two active keys, so a key can rotate without downtime.
- **`m-ai-signature`:** `t=<unix seconds>,v1=<hex>`.
  - `v1` is the HMAC-SHA256 of `"<t>.<METHOD>.<path with query>.<raw body>"`, where the raw body is empty for a GET.
  - Method and path are inside the signature, so a signed body can't be replayed on another endpoint.
- **Tolerance:** 300 s. A request outside it is refused with `401 UNAUTHENTICATED`.
- **Writes** also need `Idempotency-Key` (below), so a replay within the window still credits once.
- **Helpers:** we'll add `signRequest()` and `verifyRequest()` to `action-contract` (0.1.3, additive) once you agree.

### 1. Writing a top-up

`POST /v1/wallets/{tenantId}/top-ups`, with the header `Idempotency-Key: <uuid>`.

```json
{
  "amount": "2000",
  "currency": "PKR",
  "resellerId": "rs_123",
  "enteredBy": { "userId": "u_456", "as": "reseller" },
  "payment": { "method": "cash", "reference": "RCPT-0091", "receivedOn": "2026-10-08" },
  "note": "optional, up to 200 characters"
}
```

- **`amount`** must be > 0.
- **`as`** is `reseller` or `platform`.
- **`payment.method`** is `cash`, `bank_transfer` or `other`.
- **`resellerId`** names the reseller who sold the top-up; leave it out for a direct sale. When `as` is `reseller`, it must be that reseller's own id.
- **Who sees what** is the ERP's call. M.Ai trusts the app's key: a reseller sees only its own data because the ERP asks only for that.
- **Reply `201`:**

  ```json
  {
    "topUp": { "id": "tu_…", "amount": "2000", "currency": "PKR", "resellerId": "rs_123", "resellerCut": "100.00", "createdAt": "…" },
    "balance": "2035.40"
  }
  ```

- **The same key and the same body** return the first reply again, with `200`.
- **The same key with a different body** is refused: `409 IDEMPOTENCY_MISMATCH`.
- **A currency that isn't the wallet's** is refused: `422 CURRENCY_MISMATCH`. The first top-up sets the wallet's currency.
- **`resellerCut`** is worked out when the top-up is written: the reseller's rate × amount, rounded **down** to 2 decimals. The rate in force is stored with the top-up, so changing a reseller's rate later never rewrites history. The owner sets each reseller's rate in M.Ai.

### 2. Correcting a mistaken top-up

`POST /v1/wallets/{tenantId}/top-ups/{topUpId}/reversal`, with `Idempotency-Key`.

```json
{ "reason": "entered twice", "enteredBy": { "userId": "u_456", "as": "reseller" } }
```

- **It writes a reversing entry for the full amount.** Nothing is ever deleted or edited, and the reseller's cut on that top-up is reversed with it.
- **Who may reverse:**
  - the platform, at any time;
  - a reseller, only its own top-up, and only within 24 hours.

  Otherwise: `403 FORBIDDEN`.
- **A top-up can be reversed only once.** A second reversal is refused: `409 ALREADY_REVERSED`.
- **The balance may go below zero** if the money was already spent. The assistant then stops at zero, as usual.
- **Reply `201`:** `{ "reversal": { … }, "balance": "35.40" }`.

### 3. Reading

| Request | Gives |
|---|---|
| `GET /v1/wallets/{tenantId}` | `{ tenantId, currency, balance, lowBalanceMark, state: "ok" \| "low" \| "empty", updatedAt }` |
| `GET /v1/wallets/{tenantId}/ledger?from=&to=&type=` | The entries, oldest first, paged, plus `totals: { credits, debits }` over the whole filter. |
| `GET /v1/resellers/{resellerId}/top-ups?from=&to=` | That reseller's top-ups and reversals, paged, plus `totals: { sold, reversed, cut, count }` over the period. |
| `GET /v1/reports/totals?from=&to=&groupBy=day\|month` | Platform totals per period: top-ups, reversals, reseller cuts, charges, the model cost behind them, the margin, and the balances outstanding. For the platform console only. |

**A ledger entry:**

```json
{
  "id": "le_…",
  "type": "top_up | top_up_reversal | charge | adjustment",
  "amount": "-0.31",
  "balanceAfter": "1999.69",
  "occurredAt": "…",
  "turnId": "…",
  "model": "openai/gpt-oss-120b",
  "topUpId": "…",
  "resellerId": "…",
  "enteredBy": { "userId": "…", "as": "reseller" },
  "payment": { "method": "cash", "reference": "…" },
  "reason": "…"
}
```

- **Which fields appear:** `turnId` and `model` on charges only; `topUpId`, `resellerId`, `enteredBy` and `payment` on top-ups and reversals; `reason` on reversals and adjustments.
- **`amount` is signed:** credits are positive, charges are negative.
- **A charge's `turnId`** is the same `turnId` as in your `usage_events` row, so each charge matches its row one for one.
- **Charges are idempotent on (`tenantId`, `turnId`):** a turn is never charged twice.

### 4. Before replies stop: balance events

These are signed webhooks to the ERP's subscription URL, with the same `m-ai-signature` header and `EventDelivery` envelope as the other events. Delivery is at least once; dedupe on `eventId`.

| Event | When | Payload |
|---|---|---|
| `wallet.balance.low` | The balance falls below the mark. | `{ balance, mark, currency }` |
| `wallet.balance.empty` | The balance reaches zero or below. The assistant now refuses new turns. | `{ balance, currency }` |
| `wallet.balance.restored` | A top-up lifts the balance back above the mark. The bell can clear. | `{ balance, currency }` |

- **Each event fires once per crossing**, not on every charge.
- **The ERP picks the recipients:** the company's admins and its reseller, by its own audience rules.
- **The low-balance mark** is set by the company: a new optional `assistant.settings.lowBalanceMark` (`MoneyString`), in contract 0.1.3, additive.
  - If it isn't set, M.Ai uses 10% of the company's last top-up.
  - M.Ai reads the settings on every turn already, so a change takes effect on the next reply.

### Errors

| Code | HTTP | When |
|---|---|---|
| `VALIDATION_FAILED` | 400 | The body doesn't match the schema. |
| `UNAUTHENTICATED` | 401 | A bad or old signature, or an unknown key. |
| `FORBIDDEN` | 403 | The caller may not do this, e.g. a reseller reversing another's top-up. |
| `NOT_FOUND` | 404 | No such wallet or top-up. |
| `IDEMPOTENCY_MISMATCH` | 409 | The same key with a different body. |
| `ALREADY_REVERSED` | 409 | The top-up was already reversed. |
| `CURRENCY_MISMATCH` | 422 | The currency isn't the wallet's. |
| `NOT_LICENSED` | 422 | A direct top-up for a company without the licence. |
| `RATE_LIMITED` | 429 | Too many requests; retryable, with `Retry-After`. |

### Ledger rules (how M.Ai keeps it)

- **The ledger only grows.** Each entry stores `balanceAfter`, and the balance is always the sum of the entries.
- **Writes to one wallet happen one at a time.** A row lock means two charges can never read the same balance.
- **Charges are rounded up to 2 decimals and reseller cuts are rounded down.** All arithmetic is exact integers, never floats.

## What we need from you
- Agreement with, or changes to, this draft: above all the signed requests, the 24-hour reversal window for resellers, and `lowBalanceMark` in settings.
- In Phase D, the licence check for direct top-ups: a server-to-server read of "does tenant X hold `ASSISTANT`".

When you agree, we'll ship `action-contract` 0.1.3 with the request signing helpers, the wallet schemas and `lowBalanceMark`, and build the service to this draft.
