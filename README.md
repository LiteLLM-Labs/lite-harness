# lite-harness

Run Claude Code/Codex/OpenCode on a sandbox in autopilot. Call the harnesses via a CLI or API's through an OpenCode-compatible API spec.

[![Discord](https://img.shields.io/badge/Discord-Chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/Nkxw3rm3EE)

![litellm_hero_v11](https://github.com/user-attachments/assets/7ff9d171-fcab-4657-8e44-8a9c8b978ac6)


## ui

<img width="2076" height="1194" alt="Xnapper-2026-05-30-17 47 11" src="https://github.com/user-attachments/assets/7e45c6c7-8973-42a3-b2a3-d053ef4f4484" />


## usage

Install the skills, then deploy agents from any AI coding agent (Claude Code, Codex, Cursor, etc.):

```bash
npx skills add LiteLLM-Labs/lite-harness -g
```

```
/deploy-agent

> Deploy a GitHub stargazer outreach agent that DMs new stars on LinkedIn,
  runs every 4 hours on weekdays, requires human approval before each send.

  ✓ Checking capabilities... sandbox=e2b vault=available cron=supported
  ✓ Stored vault key BROWSER_USE_API_KEY
  ✓ Stored vault key LINKEDIN_PROFILE_ID
  ✓ Created agent: agent_abc123 (opencode · claude-sonnet-4-6)
  ✓ Attached vault keys + scheduled 0 */4 * * 1-5 America/Los_Angeles
  ✓ Test run started: run_xyz789
  → Logs: https://lite-harness.onrender.com/api/agents/agent_abc123/runs/run_xyz789/logs
  → UI:   https://lite-harness.onrender.com/agents
```

Agents run on a cron schedule in an isolated sandbox. Human-in-the-loop approval flows through the Inbox UI.

Supported harnesses: `opencode` `claude-code` `github-copilot` `codex` — [full CLI docs](cli/README.md)

## setup

```bash
npx skills add LiteLLM-Labs/lite-harness -g
```

Then in any AI coding agent (Claude Code, Codex, Cursor, etc.):

```
/lite-harness-setup
```

Or follow the manual setup guide below.

<details>
<summary>Manual setup</summary>

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

</details>

Needs a [LiteLLM](https://github.com/BerriAI/litellm) gateway. Full config: [docs/configuration.md](docs/configuration.md).

## persistence

By default, sessions (history, model context) are lost when the server restarts. To keep them across restarts, mount persistent storage at the data directory:

**Docker:**
```bash
docker run -p 4096:4096 \
  -v ./data:/home/sandbox/.local/share/lite-harness \
  -e LITELLM_API_BASE=... \
  -e LITELLM_API_KEY=... \
  -e MASTER_KEY=... \
  ghcr.io/litellm-labs/lite-harness:latest
```

**Custom path** (e.g. a mounted cloud volume at `/mnt/data`):
```bash
-e DB_PATH=/mnt/data/db.db
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
