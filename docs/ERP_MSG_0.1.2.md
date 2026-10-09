# M.Ai → ERP: action-contract 0.1.2 (the wallet fields), and the owner's two decisions

Thank you. We noted that `quota.state: 'ok'` starts in Phase D, that `usage_events` stays, and that the paper allowance rules are now marked as replaced.

## 0.1.2 — attached

| | |
|---|---|
| File | `m-ai-action-contract-0.1.2.tgz` |
| sha256 | `b220a3c68e13b347ad40486b8e79e5ae8380cd69bca9fea118d48a2d2c1ae87a` |
| Built from | commit `950adc0` |
| Tests | 105, all passing |

**It is additive.** A 0.1.1 host and a 0.1.1 record both stay valid. If an assistant sends the new fields to a host still on 0.1.1, they are silently dropped (zod strips unknown keys), so nothing fails. Vendor 0.1.2 together with your `usage_events` migration, whenever that suits Phase D. Use `vendor/m-ai-action-contract-0.1.2.tgz` plus its line in `vendor/SHA256SUMS`.

### What changed (your note 1)

`AssistantUsageRecordInput` gains two optional fields:

| Field | Type | Meaning |
|---|---|---|
| `charge` | `{ amount: MoneyString, currency: CurrencyCode }` | What the company was charged for this turn from its M.Ai wallet: the cost of the model that answered, margin included. |
| `balanceAfter` | `MoneyString` | The wallet balance after this charge, in `charge.currency`. |

- **`CurrencyCode`** is new: an ISO 4217 code in capitals, such as `"PKR"`.
- **`balanceAfter` without `charge` is refused**, because the charge gives it its currency.
- **`balanceAfter` can be slightly negative.** The reply that crosses zero is still charged in full, and the next top-up covers it. M.Ai refuses new turns at zero or below. `numeric(18,4)` holds this as-is.
- **Charges are rounded up to 2 decimals**, so in PKR they are whole paisa. `MoneyString` allows up to 4.
- **The example catalog** in the tarball is regenerated and shows both fields.

## The owner's decisions (your notes 2 and 3)

1. **Top-ups can be bought both ways: from the company's reseller, or directly from M.Ai.**
   - **Reseller's cut:** a reseller earns it only on the top-ups it sells. The owner sets the cut per reseller in M.Ai.
   - **Naming the reseller:** the top-up API takes an optional `resellerId` (the ERP's reseller id) for this.
   - **For the pilot**, a top-up is entered by hand once cash or a bank transfer is received, by the reseller or by the owner. Online payment comes later.
   - **The API draft:** we will send the top-up and balance API before the ERP screens are designed.
2. **No monthly fee for now.** The `ASSISTANT` licence carries no monthly fee alongside the wallet; the margin on each reply is the income. The owner will look at this again after the pilot.

## Next

- **ERP:** bulk import and opening balances, then Phase D, then `action-catalog.json`. We'll cross-check the catalog when it arrives.
- **M.Ai:** the wallet service (ledger, top-ups, balance), and a draft of its API for the ERP screens.
