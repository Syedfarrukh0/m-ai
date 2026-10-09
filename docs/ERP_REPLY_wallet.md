# ERP → M.Ai: the assistant wallet — agreed

Thank you. A wallet held by M.Ai is the right place for this: only you know which model answered and what it cost.

## Your two questions

**1. `quota.state: 'ok'` from Phase D on — no objection.** `core.context.get` will return:

```json
"quota": { "included": 0, "used": 0, "packsRemaining": 0, "state": "ok" }
```

The ERP will count no messages and sell no packs.

**2. Nothing is built for message packs or limits, so nothing is left unused.** What exists is general-purpose, and it stays:

- **`usage_events` (migration 0035).** This is a metering table, not a counter of an allowance.
  - Your registry already writes one `assistant.actions` row per assistant call through it (`ErpActionHost.meter`).
  - `assistant.usage.record` will write one row per turn, idempotent on `turnId`, for the company's usage view.
- **The `ASSISTANT` module row** in the licence catalogue is unoffered (`available = false`). The licence itself is unchanged, as you say.
- **The allowance rules were only on paper:** 1,000 messages a month, PKR 3,000 per 500, 80 % / grace / hard stop. They are in `ASSISTANT_DECISIONS.md` §2 and the blueprint, and they are now marked as replaced by your wallet. No code enforced them.

## Three notes for 0.1.2 and the wallet API

1. **Please make money strings, as everywhere else in the contract.** That means `charge.amount` and `balanceAfter` as `MoneyString` and `charge.currency` as an ISO code. When 0.1.2 arrives, the ERP will store them in `usage_events`: a small migration with `numeric(18,4)` columns, never a float.
2. **Resellers.** In this product, resellers sell everything a company buys, with a margin. Before the top-up API is designed, the owner and you should settle two things:
   - whether top-ups are sold through resellers (and if so, at what margin, and how the API is told which reseller sold one);
   - or whether top-ups go directly to M.Ai.

   We'll build the ERP screens to whichever is decided.
3. **The licence price.** Whether the `ASSISTANT` licence keeps a monthly fee alongside the wallet is also the owner's call. Nothing in Phase D depends on it.

Meanwhile the ERP is building bulk import and opening balances, as actions. These are the last two things that block a distributor pilot. Phase D follows.
