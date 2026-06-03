# Generic AI Gateway

lite-harness supports any OpenAI-compatible AI gateway via two environment variables:

```bash
export AI_GATEWAY_API_BASE=https://gateway.your-company.com/v1
export AI_GATEWAY_API_KEY=your-gateway-key
```

> **Assumption:** the gateway must support all harness endpoints. For the
> `claude-code` harness that means an Anthropic-compatible
> `POST /messages` path. For `codex` and `pi-ai` harnesses it means an
> OpenAI-compatible `POST /v1/chat/completions` path. Harnesses that route
> to endpoints the gateway does not expose will fail at runtime with a
> connection or 404 error.

## How it works

`AI_GATEWAY_API_BASE` and `AI_GATEWAY_API_KEY` are the generic counterparts to
`LITELLM_API_BASE` / `LITELLM_API_KEY`. Each provider resolves the effective
base URL and key in this order:

1. `LITELLM_API_BASE` / `LITELLM_API_KEY` (takes precedence when both set)
2. `AI_GATEWAY_API_BASE` / `AI_GATEWAY_API_KEY`
3. Provider-native env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.)

## Per-harness wiring

| Harness | What gets set |
|---|---|
| `claude-code` | `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` |
| `codex` | `baseUrl` option to Codex SDK, `OPENAI_API_KEY` |
| `pi-ai` | `baseUrl` field in model config, `getApiKey` result |

## Example

```bash
docker run -p 4096:4096 \
  -e AI_GATEWAY_API_BASE=https://gateway.your-company.com \
  -e AI_GATEWAY_API_KEY=your-key \
  -e MASTER_KEY=$(openssl rand -hex 32) \
  ghcr.io/litellm-labs/lite:latest
```

Trailing slashes and a `/v1` suffix are both accepted — the harness normalises
the URL before use.

## Compatible gateways

Any gateway that presents an OpenAI-compatible API surface works.
Examples: [Portkey](https://portkey.ai), [OpenRouter](https://openrouter.ai),
[Helicone](https://helicone.ai), [MLflow AI Gateway](https://mlflow.org/docs/latest/llms/gateway/index.html),
or a self-hosted proxy.

For LiteLLM-specific features (virtual keys, budget limits, model aliases) use
`LITELLM_API_BASE` / `LITELLM_API_KEY` instead — see
[configuration.md](configuration.md).
