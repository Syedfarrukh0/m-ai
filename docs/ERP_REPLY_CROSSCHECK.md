# ERP → M.Ai: your cross-check is done, and DEMO is ready for your run (8 Oct 2026)

Thank you for the careful check. All seven catalog points are taken: six are done today, and the readable statement is in E1. Your three requests (the webhook, `acceptBy` and the key names) are agreed, and the parts that can be built now are built. The new catalog is attached.

| | |
|---|---|
| Contract | 0.1.3 (unchanged) |
| Catalog hash | `afb6b51c3e4f20f2f252d3664c45633a8b82d5979ccb212dbb0335d7e5e63426` |
| Actions | **56** (one new: `assistant.terms.get`) |
| Errors / events | 52 / 21 |
| Largest tool | `sales.invoice.post`, about 6,700 characters; `masters.customer.update` is about 5,600 |

---

## 1. The cross-check, point by point

1. **Updates no longer carry the defaults for "create".**
   - In all seven `masters.*.update` actions, each field is described by what it is. A test refuses "left out", "leave it", "blank" or "is made" anywhere under `changes`.
   - `changes` says, once: *"Only what the person asked to change. null clears it."*
   - The defaults stay on `create`, where they belong: "When left out: unregistered", and "Leave it out and the next code (C-0001, …) is made".
2. **No `confirm` flag.**
   - Switching off a record that still has something left no longer refuses in the preview. The preview warns with code `masters.still_live`, for example: *"Owing Store" still owes PKR 1,200.00. Switching it off takes it out of every list and picker; that stays as it is.* The output carries `leftBehind: "still owes PKR 1,200.00"`.
   - **A confirmed execute is the person's yes**: no flag is needed or offered for it. The ERP knows an execute was confirmed because the registry has already checked the confirmation before the handler runs.
   - The maintenance screen skips the preview, so the flag stays for it, renamed **`switchOffAnyway`**. It is described as *"Only after the person has been told what is left … A confirmed preview already counts as their yes, so the assistant never needs it."* It exists only on the four lists where something can be left: customers, vendors, products and warehouses.
   - Without a preview and without the flag, the answer is still `masters.still_live` (409), saying what is left.
3. **"Company" as principal.**
   - All five `masters.company.*` descriptions now say *"principal companies (the brands whose goods you distribute, such as Nestlé)"*.
   - A reference to one reads *"The id of a principal company"*.
   - While we were there, salespersons, warehouses and categories got a short gloss too: bookers, van salesmen and supervisors; godowns and vans; product categories.
4. **`reports.sales.summary` without `groupBy` gives one total for the period:** `groupBy: null`, `items: []`, `totals.groups: null`. The first example is "Today's sales".
5. **`sales.invoice.get` takes `{ invoiceNo }` or `{ id }`, one of the two.**
   - The number is matched in any case and trimmed.
   - An unknown number answers 404, with the hint *"find it with sales.invoice.list and a word from it"*.
   - It is now a written rule (CONTRIBUTING §1.5) that **every document `get` in Phase E takes its number**: receipts, returns, bills and payments.
6. **A statement the assistant can read:** `receivables.statement.get`, first thing in E1, with the opening balance, the lines, the running balance, the closing balance and the ageing. `documents.statement.render` remains for the PDF.
7. **`daily` stays rare.**
   - It is on exactly two actions today: `sales.invoice.post` and `receivables.receipt.post`.
   - A test lists them, so adding one is a decision. CONTRIBUTING says "about six in the whole catalog".
   - Likely later additions are the credit note, the vendor payment, and the booker's order in Module 5.

**For E2:** stock on hand by product and warehouse is in the plan. Until then, your sentence ("cannot see stock yet") is right.

## 2. Hearing a decision: agreed

- **The payload is ready now.** The ERP's `assistant.stepup.approved` / `.declined` events already carry exactly what you listed:
  - `stepUpId`, `tenantId`, `requestedBy` (the token's subject);
  - `confirmationId`, `action`, `conversationId`, `clientId`;
  - `decidedAt` (UTC, `YYYY-MM-DDTHH:MM:SSZ`).
- **The delivery comes later.** Delivery as a signed `EventDelivery` with key `erp-1` comes with the balance events, before Phase G. The URL arrives with your sandbox.

## 3. The terms: agreed, and built

- **The rule.** A new version comes with `acceptBy`, and an older acceptance keeps working through that day (UTC). Two cases switch the assistant off at once: `urgent`, or a new version without `acceptBy`. This is a pure function with tests (`consentStanding`).
- **`assistant.terms.get`** (ASSISTANT, `tenant_settings:view`) returns:
  - `version`, `title`, `url`, `acceptBy` and `urgent`;
  - `standing`: `current`, `grace`, `lapsed` or `none`;
  - `accepted` (version, when, by whom).

  You can use it to tell an administrator *"new terms — accept by …"*. The assistant may read it; it can never accept.
- **The Assistant screen** shows the notice ("Version … — accept by …, or the assistant switches off then"), with **Read and accept**. Switching on asks for the terms first when the acceptance does not stand. Once the text has an address, the screen links to it.
- **Until the platform console publishes terms,** versions are a short list in the ERP's code. When the owner sends the approved text, we add its version and address there.

## 4. Keys: agreed

- **Inbound** (M.Ai → ERP) is `m-ai-1`. The owner makes it with `pnpm m-ai:keys add inbound m-ai-1` when you ask for it.
- **Outbound** (ERP → M.Ai) is `erp-1`, yours to make. He stores it with `pnpm m-ai:keys add outbound erp-1 <secret>`.
- He copies each secret himself, and only the key ids are written down.

## 5. DEMO, for your 14 conversations

| | |
|---|---|
| **Switching it on** | On the owner's machine, `pnpm demo:assistant` gives DEMO the module. The owner then switches it on himself in **Accounts → Assistant**: he accepts the terms, which is his act, and sets an approval limit (we suggest PKR 50,000 so you meet a step-up). |
| **Base URL** | `http://localhost:3001` is the API. The workbench is at `http://localhost:3000`; the owner approves step-ups there, under **Approvals**. |
| **A token from a script** | `POST /auth/login` with `{ "tenantCode": "DEMO", "email": "…", "password": "demo-password-1" }` returns `accessToken` (15 minutes) and `refreshToken` (renew at `POST /auth/refresh`). Then `POST /auth/delegate` with that bearer gives you `{ clientId: "m-ai", conversationId }`. |
| **Owner** | `owner@demo.pk`: everything. In our run, 56 actions offered. |
| **Booker** | `zahid@demo.pk`, the van salesman: he sees the masters, posts invoices and receipts, and sees stock. He cannot add or change records or touch settings. In our run, 32 actions offered; adding a customer answers `PERMISSION_DENIED`. |
| **A middle role, if useful** | `imran@demo.pk`, sales officer: he may also add and change records, and make credit notes. |
| **Data** | A year of everyday trading: shops, products, invoices, receipts, returns. To bring it up to today, run `pnpm seed:demo:activity`. |

**Why not a long-lived development token.** Two calls get you one, and a bearer token that outlives sessions is exactly what the door is built not to have.

**One caution.** Our browser suites take ASSISTANT back from DEMO when they finish, so run `pnpm demo:assistant` again after them.

**Codes you are likely to meet:**

| Code | What it means |
|---|---|
| `CONFIRMATION_REQUIRED` | A command sent without its preview |
| `IDEMPOTENCY_KEY_REQUIRED` | A command without a key |
| `PERMISSION_DENIED` | The person may not, or `reason: token_scope` |
| `ASSISTANT_POLICY_DENIED` | `disabled`, `destructive_not_allowed`, `module_not_allowed` or `step_up_declined` |
| `STEP_UP_REQUIRED` | Above the limit, with `stepUpId` and `expiresAt` |
| `masters.still_live` | Only when there was no preview |
| `sales.*` / `receivables.*` | Refusals, in English and Urdu |
| `MODULE_NOT_LICENSED` | With `module: ASSISTANT` |

We look forward to the results, every error code included.

## 6. Next on our side

**Phase E1**, in this order:

1. cash and bank accounts as actions and a screen (a new company cannot yet add one);
2. `receivables.statement.get`;
3. the rest of receipts and the customer ledger, with every document `get` taking its number;
4. FBR, sales returns, and e-mailing an invoice;
5. undo of an opening import.
