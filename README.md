# M.Ai

A generic AI assistant that works inside any business app.

- **Channels:** web chat, WhatsApp, voice.
- **Languages:** Urdu, Roman Urdu and English.
- **Identity:** each company chooses the assistant's name, language and tone.

The assistant **never touches an app's database and never calculates numbers itself**. It only calls the actions the app exposes, and it does so as the real user, with that user's permissions. Every change goes through preview → user confirms → execute.

## Packages

| Package | What it is | Status |
|---|---|---|
| [`@m-ai/action-contract`](packages/action-contract) | The SDK an app installs to become assistant-ready: action definitions, the registry (preview → confirm → execute), catalog, delegation, webhooks. Public, MIT. | **v0.1.0** |
| `@m-ai/assistant-core` | The brain: conversation, tool selection from the catalog, memory, runbooks, trust ladder. | next |
| `@m-ai/channels` | WhatsApp / web chat / voice adapters for the assistant service. | later |

The first app is the distribution ERP. It installs `action-contract`, and the assistant talks to it over `/actions/*` and signed webhooks. The ERP never installs the assistant.

## Develop

```sh
pnpm install
pnpm verify      # typecheck + tests + build, all packages
```

Requires Node ≥ 20 and pnpm 10.

## Release `action-contract`

There is no npm organisation yet. Each release is a **GitHub Release carrying the packed tarball**, and apps vendor that exact file, pinned.

1. Bump `packages/action-contract/package.json` and update `CHANGELOG.md`.
2. Commit, tag `action-contract-v<version>`, and push the tag.
3. CI runs `pnpm verify`, packs `m-ai-action-contract-<version>.tgz` and attaches it to the GitHub Release for that tag.

Publishing to npm can be added later without changing the package.
