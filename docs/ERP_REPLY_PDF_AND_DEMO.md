# ERP → M.Ai: the PDF door is built (your option 1), and DEMO is ready (8 Oct 2026)

Thank you for checking the new catalog. Short answers, then the PDF.

| | |
|---|---|
| Catalog hash | `5e351827ec60e3eea5eab577e498f774c65112b67f34e0c19276f83e2a31a4eb` |
| Actions | Still 56 |
| What changed | Only the description of the renders' `documentId`, which now says the same token fetches the file |

## Your notes

- **One plain object, never a union.**
  - Kept, and now enforced: the API refuses to start if any action's input is not a single object at the top (no `anyOf`, `oneOf` or `allOf`).
  - A test proves the rule.
  - It is written in CONTRIBUTING for Phase E.
- **Renders without a yes/no:** agreed. They need no confirmation in the catalog, and each carries its own `Idempotency-Key`, as you do.
- **The DEMO run:** the owner has the steps. One addition: `pnpm seed:demo:activity` talks to the API, so the API must be running when he runs it.

## The PDF: option 1, built and tested

**What the delegated token may fetch.** It may now `GET /documents/{documentId}` — that route and no other outside `/actions/*`. The file goes from our server to yours and never through the model.

**The answer:**

- `200`, with `application/pdf` bytes.
- Headers:
  - `content-disposition: inline; filename="Invoice INV-2026-001402.pdf"`;
  - `x-document-id`;
  - `cache-control: private, no-store`.
- `?download=1` makes it an attachment.

**Held to the same rules as an action:**

| Rule | What happens |
|---|---|
| The ASSISTANT licence, and your four rules | `X-Erp-Source` is refused on this route too |
| The company's settings | Switched off → `ASSISTANT_POLICY_DENIED` with `reason: disabled`. If `allowedModules` is set, it must include `FBR`. |
| The token's scope | No scope; or `allowReadModules` containing `FBR`; or `allowActions` containing one of the three `documents.*.render` |
| The person's own permission for that kind of document | `invoice:view` for invoices and statements, `receipt:view` for receipts |
| Only that company's files | Another company's id is `404` |
| Nothing else | The print routes (`/documents/invoices/{id}/pdf` and the like) stay closed to the token: `401` |

**Audited** as `documents.file.get`: a query, `read`, source `assistant`, with the client, the conversation and the outcome.

**A refusal** comes in the ERP's REST shape, not the `ActionResult` envelope:

```
{ code, message, messages: { en, ur }, details }
```

with its status: 403, or 404 for no such file.

**How long a file lasts.** Seven days; after that the answer is 404, so render again. An unchanged document is not printed twice: the render hands back the same file at once.

**A real run against DEMO**, as your script would do it:

1. `sales.invoice.list`.
2. `documents.invoice.render`, which returned "Invoice INV-2026-001402.pdf".
3. `GET /documents/{id}` with the same delegated token: 200, a 77,888-byte PDF.

The tests also cover:

- the audit row;
- the print routes refused;
- another company's file refused;
- the three ways a scope can allow it;
- the assistant switched off;
- the person's own session unaffected.

## Next on our side

Phase E1, starting with cash and bank accounts and `receivables.statement.get`.
