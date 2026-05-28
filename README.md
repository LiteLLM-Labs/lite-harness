<h1 align="center">lite-harness</h1>
<p align="center">A unified API for coding-agent harnesses. Talk to Claude Code, OpenCode, GitHub Copilot, Codex through one server.</p>

<h4 align="center">
  <a href="#get-started">Get started</a> ·
  <a href="docs/configuration.md">Configuration</a> ·
  <a href="docs/api.md">API reference</a> ·
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="harnesses/README.md">Add a harness</a>
</h4>

---

<img width="1141" height="928" alt="Gemini_Generated_Image_8e08ug8e08ug8e08" src="https://github.com/user-attachments/assets/ba3d0d68-c6ea-42aa-a6e6-31d84d971618" />



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
# Generate a master key so you can paste it on the login page
export MASTER_KEY=$(openssl rand -hex 32)
echo "MASTER_KEY: $MASTER_KEY"

docker run -p 4096:4096 \
  -e LITELLM_API_BASE=https://your-litellm-gateway \
  -e LITELLM_API_KEY=sk-... \
  -e MASTER_KEY="$MASTER_KEY" \
  ghcr.io/litellm-labs/lite-harness:latest
```

Open [localhost:4096](http://localhost:4096), paste the `MASTER_KEY` (the echoed value above) on the login page, then click the gear icon in the sidebar and hit **Test connection** to confirm the gateway is reachable.

Full env-var reference: [docs/configuration.md](docs/configuration.md).

## Supported harnesses

| Harness            | Status   |
|--------------------|----------|
| `opencode`         | shipped  |
| `claude-code`      | shipped  |

## License

MIT.
