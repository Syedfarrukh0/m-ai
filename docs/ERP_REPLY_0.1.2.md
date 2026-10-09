# ERP → M.Ai: 0.1.2 is in, the owner's model for the assistant, and the top-up API

Thank you, for 0.1.2 and for settling the owner's two decisions so quickly. The owner has one more, which settles how the assistant is sold.

## The owner's model: buy it once, then top up

**The ERP treats the assistant as a third-party service inside the ERP.**

1. **The `ASSISTANT` licence is a one-time fee.** The ERP sells it like any other module: from the platform, or through the company's reseller with the reseller's usual margin.
   - It switches the assistant on for that company.
   - There is **no monthly fee and no per-user fee.**
   - The ERP sets and collects the fee; M.Ai charges nothing for it.
2. **All use is paid from the wallet**, held by M.Ai, as agreed: each reply at the model's cost plus a margin.
3. **Once the company holds the licence**, it tops up its wallet either way:
   - through its reseller, who earns a cut on the top-ups it sells;
   - or directly from M.Ai.

   For the pilot, top-ups are entered by hand, as you wrote.

This replaces "no monthly fee for now" with something firmer.

Two consequences for the wallet:

- **A top-up belongs to a company that holds the licence.** In the ERP, top-up is offered only to such a company. For a direct top-up, please check the licence with the ERP; we will expose that check in Phase D.
- **If the licence ends** — taken back, or the company's ERP itself lapses — the assistant stops, because every action it takes goes through the ERP. We suggest **the balance stays in the wallet, unused, and works again when the licence returns.** Please confirm, or tell us your rule.

On the ERP side, the licence engine sells modules for a term today. It will learn a one-time, perpetual sale when `ASSISTANT` is offered, as `ASSISTANT_ONPREM` already needs. Nothing for you there.

## 0.1.2 — vendored

- **The checksum matches:** `b220a3c6…ae87a`.
- **We diffed it against 0.1.1, and it is exactly what the changelog says:**
  - `CurrencyCode`;
  - the two optional fields on `AssistantUsageRecordInput`;
  - the refinement that refuses `balanceAfter` without `charge`;
  - the version constant.

  It adds no dependencies, and zod is still the only peer.
- **Where it lives:** `vendor/m-ai-action-contract-0.1.2.tgz` with its line in `SHA256SUMS`; 0.1.1 is removed. `@erp/contracts` re-exports `CurrencyCode` beside `MoneyString`.
- **Results:** `pnpm verify` passes with 811 tests, and your `runContractChecks` passes on every ERP action.

## The charge in `usage_events` (migration 0040)

Three new columns, written once and never changed, like the rest of the row:

- `charge_amount` and `balance_after`, both `numeric(18,4)`;
- `charge_currency`, checked against `^[A-Z]{3}$`.

The database enforces your rules: a charge is an amount and a currency or neither, and a balance needs a charge. The balance may go negative.

**One assumption to confirm:** the ERP refuses a **negative charge**. We take a refund or a correction to be a credit in your wallet ledger, not a negative turn. If you will ever send a negative `charge.amount`, please tell us before Phase D.

## For the top-up and balance API draft

The ERP will call it **server to server only**, never from a browser. Please cover these four things:

1. **Writing a top-up** (reseller console, platform console):
   - **Fields:** an idempotency key, so a hand-entered top-up pressed twice credits once; the company (the ERP's tenant id); the amount as `MoneyString` with its currency; the optional `resellerId`; who entered it (the ERP's user id and whether a reseller or the platform); and the payment reference (cash receipt or bank transfer).
   - **Response:** the new balance.
   - **Credential:** please say how the ERP authenticates — a signed request like your webhooks, or client credentials.
2. **Correcting a mistaken top-up.** Who may do it, and how it appears: as a reversing entry, never a deletion.
3. **Reading:**
   - a company's balance;
   - its ledger, paged: top-ups, and charges per turn **with the `turnId`**, so the ERP can match each to its own `usage_events` row;
   - a reseller's top-ups sold and its cut, by period;
   - the platform's totals.

   All money as `MoneyString`.
4. **Before replies stop.** A signed event when a company's balance falls below a low-balance mark, and another when it reaches zero, so the ERP's bell can tell the company's admins (and its reseller) in time. Please also say where the mark is set: by the company in `assistant.settings`, or by M.Ai.

## Next

Bulk import and opening balances are done (7 Oct). **Phase D starts now:**

- delegated tokens with your four rules, and a test for each;
- the host's assistant hooks;
- `core.context.get` returning `quota.state: 'ok'`;
- the pilot actions.

Then `action-catalog.json` comes to you for the cross-check.
