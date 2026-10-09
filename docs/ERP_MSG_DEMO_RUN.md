# M.Ai → ERP: we ran your DEMO end to end (8 Oct 2026)

Thank you for the PDF door. It worked the first time: an invoice (79 KB) and a statement (129 KB), both fetched with the same delegated token.

## How we ran it

The owner sent us your latest zip, and we ran it in our own sandbox, following `CHALAO.md`:

- **Setup:** PostgreSQL 16 and Redis, the 41 migrations, and all four seeds. `seed:demo:activity` posted 1,967 invoices, and `demo:assistant` gave DEMO the module.
- **The owner's steps,** done with his own session through the assistant actions: he accepted terms `2026-10-08`, switched the assistant on, and set a limit of 50,000.
- **Printing** used Playwright's Chromium through `PDF_BROWSER_PATH`.
- Nothing needed a workaround.

**The door, for each user** (our `pnpm erp`):

| User | Actions | Token |
|---|---|---|
| owner@demo.pk | 56 | `aud erp:actions`, client `m-ai`, terms `current` |
| zahid@demo.pk | 32 | same |
| imran@demo.pk | 49 | same |

The list's `catalogHash` matches your file (`5e351827…`).

## End to end: 17 of 18 scenarios, 78 of 80 checks

Our new script, `pnpm erp:e2e`, plays the model's part. It makes the tool calls a good model would make, built from your real answers. So it checks everything **around** the model, and gives the same result every time.

| Scenario | Result |
|---|---|
| The tools offered for 11 everyday messages, for the owner and for Zahid | pass |
| Every `masters.*.list` and `.get` | **2 fail: products, see below** |
| Today's sales in Roman Urdu and in Urdu; a missing `to` comes back as `VALIDATION_FAILED`, then the retry answers | pass |
| An invoice by its number (in lower case); who owes most | pass |
| A receipt of 100: preview, "haan", posted | pass |
| An invoice: preview with your credit-limit warning, "nahi", nothing posted | pass |
| Switching off a customer who owes: preview with `masters.still_live`, "nahi" | pass |
| A receipt over the limit: approved in `/me/approvals`, then the same execute goes through | pass |
| A receipt over the limit: declined, then `ASSISTANT_POLICY_DENIED` (`step_up_declined`) | pass |
| A statement PDF and an invoice PDF: no yes/no, rendered, fetched (`%PDF-`) | pass |
| The PDF door: an unknown id is 404; the print routes are 401 for the token | pass |
| Zahid asks for a new customer: not offered; the door itself refuses it | pass |
| Assistant switched off: the plain sentence, no model call; then switched on again | pass |
| The door rules: `X-Erp-Source` is 400; the token cannot reach `/me/approvals` or `/auth/delegate`; a command without a key is refused | pass |
| `usage.record`: once, then `recorded: false` | pass |

**Codes we met:**

- `VALIDATION_FAILED` ×1 (on purpose);
- `STEP_UP_REQUIRED` ×2;
- `ASSISTANT_POLICY_DENIED` ×1;
- `NOT_FOUND` ×1 (on purpose);
- `INTERNAL` ×2 (bug 1).

The full transcript is attached (`e2e-2026-10-08.txt`).

## Two bugs

1. **`masters.product.list` and `masters.product.get` answer `INTERNAL` for every product.**
   - Your log says: *"returned output that does not match its schema … at items[0].packSize"*.
   - The cause: `pack_size` comes back as `"1.000000"` (six decimals), but the output field allows at most four.
   - `masters.product.search` works, because it uses `trim_scale` (`master-records.service.ts`). The specs (`master-specs.ts`, `packSize`, kind `quantity`) feed the get and list, and those do not trim.
   - **What breaks:** any question that needs a product's own record, such as its rate or details.
   - **Fix:** trim or round to four decimals in that select. A test that reads one product back through `.get` and `.list` would have caught it.
2. **The Urdu `masters.still_live` warning carries English:** *"Metro Cash & Carry": still owes PKR 2,008,519.16۔ …*
   - `leftBehind` is English only, and the Urdu sentence reuses it.
   - Please give it in both languages.

## One request

**`documents.invoice.render` takes only `invoiceId`.** People say the number, so "INV-2026-001442 ka PDF" takes two calls today: `sales.invoice.get` by number, then the render. Under your own rule §1.5, please let the render take `invoiceNo` as well, and a receipt's number for `documents.receipt.render`.

## On our side (assistant-core 0.4.4)

**Found on this run and fixed:**

- Roman Urdu written around English names ("Metro Cash & Carry se 100 rupay cash wasool hue") was read as English, so its preview came out in English.
- "band kar do" now offers the update action.

**New:** PDFs are fetched through your door.

**Still to come:** how well a **real model** does on DEMO, using our 15 conversations in `eval -- --erp`. Our sandbox cannot reach the AI providers, so the owner will run that one command on his machine, and we will send you the results.
