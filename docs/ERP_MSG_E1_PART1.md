# ERP → M.Ai: four new actions, receipts go where the money went, new catalog (8 Oct 2026)

Thank you for the real-model run: 13 of 13 scenarios and 69 of 69 checks. The two product scenarios were skipped because the seed stopped at the numbering bug. With 0042 and the catch-up seed, this month's sales by product are filled again, so they should run next time.

This is the first batch of Phase E1. **No action you already use changed shape.**

## The catalog

| | |
|---|---|
| Hash | `8b6766a605a3f35f6e42e53e694a58924a8c75a15606bbba1645c47252010982` |
| Counts | 60 actions (from 56), 56 errors (from 52), 21 events (unchanged) |
| Contract | 0.1.3 |

## New

| Action | Module · permission | What it is for |
|---|---|---|
| `accounts.cash-account.list` | CORE · `account:view` | The cash counters, banks and mobile wallets, with what the general ledger says each holds today, and the total. For "bank mein kitna paisa hai?" |
| `accounts.cash-account.create` | CORE · `account:create` | Adds a bank, a cash counter or a mobile wallet. It needs confirmation. The preview says where the money will post: "Add the bank account "HBL current" as HBL-CURRENT, posting to ledger account 1130 HBL current." |
| `accounts.cash-account.update` | CORE · `account:update` | Renames an account, changes its bank details, or switches it off. It needs confirmation, and `null` clears a field. |
| `receivables.statement.get` | FBR · `invoice:view` | Your ask: the statement as data. See below. |

**`receivables.statement.get`.** Input `{ customerId, from?, to? }`.

- **Defaults:** the period runs from the first day of this month to today.
- **What it answers:**
  - `opening`: what the customer owed before the period.
  - `entries`: every document in the period, oldest first, each with `balance` after it.
  - `totals`, and `closing`: what the customer owes at the end.
  - `ageing`: given only when the period ends today, otherwise `null`.
- **Same figures as the PDF.** It uses the same query as `documents.statement.render`, so the chat and the PDF cannot disagree.
- **At most 500 lines.** A longer period is refused as `VALIDATION_FAILED` on `from`, with "Choose a shorter period"; the PDF takes more.

**New refusals, each in English and Urdu:**

- `accounts.code_taken`
- `accounts.has_balance`: "HBL current still holds PKR 12,500.00. Move it to another account first, then switch it off."
- `accounts.ledger_not_suitable`
- `accounts.no_place_in_chart`

## Changed behaviour, same shape: `receivables.receipt.post`

When `cashBankAccountId` is left out, a receipt used to go to the first account by code, so a cheque landed in cash. Now:

- **cash** goes to a cash account;
- **a cheque, a transfer, online or a card** goes to a bank account.

The right kind comes first, then cash. The field's description says so. To name an account, take its id from `accounts.cash-account.list`.

**Also new on our side.** Every company now starts with "Cash in hand" (migration 0043). Before this, a freshly provisioned company had nowhere to receive money: its first receipt, from a screen or from you, was refused with `receivables.no_cash_account`. DEMO is unchanged: Main counter and Meezan current.

## For the owner's next run

1. Take the new zip.
2. Run `pnpm install`, then `pnpm db:migrate` (0043), then `pnpm dev`.
3. Run `pnpm seed:demo:activity` and `pnpm demo:assistant`.

Nothing else changed for your scripts.

## Next from us

The rest of E1:

1. receipts list, get by number, and bounce;
2. open invoices;
3. the customer ledger;
4. recovery;
5. FBR;
6. sales returns;
7. e-mailing an invoice;
8. undoing an opening import.

We will send the catalog again when that batch is done.
