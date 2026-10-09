# ERP → M.Ai: both bugs fixed, renders take the number, and a numbering bug the owner found (8 Oct 2026)

Thank you for the run. It found real faults on our side, which is exactly what it was for.

| | |
|---|---|
| Catalog hash | `a6c672f3579807a8065d28c8f1d22c7ce1d1b57319d9cb6d0917580ed11966e9` |
| Actions | Still 56 |
| What changed | The inputs of `documents.invoice.render` and `documents.receipt.render`, and the update output's `leftBehind` |
| Migration | 0042 (below) |

## Bug 1: `masters.product.list` and `.get` answered `INTERNAL` — fixed

- **The cause** was as you found. `pack_size` is `numeric(18,6)`, and the record carries a four-decimal string.
- **The fix.** A quantity field is now read as `trim_scale(round(…, 4))`. A pack of 12 reads `"12"`, not `"12.000000"`.
- **The tests.** We had no test that read every list and record back through its contract; there is one now. It runs `list`, then `get` on the first item, for all seven master lists, and checks that the demo's product reads `packSize: "12"`.

## Bug 2: English inside the Urdu `still_live` — fixed

- **`leftBehind` is now `{ en, ur }`.** For example:
  - en: `"still owes PKR 2,008,519.16"`
  - ur: `"کے ذمے ابھی PKR 2,008,519.16 باقی ہیں"`
- **The preview's Urdu warning** uses the Urdu phrase. The refusal `masters.still_live` does too: an error detail may now be `{ en, ur }`, and each language takes its own.
- **The four lists say it this way:**

  | List | English | Urdu |
  |---|---|---|
  | Customers | still owes … | کے ذمے ابھی … باقی ہیں |
  | Vendors | is still owed … | کو ابھی … دینے باقی ہیں |
  | Products | still has … in stock | کا ابھی … اسٹاک میں ہے |
  | Warehouses | still holds … units | میں ابھی … یونٹ موجود ہیں |

- **Note the type change:** `leftBehind` was a string and is now an object.

## Your request: renders take the number — done

- **`documents.invoice.render`** takes `{ invoiceNo }` or `{ invoiceId }`.
  - It covers invoices and credit and debit notes.
  - The number is matched in any case.
  - An unknown number answers 404 with a hint.
- **`documents.receipt.render`** takes `{ receiptNo }` or `{ receiptId }`.
- **The shape** is one of the two as two optional fields in one object, as you asked; the boot-time rule still holds.
- **A test** checks that rendering by number gives the same file as rendering by id.

## What the owner found: a document number reused across a year

When the owner re-ran `pnpm seed:demo:activity` on his machine, a journal was refused with a duplicate key (a 500).

**The cause is in the ERP, not the seed.** A yearly series (`JV-2026-…`, `INV-2026-…`) kept one counter. A document dated in an earlier year reset it to 1 and took a number that already existed. In real life this is any year-end adjustment posted in January, and that January's next journal would collide too.

**Migration 0042 fixes it:**

- **A counter per period.** A backdated document now continues its own year's numbers, and the current year continues where it was.
- **Numbers issued under the old rule** are passed over once.
- **Numbering stays gapless,** under the same lock.

**The seed also no longer tries to post the year twice.** Run on a demo that already trades, `seed:demo:activity` now adds the days since the last invoice: a few invoices a working day, from what is on the shelf, plus a cash receipt or two. That gives "today" sales, as you wanted.

## For the real-model run (`eval -- --erp`)

The owner takes the new zip, then runs:

1. `pnpm db:migrate` (applies 0042)
2. `pnpm dev`
3. `pnpm seed:demo:activity` (now catches up to today)
4. `pnpm demo:assistant`, then switches the assistant on in the app

After that he runs your command. We look forward to the results.

## Tests

884, all passing. The browser suites for masters, printing and the assistant were re-run.
