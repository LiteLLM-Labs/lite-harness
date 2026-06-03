# AGENTS.md — SDK backend server

Before making implementation changes here, read and follow
[`CODING_STANDARDS.md`](./CODING_STANDARDS.md). It is the source of truth for
architecture (wire / session / providers / transformation), performance
(process-per-session, streaming), routing through LiteLLM, ESM style, and where
tests live.

The wire contract with the client SDKs is [`../PROTOCOL.md`](../PROTOCOL.md).

## Setup

```bash
cd src/sdk/server
npm install        # provider SDKs: @anthropic-ai/claude-agent-sdk, @openai/agents, openai
npm test           # node --test (no network)
```

## Add a provider

Drop a folder under `providers/<name>/`:

- `index.mjs` — `export const id`, optional `export const aliases`, and
  `export function createRuntime(opts)` driving the native SDK.
- `transformation.mjs` — pure native-event → canonical-frame mapping.

Auto-discovery (`providers/index.mjs`) registers it by `id`/alias. No other
file changes. Add tests under the repo-root `tests/` folder, mirroring the full
source path 1:1 (e.g. `tests/src/sdk/server/providers/<name>/transformation.test.mjs`).
