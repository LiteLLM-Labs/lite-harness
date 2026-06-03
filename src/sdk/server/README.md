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
messages to canonical frames. LiteLLM is optional: when both `LITELLM_API_BASE`
and `LITELLM_API_KEY` are set it routes through the gateway (setting
`ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`); otherwise it goes direct via the
SDK's own `ANTHROPIC_API_KEY`. An explicit `ANTHROPIC_BASE_URL` always wins.
Default model is `LITELLM_DEFAULT_MODEL` or `claude-sonnet-4-6`.

### codex (`openai`)

Drives `@openai/agents` in-process via `run(...)` and maps its run-stream events
to canonical frames. LiteLLM is optional: when both `LITELLM_API_BASE` and
`LITELLM_API_KEY` are set it installs an OpenAI-compatible client (`/v1`) as the
default and uses the chat-completions surface; otherwise it uses the Agents SDK
default client (direct to OpenAI via `OPENAI_API_KEY`). Default model is
`LITELLM_DEFAULT_MODEL` or `gpt-4o`.

## Control Requests

`Session.handleControl` services these subtypes:

- `initialize` — stores `hooks` and `sdk_mcp_servers`
- `set_permission_mode` — updates runtime permission mode when supported
- `set_model` — updates the runtime model
- `interrupt` — interrupts the active runtime

Unknown subtypes throw, which the wire returns as a correlated error response.

## Testing

Tests live in the **repo-root `tests/`** folder, mirroring the full source path
1:1 (e.g. `tests/src/sdk/server/providers/codex/transformation.test.mjs`), so the
core stays uncluttered.

```bash
cd src/sdk/server && npm test          # node --test, no network
# or from the repo root:
node --test "tests/src/sdk/server/**/*.test.mjs"
```

### Testing the internal SDK directly (no stdio)

The internal "unified SDK" — `Session` plus the per-provider runtimes — is a
plain in-process API. You can exercise it directly, without spawning the server
or framing stream-json, which is the fastest way to unit-test behavior.

**Drive a `Session` with a stub provider** (asserts the turn lifecycle: leading
`system/init`, streamed frames, trailing `result`):

```js
import { Session } from "./session.mjs";

const provider = {
  id: "stub",
  createRuntime: () => ({
    model: "stub-model",
    async *runTurn({ prompt }) {
      yield { type: "assistant", message: { model: "stub-model", content: [{ type: "text", text: `echo: ${prompt}` }] }, parent_tool_use_id: null };
    },
  }),
};

const session = new Session({ provider, env: {}, stderr: process.stderr });
const frames = [];
for await (const f of session.runTurn({ prompt: "hi", content: "hi" })) frames.push(f);
// frames: [ system/init, assistant("echo: hi"), result(success) ]
```

**Test a provider transformation in isolation** (pure — no SDK, no network):

```js
import { createEventTransformer } from "./providers/codex/transformation.mjs";

const toFrames = createEventTransformer();
toFrames(
  { type: "item.updated", item: { id: "msg_1", type: "agent_message", text: "4" } },
  { sessionId: "s", model: "m" },
);
// → [ { type: "stream_event", session_id: "s", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "4" } } } ]
```

**Drive a real provider runtime against LiteLLM** (integration; needs
`LITELLM_API_BASE` / `LITELLM_API_KEY`):

```js
import * as anthropic from "./providers/anthropic/index.mjs";

const runtime = anthropic.createRuntime({ env: process.env, diagnostics: () => {} });
for await (const frame of runtime.runTurn({ prompt: "What is 2 + 2?", session: { sessionId: "s" } })) {
  console.log(frame.type, frame.type === "assistant" ? frame.message.content : "");
}
```
