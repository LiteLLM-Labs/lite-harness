# Configuration

Everything is configured via environment variables. Set them on `docker run` (or your platform's env panel) and restart.

## Required

| Var                     | What it is                                                                                            |
|-------------------------|-------------------------------------------------------------------------------------------------------|
| `LITELLM_API_BASE`      | URL of your LiteLLM gateway. Either bare (`https://gw.acme.com`) or with `/v1` suffix. Both work.     |
| `LITELLM_API_KEY`       | Virtual key the harness uses to call the gateway. Sent as `Authorization: Bearer <key>`.              |

The harness queries `${LITELLM_API_BASE}/v1/models` at boot and registers every model the gateway returns. Clients pick a `modelID` per request. If the gateway returns no models, boot fails fast with a clear error.

## Auth on lite-harness itself

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

## Repo / harness internals

| Var          | What it is                                                                              |
|--------------|-----------------------------------------------------------------------------------------|
| `CC_REPO_DIR`| Working dir for the claude-code in-process adapter. Defaults to `$HOME`.                |

## Example

```bash
docker run -p 4096:4096 \
  -e LITELLM_API_BASE=https://litellm.internal.acme.com \
  -e LITELLM_API_KEY=sk-litellm-... \
  -e MASTER_KEY=$(openssl rand -hex 32) \
  ghcr.io/litellm-labs/lite-harness:latest
```

Open `http://localhost:4096`, paste the `MASTER_KEY` on the login page, and you're in.

## Note: model coverage through opencode

opencode talks to LiteLLM via the Anthropic Messages format (`POST {base}/messages`). LiteLLM's passthrough can translate non-Anthropic models (GPT, Gemini, Bedrock), so they work end-to-end as long as your gateway routes them. If a model returns errors, check that the gateway has it registered and that `/v1/messages` is enabled.
