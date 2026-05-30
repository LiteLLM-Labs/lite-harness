# Build: APIs needed for agent self-publishing

## Context

A Claude Code agent running locally built a browser automation (LinkedIn outreach). It now needs to publish itself as a recurring agent on this lite-harness instance. This doc lists every API the agent needs to call to do that.

## IMPORTANT: Check existing endpoints first

Before building anything new, audit what already exists. Known existing endpoints as of this writing:

```
# Sessions (agent-like CRUD already exists)
GET    /session
POST   /session
GET    /session/{id}
POST   /session/{id}/message
POST   /session/{id}/prompt_async
GET    /session/{id}/message
POST   /session/{id}/abort
GET    /event                    # SSE stream

# Vault (exists as slash-command plugin: /vault set, list, delete, clear)
# Loop (exists as slash-command plugin: /loop start, stop, list, status)

# Infrastructure
GET    /health
GET    /whoami
GET    /v1/models
GET    /_litellm/health
```

**For each API below: check if an existing endpoint or plugin already does this. If it does, extend it rather than creating a duplicate. If it partially does it, add the missing fields. Only create new endpoints for genuinely new functionality.**

---

## APIs the publishing agent needs to call (in order of use)

### 1. Discovery — "what can this platform do?"

```
GET /api/capabilities
```

The agent calls this first to diff its local tools against what's available remotely.

**Check:** Does any existing endpoint return platform capabilities (available MCP servers, sandbox config, vault availability)? If not, this is new.

**Response must include:**
```json
{
  "harnesses": [{"name": "claude-code", "version": "..."}],
  "mcp_servers": [
    {
      "name": "...",
      "tools": ["..."],
      "auth_required": true/false,
      "auth_type": "api_key|bearer_token|service_account|oauth"
    }
  ],
  "vault": {"available": true/false},
  "scheduler": {"available": true/false, "min_interval_minutes": 15},
  "sandbox": {
    "provider": "e2b",
    "pip_install": true/false,
    "outbound_network": true/false,
    "persistent_storage": true/false,
    "max_runtime_minutes": 30
  }
}
```

**Why each field matters to the agent:**
- `mcp_servers` — agent diffs local tools vs available MCPs. Missing MCP = gap to surface to user.
- `mcp_servers[].auth_type` — tells agent what credential to ask user for (API key vs service account vs OAuth).
- `sandbox.pip_install` — can agent install `browser-use-sdk` at runtime?
- `sandbox.persistent_storage` — if false, agent knows to use external state (Google Sheets) not local files.
- `scheduler.available` — can agent set up cron, or manual-trigger only?

**Populate dynamically:** Read configured harnesses, scan registered MCP servers, check E2B/Daytona config. Don't hardcode.

---

### 2. Vault — store credentials securely

The agent needs to store API keys the user provides (Browser Use key, LinkedIn profile ID, GitHub token, etc).

**Check:** The `/vault` slash-command plugin already does `set`, `list`, `delete`, `clear`. Can this be exposed as HTTP endpoints? The agent calling from outside a session can't use slash commands — it needs HTTP.

**What's needed (HTTP equivalents of the vault plugin):**

```
POST   /api/vault/{user_id}          # store a key-value pair
GET    /api/vault/{user_id}          # list key names (never values)
DELETE /api/vault/{user_id}/{key}    # delete a key
```

**Request body for POST:**
```json
{
  "key": "BROWSER_USE_API_KEY",
  "value": "bu_xxx",
  "scope": "agent:linkedin-outreach"   // optional, limits which agents can read
}
```

**Response for GET (names only, never values):**
```json
{
  "keys": [
    {"key": "BROWSER_USE_API_KEY", "scope": "agent:linkedin-outreach", "created_at": "..."}
  ]
}
```

**Runtime resolution:** When a session/agent prompt contains `{{vault.KEY_NAME}}`, resolve it from vault before passing to harness. Scan prompt with regex `/\{\{vault\.([A-Za-z0-9_]+)\}\}/g`, fetch from vault scoped to the user, string-replace. Missing key = fail with clear error.

**If extending the existing vault plugin:** Reuse its storage backend. Just add HTTP route handlers that call the same underlying store. Don't build a second vault.

---

### 3. Create agent — persistent session with schedule

The agent needs to create a recurring automation that runs on a schedule.

**Check:** `POST /session` already creates sessions. Can it be extended with `schedule`, `setup_commands`, and `vault_keys` fields? Or is a separate `/api/agents` endpoint cleaner?

**Decision criteria:** If sessions are ephemeral (die after one conversation), agents need a separate entity. If sessions can be persistent + scheduled, extend sessions.

**What's needed:**

```
POST /api/agents
```

```json
{
  "name": "linkedin-stargazer-outreach",
  "owner_id": "1234",
  "description": "DMs GitHub stargazers on LinkedIn daily",
  "harness": "claude-code",
  "prompt": "You are an autonomous outreach agent...\n{{vault.BROWSER_USE_API_KEY}}...",
  "schedule": {
    "cron": "0 9 * * 1-5",
    "timezone": "America/Los_Angeles"
  },
  "vault_keys": ["BROWSER_USE_API_KEY", "LINKEDIN_PROFILE_ID", "GITHUB_TOKEN"],
  "mcp_servers": ["google-sheets"],
  "setup_commands": ["pip install browser-use-sdk gspread"],
  "max_runtime_minutes": 30,
  "on_failure": "pause_and_notify",
  "config": {
    "PER_RUN_CAP": 5,
    "SEND_ENABLED": false,
    "REPO": "BerriAI/litellm"
  }
}
```

**Response:**
```json
{
  "id": "agent_abc123",
  "name": "linkedin-stargazer-outreach",
  "owner_id": "1234",
  "status": "paused",
  "url": "https://lite-harness-direct-e2b.onrender.com/agents/agent_abc123",
  "schedule": {"cron": "0 9 * * 1-5", "next_run": "2026-05-30T09:00:00-07:00"},
  "created_at": "..."
}
```

**Key fields:**
- `prompt` — the full agent prompt. Contains `{{vault.X}}` and `{{config.X}}` template vars resolved at runtime.
- `schedule.cron` — optional. Omit for manual-trigger-only agents.
- `vault_keys` — platform validates these exist before each run. Missing key = fail fast, don't burn sandbox time.
- `setup_commands` — run in sandbox before agent starts. For `pip install`, etc.
- `config` — key-value map. Injected via `{{config.KEY}}` in prompt. Lets user tweak params without editing prompt.
- `on_failure` — `"pause_and_notify"` stops schedule on failure. Prevents burning through LinkedIn rate limits on a broken auth session.

**Also need:**

```
GET    /api/agents?owner_id={uid}        # list my agents
GET    /api/agents/{id}                  # get agent details
PATCH  /api/agents/{id}                  # update config, schedule, prompt
DELETE /api/agents/{id}                  # remove agent + stop schedule
POST   /api/agents/{id}/pause           # pause schedule
POST   /api/agents/{id}/resume          # resume schedule
```

**Check:** If these map cleanly onto existing session endpoints with added fields, extend sessions instead of building a parallel CRUD.

---

### 4. Trigger a run — manual execution

```
POST /api/agents/{agent_id}/run
```

```json
{
  "config_overrides": {
    "SEND_ENABLED": false,
    "PER_RUN_CAP": 1
  }
}
```

**`config_overrides`** merges with agent's stored config for THIS run only. Critical for dry-runs and testing.

**Response `202`:**
```json
{
  "run_id": "run_xyz789",
  "agent_id": "agent_abc123",
  "status": "starting",
  "logs_url": ".../api/agents/agent_abc123/runs/run_xyz789/logs"
}
```

**Check:** Does `POST /session/{id}/prompt_async` already do this? If so, can it accept `config_overrides` and return a `run_id`?

**Runtime per run:**
1. Spin up sandbox
2. Run `setup_commands`
3. Attach `mcp_servers`
4. Validate `vault_keys` exist
5. Resolve `{{vault.X}}` and `{{config.X}}` in prompt (with overrides applied)
6. Start harness with resolved prompt
7. Stream stdout to logs
8. On completion: capture summary, tear down sandbox

---

### 5. Stream logs — watch a run in real time

```
GET /api/agents/{agent_id}/runs/{run_id}/logs
Accept: text/event-stream
```

**SSE stream:**
```
data: {"ts": "...", "type": "info", "msg": "Loading tracker from Google Sheet..."}
data: {"ts": "...", "type": "action", "msg": "Sent connection request to Subhayu Kumar Bala"}
data: {"ts": "...", "type": "complete", "msg": "Done. 3 sent, 1 skipped."}
```

**Check:** `GET /event` already streams SSE for sessions. Can it be filtered by run ID? If yes, just add a `?run_id=` query param. Don't build a second SSE system.

**If run is already finished:** Return full log as batch, then close stream.

---

### 6. Run history — what happened

```
GET /api/agents/{agent_id}/runs?limit=10
```

```json
{
  "runs": [
    {
      "run_id": "run_xyz789",
      "status": "completed",
      "started_at": "...",
      "finished_at": "...",
      "summary": "Processed 5 stargazers: 3 sent, 1 skipped, 1 already connected",
      "error": null
    }
  ]
}
```

`status` ∈ `starting | running | completed | failed | timed_out | cancelled`

**Check:** Does the existing session message history (`GET /session/{id}/message`) already track this? If so, expose a filtered view rather than building new storage.

---

## What NOT to build

- **No file storage API.** Agent uses Google Sheets as state. No local files needed.
- **No webhook/notification API.** `on_failure: "pause_and_notify"` can just log for now. Add email/slack later.
- **No agent-to-agent communication.** Out of scope.
- **No prompt versioning.** PATCH overwrites. Git-level versioning is overkill for now.
- **No billing/usage tracking.** Out of scope.

## Build order

Each step is independently useful. Ship incrementally.

1. `GET /api/capabilities` — discovery. Static-ish, quick win.
2. `POST/GET/DELETE /api/vault/{user_id}` — or expose existing vault plugin as HTTP.
3. `POST /api/agents` + `GET /api/agents/{id}` — agent CRUD.
4. `POST /api/agents/{id}/run` — manual trigger.
5. `GET .../runs/{rid}/logs` — SSE log stream (reuse existing SSE infra if possible).
6. `GET .../runs` — run history.
7. Scheduler (cron) — `pause`/`resume`.

After step 5, the full "dry-run → verify → go live" flow works.
