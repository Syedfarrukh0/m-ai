# @m-ai/action-contract

The contract through which an app exposes its operations to its own clients (web, mobile, desktop, public API) **and** to the M.Ai assistant.

An app declares each operation once as an **action**. The registry then gives every caller the same pipeline:

- validation;
- permissions;
- licence;
- **preview → confirm → execute**;
- idempotency;
- audit;
- outbox events;
- metering;
- errors with stable codes, in English and Urdu.

The assistant discovers what the app can do at runtime from the **catalog**, so every new action the app registers is available to it with no change on the assistant side.

- Pure TypeScript + [zod](https://zod.dev) 4 (peer dependency).
- No app, framework, database, network or AI dependency.
- Hashing and signing use Web Crypto, so there are no `node:` imports.
- Node ≥ 20. ESM and CommonJS.

It isn't on npm yet. Each version is attached to its GitHub Release as `m-ai-action-contract-<version>.tgz`. Vendor that exact file and pin it:

```sh
# e.g. vendor/m-ai-action-contract-0.1.0.tgz
pnpm add ./vendor/m-ai-action-contract-0.1.0.tgz zod
```

Imports stay `@m-ai/action-contract`, whether you install from the tarball or (later) from npm.

---

## For the app

### 1. Declare actions

```ts
import { z } from 'zod';
import { defineAction, MoneyString, Uuid, IsoDate } from '@m-ai/action-contract';

export const invoicePost = defineAction<PostInput, PostOutput, Runtime, Events>({
  name: 'sales.invoice.post',        // <area>.<entity>.<verb>, stable forever
  version: 1,
  kind: 'command',
  module: 'SALES',                   // licence module
  description: 'Post a sales invoice for a customer: numbers it, adds sales tax and updates the balance.',
  tags: ['sales', 'invoices'],       // required; the assistant picks tools by module + tags
  input: PostInput,                  // zod
  output: PostOutput,                // zod
  permissions: ['invoice:create'],
  risk: 'financial',                 // read | write | financial | destructive
  requiresConfirmation: true,
  idempotent: true,
  handler: async (input, ctx) => {
    // ctx.runtime = your services, bound to this request's transaction (RLS set)
    // ctx.emit('invoice.posted', {...})  → outbox, same transaction
    // ctx.fail('sales.credit_limit_exceeded', { en, ur }, details) → stable error, rollback
    return { /* output */ };
  },
  // Describes the REAL output. In a preview it runs on a rolled-back transaction.
  preview: ({ result }) => ({
    summary: { en: `Invoice ${result.invoiceNo} for ${result.gross}`, ur: '…' },
    primaryAmount: result.gross,     // required for risk 'financial'
    changes: [{ op: 'post', entity: 'sales_invoice', ref: result.invoiceNo,
                label: { en: 'Sales invoice', ur: 'سیلز انوائس' },
                amounts: { net: result.net, tax: result.tax, gross: result.gross } }],
    warnings: [],
  }),
});
```

`defineAction` throws at boot, listing every rule the definition breaks (`DEFINITION_RULES`).

Other fields a definition can carry:

| Field | Use it for |
|---|---|
| `sensitive: ['cnic', 'owner.password']` | Input paths kept out of the audit log. |
| `sensitiveOutput: ['inviteLink']` | A secret the command returns **once** (an invitation or reset link). The caller gets it; the audit log and the idempotency store get `"[redacted]"`. A replay returns the redacted output with `meta.redacted: true`. |
| `availableWhenReadOnly: true` | A `write` command that only reads the books — printing an old invoice, exporting a report — so it still runs when the licence has lapsed to read-only. Shown in the catalog. |
| `paging: { defaultLimit, maxLimit }` | List queries. The registry applies the default and refuses anything above the maximum. |
| `deprecated: { since, useInstead }` | An old version that still runs, with a warning in `meta`. |

One operation whose permission depends on its input is **several actions**, each with a static permission. For example, `documents.invoice.render`, `documents.statement.render` and `documents.receipt.render` — not one `documents.render`. That way `list()` and the catalog stay exact. See `WELL_KNOWN_ACTION_PATTERNS`.

### 2. Implement the host once

`ActionHost` is the only app-shaped seam. It covers:

- `availability`: licence checks;
- `transaction`: one DB transaction with the tenant context set, rolled back when asked;
- `auditOutside` and `meterOutside`;
- `toError`: maps database/domain errors to codes;
- `confirmationSecret`;
- `afterCommit`: live hints to open screens;
- optionally `assistant`: settings, quota and step-up.

Inside a transaction the host provides:

- `emit`: outbox;
- `audit`;
- `claimIdempotency` / `storeIdempotency`;
- `consumeConfirmation`: a unique insert;
- `meter`.

```ts
import { createActionRegistry } from '@m-ai/action-contract';

const registry = createActionRegistry<Runtime, Events>({ host, producer: { name: 'my-erp', version } });
registry.register(invoicePost, /* … */);
registry.registerEvents(invoicePosted, /* … */);
registry.registerErrors({
  'sales.credit_limit_exceeded': { en: '…', ur: '…' },                      // 422, not retryable
  'documents.busy': { en: '…', ur: '…', http: 503, retryable: true },       // "try again in a moment"
});
registry.validate();
```

### 3. Expose it

Your controllers become thin wrappers over `registry.execute(ctx, req)`. For external clients, add three routes (`HTTP_ROUTES`):

| Route | Body | Returns |
|---|---|---|
| `POST /actions/list` | `ListRequest` | `ListResponse` (`actions`, `catalogHash`) |
| `POST /actions/preview` | `PreviewRequest` | `ActionResult<PreviewResult>` |
| `POST /actions/execute` | `ExecuteRequest` | `ActionResult` |

- Status code: `httpStatusOf(result)`.
- The `Idempotency-Key` header goes into `ctx.idempotencyKey`.

### 4. Test it

```ts
import { InMemoryHost, runContractChecks } from '@m-ai/action-contract/testing';

const report = await runContractChecks(registry, testHost, [
  { action: 'sales.invoice.post', ctx, input, isolation: { ctx: otherCompanyCtx } },
]);
expect(report.failures).toEqual([]);
```

The harness runs these checks on every command:

- permission denied;
- preview leaves no trace;
- preview is stable;
- preview === commit;
- outbox in the same transaction;
- idempotent replay;
- rollback on failure;
- tenant isolation.

`InMemoryHost` is a full host with real rollback. Use it for unit tests, or as a mock backend.

### 5. Export the catalog

```ts
writeFileSync('action-catalog.json', JSON.stringify(registry.catalog(), null, 2));
```

It contains every action with its JSON Schema 2020-12 input/output, every event, and every error code in `en` + `ur`. Commit it and snapshot-test it. See [`examples/action-catalog.example.json`](examples/action-catalog.example.json).

---

## How the pipeline behaves

### `execute`

1. **Resolve the action.** Unknown name → `UNKNOWN_ACTION`; unknown version → `VERSION_NOT_SUPPORTED`. A deprecated version still runs and adds a warning to `meta`.
2. **Token scope.** A delegated token with a `scope` that doesn't cover the action → `PERMISSION_DENIED`.
3. **Permissions.** The user must hold every required permission → `PERMISSION_DENIED`.
4. **Licence.** `MODULE_NOT_LICENSED`. `LICENCE_READ_ONLY` refuses commands, except those marked `availableWhenReadOnly`; queries still run.
5. **Assistant gates** (source `assistant`): enabled, policy (destructive, allowedModules), quota → `ASSISTANT_POLICY_DENIED` / `ASSISTANT_QUOTA_EXCEEDED`.
6. **Input.** Validated with zod → `VALIDATION_FAILED`. Paging defaults are applied and the maximum enforced. This comes after the access checks, so a caller without access learns nothing about the schema.
7. **Idempotency key.** Commands from mobile, desktop, api and the assistant must carry one → `IDEMPOTENCY_KEY_REQUIRED`.
8. **Confirmation.**
   - The assistant must send the one from its preview → `CONFIRMATION_REQUIRED`.
   - A tampered confirmation, or one bound to another user or action → `CONFIRMATION_REQUIRED` with `reason: invalid`.
   - An expired confirmation → `PREVIEW_EXPIRED`.
9. **Step-up.** For the assistant, a financial action whose `primaryAmount` is above the company's `financialLimit` needs approval in the app → `STEP_UP_REQUIRED`. A decline → `ASSISTANT_POLICY_DENIED` with `reason: step_up_declined`. A retry of an execute that already committed replays before this check runs.
10. **One transaction:**
    1. claim the idempotency key (same key again → replay; a different input → `IDEMPOTENCY_KEY_REUSED`);
    2. consume the confirmation (already used → `CONFIRMATION_USED`);
    3. run the handler;
    4. validate the output;
    5. re-describe the result and compare fingerprints (mismatch → `PREVIEW_STALE`, with the new preview in `details`);
    6. write the audit row, with `sensitiveOutput` redacted;
    7. store the idempotency result, also redacted (and handed `{ action, version }`);
    8. meter.

    Then commit, and call `afterCommit`.

### `preview`

`preview` runs steps 1–6. It then runs the **real handler** in a transaction that always rolls back, and returns:

- `preview`;
- `fingerprint`;
- `confirmationId`, which is stateless and HMAC-signed;
- `expiresAt`: 15 minutes for the assistant, 5 for others;
- `stepUp.required`.

The fingerprint covers action, version, tenant, user, input, `primaryAmount`, each change's op/entity/amounts/fields, and the warning codes. It deliberately ignores provisional document numbers and text.

### Errors

Every error carries:

- `code`;
- `message`, in the caller's language;
- `messages`, in `en` + `ur`;
- `http`, the status on `/actions/*`;
- `retryable`;
- optional `details`.

Standard codes take their status and retryability from `STANDARD_ERRORS`. Module codes take theirs from `registerErrors`; the default is 422, not retryable. Unexpected errors become `INTERNAL`, with no detail leaked, and are passed to `host.logError`.

---

## For the assistant

The assistant uses:

- `AssistantSettings`: name, language, tone, policy, consent;
- `CoreContextOutput`, from `core.context.get`;
- `SearchItem`;
- `AssistantUsageRecordInput`;
- `WELL_KNOWN_ACTIONS` and `WELL_KNOWN_ACTION_PATTERNS` (with `matchesActionPattern`);
- `alertTokenScope()`;
- `EventDelivery`;
- `verifyWebhook()`.

For webhooks:

- Verify every delivery on the **raw** body before parsing.
- Dedupe on `eventId` + `recipient.userId`.

```ts
import { EventDelivery, verifyWebhook, WEBHOOK_HEADERS } from '@m-ai/action-contract';

if (!(await verifyWebhook(secrets, rawBody, req.headers[WEBHOOK_HEADERS.signature]))) return 401;
const delivery = EventDelivery.parse(JSON.parse(rawBody));
```

---

## Versioning

Semver. While in `0.x`, a breaking change bumps the minor version. The ERP pins exact versions.

- **v0.1.x** knows the `stepUp` modes `'none' | 'app'`. Unknown values parse as `'app'`, the strictest.
- **0.2.0** will remove `WELL_KNOWN_ACTIONS.documentsRender`. It is deprecated in 0.1.1; use `documents.<kind>.render`.
