# M.Ai → ERP: the new catalog checked, ready for DEMO, and one question about PDFs (8 Oct 2026)

Thank you: all seven done in a day, and the terms rule built as well.

## The new catalog, checked

| | |
|---|---|
| Catalog hash | Recomputed: **matches** `afb6b51c…5e63426` |
| Actions | 56. Only `assistant.terms.get` is new; 27 descriptions or inputs changed. |
| Our picking test | All 15 everyday messages still get every action they need: on average 23 tools in about 17,600 characters, under our 24,000 budget |

**Checked by script:**

1. No field under `changes` in the seven updates says "left out", "leave it" or "is made". `changes` carries *"Only what the person asked to change. null clears it."*
2. There is no `confirm`. `switchOffAnyway` is on customers, vendors, products and warehouses only.
3. Every `masters.company.*` description says "principal companies".
4. `reports.sales.summary` requires only `from` and `to`, and its first example is "Today's sales".
5. `sales.invoice.get` takes `invoiceNo` or `id`. Our document-number hint already matches your format (`SI-000123`).
6. `daily` is on exactly `sales.invoice.post` and `receivables.receipt.post`.

**One thing to keep in Phase E:** you wrote "one of the two" for `sales.invoice.get` as **two optional fields in one object**, not as a union. Please keep that pattern. A union becomes a top-level `anyOf`, and some model providers refuse a tool whose input is not a single object.

## On our side (assistant-core 0.4.3)

- **`assistant.terms.get` is never offered to the model.** No `assistant.*` action is.
- **The renders run without a yes/no.** They need no confirmation in your catalog and change no records, so asking "yes?" before printing helps nobody. Each one still carries its own `Idempotency-Key`. Every other change is previewed and confirmed as before.
- **The run against DEMO is ready.** The owner runs it on his machine, because your API is on his `localhost`:
  - `pnpm erp` checks the door for the owner, Zahid and Imran. It shows the token's claims, the action count, whether the assistant is on, the approval limit and the terms' standing.
  - `eval --erp` runs 15 conversations on real DEMO records. It first reads a customer who owes, a product, an invoice number and the limit. It checks each figure in a reply against what your API answers for the same query.
  - **Changes on DEMO:** it posts **one receipt of PKR 100**, and leaves **one receipt above the limit waiting** in Approvals. Every other change is previewed, then declined.
- **Before the run, the owner will:**
  1. run `pnpm seed:demo:activity`, so "today" has sales;
  2. run `pnpm demo:assistant`;
  3. in Accounts → Assistant, accept the terms, switch the assistant on and set the limit to 50,000.

  We will send you the results with every error code.

## One question: how does a PDF reach the chat?

`documents.*.render` answers with a `documentId`: *"Open with GET /documents/{documentId}"*. But the delegated token opens only `/actions/*`. So M.Ai can make the PDF, but cannot fetch it to attach in WhatsApp or the web chat.

Two ways we can see:

1. **The delegated token may also `GET /documents/{documentId}`:**
   - only that company's documents;
   - read-only;
   - audited like an action.

   This is our preference. The file never passes through the model, and nothing new needs to expire.
2. **The render answers with a signed download link** that lasts a few minutes. This is simpler for you, but the model would see the link in the result. We tell it never to repeat a link, but we would rather it never saw one.

Whichever you choose, we can build to it now. Until then, the chat says the PDF is ready and gives its file name.

## Terms and keys: noted

- The owner sends the terms text when he has approved it.
- We will ask for `m-ai-1` when our service first calls the licence check.
