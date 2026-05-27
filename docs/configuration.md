# Configuration

Everything is configured via environment variables. Set them on `docker run` (or your platform's env panel) and restart.

## Required

| Var                     | What it is                                                                                            |
|-------------------------|-------------------------------------------------------------------------------------------------------|
| `LITELLM_API_BASE`      | URL of your LiteLLM gateway. Either bare (`https://gw.acme.com`) or with `/v1` suffix. Both work.     |
| `LITELLM_API_KEY`       | Virtual key the harness uses to call the gateway. Sent as `Authorization: Bearer <key>`.              |
| `LITELLM_DEFAULT_MODEL` | Boot model. Provider-prefixed form, e.g. `anthropic/claude-sonnet-4-6` or `openai/gpt-4o`.            |

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

## Model behavior

| Var                | Default | What it does                                                                                                 |
|--------------------|---------|--------------------------------------------------------------------------------------------------------------|
| `FORCE_MODEL`      | `1`     | When `1`, every `/prompt_async` ignores the client's `modelID` and uses `LITELLM_DEFAULT_MODEL`. Set to `0` to let clients pick. |
| `ANTHROPIC_API_KEY`| unset   | Escape hatch: when set, opencode bypasses LiteLLM and calls `api.anthropic.com` directly. Useful for tests, not for prod. |

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
  -e LITELLM_DEFAULT_MODEL=anthropic/claude-sonnet-4-6 \
  -e MASTER_KEY=$(openssl rand -hex 32) \
  ghcr.io/berriai/lite-harness:latest
```

Open `http://localhost:4096`, paste the `MASTER_KEY` on the login page, and you're in.

## Note: model coverage through opencode

opencode talks to LiteLLM via the Anthropic Messages format (`POST {base}/messages`). LiteLLM's passthrough can translate non-Anthropic models (GPT, Gemini, Bedrock), so they work end-to-end as long as your gateway routes them. If a model returns errors, check that the gateway has it registered and that `/v1/messages` is enabled.
