<h1 align="center">lite-harness</h1>
<p align="center">One server. Any coding agent. Any model.</p>
<p align="center">Unified API in front of opencode, claude-code, claude-agent-sdk, and openai-agents. Durable sessions, streamed events, built-in UI.</p>

<h4 align="center">
  <a href="docs/scope.md">What lite-harness is (and isn't)</a> ·
  <a href="docs/api.md">API reference</a> ·
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="harnesses/README.md">Add a harness</a>
</h4>

---

## What is lite-harness

lite-harness is a single HTTP server that fronts any coding-agent harness (opencode, claude-code, claude-agent-sdk, openai-agents) behind one API. Same 3 endpoints, every harness. Point it at a LiteLLM gateway and every harness can use any model.

Read the full [scope doc](docs/scope.md) for what's in and out.

---

## Why lite-harness

- **Unified API.** `/session`, `/session/{id}/prompt_async`, `/event`. That's it.
- **Swap harnesses with one field.** `"harness": "opencode"` to `"harness": "claude-code"`. Nothing else changes.
- **Any model via LiteLLM.** Every harness routes through your gateway. Claude, GPT, Gemini, Bedrock all just work.
- **Built for scale.** Designed for 10K RPS.

---

## Create a session

Pick your harness in the body. Same call, every harness.

### opencode

```bash
curl -X POST localhost:4096/session \
  -H 'content-type: application/json' \
  -d '{"title": "fix the bug", "harness": "opencode"}'
```

### claude-code

```bash
curl -X POST localhost:4096/session \
  -H 'content-type: application/json' \
  -d '{"title": "fix the bug", "harness": "claude-code"}'
```

### claude-agent-sdk

```bash
curl -X POST localhost:4096/session \
  -H 'content-type: application/json' \
  -d '{"title": "fix the bug", "harness": "claude-agent-sdk"}'
```

### openai-agents

```bash
curl -X POST localhost:4096/session \
  -H 'content-type: application/json' \
  -d '{"title": "fix the bug", "harness": "openai-agents"}'
```

---

## Send a prompt

Same shape, every harness. Pick any LiteLLM-routed model.

### Claude via opencode

```bash
curl -X POST localhost:4096/session/$SID/prompt_async \
  -H 'content-type: application/json' \
  -d '{"model": {"providerID": "litellm", "modelID": "claude-sonnet-4-6"},
       "parts": [{"type": "text", "text": "summarize this repo"}]}'
```

### GPT via opencode

```bash
curl -X POST localhost:4096/session/$SID/prompt_async \
  -H 'content-type: application/json' \
  -d '{"model": {"providerID": "litellm", "modelID": "gpt-4o"},
       "parts": [{"type": "text", "text": "summarize this repo"}]}'
```

### Gemini via claude-code

```bash
curl -X POST localhost:4096/session/$SID/prompt_async \
  -H 'content-type: application/json' \
  -d '{"model": {"providerID": "litellm", "modelID": "gemini-2.5-pro"},
       "parts": [{"type": "text", "text": "summarize this repo"}]}'
```

### Bedrock Claude via claude-agent-sdk

```bash
curl -X POST localhost:4096/session/$SID/prompt_async \
  -H 'content-type: application/json' \
  -d '{"model": {"providerID": "litellm", "modelID": "bedrock/anthropic.claude-sonnet-4"},
       "parts": [{"type": "text", "text": "summarize this repo"}]}'
```

---

## Stream events

One SSE stream, every session.

```bash
curl -N localhost:4096/event
```

```
data: {"type":"message.part.updated","properties":{"sessionID":"ses_...","part":{...}}}
data: {"type":"message.completed","properties":{"sessionID":"ses_..."}}
```

---

## Get started

```bash
docker run -p 4096:4096 \
  -e LITELLM_API_BASE=https://your-litellm-gateway \
  -e LITELLM_API_KEY=sk-... \
  ghcr.io/berriai/lite-harness:latest
```

Open [localhost:4096](http://localhost:4096) for the UI.

## Supported harnesses

| Harness            | Status   |
|--------------------|----------|
| `opencode`         | shipped  |
| `claude-code`      | in dev   |
| `claude-agent-sdk` | planned  |
| `openai-agents`    | planned  |

## License

MIT.
