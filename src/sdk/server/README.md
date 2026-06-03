# SDK Backend Server

This directory is the production stdio backend for the lite-harness SDK. It
speaks the Claude Agent SDK `stream-json` stdio protocol on the wire and drives
native provider agent SDKs **in-process** — no child CLIs are spawned.

```text
SDK client
  │ Claude Agent SDK stream-json over stdio
  ▼
StreamJsonServer            protocol.mjs   (the wire)
  ▼
Session                     session.mjs    (process-local state)
  ▼
provider runtime            providers/<name>/
  ├─ anthropic   → @anthropic-ai/claude-agent-sdk (in-process)
  └─ codex       → @openai/agents (in-process)
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

`server.mjs` parses the launch flags, resolves a provider for `--agent`, builds
a `Session`, and starts the `StreamJsonServer`. `LITE_HARNESS_DEFAULT_AGENT`
controls the default when `--agent` is omitted; if unset the default is
`claude`.

## Layout

- `protocol.mjs` — the wire. Parses launch flags, reads one JSON object per
  stdin line, writes one per stdout line, keeps diagnostics on stderr,
  correlates `control_request`/`control_response`, and streams a turn's frames
  as they arrive. Also the single home for the canonical frame builders
  (`systemInit`, `assistantFrame`, `streamEventFrame`, `resultFrame`, …).
- `session.mjs` — `Session` holds all process-local state: stable `sessionId`,
  turn count, text history, initialized MCP server metadata, hooks, current
  model and permission mode. `handleControl(request)` services control
  requests; `runTurn({ prompt, content })` wraps the runtime's frames with a
  leading `system/init` and a trailing `result` (synthesizing one on error or
  when the runtime yields none).
- `providers/index.mjs` — the registry. Auto-discovers providers by scanning
  each subfolder for an `index.mjs` exporting `id`, optional `aliases`, and
  `createRuntime(...)`. `resolveProvider(agent)` maps an id/alias to a provider.
  Adding a provider is dropping a folder; `LITE_HARNESS_PROVIDERS_DIR` can layer
  in extra/test providers.
- `providers/<name>/index.mjs` + `transformation.mjs` — each provider drives its
  native SDK in `index.mjs` and maps that SDK's messages/events to canonical
  wire frames in `transformation.mjs` (kept pure for testability).

## Providers

### anthropic (`claude`, `claude-code`, `cc`)

Drives `@anthropic-ai/claude-agent-sdk` in-process via `query(...)` and maps its
messages to canonical frames. Routes through LiteLLM by setting
`ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` from `LITELLM_API_BASE` /
`LITELLM_API_KEY` (an explicit `ANTHROPIC_BASE_URL` wins). Default model is
`LITELLM_DEFAULT_MODEL` or `claude-sonnet-4-6`.

### codex (`openai`)

Drives `@openai/agents` in-process via `run(...)` and maps its run-stream events
to canonical frames. Routes through LiteLLM by installing an OpenAI-compatible
client (`/v1`) as the default and using the chat-completions surface. Default
model is `LITELLM_DEFAULT_MODEL` or `gpt-4o`.

## Control Requests

`Session.handleControl` services these subtypes:

- `initialize` — stores `hooks` and `sdk_mcp_servers`
- `set_permission_mode` — updates runtime permission mode when supported
- `set_model` — updates the runtime model
- `interrupt` — interrupts the active runtime

Unknown subtypes throw, which the wire returns as a correlated error response.

## Testing

```bash
node --test src/sdk/server
```
