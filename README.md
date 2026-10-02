# M.Ai

A generic AI assistant that works inside any business app.

- **Channels:** web chat, WhatsApp, voice.
- **Languages:** Urdu, Roman Urdu and English.
- **Identity:** each company chooses the assistant's name, language and tone.

The assistant **never touches an app's database and never calculates numbers itself**. It only calls the actions the app exposes, and it does so as the real user, with that user's permissions. Every change goes through preview → user confirms → execute.

## Packages

| Package | What it is | Status |
|---|---|---|
| [`@m-ai/action-contract`](packages/action-contract) | The SDK an app installs to become assistant-ready: action definitions, the registry (preview → confirm → execute), catalog, delegation, webhooks. Public, MIT. | **0.1.1** — vendored by the ERP |
| [`@m-ai/assistant-core`](packages/assistant-core) | The brain: conversation, tool selection from the catalog, confirmations, step-up, the numbers guard, language packs, any model (Anthropic, OpenAI, OpenAI-compatible / Ollama), usage. | **0.2.0** |
| [`@m-ai/mock-erp`](packages/mock-erp) | A small distributor ERP on the contract, for building and testing without the real ERP. Private. | 0.1.0 |
| `@m-ai/channels` | WhatsApp / web chat / voice adapters, and the assistant service. | next |

The first app is the distribution ERP. It installs `action-contract`, and the assistant talks to it over `/actions/*` and signed webhooks. The ERP never installs the assistant.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start (terminal)

```sh
corepack enable && pnpm install && pnpm verify        # build + all tests
pnpm --filter @m-ai/assistant-core demo               # offline demo, no API key needed
cp .env.example .env                                  # then fill in M_AI_PROVIDER, M_AI_MODEL, M_AI_API_KEY
pnpm --filter @m-ai/assistant-core chat               # chat with a real model against the mock ERP
pnpm --filter @m-ai/assistant-core eval               # measure accuracy on 14 scenarios
```

The full guide — what to type, chat commands, models, languages — is in [packages/assistant-core/README.md](packages/assistant-core/README.md).

Requires Node ≥ 20 (pnpm comes through corepack).

## Release `action-contract`

There is no npm organisation yet. Each release is a **GitHub Release carrying the packed tarball**, and apps vendor that exact file, pinned.

1. Bump `packages/action-contract/package.json` and update `CHANGELOG.md`.
2. Commit, tag `action-contract-v<version>`, and push the tag.
3. CI runs `pnpm verify`, packs `m-ai-action-contract-<version>.tgz` and attaches it to the GitHub Release for that tag.

Publishing to npm can be added later without changing the package.
