# Skill: Deploy an Agent to lite-harness

Guide for publishing an autonomous agent to a lite-harness instance.
Covers discovery, vault setup, agent creation, and triggering runs.

---

## Prerequisites

- lite-harness instance URL (e.g. `https://lite-harness-direct-e2b.onrender.com`)
- Master API key (passed as `Authorization: Bearer <key>`)
- Agent prompt (system instructions for the agent)
- Any secrets the agent needs at runtime

---

## Step 1: Discover capabilities

```bash
curl -s -H "Authorization: Bearer $KEY" $BASE_URL/api/capabilities | jq .
```

Check:
- `sandbox.pip_install` — can the agent install Python packages?
- `sandbox.outbound_network` — can it make HTTP calls?
- `vault.available` — can you store secrets?
- `scheduler.cron_supported` — can you schedule recurring runs?
- `harnesses[]` — which harnesses are available (claude-code, opencode, codex)?

---

## Step 2: Store vault secrets

Vault keys are scoped by `owner_id`. The path is `/api/vault/{owner_id}`.

```bash
# Store a key
curl -X POST $BASE_URL/api/vault/{owner_id} \
  -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{"key":"MY_SECRET","value":"the-actual-value"}'

# List keys for an owner
curl -s -H "Authorization: Bearer $KEY" $BASE_URL/api/vault/{owner_id}
```

**Gotcha:** The generic `/api/vault/store` endpoint accepts writes but does NOT persist.
Always use `/api/vault/{owner_id}` — this is the path that works.

Store all secrets the agent needs before creating the agent (if the agent references `vault_keys`, creation validates they exist).

---

## Step 3: Create the agent

```bash
curl -X POST $BASE_URL/api/agents \
  -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{
    "name": "my-agent",
    "owner_id": "the-owner",
    "description": "One-line description of what the agent does",
    "prompt": "Full system prompt here...",
    "harness": "opencode",
    "model": "claude-sonnet-4-6",
    "vault_keys": ["MY_SECRET", "ANOTHER_SECRET"],
    "setup_commands": ["pip install some-package"],
    "max_runtime_minutes": 30,
    "on_failure": "pause_and_notify"
  }'
```

### Required fields
| Field | Description |
|-------|-------------|
| `name` | Kebab-case identifier |
| `owner_id` | Owner identifier (used for vault scoping) |

### Optional fields
| Field | Default | Description |
|-------|---------|-------------|
| `prompt` | `""` | System prompt — the agent's instructions |
| `description` | `null` | Human-readable description |
| `harness` | `"claude-code"` | Which harness runs the agent: `claude-code`, `opencode`, `codex` |
| `model` | `"claude-sonnet-4-6"` | Model to use |
| `vault_keys` | `[]` | List of vault key names to inject as env vars |
| `setup_commands` | `[]` | Shell commands to run before the agent starts |
| `cron` | `null` | Cron expression for scheduling (e.g. `"0 */4 * * 1-5"`) |
| `timezone` | `"UTC"` | Timezone for cron (e.g. `"America/Los_Angeles"`) |
| `max_runtime_minutes` | `30` | Max runtime before sandbox is killed |
| `on_failure` | `"pause_and_notify"` | What to do on failure |

### Harness selection
- `opencode` — lightweight, fast, good for automation tasks
- `claude-code` — full Claude Code CLI with file editing, git, etc.
- `codex` — OpenAI Codex harness

### Gotcha: vault_keys validation
If you pass `vault_keys` and the keys don't exist in the vault for that owner, creation returns `422 vault keys missing`. Two workarounds:
1. Store keys first (Step 2), then create agent with `vault_keys`
2. Create agent with `vault_keys: []`, then PATCH later after storing keys

---

## Step 4: Update an agent

```bash
curl -X PATCH $BASE_URL/api/agents/{agent_id} \
  -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{"prompt": "updated prompt", "vault_keys": ["KEY1", "KEY2"]}'
```

All fields from creation are patchable. PATCH may auto-activate the agent (set status to `active`).

---

## Step 5: Schedule or trigger

### Add a cron schedule
```bash
curl -X PATCH $BASE_URL/api/agents/{agent_id} \
  -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{"cron": "0 */4 * * 1-5", "timezone": "America/Los_Angeles"}'
```

Common cron patterns:
- `0 */4 * * 1-5` — every 4 hours, weekdays only
- `0 9 * * *` — daily at 9am
- `*/30 * * * *` — every 30 minutes

### Trigger a manual run
```bash
curl -X POST $BASE_URL/api/agents/{agent_id}/run \
  -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json"
```

Returns `{ "run_id": "run_xxx", "status": "starting", "logs_url": "..." }`.

### Pause / resume
```bash
curl -X POST $BASE_URL/api/agents/{agent_id}/pause \
  -H "Authorization: Bearer $KEY"

curl -X POST $BASE_URL/api/agents/{agent_id}/resume \
  -H "Authorization: Bearer $KEY"
```

Resume auto-wires cron loop if agent has a schedule.

---

## Step 6: Monitor

### Check run status
```bash
curl -s -H "Authorization: Bearer $KEY" \
  $BASE_URL/api/agents/{agent_id}/runs
```

### Stream run logs
```bash
curl -s -H "Authorization: Bearer $KEY" \
  $BASE_URL/api/agents/{agent_id}/runs/{run_id}/logs
```

---

## Step 7: Clean up

```bash
# Delete agent
curl -X DELETE $BASE_URL/api/agents/{agent_id} \
  -H "Authorization: Bearer $KEY"

# Delete a vault key
curl -X DELETE $BASE_URL/api/vault/{owner_id}/{key_name} \
  -H "Authorization: Bearer $KEY"

# List all agents
curl -s -H "Authorization: Bearer $KEY" \
  "$BASE_URL/api/agents?owner_id={owner_id}"
```

---

## Full example: end-to-end deploy

```bash
BASE_URL="https://lite-harness-direct-e2b.onrender.com"
KEY="sk-dev-master-key-change-me"
OWNER="krrish"

# 1. Check capabilities
curl -s -H "Authorization: Bearer $KEY" $BASE_URL/api/capabilities | jq .sandbox

# 2. Store secrets
curl -X POST $BASE_URL/api/vault/$OWNER \
  -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{"key":"API_KEY","value":"sk-real-key-here"}'

# 3. Create agent (no vault_keys yet to avoid validation)
curl -X POST $BASE_URL/api/agents \
  -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{
    "name": "my-agent",
    "owner_id": "'$OWNER'",
    "prompt": "You are an agent that...",
    "harness": "opencode",
    "vault_keys": []
  }'
# Returns: {"id": "agent_xxx", ...}

# 4. Patch with vault keys + schedule
curl -X PATCH $BASE_URL/api/agents/agent_xxx \
  -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{"vault_keys": ["API_KEY"], "cron": "0 9 * * *", "timezone": "America/Los_Angeles"}'

# 5. Trigger test run
curl -X POST $BASE_URL/api/agents/agent_xxx/run \
  -H "Authorization: Bearer $KEY"
```

---

## Writing agent prompts

Agents run in an E2B sandbox with pip/npm install and outbound network. The prompt should:

1. **Specify setup** — list packages to install (`pip install x y z`)
2. **Reference env vars** — secrets from vault are injected as `os.environ["KEY_NAME"]`
3. **Be self-contained** — include all logic, API patterns, data schemas
4. **Include guardrails** — rate limits, dedup, failure handling, stop conditions
5. **Handle state** — sandbox storage is ephemeral; use external APIs (Google Sheets, databases) for persistence across runs
6. **Report results** — print a summary at the end so logs are useful

### Sandbox limitations
- `persistent_storage: false` — files don't survive across runs
- `max_runtime_minutes: 30` — agent is killed after this
- No browser — use cloud browser APIs (e.g. Browser Use SDK) for web automation
- No GUI — everything is CLI/API driven
