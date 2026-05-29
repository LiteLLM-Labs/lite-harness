# Configuration

Everything is configured via environment variables. Set them on `docker run` (or your platform's env panel) and restart.

## Required

| Var                     | What it is                                                                                            |
|-------------------------|-------------------------------------------------------------------------------------------------------|
| `LITELLM_API_BASE`      | URL of your LiteLLM gateway. Either bare (`https://gw.acme.com`) or with `/v1` suffix. Both work.     |
| `LITELLM_API_KEY`       | Virtual key the harness uses to call the gateway. Sent as `Authorization: Bearer <key>`.              |

The harness queries `${LITELLM_API_BASE}/v1/models` at boot and registers every model the gateway returns. Clients pick a `modelID` per request. If the gateway returns no models, boot fails fast with a clear error.

## Auth on lite itself

| Var          | What it is                                                                                                  |
|--------------|-------------------------------------------------------------------------------------------------------------|
| `MASTER_KEY` | Bearer token gating every HTTP route. Unset = open (local dev). Set = clients must send `Authorization: Bearer <MASTER_KEY>`. The UI's `/login` page accepts this key. |

When `MASTER_KEY` is set, `EventSource` clients can pass it as `?key=<MASTER_KEY>` on `/event` since browsers can't set headers on SSE.

## Ports

| Var                  | Default | What it is                                                |
|----------------------|---------|-----------------------------------------------------------|
| `PORT`               | `4096`  | Where the unified API + UI listen.                        |
| `OPENCODE_CHILD_PORT`| `PORT+1`| Internal opencode child server. Don't expose this.        |

## UI

| Var       | What it is                                                              |
|-----------|-------------------------------------------------------------------------|
| `UI_DIST` | Path to a pre-built Next.js export. Defaults to `ui/out/` inside image. |

## Sandbox (opencode MCP)

The sandbox MCP is activated automatically when any of the following are set.

### Direct mode (default)

The MCP provisions sandboxes directly from the harness process. Two providers are supported.

**E2B**

| Var | Required | What it is |
|---|---|---|
| `E2B_API_KEY` | yes | E2B API key |
| `E2B_TEMPLATE` | no | Sandbox template name (default: `base`) |

**Daytona**

| Var | Required | What it is |
|---|---|---|
| `DAYTONA_API_KEY` | yes | Daytona API key |
| `DAYTONA_API_URL` | no | Daytona API base URL |
| `DAYTONA_SNAPSHOT` | no | Snapshot to use when creating |
| `DAYTONA_IMAGE` | no | Image to use instead of snapshot |

**Provider selection**

| Var | What it is |
|---|---|
| `SANDBOX_PROVIDER` | `e2b` or `daytona`. Auto-detects from whichever API key is present if unset. |

**Vault proxy (both providers)**

| Var | What it is |
|---|---|
| `VAULT_URL` | Proxy URL for credential injection into the sandbox |
| `VAULT_PROXY_TOKEN` | Token embedded into the proxy URL as basic-auth password |

### Platform mode (`LAP_PLATFORM_MODE=1`)

Delegates sandbox provisioning to the LAP platform API, which injects agent-specific credentials automatically.

| Var | Required | What it is |
|---|---|---|
| `LAP_PLATFORM_MODE` | yes | Set to `1` to enable platform mode |
| `LAP_BASE_URL` | yes | LAP platform base URL |
| `LAP_AUTH_TOKEN` | yes | Platform auth token (`MASTER_KEY` accepted as fallback) |
| `SESSION_ID` | yes | LAP session ID (or pass `session_id` per `provision` call) |

## CLI (`lite`)

A zero-dependency Node.js CLI (requires Node 18+). Install:

```bash
cd cli && npm install -g .
```

| Command | What it does |
|---|---|
| `lite login` | Prompt for server URL + master key, validate, save to `~/.config/lite/config.json` |
| `lite list` | List available harnesses |
| `lite models` | List models from the configured server |
| `lite <harness>` | Start a TUI chat session with the named harness |

Chat session flags:

| Flag | What it does |
|---|---|
| `--model <id>` | Override model (default: first model from `/v1/models`) |

In-session commands:

| Command | What it does |
|---|---|
| `/clear` | Delete the current session and start a fresh one |
| `exit` / `quit` | Exit the chat |

## Repo / harness internals

| Var          | What it is                                                                              |
|--------------|-----------------------------------------------------------------------------------------|
| `CC_REPO_DIR`| Working dir for the claude-code in-process adapter. Defaults to `$HOME`.                |
| `CODEX_MODEL`| Model passed to `codex exec -m`. Must be an OpenAI model name (e.g. `gpt-4o`, `o3`). Defaults to `gpt-4o`. Anthropic model names fail — codex's Responses API WebSocket only accepts OpenAI model identifiers. |

## Example

```bash
docker run -p 4096:4096 \
  -e LITELLM_API_BASE=https://litellm.internal.acme.com \
  -e LITELLM_API_KEY=sk-litellm-... \
  -e MASTER_KEY=$(openssl rand -hex 32) \
  ghcr.io/litellm-labs/lite:latest
```

Open `http://localhost:4096`, paste the `MASTER_KEY` on the login page, and you're in.

## Note: model coverage through opencode

opencode talks to LiteLLM via the Anthropic Messages format (`POST {base}/messages`). LiteLLM's passthrough can translate non-Anthropic models (GPT, Gemini, Bedrock), so they work end-to-end as long as your gateway routes them. If a model returns errors, check that the gateway has it registered and that `/v1/messages` is enabled.
