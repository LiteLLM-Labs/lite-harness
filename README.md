<h1 align="center">lite-harness</h1>
<p align="center">One server. Any coding agent. Any model.</p>
<p align="center">Unified API in front of opencode and claude-code. Streamed events, built-in UI, master-key auth, LiteLLM gateway connection test in the UI.</p>

<h4 align="center">
  <a href="#get-started">Get started</a> ·
  <a href="docs/configuration.md">Configuration</a> ·
  <a href="docs/api.md">API reference</a> ·
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="harnesses/README.md">Add a harness</a>
</h4>

---

<img width="1200" height="800" alt="litellm_hero_v6" src="https://github.com/user-attachments/assets/74664c56-23fa-4bf7-8264-09e26643cd96" />


## What is lite-harness

lite-harness is a single HTTP server that fronts any coding-agent harness (opencode, claude-code, claude-agent-sdk, openai-agents) behind one API. Same 3 endpoints, every harness. Point it at a LiteLLM gateway and every harness can use any model.

---

## Why lite-harness

- **Unified API.** `/session`, `/session/{id}/prompt_async`, `/event`. That's it.
- **Swap harnesses with one field.** `"harness": "opencode"` to `"harness": "claude-code"`. Nothing else changes.
- **Any model via LiteLLM.** Every harness routes through your gateway. Claude, GPT, Gemini, Bedrock all work when the gateway routes them.
- **Master-key auth out of the box.** Set `MASTER_KEY` and every API route requires `Authorization: Bearer <key>`. UI ships with a login page.

---

## Create a session

Pick your harness in the body. Same call, every harness.

### opencode

```bash
curl -X POST localhost:4096/session \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $MASTER_KEY" \
  -d '{"title": "fix the bug", "harness": "opencode"}'
```

### claude-code

```bash
curl -X POST localhost:4096/session \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $MASTER_KEY" \
  -d '{"title": "fix the bug", "harness": "claude-code"}'
```

---

## Send a prompt

Same call for every harness. Swap `modelID` for any model your LiteLLM gateway routes (Claude, GPT, Gemini, Bedrock, ...).

```bash
curl -X POST localhost:4096/session/$SID/prompt_async \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $MASTER_KEY" \
  -d '{"model": {"providerID": "litellm", "modelID": "claude-sonnet-4-6"},
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

You need a LiteLLM gateway URL and a virtual key. If you don't have one, run [BerriAI/litellm](https://github.com/BerriAI/litellm) first.

```bash
docker run -p 4096:4096 \
  -e LITELLM_API_BASE=https://your-litellm-gateway \
  -e LITELLM_API_KEY=sk-... \
  -e MASTER_KEY=$(openssl rand -hex 32) \
  ghcr.io/litellm-labs/lite-harness:latest
```

Open [localhost:4096](http://localhost:4096), paste the `MASTER_KEY` on the login page, then click the gear icon in the sidebar and hit **Test connection** to confirm the gateway is reachable.

Full env-var reference: [docs/configuration.md](docs/configuration.md).

## Supported harnesses

| Harness            | Status   |
|--------------------|----------|
| `opencode`         | shipped  |
| `claude-code`      | shipped  |

## License

MIT.
