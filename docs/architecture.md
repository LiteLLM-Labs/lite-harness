# Harness Architecture

## How harness selection works

The harness is a **per-session, immutable property** set at session creation time.
Once a session has messages, its harness cannot change.

```
Developer / UI
    │
    │  POST /session {"harness": "claude-code"}
    ▼
┌─────────────────────────────────────────────────┐
│           Unified adapter  :4096                │
│                                                 │
│  sessionHarness Map                             │
│    ses_abc → "opencode"                         │
│    ses_xyz → "cc"                               │
│                                                 │
│   ┌───────────────┐    ┌───────────────────┐   │
│   │  opencode     │    │  claude-code SDK   │   │
│   │  child :4097  │    │  (in-process)      │   │
│   └───────────────┘    └───────────────────┘   │
└─────────────────────────────────────────────────┘
```

---

## When do you specify the harness?

**At `POST /session`** — and only then.

```bash
# opencode session (default)
curl -X POST http://localhost:4096/session \
  -d '{"harness": "opencode"}'

# claude-code session
curl -X POST http://localhost:4096/session \
  -d '{"harness": "claude-code"}'
```

After creation, every request to `/session/:id/...` is routed based on the harness
stored in the server's `sessionHarness` map — the caller never specifies it again.

---

## Request routing

On every inbound request the adapter checks `sessionHarness.get(sessionId)`:

| Harness | `prompt_async` | `GET message` | `GET /event` |
|---|---|---|---|
| `opencode` | Proxied to `opencode serve` child on `:4097` | Proxied to child | Piped from child SSE |
| `claude-code` | `@anthropic-ai/claude-code` `query()` called in-process | Returned from in-memory history | Written to `ccGlobalBus` → merged into `/event` SSE |

The `/event` SSE endpoint multiplexes both buses — a single `EventSource` on the
client receives events from whichever harness the session belongs to.

---

## Harness lifecycle

```
POST /session  →  harness locked in sessionHarness Map
                       │
                       ▼
                  [messages.length === 0]  ←── harness can still be swapped
                       │                       (UI deletes + recreates session)
                       │  first prompt_async
                       ▼
                  [messages.length > 0]   ←── harness is read-only
                       │
                       │  DELETE /session/:id
                       ▼
                  session removed from Map
```

"Swapping" before the first message is a client-side operation:
the UI calls `DELETE /session/:id` then `POST /session` with the new harness
and redirects to the new session URL. No partial state is left behind.

---

## Session state persistence

| | opencode | claude-code |
|---|---|---|
| **Where state lives** | `opencode serve` process (in-memory) | In-memory Map inside the adapter |
| **Survives restart** | No | No |
| **Multi-turn context** | Managed by opencode via `resume` | SDK `session_id` passed back as `resume` option each turn |

---

## Setup

Only two env vars are required:

```bash
export LITELLM_API_BASE="https://your-gateway/"   # trailing slash optional
export LITELLM_API_KEY="sk-..."

cd harnesses/opencode
./start-local.sh
# → server on http://localhost:4096
```

Optional vars:

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `4096` | Port the unified adapter listens on |
| `REPO_DIR` | adapter directory | Working directory for **opencode** sessions |
| `CC_REPO_DIR` | `$HOME` | Working directory for **claude-code** sessions |
| `LAP_BASE_URL` | `http://localhost:3000` | Only needed for LAP MCP tools (memory, issue reporter) |

See [docs/configuration.md](configuration.md) for the full env-var reference (`MASTER_KEY`, etc.).

---

## REPO_DIR vs CC_REPO_DIR

They're separate because each harness reads its working directory for context, and giving both the same directory would break claude-code identity.

`REPO_DIR` points at `harnesses/opencode/` — opencode runs from there and uses local config files (`opencode.json`, `CLAUDE.md`) to configure itself. This is intentional.

If claude-code sessions used the same directory, the model would read `harnesses/opencode/CLAUDE.md` and surrounding context and self-identify as the opencode harness. Early in development this produced responses like *"I'm running in the opencode harness (working directory: lite-harness/harnesses/opencode)"* from a claude-code session.

`CC_REPO_DIR` defaults to `$HOME` — a neutral directory with no harness-specific context. Set it to whatever workspace you want the claude-code agent to operate in.

---

## Environment wiring

The adapter sets Anthropic-SDK env vars at boot from the LiteLLM gateway vars,
so both harnesses talk to the same gateway:

```
LITELLM_API_BASE  ->  ANTHROPIC_BASE_URL  (used by claude-code SDK)
LITELLM_API_KEY   ->  ANTHROPIC_AUTH_TOKEN
```

The `opencode serve` child picks up the same env and routes through the
LiteLLM gateway via the provider config written to `opencode.json` at startup.

---

## Adding a new harness

1. Add harness id to the `harness` field union in `POST /session` handling
2. Add in-process session state (or a child process) for the new harness
3. Route `prompt_async`, `GET message`, and SSE bus in the adapter's switch points
4. Emit the same SSE event shapes (`message.part.delta`, `session.idle`, etc.)
