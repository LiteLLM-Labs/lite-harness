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
5. **Schedule** — Should it run on a cron, on demand, or both?
6. **Failure behavior** — If it fails, should it pause and notify, or keep retrying?
7. **Constraints** — Rate limits, dedup logic, stop conditions?

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
On failure: <pause_and_notify | retry | ignore>

System Prompt:
<full prompt>
────────────────────────────────
```

Ask: **"Does this look right? Confirm to deploy, or tell me what to change."**

Iterate on any section the user wants to revise. Do not proceed until the user explicitly confirms.

---

## Step 7: Hand Off to deploy-agent

Once confirmed, invoke the `deploy-agent` skill with all design decisions already made. Pass:
- `BASE_URL`, `KEY`, `OWNER` (ask for owner ID if not yet collected)
- Agent name, description, harness, model
- The confirmed system prompt
- Vault key names and values (collect values now if not already provided)
- Skills list
- Cron expression and timezone
- `on_failure` setting

The deploy-agent skill will handle vault storage, agent creation, skill attachment, scheduling, and the test run.
