# M.Ai → ERP: your fixes confirmed on the owner's machine, and the E1 batch checked (8 Oct 2026)

Thank you for E1's first batch. The statement as data is exactly what the chat needed.

## The owner's run on your fixed DEMO

**`pnpm erp:e2e`: 18 of 18 scenarios, 80 of 80 checks.** Your three fixes hold:

| Fix | Seen on the run |
|---|---|
| The product `pack_size` bug | Every `masters.*.list` and `.get` answers |
| Renders by number | "render by number: yes"; the invoice PDF was 61 KB |
| Records found again | With 0042 and the catch-up seed, this month's sales by product came back |

**`eval -- --erp`, Groq `openai/gpt-oss-120b`: 7 of 8 scenarios, 36 of 38 checks.** Then our model provider's free plan ran out of tokens for the day.

The one miss was on our side, and your renders-by-number change brought it out:

- **What happened:** "INV-2026-001424 dikhao" (show it) made a PDF instead of reading the invoice.
- **The fix, in assistant-core 0.4.6:** the assistant now offers a render only when the person asks for a PDF, a print or a file. "dikhao" reads the document with `sales.invoice.get`.

Nothing for you to change. We will send the full run when the provider's limit allows.

## The new catalog

| | |
|---|---|
| Hash | Recomputed: **matches** `8b6766a6…52010982` |
| New | 4 actions. Each is one object at the top level, with one plain sentence and its tags. |
| Errors | The 4 new `accounts.*` codes come in English and Urdu |

**On our side:**

- **"bank", "cash", "paisa", "raqam", JazzCash and Easypaisa** bring `accounts.cash-account.list`.
- **"hisaab", "khata" and "statement"** bring `receivables.statement.get`, and the statement PDF only when it is asked for.
- **New tests:**
  - our live evals check a customer's account (`closing`) and the money in hand (`totals.balance`) against your answers;
  - our end-to-end script covers both, and skips them on an ERP from before E1.

**The receipt change suits us.** We leave `cashBankAccountId` out unless the person names an account, so a cheque now lands in the bank, as it should.

## Next

The owner will:

1. take this zip;
2. run `pnpm install`, `pnpm db:migrate` (0043), `pnpm dev`, `seed:demo:activity` and `demo:assistant`;
3. run our three checks again.

We look forward to the rest of E1.
