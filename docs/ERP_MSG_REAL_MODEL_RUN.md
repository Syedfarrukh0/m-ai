# M.Ai → ERP: a real model on your DEMO, 100% of checks (8 Oct 2026)

Thank you for both fixes, the renders by number, and migration 0042. The owner's numbering find was a good one.

## Your new catalog

| | |
|---|---|
| Hash | Recomputed: **matches** `a6c672f3…11966e9` |
| Changed | `documents.invoice.render` takes `{ invoiceNo }` or `{ invoiceId }`, and `documents.receipt.render` takes `{ receiptNo }` or `{ receiptId }`, each as two optional fields with no union. The seven updates' `leftBehind` is `{ en, ur }`. |

**On our side:** a number in the message now points to its document's actions for receipts (`RC-2026-…`) and for credit and debit notes (`CN-…`, `DN-…`) too. Our end-to-end script renders an invoice by its number, and falls back to the id on an older ERP.

## The first run with a real model

The owner ran our 15 live conversations on his machine. They used Groq `openai/gpt-oss-120b` against his DEMO, which still had the earlier zip.

| | |
|---|---|
| **Scenarios** | **13 of 13 passed** |
| **Checks** | **69 of 69 (100%)** |
| Not run | 2. Our script found no product on his DEMO, so these were skipped (see below). |
| Cost | $0.023 for the whole run |

**What passed, each checked against your own answers:**

- Today's sales in Roman Urdu and Urdu, and this month's in English.
- Sales by customer, who owes what, one customer's balance, an invoice by its number, and unpaid invoices.
- A statement PDF.
- A receipt of 100, posted after "haan".
- A receipt over the limit, which went to Approvals.
- Zahid unable to add a customer.
- Imran's phone change, previewed and then declined.

**Why two were skipped.** Our script picks a product from this month's sales by product. On the owner's DEMO that was empty, which is likely the seed stopping at the numbering bug. Before your fix, the product list answered `INTERNAL`. We now also look at the latest invoice's lines, and a scenario without its records is skipped rather than failed.

**Reply times averaged 60 seconds.** That was our model provider's free plan, which allows only a few thousand tokens a minute, so the run waited between calls. Your API answered well within a second: signing in, a token, the list and the context took 0.2–0.4 s per user. The next run counts those waits separately.

## Next

The owner will:

1. take your new zip;
2. run `pnpm db:migrate` (0042), then `pnpm dev`;
3. run `seed:demo:activity`, then `demo:assistant`;
4. run our door check, the end-to-end script and the real-model run again.

We will send all three results.
