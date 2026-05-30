# Build: Agent CRUD + Vault + Run APIs

These endpoints let a Claude Code agent deploy itself as a recurring automation on lite-harness. The capabilities endpoint (see `capabilities-api-spec.md`) handles discovery. These handle everything else.

---

## 1. Vault — credential storage

### Store a secret

```
POST /api/vault/{user_id}
Authorization: Bearer {MASTER_KEY}
Content-Type: application/json

{
  "key": "BROWSER_USE_API_KEY",
  "value": "bu_J1yvpHWGf1Jvn_puOPlEKRts5-CTC-wzIQxfVdg7oMw",
  "scope": "agent:linkedin-stargazer-outreach"   // optional, limits which agents can read it
}
```

Response `201`:
```json
{
  "key": "BROWSER_USE_API_KEY",
  "user_id": "1234",
  "scope": "agent:linkedin-stargazer-outreach",
  "created_at": "2026-05-29T10:00:00Z"
}
```

Value is never returned after storage. Encrypted at rest.

### List keys (names only, never values)

```
GET /api/vault/{user_id}
Authorization: Bearer {MASTER_KEY}
```

Response `200`:
```json
{
  "keys": [
    {"key": "BROWSER_USE_API_KEY", "scope": "agent:linkedin-stargazer-outreach", "created_at": "..."},
    {"key": "LINKEDIN_PROFILE_ID", "scope": "agent:linkedin-stargazer-outreach", "created_at": "..."},
    {"key": "GITHUB_TOKEN", "scope": null, "created_at": "..."}
  ]
}
```

### Delete a secret

```
DELETE /api/vault/{user_id}/{key}
Authorization: Bearer {MASTER_KEY}
```

Response `204` (no body).

### How agents access vault values

In the agent prompt, use `{{vault.KEY_NAME}}`. At runtime, lite-harness resolves these from the vault before passing the prompt to the harness. The plaintext value never appears in logs or stored prompts.

Implementation: before spawning the sandbox, regex-scan the prompt for `{{vault.XXX}}` patterns, fetch values from vault (scoped to agent + user), string-replace. If a key is missing, fail the run with a clear error: `"Vault key BROWSER_USE_API_KEY not found for user 1234"`.

---

## 2. Agents — CRUD

### Create an agent

```
POST /api/agents
Authorization: Bearer {MASTER_KEY}
Content-Type: application/json

{
  "name": "linkedin-stargazer-outreach",
  "owner_id": "1234",
  "description": "DMs GitHub stargazers of BerriAI/litellm on LinkedIn daily",
  
  "harness": "claude-code",
  "model": "claude-sonnet-4-20250514",
  
  "prompt": "You are an autonomous outreach agent. Each run, process up to 5 new stargazers...\n\nCredentials:\n- BROWSER_USE_API_KEY = {{vault.BROWSER_USE_API_KEY}}\n- LINKEDIN_PROFILE_ID = {{vault.LINKEDIN_PROFILE_ID}}\n...",
  
  "schedule": {
    "cron": "0 9 * * 1-5",          // 9am UTC weekdays
    "timezone": "America/Los_Angeles"
  },
  
  "vault_keys": [
    "BROWSER_USE_API_KEY",
    "LINKEDIN_PROFILE_ID", 
    "GITHUB_TOKEN",
    "GOOGLE_SHEETS_SERVICE_ACCOUNT"
  ],
  
  "mcp_servers": ["google-sheets", "github"],
  
  "setup_commands": [
    "pip install browser-use-sdk gspread"
  ],
  
  "max_runtime_minutes": 30,
  
  "on_failure": "pause_and_notify",
  
  "config": {
    "PER_RUN_CAP": 5,
    "PACING_SECONDS_MIN": 60,
    "PACING_SECONDS_MAX": 120,
    "SEND_ENABLED": false,
    "REPO": "BerriAI/litellm",
    "DO_NOT_CONTACT": ["krrish-berri-2", "Pete Koomen"],
    "GOOGLE_SHEET_ID": "1sUW3PBxc1Zt8Q1oJFU8cPTKAM9nPgPoqsmTbuG2gEfU",
    "GOOGLE_SHEET_TAB": "contributors"
  }
}
```

Response `201`:
```json
{
  "id": "agent_a1b2c3",
  "name": "linkedin-stargazer-outreach",
  "owner_id": "1234",
  "status": "paused",
  "url": "https://lite-harness-direct-e2b.onrender.com/agents/agent_a1b2c3",
  "schedule": {"cron": "0 9 * * 1-5", "timezone": "America/Los_Angeles", "next_run": "2026-05-30T09:00:00-07:00"},
  "created_at": "2026-05-29T10:05:00Z"
}
```

Note: agent starts in `paused` status. User must explicitly trigger first run or resume the schedule after verifying the dry-run works.

### Field reference

| Field | Required | Description |
|---|---|---|
| `name` | yes | Unique per owner. Slug format. |
| `owner_id` | yes | User ID. Vault keys are scoped to this. |
| `description` | no | Human-readable, shown in dashboard. |
| `harness` | yes | Which runtime. Must match a name from `GET /api/capabilities → harnesses[].name`. |
| `model` | no | LLM model override. Default: whatever harness uses. |
| `prompt` | yes | The full agent prompt. May contain `{{vault.X}}` and `{{config.X}}` template vars. |
| `schedule.cron` | no | Cron expression. Omit for manual-only agents. |
| `schedule.timezone` | no | IANA timezone. Default UTC. |
| `vault_keys` | no | List of vault key names this agent needs. Platform validates they exist before running. |
| `mcp_servers` | no | List of MCP server names to attach. Must match names from capabilities endpoint. |
| `setup_commands` | no | Shell commands to run in sandbox before the agent starts. For installing dependencies. |
| `max_runtime_minutes` | no | Hard timeout. Default 30. Max from sandbox config. |
| `on_failure` | no | `"pause_and_notify"` (default), `"retry_once"`, `"continue"`. |
| `config` | no | Key-value pairs. Injected into prompt via `{{config.KEY}}`. For tweakable params without editing the prompt. |

### Get agent

```
GET /api/agents/{agent_id}
Authorization: Bearer {MASTER_KEY}
```

Returns full agent object (same as create response + `last_run`, `total_runs`, `status`).

### List agents

```
GET /api/agents?owner_id=1234
Authorization: Bearer {MASTER_KEY}
```

Returns array of agent objects (without full prompt — just metadata).

### Update agent

```
PATCH /api/agents/{agent_id}
Authorization: Bearer {MASTER_KEY}
Content-Type: application/json

{
  "config": {"SEND_ENABLED": true, "PER_RUN_CAP": 10},
  "schedule": {"cron": "0 9 * * *"}
}
```

Partial update. Only include fields to change. Response: updated agent object.

### Delete agent

```
DELETE /api/agents/{agent_id}
Authorization: Bearer {MASTER_KEY}
```

Response `204`. Stops any running execution. Removes schedule. Does NOT delete vault keys (those belong to the user, not the agent).

### Pause / Resume schedule

```
POST /api/agents/{agent_id}/pause
POST /api/agents/{agent_id}/resume
Authorization: Bearer {MASTER_KEY}
```

Response `200`: `{"status": "paused"}` or `{"status": "active"}`.

---

## 3. Runs — trigger and observe

### Trigger a run manually

```
POST /api/agents/{agent_id}/run
Authorization: Bearer {MASTER_KEY}
Content-Type: application/json

{
  "config_overrides": {
    "SEND_ENABLED": false,
    "PER_RUN_CAP": 1
  }
}
```

`config_overrides` is optional. Merges with agent's stored config for THIS run only. Useful for dry-runs.

Response `202`:
```json
{
  "run_id": "run_x9y8z7",
  "agent_id": "agent_a1b2c3",
  "status": "starting",
  "started_at": "2026-05-29T10:10:00Z",
  "logs_url": "https://lite-harness-direct-e2b.onrender.com/api/agents/agent_a1b2c3/runs/run_x9y8z7/logs"
}
```

### List runs

```
GET /api/agents/{agent_id}/runs?limit=10
Authorization: Bearer {MASTER_KEY}
```

Response `200`:
```json
{
  "runs": [
    {
      "run_id": "run_x9y8z7",
      "status": "completed",
      "started_at": "2026-05-29T10:10:00Z",
      "finished_at": "2026-05-29T10:18:00Z",
      "summary": "Processed 5 stargazers: 3 sent, 1 already connected, 1 skipped (no LinkedIn)",
      "error": null
    }
  ]
}
```

`status` ∈ `starting | running | completed | failed | timed_out | cancelled`

### Get run detail

```
GET /api/agents/{agent_id}/runs/{run_id}
Authorization: Bearer {MASTER_KEY}
```

Returns full run object including `summary`, `error`, `duration_seconds`, `config_used`.

### Stream run logs (SSE)

```
GET /api/agents/{agent_id}/runs/{run_id}/logs
Authorization: Bearer {MASTER_KEY}
Accept: text/event-stream
```

Server-Sent Events stream. Each event:

```
data: {"ts": "2026-05-29T10:10:05Z", "type": "info", "msg": "Loading stargazer tracker from Google Sheet..."}

data: {"ts": "2026-05-29T10:10:12Z", "type": "info", "msg": "Found 3 unprocessed stargazers"}

data: {"ts": "2026-05-29T10:11:30Z", "type": "action", "msg": "Sent connection request to Subhayu Kumar Bala (Loop AI)"}

data: {"ts": "2026-05-29T10:12:45Z", "type": "warning", "msg": "LinkedIn rate limit approaching, pacing extended to 180s"}

data: {"ts": "2026-05-29T10:18:00Z", "type": "complete", "msg": "Run complete. 3 sent, 1 skipped, 1 already connected."}
```

If the run is already finished, return the full log as a batch and close the stream.

Implementation: pipe stdout/stderr from the sandbox process as SSE events. The agent's `print()` statements become log entries. Add a `type` field based on prefix convention: lines starting with `[ERROR]` → `type: "error"`, `[WARN]` → `type: "warning"`, `[ACTION]` → `type: "action"`, else `type: "info"`.

---

## 4. Runtime behavior

### Sandbox lifecycle per run

1. Spin up E2B sandbox
2. Run `setup_commands` (pip install, etc.)
3. Attach `mcp_servers` listed in agent config
4. Resolve `{{vault.X}}` and `{{config.X}}` in prompt
5. Validate all `vault_keys` exist — fail fast if any missing
6. Start harness (claude-code) with resolved prompt
7. Stream stdout → SSE logs
8. On completion: capture last message as `summary`
9. On timeout: kill sandbox, set `status: "timed_out"`
10. On error: set `status: "failed"`, capture error
11. If `on_failure == "pause_and_notify"`: pause the schedule, notify owner (email/webhook TBD)
12. Tear down sandbox

### Config + vault template resolution

Before the prompt reaches the harness, replace:
- `{{vault.BROWSER_USE_API_KEY}}` → fetched from vault for this user
- `{{config.PER_RUN_CAP}}` → from agent's config map (with run-level overrides applied)

Scan with regex: `/\{\{(vault|config)\.([A-Za-z0-9_]+)\}\}/g`

Unresolved templates → fail the run with clear error listing which keys are missing.

---

## Verification flow (how user confirms it works)

This is the sequence Claude walks the user through after creating the agent:

### Step 1: Dry-run with cap of 1

```
POST /api/agents/agent_a1b2c3/run
{"config_overrides": {"SEND_ENABLED": false, "PER_RUN_CAP": 1}}
```

Claude tells user: "Triggered dry-run. Processing 1 stargazer with sends disabled. Watch logs:"

### Step 2: Stream logs together

```
GET /api/agents/agent_a1b2c3/runs/run_x9y8z7/logs
```

Claude and user watch the SSE stream. Claude narrates: "It found the stargazer, looked up LinkedIn, drafted the message. No send because dry-run. Check the Google Sheet — you should see the row updated."

### Step 3: User verifies sheet

User opens Google Sheet, confirms the row was read and status column updated correctly.

### Step 4: Live send of 1

```
POST /api/agents/agent_a1b2c3/run
{"config_overrides": {"SEND_ENABLED": true, "PER_RUN_CAP": 1}}
```

Claude: "Now sending for real — 1 person only. Watch logs."

User verifies: LinkedIn shows the connection request was sent with the right message.

### Step 5: Enable schedule

```
POST /api/agents/agent_a1b2c3/resume
```

```
PATCH /api/agents/agent_a1b2c3
{"config": {"SEND_ENABLED": true, "PER_RUN_CAP": 5}}
```

Claude: "Schedule active. Runs weekdays at 9am PT, processes 5 people per run. Dashboard: https://lite-harness-direct-e2b.onrender.com/agents/agent_a1b2c3"

---

## Implementation priority

Build in this order — each step is independently useful:

1. **`POST /api/vault/{user_id}`** + **`GET /api/vault/{user_id}`** — agents need credential storage before anything else
2. **`POST /api/agents`** + **`GET /api/agents/{id}`** — create and read agents
3. **`POST /api/agents/{id}/run`** — trigger runs manually
4. **`GET /api/agents/{id}/runs/{rid}/logs`** — SSE log streaming
5. **`GET /api/agents/{id}/runs`** — run history
6. **Scheduler** (cron integration) — `PATCH` to set schedule, `pause`/`resume`
7. **`DELETE`** endpoints — cleanup

Each step gives more capability. After step 4, the full verification flow works.
