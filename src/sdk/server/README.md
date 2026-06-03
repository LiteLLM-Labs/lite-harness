# SDK Backend Server

This directory contains the production stdio backend for the lite-harness SDK.
It follows the same shape as the existing harness server: one unified adapter
fronts multiple agent runtimes behind one contract.

The difference is the contract. `harnesses/inline-adapter.mjs` fronts runtimes
behind lite-harness HTTP/SSE endpoints; this server fronts runtimes behind the
Claude Agent SDK `stream-json` stdio protocol.

```text
SDK client
  │ Claude Agent SDK stream-json over stdio
  ▼
StreamJsonServer          protocol.mjs
  │
  ▼
UnifiedAgentSDK           unified-sdk.mjs
  ├─ ClaudeCodeRuntime    real `claude` / Claude Code CLI
  └─ CodexRuntime         real `codex exec` CLI
```

## Entrypoint

Run the server directly:

```bash
node src/sdk/server/server.mjs \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --agent claude \
  --model claude-sonnet-4-6 \
  --permission-mode default \
  --cwd "$PWD"
```

Supported production agents:

- `claude`, `claude-code`, `cc`
- `codex`

`LITE_HARNESS_DEFAULT_AGENT` controls the default when `--agent` is omitted.
If unset, the default is `claude`.

## Unified Adapter

`protocol.mjs` is the stdio adapter. It owns all SDK-facing protocol work:

- parse the launch flags the SDK passes
- read one JSON object per stdin line
- write one JSON object per stdout line
- keep diagnostics on stderr
- route messages by top-level `type`
- correlate `control_request` and `control_response`
- start turns from `user` messages

The adapter does not know how Claude or Codex run. It calls `UnifiedAgentSDK`.

## Unified SDK

`unified-sdk.mjs` is the internal runtime API. It owns process-local session
state and exposes the small surface the protocol adapter needs:

- `handleControl(request)`
- `runTurn({ prompt, content })`
- `errorResult(error)`

State held here:

- stable `sessionId`
- selected runtime, model, permission mode, and cwd
- initialized MCP server metadata
- turn count
- text history used by runtimes that need conversation context

This mirrors the existing harness design: add runtime-specific behavior behind
the unified SDK, not in the protocol layer.

## Runtime Adapters

### Claude Code

`ClaudeCodeRuntime` launches the real Claude Code CLI:

```text
CLAUDE_CODE_COMMAND || CLAUDE_COMMAND || claude
```

It starts the command with:

```text
--input-format stream-json
--output-format stream-json
--verbose
--model <model>
--permission-mode <mode>
--cwd <cwd>
```

For each SDK turn, it sends an internal `initialize` control request followed by
the user message, then forwards non-control Claude Agent SDK messages back to
the client.

### Codex

`CodexRuntime` launches the real Codex CLI:

```text
CODEX_COMMAND || codex
```

It runs:

```text
codex exec -m <model> --dangerously-bypass-approvals-and-sandbox <prompt>
```

The adapter captures stdout and normalizes it to Claude Agent SDK messages:

1. `system`
2. `assistant`
3. `result`

When `LITELLM_API_BASE` is set, the adapter passes the same LiteLLM provider
configuration style used by the existing Codex harness. The model resolution is:

1. `--model`
2. `CODEX_MODEL`
3. `gpt-4o`

## Control Requests

Implemented control subtypes:

- `initialize`: stores hooks and `sdk_mcp_servers`
- `set_permission_mode`: updates runtime permission mode when supported
- `set_model`: updates the runtime model
- `interrupt`: terminates the active runtime child process

Unknown control subtypes return a correlated error response.

## Testing

Run:

```bash
node --test src/sdk/server/server.test.mjs
```

The tests execute `server.mjs` and generate temporary command recorders at
runtime to validate command routing and wire normalization without requiring
local Claude/Codex credentials. Those recorders are not part of the server
implementation.

