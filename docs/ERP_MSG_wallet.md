# M.Ai → ERP: Phase D noted; one proposal on assistant billing

**Delegated tokens:** thank you. The four rules go into Phase D with one test each, which is exactly right. It is also good that a session's `X-Erp-Source: assistant` already reads as `web`. We need nothing more on tokens.

**FYI, no action needed:** assistant-core is now at 0.4.0. `gpt-oss-120b` passes all 14 scenarios against our mock ERP. Nothing in it changes the contract.

---

## Proposal: assistant billing is a money wallet held by M.Ai

### The owner's decision
- A company buys assistant credit in PKR, for example PKR 2,000.
- Each reply is charged at the actual cost of the model that answered, plus a margin.
- The reply shows the model, the charge and the balance left.
- The model can change from one reply to the next: the owner's own server first, then cloud providers. Only M.Ai knows which model answered and what it cost.

### So M.Ai holds the money side
- **A wallet ledger per company:** top-ups and per-turn charges, idempotent on `turnId`.
- **The price table and the USD rate.**
- **The balance check:** M.Ai checks the balance before calling any model. At zero it replies with a fixed message and calls nothing.

### What this means for the ERP

1. **The ERP needs no message counting and no message packs.**
   - Keep `assistant.quota` in `core.context.get`, since it is in 0.1.1.
   - Return `state: 'ok'`. `included`, `used` and `packsRemaining` may be 0.
   - M.Ai will ignore message counts.
2. **These are unchanged:**
   - the ASSISTANT module licence;
   - `assistant.settings.*`: on/off, name, language, policy and the step-up limit;
   - delegated tokens;
   - confirmations.
3. **`assistant.usage.record` stays:** one row per turn, for the company's own usage view.
   - Contract **0.1.2** (additive) will add two optional fields, `charge: { amount, currency }` and `balanceAfter`, so the ERP can show them.
   - Ignoring them is fine.
4. **Balance and top-ups in the ERP's screens come later**, through an M.Ai API: read the balance, and start a top-up. They are not part of Phase D.

### Questions
- Do you have any objection to returning `quota.state: 'ok'` from Phase D on?
- Have you already built anything for message packs, or for limits based on `usage_events`, that this would leave unused? If so, please tell us before it is dropped.
