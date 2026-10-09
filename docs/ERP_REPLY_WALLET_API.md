# ERP → M.Ai: the wallet API, draft 1 — agreed, with six small changes

Thank you. Your four answers settle it:

- the licence is one-time and M.Ai never sees it;
- the ERP's check is trusted for its own top-ups;
- a balance stays when a licence ends, and never expires;
- a charge is never negative.

The ERP records all four in `ASSISTANT_DECISIONS.md` §2.

## Agreed as drafted

- **Signed requests** (HMAC, `m-ai-key-id` + `m-ai-signature`, 300 s), with `Idempotency-Key` on every write. Yes to `signRequest()` / `verifyRequest()` in 0.1.3.
- **The top-up body and reply,** `resellerCut` rounded down at the rate in force, and `IDEMPOTENCY_MISMATCH` / `CURRENCY_MISMATCH`.
  - The ERP's tenant, reseller and user ids are UUIDs.
  - The ERP enforces that a reseller names only itself.
- **Reversals:** one per top-up, as a reversing entry. The platform may reverse at any time; a reseller only its own top-up, within 24 hours. The ERP shows the button only while it is allowed.
- **The ledger, the reseller and platform reports,** signed amounts, and `turnId` on charges. The ERP keeps `usage_events.charge_amount` positive and matches it to your negative ledger amount by `turnId`.
- **The three balance events,** once per crossing, at least once, deduped on `eventId`. The ERP chooses the recipients: the company's admins and its reseller.
- **`assistant.settings.lowBalanceMark`** (`MoneyString`, ≥ 0), defaulting to 10% of the last top-up when unset.

## Six changes

1. **The canonical string, exactly.** `"<t>.<METHOD>.<path>.<body>"`:
   - `t` is integer seconds;
   - `METHOD` is upper case;
   - `path` is the path and query **exactly as sent on the wire**, not re-encoded or re-ordered;
   - `body` is the raw bytes.

   The hex is lower case. Please put that sentence in the README, so both sides can't sign differently.
2. **One error shape everywhere.** Please use `ActionError` exactly: `{ code, message, messages: { en, ur }, details?, http, retryable }`. Here `message` is in the caller's language (from `Accept-Language`, default `en`). The ERP then turns a wallet error and an action error into a screen with one function.
3. **A wallet before its first top-up.** For any tenant of the app, `GET /v1/wallets/{tenantId}` should answer `{ balance: "0", currency: null, state: "empty", lowBalanceMark: null }`, not `404`. A newly licensed company's screen then needs no special case.
4. **Keys in both directions.** The ERP signs its calls to you with the app's key. You sign your calls to the ERP — the licence check, and the balance events — with a **separate key pair**, so neither side's key can forge the other's requests. The ERP stores its secrets sealed at rest, as it does mail passwords.
5. **The licence check (the ERP's side, Phase D).** We propose:

   `GET /m-ai/v1/tenants/{tenantId}/licences/ASSISTANT`

   It is signed by M.Ai and answers:

   ```json
   { "tenantId": "…", "module": "ASSISTANT", "holds": true,
     "state": "active" , "until": null }
   ```

   - `state` is one of `active`, `grace`, `read_only`, `ended` or `none`.
   - `holds` is true for `active` and `grace`.
   - A direct top-up is allowed only when `holds` is true.
   - `until` is null for a one-time licence. It is there for when the company's ERP itself lapses: the assistant stops then, because every call goes through the ERP.
6. **For building before the service exists.** Please put the wallet's request, reply, ledger-entry and event schemas in 0.1.3, as you planned, so the ERP can test against a fake built from them. When the service runs, please give us a sandbox app with test keys.

## The ERP's order of work — the owner's decision

**Before anything new, the whole existing ERP is brought up to the contract:** every company operation becomes an action. That is about 110 actions over roughly 100 routes today, with every refusal as a code in English and Urdu, every list with server-side totals, and fuzzy search on every main record.

1. **Phase D first:**
   - the pilot actions;
   - delegated tokens with your four rules, and a test for each;
   - the host's assistant hooks;
   - `assistant.settings` with `lowBalanceMark`;
   - the licence check above.

   **Then `action-catalog.json` comes to you** before the rest is converted, so any change you ask for lands on about 25 actions, not 110.
2. **Phase E:** the rest, module by module — sales, purchases and stock, accounts and reports, people and the company.
3. **Then new work:** the wallet screens (top-up, reversal, balance, the reseller's cut, the bell) and the ERP's webhook endpoint for your balance events.

The reseller and platform consoles stay outside actions v1, as agreed. Their wallet screens call your API through the ERP's server.
