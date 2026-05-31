---
name: deploy-agent
description: >
  Deploy an autonomous agent to a lite-harness instance — store vault secrets,
  create the agent, attach skills, set a cron schedule, and trigger a test run.
  Use when the user says "deploy an agent", "push this agent", "create an agent on lite-harness",
  or describes an automation they want running on a schedule.
---

# Deploy Agent to lite-harness

Deploy an autonomous agent to any lite-harness instance. The agent will collect what it needs from the user, store secrets in the vault, create the agent via the API, and optionally schedule and trigger a test run.

## Before You Start

Collect from the user (ask if not already provided):

| What | Why |
|------|-----|
| `BASE_URL` | lite-harness instance URL (e.g. `https://lite-harness.onrender.com` or `http://localhost:4096`) |
| `MASTER_KEY` | API key — `Authorization: Bearer <key>`. Leave empty if the server has no auth. |
| Agent name | Kebab-case identifier (e.g. `stargazer-outreach`) |
| Owner ID | Scopes vault keys — typically a username or team name |
| What the agent should do | Used to write the system prompt if the user doesn't provide one |

Store as shell vars for use in every command:

```bash
BASE_URL="<from user>"
KEY="<from user>"
OWNER="<from user>"
```

---

## Step 1: Check Capabilities

Verify the instance supports what the agent needs:

```bash
curl -s -H "Authorization: Bearer $KEY" "$BASE_URL/api/capabilities" | jq .
```

Report to the user:
- `sandbox.pip_install` / `sandbox.outbound_network` — whether the agent can install packages and make HTTP calls
- `vault.available` — whether secrets can be stored
- `scheduler.cron_supported` — whether cron scheduling is available
- `harnesses[]` — which harnesses are available

List available skills the agent can use:

```bash
curl -s -H "Authorization: Bearer $KEY" "$BASE_URL/api/skills" | jq '.skills[] | .slug'
```

---

## Step 2: Store Vault Secrets

Ask the user which secrets the agent needs at runtime (API keys, tokens, etc.).

For each secret:

```bash
curl -s -X POST "$BASE_URL/api/vault/$OWNER" \
  -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{"key": "<KEY_NAME>", "value": "<VALUE>"}'
```

**Critical:** Always use `/api/vault/$OWNER` — the generic `/api/vault/store` path does NOT persist.

Verify the keys were stored:

```bash
curl -s -H "Authorization: Bearer $KEY" "$BASE_URL/api/vault/$OWNER" | jq '.keys[]'
```

---

## Step 3: Write the System Prompt

If the user hasn't provided a prompt, draft one based on their description. A good agent prompt:

1. **Specifies setup** — `pip install x y z` or `npm install x`
2. **References env vars by name** — secrets from vault are injected as `os.environ["KEY_NAME"]`
3. **Is self-contained** — includes all logic, API patterns, error handling
4. **Includes guardrails** — rate limits, dedup, stop conditions, failure handling
5. **Handles state externally** — sandbox storage is ephemeral; persist to APIs, Sheets, databases
6. **Reports results** — prints a summary at the end so logs are useful

Show the draft prompt to the user and ask them to confirm or edit before proceeding.

---

## Step 4: Create the Agent

Create without `vault_keys` first to avoid 422 validation errors, then patch them on:

```bash
agent=$(curl -s -X POST "$BASE_URL/api/agents" \
  -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{
    "name": "<agent-name>",
    "owner_id": "'"$OWNER"'",
    "description": "<one-line description>",
    "prompt": "<system prompt>",
    "harness": "<opencode|claude-code|codex>",
    "model": "claude-sonnet-4-6",
    "setup_commands": ["<any pip/npm installs>"],
    "max_runtime_minutes": 30,
    "on_failure": "pause_and_notify",
    "vault_keys": []
  }')

AGENT_ID=$(echo "$agent" | jq -r '.id')
echo "Created: $AGENT_ID"
```

**Harness guide:**
- `opencode` — lightweight, fast, good for automation and API tasks
- `claude-code` — full Claude Code CLI with file editing, git, shell access
- `codex` — OpenAI Codex (requires OpenAI-compatible model)

---

## Step 5: Attach Vault Keys and Skills

```bash
curl -s -X PATCH "$BASE_URL/api/agents/$AGENT_ID" \
  -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{
    "vault_keys": ["<KEY1>", "<KEY2>"],
    "skills": ["<skill-slug-1>", "<skill-slug-2>"]
  }'
```

`skills` are slug names from `GET /api/skills`. The server injects the skill files into the agent's context at runtime.

---

## Step 6: Schedule (Optional)

Ask the user if they want the agent to run on a cron schedule.

```bash
curl -s -X PATCH "$BASE_URL/api/agents/$AGENT_ID" \
  -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{"cron": "<expression>", "timezone": "<tz>"}'
```

Common patterns:
| Schedule | Expression |
|----------|-----------|
| Every 4 hours, weekdays | `0 */4 * * 1-5` |
| Daily at 9am | `0 9 * * *` |
| Every 30 minutes | `*/30 * * * *` |
| Weekly Monday 9am | `0 9 * * 1` |

Use IANA timezone names (e.g. `America/Los_Angeles`, `Europe/London`, `UTC`).

---

## Step 7: Trigger a Test Run

```bash
run=$(curl -s -X POST "$BASE_URL/api/agents/$AGENT_ID/run" \
  -H "Authorization: Bearer $KEY")

RUN_ID=$(echo "$run" | jq -r '.run_id')
echo "Run started: $RUN_ID"
echo "Logs: $BASE_URL/api/agents/$AGENT_ID/runs/$RUN_ID/logs"
```

Stream logs:

```bash
curl -s -H "Authorization: Bearer $KEY" \
  "$BASE_URL/api/agents/$AGENT_ID/runs/$RUN_ID/logs"
```

---

## Step 8: Summary

Print a summary for the user:

```
✓ Agent deployed: <name> (<AGENT_ID>)
  Instance:  <BASE_URL>
  Harness:   <harness>
  Model:     <model>
  Schedule:  <cron expression or "manual only">
  Vault:     <list of injected key names>
  Skills:    <list of attached skill slugs>
  UI:        <BASE_URL>/agents
```

---

## Managing Deployed Agents

```bash
# List all agents for an owner
curl -s -H "Authorization: Bearer $KEY" "$BASE_URL/api/agents?owner_id=$OWNER" | jq '.agents[] | {id, name, status}'

# Update prompt or config
curl -s -X PATCH "$BASE_URL/api/agents/$AGENT_ID" \
  -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{"prompt": "updated prompt"}'

# Pause / resume cron
curl -s -X POST "$BASE_URL/api/agents/$AGENT_ID/pause" -H "Authorization: Bearer $KEY"
curl -s -X POST "$BASE_URL/api/agents/$AGENT_ID/resume" -H "Authorization: Bearer $KEY"

# Delete
curl -s -X DELETE "$BASE_URL/api/agents/$AGENT_ID" -H "Authorization: Bearer $KEY"
```

**Patch semantics:** omitted fields are preserved; array fields (`vault_keys`, `setup_commands`, `skills`) are fully replaced.
