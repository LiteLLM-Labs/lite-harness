---
name: build-agent
description: >
  Interactively design a new agent for a lite-harness instance — discover platform
  capabilities, interview the user about their goal, draft a system prompt grounded
  in what the server actually supports, then hand off to deploy-agent.
  Use when the user says "build an agent", "help me design an agent", "I want an agent that...",
  or describes an automation goal without an existing agent config.
---

# Build Agent for lite-harness

Design a new agent from scratch, grounded in what the target lite-harness instance actually supports. Ends with a confirmed agent design ready for `deploy-agent`.

---

## Step 1: Connect to the Instance

Collect from the user:

| What | Why |
|------|-----|
| `BASE_URL` | lite-harness instance URL (e.g. `https://lite-harness.onrender.com` or `http://localhost:4096`) |
| `MASTER_KEY` | API key — `Authorization: Bearer <key>`. Leave empty if no auth. |

```bash
BASE_URL="<from user>"
KEY="<from user>"
```

---

## Step 2: Discover Capabilities

Query everything the platform supports before designing anything.

**Capabilities:**

```bash
curl -s -H "Authorization: Bearer $KEY" "$BASE_URL/api/capabilities" | jq .
```

Note and report to user:
- `sandbox.pip_install` — can agent install Python packages?
- `sandbox.outbound_network` — can agent make HTTP/API calls?
- `vault.available` — can secrets be stored and injected?
- `scheduler.cron_supported` — can agent run on a schedule?
- `harnesses[]` — which harnesses are available (`opencode`, `claude-code`, `codex`)
- Files: always available — agents can have workspace files (`.py`, `.md`, `.txt`, `.json`, `.yaml`, `.yml`, `.csv`, `.xlsx`, `.sh`) pre-loaded into their sandbox. Max 2 MB per file, 100 per agent.

**Available models:**

```bash
curl -s -H "Authorization: Bearer $KEY" "$BASE_URL/api/models" | jq '.models[] | {id, name}'
```

**Available skills:**

```bash
curl -s -H "Authorization: Bearer $KEY" "$BASE_URL/api/skills" | jq '.skills[] | {slug, description}'
```

Show the user a summary of what's available. Flag anything missing that their goal might need (e.g. "outbound network is disabled — HTTP calls won't work").

---

## Step 3: Interview the User

Ask these questions. Adapt based on what capabilities are available — don't ask about schedules if `scheduler.cron_supported` is false.

1. **Goal** — What should the agent do? What's the trigger and the output?
2. **Inputs** — What data does it consume? (APIs, files, webhooks, env vars?)
3. **Outputs** — Where does it write results? (API, Slack, GitHub, database, logs?)
4. **Secrets** — Which API keys or tokens does it need at runtime?
5. **Workspace files** — Does the agent need any files pre-loaded in its sandbox? (config, seed data, scripts, templates — `.py`, `.json`, `.csv`, `.xlsx`, `.yaml`, `.sh`, etc.)
6. **Schedule** — Should it run on a cron, on demand, or both?
7. **Failure behavior** — If it fails, should it pause and notify, or keep retrying?
8. **Constraints** — Rate limits, dedup logic, stop conditions?

Keep the interview tight. If the user gave a clear description upfront (e.g. "CI monitor that posts to Slack"), infer what you can and only ask about gaps.

---

## Step 4: Recommend Design

Based on the interview and discovered capabilities, recommend:

### Harness
| Goal type | Recommended harness |
|-----------|-------------------|
| API automation, data pipelines, HTTP tasks | `opencode` |
| File editing, git operations, shell scripting | `claude-code` |
| OpenAI-compatible model required | `codex` |

### Model
Pick from the available models. Default to `claude-sonnet-4-6` for balanced speed/cost. Use a more capable model (e.g. `claude-opus-4-8`) only if the task requires complex reasoning. Use a smaller model (e.g. `claude-haiku-4-5`) for high-frequency simple tasks.

### Skills
Match discovered skill slugs to the agent's goal. Only attach skills that are directly relevant — extra skills add noise to context.

### Workspace Files
If the user needs files available at runtime, list them here with their paths and content. Files are materialized into the sandbox working directory before each run. Reference them in the system prompt by path (e.g. `open("config.json")`). If no files are needed, skip this section.

### Schedule
Suggest a cron expression based on the task. Common patterns:

| Use case | Expression |
|----------|-----------|
| Continuous monitoring (every 5 min) | `*/5 * * * *` |
| Hourly digest | `0 * * * *` |
| Daily report | `0 9 * * *` |
| Weekday business hours (every 4h) | `0 */4 * * 1-5` |
| Weekly summary | `0 9 * * 1` |

Use IANA timezone names (e.g. `America/Los_Angeles`, `UTC`).

---

## Step 5: Draft the System Prompt

Write a system prompt for the agent. A good prompt:

1. **Specifies setup** — `pip install x y z` as the first action
2. **References secrets by env var name** — vault keys are injected as `os.environ["KEY_NAME"]`
3. **Is self-contained** — all logic, API call patterns, error handling, dedup
4. **Has guardrails** — rate limits, max retries, stop conditions
5. **Handles state externally** — sandbox is ephemeral; persist to APIs, databases, or external stores
6. **Reports results** — prints a structured summary so logs are useful

Structure the prompt in clear sections:
- What to do
- How to set up (installs, auth)
- The main loop / task logic
- Error handling
- Output format / where to write results

Show the draft to the user. Ask them to confirm or request changes before proceeding.

---

## Step 6: Present Full Design

Show a design summary for user confirmation:

```
Agent Design
────────────────────────────────
Name:       <proposed-kebab-name>
Goal:       <one-line description>
Harness:    <harness>
Model:      <model>
Skills:     <skill-slug-1>, <skill-slug-2>
Schedule:   <cron expression or "manual only">
Timezone:   <tz>
Vault keys: <KEY1>, <KEY2>
Files:      <path/to/file.json>, <path/to/data.csv>  (or "none")
On failure: <pause_and_notify | retry | ignore>

System Prompt:
<full prompt>
────────────────────────────────
```

Ask: **"Does this look right? Confirm to deploy, or tell me what to change."**

Iterate on any section the user wants to revise. Do not proceed until the user explicitly confirms.

---

## Step 7: Dry-Test Locally

Before handing off to deploy-agent, run the agent's script locally to catch errors while you can still iterate fast.

Extract the executable code from the system prompt. Write it to a temp file:

```bash
cat > /tmp/agent_dry_test.py << 'SCRIPT'
<extracted agent script>
SCRIPT
```

Stub every vault secret with a placeholder — use obviously fake values so no real API calls fire:

```bash
export KEY1="dry-run-placeholder"
export KEY2="dry-run-placeholder"
# repeat for each vault key
```

Run **1-2 test cycles**:

```bash
python /tmp/agent_dry_test.py
# fix any errors in the system prompt, then run again
python /tmp/agent_dry_test.py
```

**What to check:**
- No import errors (add missing packages to `setup_commands`)
- No syntax errors
- Main task logic runs without crashing on stub credentials
- Output format looks correct (even if data is empty/fake)

If both passes exit cleanly, proceed. If the script requires a live API that truly can't be stubbed (e.g. OAuth redirect), get explicit user confirmation to skip.

Clean up:

```bash
rm /tmp/agent_dry_test.py
unset KEY1 KEY2  # unset each stubbed var
```

---

## Step 8: Hand Off to deploy-agent

Once confirmed, invoke the `deploy-agent` skill with all design decisions already made. Pass:
- `BASE_URL`, `KEY`, `OWNER` (ask for owner ID if not yet collected)
- Agent name, description, harness, model
- The confirmed system prompt
- Vault key names and values (collect values now if not already provided)
- Skills list
- Workspace files (paths + content, if any)
- Cron expression and timezone
- `on_failure` setting

The deploy-agent skill will handle vault storage, agent creation, skill attachment, scheduling, and the test run.
