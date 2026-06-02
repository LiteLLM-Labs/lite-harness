# lite-harness SDK

Client SDKs for driving lite-harness agents from your own code — **drop-in
compatible with the official Claude Agent SDK** in both Python and JavaScript/TypeScript.

"Drop-in" means the public API is identical to the Claude Agent SDK. Migrating an
existing project is a one-line change: swap the import, nothing else.

```python
# before
from claude_agent_sdk import query, ClaudeSDKClient, ClaudeAgentOptions
# after
from lite_agent_sdk import query, ClaudeSDKClient, ClaudeAgentOptions
```

```ts
// before
import { query } from "@anthropic-ai/claude-agent-sdk";
// after
import { query } from "@lite-harness/sdk";
```

See [`interface.html`](./interface.html) for a side-by-side view of the exposed
interface (open it in a browser).

## How it works

The SDK is a thin client. It spawns the lite-harness agent server as a child
process and speaks newline-delimited JSON-RPC to it over stdio. The server owns
the real agent runtimes (claude-code, codex, opencode); the SDK owns only the
process + wire glue and presents the Claude-shaped surface.

```
your code ──> lite_agent_sdk ──(stdio JSON-RPC)──> lite-harness server ──> agent runtime
```

## Language asymmetry (intentional)

The SDK mirrors each language's *native* Claude Agent SDK shape exactly:

| | Python | JS / TS |
| --- | --- | --- |
| One-shot | `query(...)` async iterator | `query(...)` async generator |
| Session | stateful `ClaudeSDKClient` class | the `Query` object returned by `query()` |
| Control | `client.interrupt()`, `set_permission_mode()`, … | `q.interrupt()`, `q.setPermissionMode()`, … |

Python has a client class; JS/TS does not. This matches upstream — so existing
code runs unchanged.

## Layout

```
src/sdk/
├── interface.html      # side-by-side interface reference (this PR)
├── python/             # lite-agent-sdk  (Python drop-in)        — next PR
└── typescript/         # @lite-harness/sdk  (JS/TS drop-in)      — next PR
```

## Status

Scaffold only. This PR lands the directory and the interface reference. The
Python and TypeScript packages — plus parity tests that assert every Claude
Agent SDK export/signature also exists here — follow in subsequent PRs.
