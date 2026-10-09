# M.Ai

A generic AI assistant that works inside any business app.

- **Channels:** web chat, WhatsApp, voice.
- **Languages:** Urdu, Roman Urdu and English.
- **Identity:** each company chooses the assistant's name, language and tone.

The assistant **never touches an app's database and never calculates numbers itself**. It only calls the actions the app exposes, and it does so as the real user, with that user's permissions. Every change goes through preview → user confirms → execute.

## Packages

| Package | What it is | Status |
|---|---|---|
| [`@m-ai/action-contract`](packages/action-contract) | The SDK an app installs to become assistant-ready: action definitions, the registry (preview → confirm → execute), catalog, delegation, webhooks. Public, MIT. | **0.1.3** — adds the wallet API (signed requests, schemas, a fake wallet). The ERP vendors 0.1.2. |
| [`@m-ai/assistant-core`](packages/assistant-core) | The brain: conversation, tool selection from the catalog, confirmations, step-up, the numbers guard, language packs, any model (Anthropic, OpenAI, Z.ai, Groq, Gemini, OpenRouter, Ollama, any OpenAI-compatible server) — switchable at runtime, with fallbacks — usage. | **0.4.9** |
| [`@m-ai/service`](packages/service) | M.Ai's server: the web chat, and turns for apps that hand over a person's delegated token. Private. | **0.1.0** — web chat (pilot sign-in) |
| [`@m-ai/mock-erp`](packages/mock-erp) | A small distributor ERP on the contract, for building and testing without the real ERP. Private. | 0.1.0 |
| WhatsApp, voice, the wallet | In the service. | next |

The first app is the distribution ERP. It installs `action-contract`, and the assistant talks to it over `/actions/*` and signed webhooks. The ERP never installs the assistant.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start (terminal)

```sh
corepack enable && pnpm install && pnpm verify        # build + all tests
pnpm --filter @m-ai/assistant-core demo               # offline demo, no API key needed
cp .env.example .env                                  # then fill in M_AI_API_KEY (starts on Z.ai's free model)
pnpm --filter @m-ai/assistant-core models             # the exact model ids your key can use → M_AI_MODEL
pnpm --filter @m-ai/assistant-core chat               # chat with a real model against the mock ERP
pnpm --filter @m-ai/assistant-core eval               # measure accuracy on 14 scenarios
```

The full guide — what to type, chat commands, models, languages — is in [packages/assistant-core/README.md](packages/assistant-core/README.md).

## Web chat

```sh
pnpm --filter @m-ai/service start      # http://127.0.0.1:3100 — sign in with your ERP account (M_AI_ERP_URL in .env)
```

See [packages/service/README.md](packages/service/README.md).

Requires Node ≥ 20 (pnpm comes through corepack).

## Release `action-contract`

There is no npm organisation yet. Each release is a **GitHub Release carrying the packed tarball**, and apps vendor that exact file, pinned.

1. Bump `packages/action-contract/package.json` and update `CHANGELOG.md`.
2. Commit, tag `action-contract-v<version>`, and push the tag.
3. CI runs `pnpm verify`, packs `m-ai-action-contract-<version>.tgz` and attaches it to the GitHub Release for that tag.

Publishing to npm can be added later without changing the package.
