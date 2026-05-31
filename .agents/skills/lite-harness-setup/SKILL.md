---
name: lite-harness-setup
description: >
  Set up lite-harness locally — install prerequisites, configure a LiteLLM gateway connection,
  build the UI, start the server, and install the CLI. Run this once to get lite-harness
  running on http://localhost:4096.
---

# lite-harness Setup

One-command setup for a local lite-harness instance. Walks you through everything needed to run opencode, claude-code, codex, and github-copilot behind a single unified API on your machine.

## CRITICAL Rules

### Check Before Acting

Every step must **verify current state before making changes**. Run the check command first — if the condition is already satisfied, print "✓ already done" and skip. Re-running this skill at any time must be safe.

### Never Hardcode Secrets

All secrets (`LITELLM_API_KEY`, `MASTER_KEY`) are written to `.env` via `Bash` commands the user can see and approve. Never echo them into the conversation or write them with the `Write` tool.

### Fail Fast, Explain Clearly

If a prerequisite check fails or a command errors, stop immediately, explain what's missing, and tell the user exactly what to fix before continuing.

---

## Step 0: Choose Setup Mode

Ask the user which setup path they want:

- **Local dev** (recommended for contributors) — clone the repo, install deps, run `start-local.sh`. Full source access, hot-reloadable UI.
- **Docker** — pull and run the published image. No Node.js required, no build step.

If the user already has the repo cloned, default to **local dev** and skip the clone step.

Store the choice — it determines which path to follow throughout.

---

## Step 1: Prerequisites

### 1a. Node.js (local dev only)

```bash
node --version
```

Required: **18 or higher**. If missing or too old:

```bash
# macOS (Homebrew)
brew install node

# Or download from https://nodejs.org
```

Verify:

```bash
node --version   # must print v18.x.x or higher
```

### 1b. opencode (local dev only)

```bash
which opencode && opencode --version
```

If missing:

```bash
npm install -g opencode@latest
```

Verify:

```bash
opencode --version
```

### 1c. Docker (Docker path only)

```bash
docker --version
```

If missing, direct the user to https://docs.docker.com/get-docker/ and wait.

---

## Step 2: Clone the Repo (local dev only)

Check if already cloned:

```bash
ls lite-harness/harnesses/inline-adapter.mjs 2>/dev/null && echo "exists"
```

If not present:

```bash
git clone https://github.com/LiteLLM-Labs/lite-harness.git
cd lite-harness
```

Verify:

```bash
ls harnesses/inline-adapter.mjs   # must exist
```

---

## Step 3: Install Dependencies (local dev only)

### 3a. Harness deps

```bash
cd harnesses
npm install
cd ..
```

### 3b. UI deps

```bash
cd ui
npm install
cd ..
```

Both installs are idempotent — re-running is safe.

---

## Step 4: Configure Environment

### 4a. LiteLLM gateway

lite-harness routes all agent traffic through a [LiteLLM](https://github.com/BerriAI/litellm) gateway. The user needs:

- `LITELLM_API_BASE` — their gateway URL (e.g. `https://gateway.mycompany.com`)
- `LITELLM_API_KEY` — a virtual key issued by that gateway

Ask the user for both values. If they don't have a gateway yet, point them to the [LiteLLM quickstart](https://docs.litellm.ai/docs/proxy/quick_start).

### 4b. Write .env

Check if `.env` already exists:

```bash
ls .env 2>/dev/null && echo "exists"
```

If it exists, check whether `LITELLM_API_BASE` and `LITELLM_API_KEY` are already set:

```bash
grep -E "^LITELLM_API_BASE=|^LITELLM_API_KEY=" .env
```

If both are already set, skip this step.

Otherwise, write the values the user provided:

```bash
# Write LITELLM_API_BASE (append or create)
grep -q "^LITELLM_API_BASE=" .env 2>/dev/null \
  && sed -i '' "s|^LITELLM_API_BASE=.*|LITELLM_API_BASE=<value-from-user>|" .env \
  || echo "LITELLM_API_BASE=<value-from-user>" >> .env

# Write LITELLM_API_KEY
grep -q "^LITELLM_API_KEY=" .env 2>/dev/null \
  && sed -i '' "s|^LITELLM_API_KEY=.*|LITELLM_API_KEY=<value-from-user>|" .env \
  || echo "LITELLM_API_KEY=<value-from-user>" >> .env
```

**Replace `<value-from-user>` with the actual values the user gave you.**

### 4c. Optional: MASTER_KEY

Ask: *"Do you want to password-protect your lite-harness UI? If yes, I'll generate a master key. If no, the server will be open (fine for local dev)."*

If yes, generate and save:

```bash
MASTER_KEY=$(openssl rand -hex 32)
echo "MASTER_KEY=$MASTER_KEY" >> .env
echo "Generated MASTER_KEY — save this, you'll need it to log in to the UI"
```

Print the key value so the user can note it down.

### 4d. Optional: Sandbox (E2B or Daytona)

Ask: *"Do you want agents to run in isolated sandboxes (E2B or Daytona)? This enables pip/npm install and outbound network in a safe container."*

If **E2B**:

```bash
echo "E2B_API_KEY=<user-provided-key>" >> .env
```

If **Daytona**:

```bash
echo "DAYTONA_API_KEY=<user-provided-key>" >> .env
echo "DAYTONA_API_URL=<user-provided-url>" >> .env
```

If neither, skip — agents still run without sandboxing.

---

## Step 5: Start the Server

### Local dev path

Build the UI and start in one command:

```bash
./start-local.sh
```

This will:
1. Build the Next.js UI into `ui/out/`
2. Start the opencode child process
3. Start the unified inline adapter on `http://localhost:4096`

To skip the UI build on subsequent starts (faster):

```bash
SKIP_UI_BUILD=1 ./start-local.sh
```

**Expected output:**

```
[start-local] building UI...
[start-local] base=https://... model=anthropic/claude-sonnet-4-6 port=4096
[start-local] MCP servers: ...
[start-local] starting inline adapter on :4096
[start-local] open http://localhost:4096 in your browser
```

Wait for the `starting inline adapter` line before continuing. If the server errors, check:

```bash
# Common: LITELLM_API_BASE not set or unreachable
curl -s "$LITELLM_API_BASE/v1/models" -H "Authorization: Bearer $LITELLM_API_KEY" | head -5
```

### Docker path

```bash
export MASTER_KEY=$(openssl rand -hex 32)
echo "MASTER_KEY: $MASTER_KEY"   # save this

docker run -p 4096:4096 \
  -e LITELLM_API_BASE=<user-provided-base> \
  -e LITELLM_API_KEY=<user-provided-key> \
  -e MASTER_KEY="$MASTER_KEY" \
  ghcr.io/litellm-labs/lite-harness:latest
```

Wait until the container logs show the server is listening on port 4096.

---

## Step 6: Verify the Server

Open the UI:

```bash
open http://localhost:4096   # macOS
# or: xdg-open http://localhost:4096  (Linux)
```

If `MASTER_KEY` was set, enter it on the login page.

Check the API directly:

```bash
curl -s http://localhost:4096/whoami \
  -H "Authorization: Bearer <master-key-or-omit-if-none>" | jq .
```

Should return `{"ok": true}` or similar.

---

## Step 7: Install the CLI (optional)

The `lite` CLI gives a terminal TUI for chatting with any harness.

Check if already installed:

```bash
which lite && lite --version
```

If missing:

```bash
# From the repo root
cd cli && npm install -g .
```

Or link for development:

```bash
cd cli && npm link
```

Verify:

```bash
lite --help
```

### Log in to the local server

```bash
lite login
# Server URL [http://localhost:4096]: (press Enter to accept default)
# Master key: (enter MASTER_KEY if set, or leave empty)
```

### Start a chat session

```bash
lite opencode          # default harness
lite claude-code       # Claude Code harness
lite codex             # OpenAI Codex harness
lite github-copilot    # GitHub Copilot harness
```

---

## Step 8: Summary

Print a summary of what was set up:

- Server URL: `http://localhost:4096`
- Gateway: `<LITELLM_API_BASE>`
- UI: open in browser, paste MASTER_KEY if set
- CLI: `lite opencode` to start a session
- Docs: `docs/` folder in the repo for API reference, configuration, and architecture

If anything failed, print the specific step that failed and the error message.

---

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `LITELLM_API_BASE not set` on start | `.env` not found or missing var | Run Step 4 again; check `.env` exists in repo root |
| `ProviderModelNotFoundError` | Model not registered in gateway | Check gateway has the model; re-run `start-local.sh` to refresh model list |
| `EADDRINUSE :4096` | Another process on port 4096 | `lsof -ti :4096 \| xargs kill` then restart |
| UI loads but login fails | Wrong MASTER_KEY | Check `.env` for the exact value; it's case-sensitive |
| `opencode: command not found` | opencode not installed | `npm install -g opencode@latest` |
| Docker image not found | Wrong tag | Use `ghcr.io/litellm-labs/lite-harness:latest` |
