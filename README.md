# lite-harness

Run Claude Code/Codex/OpenCode on a sandbox in autopilot. Call the harnesses via a CLI or API's through an OpenCode-compatible API spec.

![litellm_hero_v11](https://github.com/user-attachments/assets/7ff9d171-fcab-4657-8e44-8a9c8b978ac6)

## usage

```bash
# git clone https://github.com/LiteLLM-Labs/lite-harness && cd lite-harness
# cd cli && npm install -g .

lite login
# Server URL [http://localhost:4096]:
# Master key: ✓ Saved

lite claude-code

  lite  claude-code
  claude-sonnet-4-6  ·  localhost:4096  ·  sess_a1b2c3

  /clear to reset history  · Ctrl+C or "exit" to quit

❯ monitor CI every hour and fix any bugs
  ⠙ thinking…
  ✓ bash {"command":"gh run list --limit 5"}
  I'll set up a recurring CI monitor. Checking the last 5 runs now...
```

```bash
lite opencode

  lite  opencode
  claude-sonnet-4-6  ·  localhost:4096  ·  sess_d4e5f6

  /clear to reset history  · Ctrl+C or "exit" to quit

❯ dm github stargazers daily
  ⠙ thinking…
  ✓ bash {"command":"gh api /repos/LiteLLM-Labs/lite-harness/stargazers"}
  Got 42 new stargazers. Drafting DMs...
```

Supported agents: `opencode` `claude-code` `github-copilot` `codex` — [full CLI docs](cli/README.md)

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

## persistence

By default, sessions (history, model context) are lost when the server restarts. To keep them across restarts, mount persistent storage at the SQLite path.

**Docker:**
```bash
docker run -p 4096:4096 \
  -v ./data:/home/sandbox/.local/share/opencode \
  -e LITELLM_API_BASE=... \
  -e LITELLM_API_KEY=... \
  -e MASTER_KEY=... \
  ghcr.io/litellm-labs/lite-harness:latest
```

**Custom path** (e.g. a mounted cloud volume at `/mnt/data`):
```bash
-e LOOP_DB_PATH=/mnt/data/sessions.db
```

On restart the server logs `hydrated N session(s) from db` and all prior sessions are immediately available.

## sandboxing

Set `E2B_API_KEY` or `DAYTONA_API_KEY` and agents get an isolated Linux sandbox automatically. Full options (templates, snapshots, vault): [docs/configuration.md](docs/configuration.md#sandbox-opencode-mcp).

## about

We built lite-harness because running opencode and claude-code as separate servers got hard to maintain - multiple services, different API specs, unreliable session management, different inputs for MCP tools and system prompts.

So we wrapped all harnesses in an OpenCode-compatible server and put it in one Dockerfile, giving us one service to maintain, with shared MCP tools, prompts, and session management across all harnesses.

## docs

[API reference](docs/api.md) · [Architecture](docs/architecture.md) · [Configuration](docs/configuration.md) · [CLI](cli/README.md) · [Add a harness](docs/contributing-harness.md)

## license

MIT
