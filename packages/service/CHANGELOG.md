# Changelog

## 0.1.1 — 2026-10-09

- **The service runs from the packages' source.** tsconfig `paths` (followed by tsx) and the same aliases in vitest point at `../assistant-core/src` and `../action-contract/src`.
- **Why:** on the owner's machine, `start` failed with "does not provide an export named 'ErpError'", because `@m-ai/assistant-core`'s build was older than its source. A missing or old build can no longer be what runs.


## 0.1.0 — 2026-10-09

The first slice of M.Ai's server.

- **The web chat**, a page with one script:
  - sign-in, messages and "Haan" / "Nahi" buttons;
  - PDF links;
  - "Naya chat" (a new conversation);
  - Urdu shown right-to-left.
- **The pilot sign-in** to the app (`/auth/login`):
  - the password is passed on, never kept;
  - the app session is kept in memory only, and ends after 8 idle hours;
  - the cookie is HttpOnly and SameSite=Strict;
  - the server listens on 127.0.0.1 by default.
- **Turns for an app that sends a delegated token** (`POST /v1/apps/:app/turn`): the person's identity comes from the app's `core.context.get`, not from the token's claims.
- **PDFs through the same door** (`GET /v1/.../documents/:id`).
- **One turn at a time per conversation.**
- **Errors:** an app that cannot be reached is not reported as a wrong password.
- **Checked against the real ERP (DEMO)** in a browser: sign-in, today's sales, who owes most, a receipt previewed and confirmed with the button, and a statement PDF opened from its link.
