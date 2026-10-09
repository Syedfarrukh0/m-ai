# ERP → M.Ai: Phase D is done, and the catalog for your cross-check (7 Oct 2026)

Thank you for 0.1.3. It is vendored, checksum-matched and pinned, and it is what the ERP now runs on.

We agreed that the pilot comes first, then the catalog to you, then the rest (Phase E), so that any change you want lands on 55 actions rather than 110. **The catalog is attached: `action-catalog.json`.**

| | |
|---|---|
| Contract | 0.1.3 |
| Producer | `erp` 0.1.0 |
| Catalog hash | `2388779dd0b3e5be9aec8da8e90070886d244bc2082686cae2f9533dcea02e5e` |
| Actions | 55 |
| Errors | 52 (21 standard + 31 of the ERP's own) |
| Events | 21 |

As you asked, every action has a description of one plain sentence (at most 200 characters), at least one area tag and exactly one intent tag. The ERP refuses to start otherwise.

---

## 1. What is in it

- **`core.context.get`**: today in the company's timezone, the fiscal year, the licensed modules, and the assistant's settings and quota.
- **`masters.<x>.search | list | get | create | update`** for customers, vendors, products, companies, categories, salespersons and warehouses.
  - Search is pg_trgm on the name, a code prefix, the digits of a phone number, and a barcode (`matchedOn: "other"`).
  - `disambiguation` carries city and area, phone, code and pack size.
- **`sales.invoice.post | list | get`**, **`receivables.receipt.post`**, **`reports.sales.summary`** and **`reports.receivables.outstanding`**.
  - Financial commands preview from the real handler, rolled back. `primaryAmount` is the invoice total or the amount received.
  - Amounts in sentences read "PKR 1,470,299.46".
- **`assistant.settings.get | update`**, **`assistant.consent.accept`** and **`assistant.usage.record`**.
- The six imports (tag `bulk`) and the three renders, as before.

## 2. The door — how to call it

**A token.** The person's own ERP session calls this, and the web chat holds the token:

```
POST /auth/delegate
{ "clientId": "m-ai", "conversationId": "<yours>", "scope": { "allowActions": [...], "allowReadModules": [...] } }
→ 200 { "token": "<jwt>", "expiresAt": "<ISO>" }
```

- The token is a `DelegatedTokenClaims` exactly as in 0.1.3: `typ: "delegated"`, `sub`, `tid`, `act.sub`, `aud: "erp:actions"`, `cnv`, `scp`, `iat` and `exp`.
- It lasts 300 seconds; ask again as needed.
- It opens `/actions/list|preview|execute` and nothing else. It cannot ask for another token.
- It is issued only while the company holds ASSISTANT; otherwise `/auth/delegate` answers 403 `{ error: "module_not_licensed", moduleCode: "ASSISTANT" }`.
- If the licence ends while a token is still live, every call with that token answers `MODULE_NOT_LICENSED` with `details.module: "ASSISTANT"`.

**Your four rules** are implemented as written, with a test each:

1. A delegated token always means source `assistant`.
2. `X-Erp-Source` on a delegated request is a 400.
3. The actor comes from `act.sub`, `cnv` and `scp` only.
4. A session token is never the assistant.

**Commands.** Every command needs an `Idempotency-Key`, and a confirmed command needs its confirmation (registry defaults).

**Policy.**

- **While a company has the assistant switched off,** list and execute offer only `core.context.get` and `assistant.usage.record`. Anything else answers `ASSISTANT_POLICY_DENIED` with `reason: "disabled"`.
- **The assistant can never change its own settings or accept terms** (`PERMISSION_DENIED`), whoever it acts for.
- **The quota** is always `{ included: 0, used: 0, packsRemaining: 0, state: "ok" }`, because your wallet decides and the ERP never sends `ASSISTANT_QUOTA_EXCEEDED`.

**Step-up.**

1. A financial action above the company's `financialLimit` answers `STEP_UP_REQUIRED` with `details: { stepUpId, expiresAt }`. It is idempotent on the confirmation, so sending it again returns the same `stepUpId`.
2. The person is told in the ERP's bell and decides in the ERP's **Approvals** screen. Your token cannot reach that screen.
3. Then send **the same execute** again: the same input, the same confirmation and the same `Idempotency-Key`. It either goes through once, or answers `ASSISTANT_POLICY_DENIED` with `reason: "step_up_declined"`.
4. The decision has to come before the confirmation expires, which is 15 minutes.

**`assistant.usage.record`** is idempotent on `turnId`. Recording the same turn again answers `{ recorded: false }`.

- These are refused as `VALIDATION_FAILED`:
  - a negative `charge.amount`;
  - a negative `costUsd`;
  - a `balanceAfter` without a `charge`.
- A `balanceAfter` below zero is accepted.
- Recording keeps working when the assistant is switched off, and through the licence's grace days.
- Once the licence has ended, nothing you send is taken, so your wallet ledger is the record from then on.

**`assistant.settings.update`** takes `null` to clear `policy.financialLimit`, `policy.allowedModules`, `greeting` and `lowBalanceMark`. That is the only way to unset them, because 0.1.3's partial policy has no "unset".

## 3. The licence check you call

```
GET /m-ai/v1/tenants/{tenantId}/licences/{module}      signed with signRequest(), empty body
→ 200 LicenceCheckReply   e.g. { tenantId, module: "ASSISTANT", holds: true, state: "active", until: null }
→ 401 { ok: false, error: { code: "m-ai.unauthenticated", details: { reason } } }   says nothing about the company
→ 404 NOT_FOUND           no such company (or a malformed id / module)
```

- The `path` signed is exactly `licenceCheckPath(tenantId, module)`, with a tolerance of 300 seconds.
- `state` is `active`, `grace`, `read_only`, `ended` or `none`. `until` is set only for a dated licence (the expiry, or the end of grace).

**Keys.** The ERP keeps them sealed, at most two live keys per direction for rotation:

- **inbound**, M.Ai → ERP: we generate it and give you the key id and secret;
- **outbound**, ERP → M.Ai, for top-ups and wallet reads later: you give us yours.

## 4. Questions

1. **Hearing a decision.** The ERP writes `assistant.stepup.approved` / `.declined` to its outbox with `stepUpId`, `confirmationId`, `conversationId` and `clientId`, but nothing delivers it to you yet. Until then the chat sends the request again when the person says "done". Would you rather have a **signed webhook** to you (outbound key, the same signing) when a request is decided? We can add it with the wallet's balance events, before Phase G.
2. **The AI terms.** The ERP shows "version 2026-10-08" and keeps who accepted it and when. The **text** is yours. Will you send it, or a stable URL, and tell us how you number versions? A new version switches the assistant off for every company until an administrator accepts it again.
3. **Key ids and handover.** What key id do you want for the first inbound key, and how should the secret reach you? Not e-mail.
4. **The cross-check.** Anything in the catalog you want changed: names, tags, descriptions, shapes. We change it now, before Phase E copies it 60 more times.

## 5. For your testing

ASSISTANT is **not on sale yet**: the reseller cannot sell it until your chat is live, and then it goes on sale with a one-line migration. Until then the ERP can give a test company the module, and the demo company `DEMO` can have it whenever you want to try the door end to end.

**Next on our side: Phase E1** (the rest of sales and receivables), unless the cross-check changes something first.
