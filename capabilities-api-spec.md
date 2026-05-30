# Build: GET /api/capabilities endpoint

## What this is

A single discovery endpoint that tells Claude Code agents what this lite-harness instance can do. Agents call this before self-porting automations to identify gaps between their local tools and what's available remotely.

No auth required. Read-only. Returns JSON.

## Where to add it

Add a new route in `harnesses/inline-adapter.mjs` (or wherever the HTTP routes live). This is a top-level platform endpoint, not harness-specific.

## Route

```
GET /api/capabilities
```

No query params. No auth header. No request body.

## Response format

```json
{
  "harnesses": [
    {
      "name": "claude-code",
      "version": "1.0.0",
      "model_providers": ["anthropic", "litellm"]
    }
  ],

  "mcp_servers": [
    {
      "name": "google-sheets",
      "description": "Read/write Google Sheets via service account",
      "tools": ["sheets_read", "sheets_write", "sheets_append", "sheets_list"],
      "auth_required": true,
      "auth_type": "service_account"
    },
    {
      "name": "browser-use",
      "description": "Cloud browser automation via Browser Use API",
      "tools": ["browser_navigate", "browser_click", "browser_type", "browser_screenshot", "browser_js_exec", "browser_extract"],
      "auth_required": true,
      "auth_type": "api_key"
    },
    {
      "name": "github",
      "description": "GitHub API operations",
      "tools": ["gh_api", "gh_search", "gh_list_stargazers"],
      "auth_required": false,
      "auth_type": "bearer_token"
    }
  ],

  "vault": {
    "available": true,
    "operations": ["store", "list_keys", "delete"]
  },

  "scheduler": {
    "available": true,
    "min_interval_minutes": 15,
    "cron_supported": true,
    "manual_trigger": true
  },

  "sandbox": {
    "provider": "e2b",
    "outbound_network": true,
    "pip_install": true,
    "npm_install": true,
    "max_runtime_minutes": 30,
    "persistent_storage": false,
    "memory_mb": 2048,
    "cpu_cores": 2
  },

  "agents": {
    "create": "POST /api/agents",
    "list": "GET /api/agents?owner_id={uid}",
    "get": "GET /api/agents/{id}",
    "update": "PATCH /api/agents/{id}",
    "delete": "DELETE /api/agents/{id}",
    "trigger": "POST /api/agents/{id}/run",
    "pause": "POST /api/agents/{id}/pause",
    "resume": "POST /api/agents/{id}/resume",
    "runs": "GET /api/agents/{id}/runs",
    "run_logs": "GET /api/agents/{id}/runs/{rid}/logs"
  }
}
```

## How to populate the response

Don't hardcode the full JSON. Build it dynamically from what's actually configured on this instance.

### `harnesses`
Read from the existing harness registry. Each subdirectory in `harnesses/` that has a valid adapter = one entry. Version comes from each harness's package.json or config. `model_providers` comes from the LiteLLM gateway config (which providers are configured).

### `mcp_servers`
Read from the MCP server config (wherever shared MCP servers are registered for agents). For each configured server:
- `name`: the server's registered name
- `description`: from server metadata or config
- `tools`: list the tool names the server exposes. If the server has a `/tools` or manifest endpoint, call it at startup and cache. Otherwise read from config.
- `auth_required`: true if the server needs credentials to function
- `auth_type`: one of `"api_key"`, `"bearer_token"`, `"service_account"`, `"oauth"`, `"username_password"`. This tells the consuming agent what kind of credential to ask the user for.

If no MCP servers are configured, return an empty array. The absence of a server is the signal to the agent that a gap exists.

### `vault`
Check if the vault service is configured and reachable. Return `available: true/false`. The `operations` array is static for now — it's what the vault API supports.

### `scheduler`
Check if the scheduler/cron service is configured. `min_interval_minutes` comes from config (platform operator sets this to prevent abuse). `manual_trigger` = true if the `POST /api/agents/{id}/run` endpoint exists.

### `sandbox`
Read from E2B / Daytona config:
- `provider`: which sandbox backend
- `outbound_network`: does the sandbox have internet access
- `pip_install` / `npm_install`: can the sandbox install packages (usually true for E2B)
- `max_runtime_minutes`: from config or E2B plan limits
- `persistent_storage`: does the sandbox filesystem survive between runs (false for default E2B, true if persistent volumes are mounted)
- `memory_mb` / `cpu_cores`: from sandbox config

### `agents`
This is static — it's the route map for agent CRUD. Only include routes that are actually implemented. If `pause`/`resume` aren't built yet, omit them.

## Implementation notes

1. **Cache the response.** MCP server list and sandbox config don't change at runtime. Build the response once at startup, serve from memory. Invalidate on config reload.

2. **No auth on this endpoint.** It's a capability manifest, like `/.well-known/openid-configuration`. It exposes no secrets — just what features exist.

3. **Return 200 always.** Even if some subsystems are down, return the response with `available: false` on those. The endpoint itself should never fail.

4. **Content-Type: application/json.** Standard JSON response, no SSE, no streaming.

5. **CORS: allow all origins.** Agents may call this from browser contexts.

## Test it

```bash
curl https://lite-harness-direct-e2b.onrender.com/api/capabilities | jq .
```

Should return the full JSON. Verify:
- Every configured MCP server appears in `mcp_servers`
- `vault.available` matches whether vault is set up
- `scheduler.available` matches whether cron is set up
- `sandbox.provider` matches the actual sandbox backend
- `agents` only lists routes that are implemented

## Why this matters

An agent that built a local automation (e.g. LinkedIn outreach using Claude in Chrome + Google Sheets) calls this endpoint and diffs:

```
Local tools used          → Remote MCP available?
─────────────────────────────────────────────────
mcp__Claude_in_Chrome__*  → browser-use MCP? YES → need API key
Google Sheets (browser)   → google-sheets MCP? YES → need service account  
Local filesystem          → persistent_storage? NO → use Sheets as state
pip install               → pip_install? YES → can install browser-use-sdk
```

Gaps become actionable questions to the user. No gaps = auto-deploy.
