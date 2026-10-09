# Every company operation as an action — the plan (proposed 8 Oct 2026)

**The owner's idea:** before building anything new, bring the whole existing app up to M.Ai's terms, so nothing has to be reopened later.

**The ERP's view:** agreed. It is the right order, and the agreed plan already ends there (Phases D and E, ADR 0012); this only moves "everything else" ahead of anything new. New work waits until it is done:

- undo of an opening import;
- the wallet screens;
- Module 5.

---

## Where it stands today

**Done — the foundation:**

- the contract package (0.1.2), `ErpActionHost`, and `/actions/list|preview|execute`;
- the error catalogue in English and Urdu, and every event as a checked schema through the outbox;
- audit, idempotency, confirmations and usage metering;
- M.Ai's contract checks in `pnpm verify`.

**Done — 9 actions:** the three print actions and the six imports.

**Not yet:** about **100 company routes** are still plain REST, with their logic behind them. That is what this plan converts.

| Area | Routes |
|---|---:|
| Invoices and FBR filing | 8 |
| Receipts, customer ledger, ageing | 9 |
| Bills, payments, vendor ledger, P&L, balance sheet, tax position | 12 |
| Stock, movements, adjustments, margins, expiry, reconciliation | 11 |
| Sales and purchase returns | 8 |
| Journals | 4 |
| Chart of accounts and mappings | 7 |
| Masters (lists, create, update) | 9 |
| People, invitations, roles | 12 |
| Overview and row charts | 9 |
| Company profile, licences, ledger health | 4 |
| E-mail settings, sent mail, e-mail an invoice | 7 |

On top of that, **about 265 refusals are still English sentences** (`BadRequestException('…')`). M.Ai's terms are a **code with English and Urdu**, so the assistant can say why in the user's language. Each refusal is converted with the action that throws it.

## What "M.Ai's terms" means for each operation

1. **An action:**
   - a name and a description;
   - zod input and output;
   - permission and licence module;
   - risk, confirmation and tags.

   A money-moving action previews from the real handler.
2. **Coded refusals** in English and Urdu, with their HTTP status and whether to retry.
3. **Lists and reports** page through the data and carry **totals computed by the server over the whole filter**. No screen and no assistant adds up a column.
4. **Search:** every main record has a `masters.<entity>.search`, fuzzy on name, code and phone (`pg_trgm`, already installed in 0035).
5. **Events** for every change, through the outbox (already true).
6. **The REST route stays, as a thin wrapper** that calls the action (as the Print button does). The screens don't change, and the 470-odd API tests that already exercise those routes keep proving them.
7. **A contract-check fixture** for every command.

**Not converted, by agreement or by nature:**

- The reseller and platform consoles: the scope of actions v1 is company operations only (`ASSISTANT_DECISIONS` §5).
- Sign-in, refresh and password-reset links.
- The live event stream.
- Picture bytes (uploads and serving).
- Health pings.
- A person's own drafts and view preferences (plumbing for the screens, not business).

## The order

Each batch ends green: `pnpm verify` and the browser suites.

| Batch | What | Roughly |
|---|---|---:|
| **D — the pilot, and the assistant's door** | `core.context.get`; masters search, list, create and update for all seven kinds; `sales.invoice.list/get/post` (the quote becomes its preview); `receivables.receipt.post`; `reports.sales.summary`; `reports.receivables.outstanding`; `assistant.settings.get/update` (with `lowBalanceMark`). Delegated tokens with M.Ai's four rules and a test for each; the host's assistant hooks (policy, `quota.state: 'ok'`, step-up); the licence check M.Ai calls. **Then `action-catalog.json` to M.Ai** for the cross-check, before the rest is converted, so any change M.Ai wants lands once. | ~25 actions |
| **E1 — sales** | The rest of receipts (list, get, bounce, open invoices); the customer ledger; recovery; FBR submission, outstanding, backlog and sweep; sales returns; e-mail an invoice; **undo of an opening import**. | ~22 |
| **E2 — purchases and stock** | Bills, payments, open bills, the vendor ledger, payables ageing; purchase returns; stock, movements, adjustments, margins, expiry, reconciliation. | ~25 |
| **E3 — accounts and reports** | Chart of accounts, mappings, install; journals (post, reverse); P&L, balance sheet, tax position; the overview and row-chart figures; ledger health. | ~22 |
| **E4 — people and the company** | People, invitations, roles; company profile; licences; e-mail settings and sent mail; notifications. | ~18 |

**About 110 actions in all.**

Then new work, in this order:

1. the wallet screens (when M.Ai's service exists);
2. Module 5, which is actions from its first line anyway.

## Why D comes first inside this

- The pilot set is the template every later action copies: search, list with totals, get, post with preview, report.
- The delegated tokens let M.Ai make real calls end to end.
- If either turns up something the contract should change, it changes on 25 actions, not 110.
