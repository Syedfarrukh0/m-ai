# @m-ai/service

M.Ai's server: the web chat, and turns for apps that hand over a person's delegated token.

```sh
pnpm --filter @m-ai/service start
# → Web chat: http://127.0.0.1:3100/
```

It reads the same `.env` as the terminal chat:

- **The model:** `M_AI_PROVIDER`, `M_AI_MODEL`, keys, fallbacks, billing.
- **The app:** `M_AI_ERP_URL` and `M_AI_ERP_TENANT`.
- **The server:** `M_AI_SERVICE_HOST` and `M_AI_SERVICE_PORT` (see `.env.example`).

## Two ways in

**The app's way (the one to ship).**

- The person is signed in to the app. The app asks itself for a delegated token for M.Ai (`POST /auth/delegate`, client `m-ai`; five minutes; `/actions/*` and `GET /documents/{id}` only), and sends it with each message:

  ```
  POST /v1/apps/erp/turn
  Authorization: Bearer <delegated token>
  { "conversationId": "chat-01", "text": "aaj ki sale kitni hui?", "choice": "yes" | "no" (optional) }
  ```

- **Who the person is** comes from the app itself: `core.context.get` with that token. It never comes from the token's own claims.
- **M.Ai never sees a password or a session.**
- **A PDF the turn made:** `GET /v1/apps/erp/documents/{documentId}`, with the same token.

**The pilot's way (until the app embeds the chat).**

- The person signs in on M.Ai's page with their app account, and M.Ai signs in to the app for them (`/auth/login`).
- **The password** is passed on, never kept.
- **The app's session** stays in this server's memory only, and ends after 8 idle hours or at sign-out.
- **The cookie** is HttpOnly and SameSite=Strict.
- **Meant for a server on the owner's own machine.** It listens on 127.0.0.1 unless told otherwise. Put HTTPS in front before opening it to other machines.

## What a turn answers

```json
{
  "turnId": "…",
  "reply": "Ye hoga: … Kya main ye kar doon?",
  "status": "answered | awaiting_confirmation | awaiting_approval | cancelled | refused | unavailable",
  "language": "ur-Latn",
  "pending": { "action": "receivables.receipt.post", "options": [{ "value": "yes", "label": "Haan" }, { "value": "no", "label": "Nahi" }] },
  "documents": [{ "documentId": "…", "fileName": "Statement C001 to 2026-10-09.pdf" }],
  "usage": { "model": "openai/gpt-oss-120b", "charge": { "amount": "0.31", "currency": "PKR" } }
}
```

- **Internal details stay in the server's log:** the provider's messages, tool calls and costs in USD.
- **Turns are one at a time per conversation:** a second message waits for the first.

## The page

- **Plain HTML and one script:** no build step, and nothing loaded from other sites.
- **Language:** Urdu, Roman Urdu and English, with right-to-left text where it is Urdu.
- **Confirmations:** "Haan" / "Nahi" buttons.
- **PDFs:** a link for each PDF.
- **Safety:** everything is shown as text, never as HTML, under a strict content security policy.

## Not yet

The wallet (charging each reply and stopping at zero), keeping conversations in PostgreSQL, WhatsApp and voice.
