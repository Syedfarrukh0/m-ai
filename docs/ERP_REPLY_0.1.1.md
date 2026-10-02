# M.Ai → ERP: answers to your 0.1.0 review, and `@m-ai/action-contract` 0.1.1

Thank you — the nine checks against ERP-shaped definitions were exactly what was needed.

**Short version:** §3 → **option 1**, one action per kind. **Yes to all five asks (A–E).** They are in **0.1.1**, attached:

| | |
|---|---|
| File | `m-ai-action-contract-0.1.1.tgz` |
| sha256 | `fc29b20105127dad4aeeba2ff452c87b68fd3f5d420907073180cef759d3b225` |
| Built from | commit `35ec6bb` |
| Tests | 98, all passing |

**0.1.1 is additive.** A host written against 0.1.0 still compiles: two-argument `claimIdempotency` and `storeIdempotency` included, which we checked. Vendor it as `vendor/m-ai-action-contract-0.1.1.tgz`. The GitHub Release `action-contract-v0.1.1` follows from the same commit once the repo is pushed; you don't need to wait for it.

---

## §3 `documents.render` → option 1: one action per kind

| Action | Permission | Notes |
|---|---|---|
| `documents.invoice.render` | `invoice:view` | module `FBR` |
| `documents.statement.render` | `invoice:view` | module `FBR` |
| `documents.receipt.render` | `receipt:view` | module `FBR` |

For all three:

- Tags: `documents` + `render`, plus your intent tag.
- `risk: 'write'`, `availableWhenReadOnly: true` (ask B).

**Why not option 2.** With an `anyOf` permission the list would still be loose. The catalog would also need per-input rules, and so would the assistant. Static permissions keep one rule everywhere. It is also the same shape as `masters.<entity>.search`.

**In the package:**

- `WELL_KNOWN_ACTION_PATTERNS.documentsRender = 'documents.<kind>.render'`, with `matchesActionPattern()`.
- `WELL_KNOWN_ACTIONS.documentsRender` is **deprecated** and will be removed in 0.2.0.

## A. Module errors carry their own status — yes

- **Registering.** `registerErrors({ 'documents.busy': { en, ur, http: 503, retryable: true } })`.
  - `http` must be between 400 and 599; the default is 422.
  - `retryable` defaults to false.
- **On every error.** Each `ActionError` now carries `http` and `retryable`, standard codes included (from `STANDARD_ERRORS`). `httpStatusOf` uses `error.http`.
- **Retryable standard codes:** `RATE_LIMITED` and `IDEMPOTENCY_IN_PROGRESS`.
- **In the catalog.** `errors[]` exports `http` and `retryable` for every code.
- **Your mapped errors.** Errors from `toError` are stamped the same way. So **register every module code that `toError` can return**; an unregistered one travels as 422, not retryable.

## B. `availableWhenReadOnly` — yes

- **Where it's allowed.** Only on `kind: 'command'` with `risk: 'write'`; this is a definition rule.
- **What it does.** `execute`, `preview` and `list` let such commands through on `LICENCE_READ_ONLY`.
- **In the catalog.** A field, `availableWhenReadOnly`, which is always `true` for queries.
- **Drop the tag workaround.** `ErpActionHost.availability` should answer `LICENCE_READ_ONLY` plainly; the registry decides.

## C. The host is told the action — yes

The scope is passed as the last argument, so 0.1.0-shaped hosts still compile:

```ts
claimIdempotency(key, inputHash, { action, version })
storeIdempotency(key, inputHash, result, { action, version })
```

- The replay peek before step-up passes the same scope.
- Keep `action` / `action_version` **NOT NULL**. Migration 0037 needs no idempotency change.

## D. Examples ship — yes

`examples/action-catalog.example.json` is in the tarball, so the README link now resolves.

## E. `sensitiveOutput` — yes, as you specified

- **Paths.** `sensitiveOutput: ['inviteLink', 'reset.url']`: dotted paths, and arrays are walked.
- **First response.** Unchanged: the caller gets the secret once.
- **Stored copies.** The audit entry's `result` and the result passed to `storeIdempotency` are both redacted to `"[redacted]"`. `StoredResult.redacted` is `true` when anything was replaced.
- **Replay.** A replay returns the redacted output with `meta.redacted: true`. A client that lost the first response must ask for a new invite or reset under a new key — which is the point.
- **Previews.** A `preview()` description is shown to people and is not redacted. Keep secrets out of `summary`, `changes` and `warnings`. Invite and reset commands usually need no preview at all.

## Noted from your review — no change needed

- `action_confirmations` as its own table, with `ON CONFLICT DO NOTHING RETURNING`. That's better than our suggestion, for both reasons you gave.
- `afterCommit` is unused, because `pg_notify` fires at commit. Fine; it stays optional.
- Sales, receivables and printing are module `FBR`. The README's `SALES` is only an example.
- Your closed tag vocabulary on top of `TAG` (one area tag + one intent tag): fine. The assistant uses module + tags.
- `aud: 'erp-actions'`, with `scp` carried into `ctx.actor.scope`: fine.
- `@erp/contracts` re-exporting our 21 codes: yes. Note that `ASSISTANT_QUOTA_EXCEEDED` is 402, not 429.

## Next — as you listed

1. Vendor 0.1.1.
2. Build:
   - `ErpActionHost`;
   - `/actions/list|preview|execute`;
   - migration 0037: `action_confirmations` and the step-up table. No idempotency change.
3. Switch `@erp/contracts` to re-export our standard errors, `MoneyString`, `IsoDate` and `Uuid`.
4. Run `runContractChecks` over PostgreSQL in `pnpm verify`.
5. Make `documents.{invoice,statement,receipt}.render` the first real actions, with `availableWhenReadOnly: true` and `documents.busy` registered as 503 and retryable.
6. Phase D pilot. Then send `action-catalog.json` for the cross-check.
