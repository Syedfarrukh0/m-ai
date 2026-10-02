# M.Ai architecture

```
 Person ──WhatsApp / web chat / voice──►  APP (e.g. the ERP)                     M.Ai service
                                          ┌──────────────────────────┐           ┌──────────────────────────────┐
                                          │ Communication Gateway    │──webhook─►│ channels (next)              │
                                          │  message.received        │  signed   │  verify m-ai-signature       │
                                          │                          │           │  queue per conversation      │
                                          │ /auth/token-exchange  ◄──┼───────────┤  delegated token per turn    │
                                          │                          │           │            │                 │
                                          │ /actions/list|preview|   │◄──────────┤ assistant-core               │
                                          │          execute         │  as the   │  context → tools → model     │
                                          │  registry (action-       │  person   │  intercept changes → preview │
                                          │  contract) + ErpActionHost│          │  confirm → execute           │
                                          │                          │           │  numbers guard, usage        │
                                          │ messaging.send        ◄──┼───────────┤  reply                       │
                                          └──────────────────────────┘           └──────────────┬───────────────┘
                                                                                                │
                                                                                         model provider
```

## Who owns what

| | Owns | Never does |
|---|---|---|
| **App** | Data, permissions, licences, numbering, totals, previews, audit, the outbox, who a phone number belongs to. | Call a model. Import M.Ai, apart from `action-contract`. |
| **action-contract** | The vocabulary, the registry pipeline, the catalog, confirmations, webhook signatures. | Know any app. |
| **assistant-core** | Language, tool choice, the conversation, asking for confirmation, phrasing. | Touch a database, hold a credential, compute a figure, or execute without an explicit yes. |
| **channels / service** (next) | Webhooks in, tokens per turn, queueing, delivery, stores. | Decide anything about business data. |

## A WhatsApp order, end to end

1. Ali types: *"Madina Store ko 10 carton Pepsi"*. The gateway stores the message and delivers `message.received` to M.Ai, signed.
2. M.Ai exchanges the message id for a 5-minute delegated token. The token is Ali's, scoped by his permissions and the company's policy.
3. **assistant-core:**
   1. `core.context.get` → Roman Urdu, today, quota OK.
   2. The model searches for the customer and the product, then calls `sales.invoice.post`.
   3. The call is intercepted → `preview` → the app runs the real posting in a rolled-back transaction and returns the summary, a fingerprint and a confirmation.
   4. M.Ai asks: *"Ye hoga: Invoice INV-0005 … total 5310.00. Kya main ye kar doon?"*
4. Ali: *"haan"*. M.Ai executes with the confirmation and an idempotency key.
   - The app checks the fingerprint again, posts, writes the audit row and outbox event, and commits.
   - The model phrases the real result. The numbers guard checks the figures.
5. The reply goes out through `messaging.send`. Usage is reported, and the app counts it against the company's monthly messages.

## Safety, layered

1. **The app's registry decides:** permissions, licence, policy, quota, step-up, confirmation required for the assistant, and fingerprints bound to user + input.
2. **assistant-core asks:** every change is shown to the person as the app's own preview, and only a deterministic "yes" executes it.
3. **The numbers guard checks:** figures in replies must come from the app.

## Next

- **`@m-ai/channels` + the M.Ai service:**
  - webhook receiver;
  - token exchange;
  - per-conversation queue;
  - PostgreSQL stores;
  - web chat first, then WhatsApp via the ERP's Communication Gateway.
- **Proactive alerts:** alert deliveries come with alert-scoped tokens; the assistant phrases them and sends them through `messaging.send`.
- **Voice notes:** speech-to-text in the service, before `handleTurn`.
