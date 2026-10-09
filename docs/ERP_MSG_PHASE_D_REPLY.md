# M.Ai → ERP: the Phase D catalog checked, and our four answers (8 Oct 2026)

Thank you. Phase D is what we hoped for: the door is narrow, the rules are tested, and the step-up flow fits our chat without changes.

## What we checked

| | |
|---|---|
| Catalog hash | Recomputed with `catalogHash()`: **matches** `2388779d…dea02e5e` |
| Actions | 55. Every description is one sentence of at most 200 characters, with an area tag and one intent tag. |
| Errors | 52, all with `en` and `ur` |
| As model tools | All 55 convert cleanly for every provider we use (name length, characters, schemas) |
| Picking the right actions | **15 everyday messages** in Roman Urdu, Urdu and English: each one gets every action it needs |

**About the picking test:**

- It covers posting an order, a receipt, "INV-0002 dikhao", changing a phone number, today's sales, who owes what, a statement, and Nestlé's sales this month.
- On the first run, 4 of the 15 missed an action. The fixes were all on our side: the words people use ("carton", "wasool", "badal do") and your `daily` tag. Now none miss.
- This test now runs on your file with every build of ours (assistant-core 0.4.2).
- The tool definitions stay under 24,000 characters per message, about 7K tokens.

**On our side, to match the door:**

- The client id is `m-ai`.
- A repeated `usage.record` answers `recorded: false`.
- `MODULE_NOT_LICENSED` in the middle of a token gets the person a plain sentence: "your company does not have the assistant licence".

## 1. Hearing a decision: yes, a signed webhook please

**The delivery.** Please send `assistant.stepup.approved` and `assistant.stepup.declined` as an `EventDelivery`, signed with `signRequest()` and your outbound key, like the balance events. We will give you the URL with the sandbox.

**The payload.** What you listed, plus three fields:

- `stepUpId`, `confirmationId`, `conversationId`, `clientId`;
- `tenantId`;
- `requestedBy`: the person whose chat it is (`act.sub`);
- `decidedAt`.

Who decided is not needed.

**What we do with it.**

1. We tell the person in their chat: "approved, posting now", or "declined".
2. If their chat is open, we send the same execute straight away with a fresh token. Otherwise it goes on their next message.
3. "Done" in the chat keeps working as it does today.

**When.** With the balance events, before Phase G, as you suggest.

## 2. The AI terms

**The text.** The owner will send it, in English and Urdu, once he has approved it. It will say:

- which model providers a message may go to;
- what is sent to them;
- that nothing is used for training;
- how long conversations are kept;
- that each reply is charged from the wallet.

**Versions.**

- A version is the date it takes effect, `YYYY-MM-DD`, as you already show.
- A new version comes only when what happens to the data changes: a new kind of provider, what is sent, or how long it is kept. A wording fix keeps the version.
- Each version will have a stable address that never changes, plus a "latest" address. Until the M.Ai service runs, we send the text as a file.

**One request.** A new version should not switch off every company's assistant on the day it appears.

- We would send it with an `acceptBy` date, normally 30 days later.
- Until then, administrators see the new text and the old acceptance keeps working.
- After `acceptBy`, the assistant is off until they accept.
- We would mark a version urgent only if the law requires it, and then it switches off at once, as you describe.

## 3. Key ids and handover

| Direction | Key id | Made by |
|---|---|---|
| Inbound, M.Ai → ERP | `m-ai-1` (then `m-ai-2` at rotation) | you |
| Outbound, ERP → M.Ai | `erp-1` (then `erp-2`) | us, when the service runs |

**Handover.** The owner runs both servers, so the secret never needs to travel in a message:

- he copies it himself from your secret store into ours;
- only the key id is ever written down.

We don't need the inbound key until our service calls the licence check, and we will say when.

## 4. The cross-check: what we would change before Phase E

In order of importance:

1. **Updates should not carry the defaults for "create".**
   - In all seven `masters.*.update` actions, fields under `changes` keep the wording for "create". For example, "Leave it out and the next code (C-0001, …) is made", and "When left out: unregistered".
   - On an update, leaving a field out means "no change". A model that reads "when left out: unregistered" may send it to be safe, and reset a registered customer.
   - Please describe each field by what it is, and say once on `changes`: *"Only what the person asked to change. null clears it."*
2. **`confirm: boolean` on master updates.**
   - The name sounds like the system's own confirmation. A model may set it to `true` on its own to get past `masters.still_live`.
   - We would rather the **preview** showed what is left (the balance or the stock) as a warning, and treated the person's "yes" as the consent.
   - If the flag must stay for other callers, please rename it (e.g. `switchOffAnyway`) and describe it as *"only after the person has been told what is left and still wants it off"*.
3. **"Company" means two things.**
   - In `masters.company.*` it means the principal, the brand whose goods are distributed. Everywhere else, including `core.context.get` and the settings, it means the business using the ERP.
   - Please keep the names, but describe them as the principal. For example: *"Find principal companies (the brands whose goods you distribute, e.g. Nestlé) by name, code or phone…"*.
4. **`reports.sales.summary`: make `groupBy` optional.** "Aaj ki sale kitni hui?" wants one number. Left out, it would give one total for the period.
5. **Find a document by its number.**
   - People say "INV-0002", not an id. Today that takes two calls: `sales.invoice.list` with the number as `query`, then `.get`.
   - Please let `sales.invoice.get` take `{ invoiceNo }` instead of `id`.
   - This is the pattern we would most like copied into Phase E: every document `get` (receipts, returns, purchase invoices) accepts its number.
6. **A statement the assistant can read.**
   - "Madina ka hisaab dikhao" today can only become a PDF (`documents.statement.render`).
   - A query version in E1 would let the chat answer in words, with a link to the PDF if wanted. It would return the lines, the running balance and the closing balance, e.g. `receivables.statement.get`.
7. **Keep `daily` rare.** It puts an action in front of every message, which is right for posting an invoice and a receipt. Please add it only to postings that happen many times a day, perhaps six in all.

**Nothing to change:**

- the catalog hash (we compute it);
- the bulk imports (we never offer `bulk`);
- the plumbing actions in the list (we hide them);
- the sizes. The largest tool, `masters.customer.update`, is about 5,000 characters, and that fits.

**One thing for E2:** stock on hand by product and warehouse ("Pepsi ka stock kitna hai?"). We know it is planned. Until then, the assistant says it cannot see stock yet.

## 5. Trying the door end to end

**Yes, please switch on ASSISTANT for `DEMO`.** To call it from our terminal chat, we need:

1. **A way for a script to get a DEMO session token**, to then call `/auth/delegate`. For example, a login for a test user, or a long-lived development token for DEMO only.
2. **Test users:** one owner and one booker. Then we can check that a booker cannot see what an owner can.
3. **The base URL**, and whether DEMO has everyday data: a few shops, products and invoices.

**What we will run:** our 14 test conversations, against your real handlers for the first time. We will send you the results, including every error code we receive.

## Next on our side

- The M.Ai service, starting with the wallet.
- The run against DEMO, as soon as we have a token.
