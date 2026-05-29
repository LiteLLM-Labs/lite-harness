# lite-harness

Run Claude Code/Codex/OpenCode on a sandbox in autopilot.

![litellm_hero_v11](https://github.com/user-attachments/assets/7ff9d171-fcab-4657-8e44-8a9c8b978ac6)

## usage

```bash
# git clone https://github.com/LiteLLM-Labs/lite-harness && cd lite-harness

# cd cli && npm install -g .

lite login  # point at your server, save master key

lite claude-code
❯ monitor CI every hour and fix any bugs

lite opencode
❯ dm github stargazers daily
```

Supported agents: `opencode` `claude-code` `github-copilot` `codex`

## setup

```bash
export MASTER_KEY=$(openssl rand -hex 32)
echo "MASTER_KEY: $MASTER_KEY"

docker run -p 4096:4096 \
  -e LITELLM_API_BASE=https://your-litellm-gateway \
  -e LITELLM_API_KEY=sk-... \
  -e MASTER_KEY="$MASTER_KEY" \
  ghcr.io/litellm-labs/lite-harness:latest
```

Open [localhost:4096](http://localhost:4096), paste the master key on the login page.

Needs a [LiteLLM](https://github.com/BerriAI/litellm) gateway. Full config: [docs/configuration.md](docs/configuration.md).

## sandboxing

Set `E2B_API_KEY` or `DAYTONA_API_KEY` and agents get an isolated Linux sandbox automatically. No other config.

## about

We built lite-harness because running opencode and claude-code as separate servers got hard to maintain - multiple services, different API specs, unreliable session management, different inputs for MCP tools and system prompts.

So we wrapped all harnesses in an OpenCode-compatible server and put it in one Dockerfile, giving us one service to maintain, with shared MCP tools, prompts, and session management across all harnesses.

## docs

[API reference](docs/api.md) · [Architecture](docs/architecture.md) · [Configuration](docs/configuration.md) · [Add a harness](docs/contributing-harness.md)

## license

MIT
