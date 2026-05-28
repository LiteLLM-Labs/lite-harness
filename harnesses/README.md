# Harnesses

Each subfolder is one supported agent harness. The lite-harness server fronts all of them behind one API.

| Folder | Status |
|---|---|
| `opencode/` | shipped |
| `claude-code/` | shipped (inline — shares the opencode Docker image) |
| `claude-agent-sdk/` | planned |
| `openai-agents/` | planned |

Code shared by all harnesses lives in `_shared/` (e.g. `_shared/entrypoint-common.sh`, sourced as `/opt/lap/common.sh` in each harness image).

## Architecture

`harnesses/inline-adapter.mjs` is the **unified HTTP adapter** — a single Node.js server (port 4096 / `$PORT`) that fronts both `opencode` and `claude-code` sessions behind the same 3-endpoint API. It:

- Routes `harness: "opencode"` sessions to a child `opencode serve` process.
- Routes `harness: "claude-code"` sessions in-process via the `@anthropic-ai/claude-code` SDK.
- Wires both paths through LiteLLM (`LITELLM_API_BASE` / `LITELLM_API_KEY`).
- Merges both SSE event streams onto a single `/event` bus.

The `opencode/Dockerfile` builds the one production image: it packages the inline adapter, the opencode binary, the claude-code SDK node_modules, and the static UI together.

## Adding a new harness

Two ways depending on complexity:

### Inline (lightweight — no new Dockerfile)

Add a new session type to `harnesses/inline-adapter.mjs`:
1. Detect `body.harness === "<name>"` in `POST /session`.
2. Store sessions in a new in-process Map.
3. Route `prompt_async` through your SDK/library, emitting the standard SSE events.
4. Wire `LITELLM_API_BASE` / `LITELLM_API_KEY` to whatever env vars your SDK reads.
5. Update the table above.

### Standalone (complex runtime — own Dockerfile)

1. Create `harnesses/<name>/` with:
   - `Dockerfile` — builds the harness runtime image
   - `entrypoint.sh` — boots the harness, wires it to LiteLLM
   - `start-local.sh` — runs the harness locally for dev
   - any harness-specific MCP servers or adapters
2. Speak HTTP on `$PORT` with the same session / message / event endpoints.
3. Update the table above.

## Contract every harness must satisfy

- Speak HTTP on `$PORT` for session create / message / event endpoints.
- Pull credentials and model config from env (`LITELLM_API_BASE`, `LITELLM_API_KEY`, `LITELLM_DEFAULT_MODEL`).
- Discover available models by calling `${LITELLM_API_BASE}/v1/models` at boot.
- Persist session state so a restart resumes mid-conversation.

## Running locally

```bash
# opencode + claude-code (unified)
cd harnesses/opencode
./start-local.sh
# → http://localhost:4096
```

The `start-local.sh` sources `.env` from the repo root (or the sibling `litellm-agent-platform/` directory), starts the opencode child process, and launches the unified inline adapter. Both `harness: "opencode"` and `harness: "claude-code"` sessions work on port 4096.
