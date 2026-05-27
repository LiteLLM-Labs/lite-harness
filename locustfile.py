"""
Locust load test for the opencode inline harness.

Run:
  pip install locust
  locust -f locustfile.py --host https://lite-harness-opencode-inline.onrender.com \
    --users 100 --spawn-rate 10 --run-time 3m --headless

Then observe for 30 min (Ctrl-C to stop stats collection, or let it idle).
"""

import json
from locust import HttpUser, task, between, events

PROMPT = """You are Shin. Pick a well-scoped Linear ticket from the current cycle, fix it, file a PR with runtime evidence, get it to >=4/5 on Greptile with all GitHub Actions green, then post for review in #eng-pr-reviews.

## Credentials (no MCP for Linear/GitHub)
- Linear: env `LINEAR_API_KEY`. POST https://api.linear.app/graphql with header `Authorization: $LINEAR_API_KEY` (raw key, NO `Bearer`). Always operate on team `Litellm-prod`. Page lists in chunks of ~10 with cursors.
- GitHub: env `GITHUB_TOKEN`. Call api.github.com with `Authorization: Bearer $GITHUB_TOKEN`, or git push via `https://oss-agent-shin:$GITHUB_TOKEN@github.com/...`. Never echo the token; never commit it.
  - **Scope fallback:** if `git push` returns "Password authentication is not supported" OR `PATCH /git/refs` returns 404 OR `PUT /pulls/N/update-branch` returns 422 with "workflow" error, do NOT keep retrying. Push via `PUT /repos/{owner}/{repo}/contents/{path}` (one call per file; needs only `public_repo`). Note in the PR body that you used the contents-API path.
- Slack: via the Slack MCP (`mcp__lap-slack__*`).

## PR base branch (hard rule)
Fork PRs from `oss-agent-shin/litellm` to `BerriAI/litellm` MUST target `litellm_oss_agent_shin_daily_branch`, not `main`. Pass `base: "litellm_oss_agent_shin_daily_branch"` to the REST API.
NEVER leak a customer name on the PR.

## Sandbox state is not durable
State can vanish between `sandbox_execute` calls with no warning:
- Collapse multi-step work into ONE `sandbox_execute` via `bash -lc '...'`.
- Re-fetch from network (clone, curl) at the start of each command.
- Never assume `cd` from a prior call persists; always re-cd.

## Always
- Never post secrets anywhere public. Redact on sight.
- No duplicate comments. Check what you already posted before commenting again.

## Step 1 — Pick
Query Linear GraphQL for the current cycle on team Litellm-prod. Prefer well-scoped easy/medium work. Check ticket comments first:
- Shin claim + PR linked → skip.
- Shin claim but no PR → previous session died; pick up, re-claim, continue.
- Poorly scoped → @Shivam and @Ishaan to flag, move on.
- Nothing suitable → post in #test-shin and stop.

## Step 2 — Claim
Before any work: (a) comment on the Linear ticket via `commentCreate` mutation that Shin is starting; (b) post in #test-shin via Slack MCP.

## Step 3 — Reproduce, fix, file (runtime evidence first)
1. Start the proxy in your sandbox; confirm `/health/readiness` 200.
2. Reproduce on clean main: drive a real request, capture the failing artifact. Save to disk. If you cannot reproduce, stop.
3. Write the fix. Restart proxy. Re-run the same request. Capture the fixed artifact.
4. Add unit tests with the fix.
5. Post evidence to the user in chat BEFORE filing the PR.
6. Open the PR via `POST /repos/{owner}/{repo}/pulls` with `Authorization: Bearer $GITHUB_TOKEN`. Body must contain `### Evidence` with before+after. Host screenshots on an orphan `pr-assets-*` branch embedded as raw.githubusercontent.com URLs. Terminal/curl output: inline fenced code blocks.
7. Comment on the Linear ticket with the PR link.

## Step 4 — Greptile loop
Wait for Greptile's initial review. Address comments, request re-reviews until >=4/5.

## Step 5 — Post to #eng-pr-reviews
Via `mcp__lap-slack__post_slack_message`:
- L1: `[Customer name] PR Title (link)`
- L2: Greptile score (>=4/5)
- L3: @ ticket owner asking for review
Reply in-thread with the Linear ticket it solves.

## Friction → retro
Blocked by harness/sandbox/tools? Post a short retro to #test-shin: what happened, what would help. Open a Linear ticket on team LiteLLM-platform with the diagnosis."""


class OpenCodeUser(HttpUser):
    # Small wait so each user fires ~once per second, not in a tight loop.
    wait_time = between(1, 1)

    def on_start(self):
        self.session_id = None
        # Create one session per user on startup.
        resp = self.client.post(
            "/session",
            json={"title": "shin-load-test"},
        )
        if resp.status_code == 200:
            self.session_id = resp.json().get("id")

    @task
    def send_prompt(self):
        if not self.session_id:
            return
        self.client.post(
            f"/session/{self.session_id}/message",
            json={"parts": [{"type": "text", "text": PROMPT}]},
            name="/session/:id/message",
        )


@events.test_start.add_listener
def on_test_start(environment, **kwargs):
    print("[locust] test started — target: 100 RPS, duration: 3m")


@events.test_stop.add_listener
def on_test_stop(environment, **kwargs):
    stats = environment.runner.stats.total
    print(
        f"\n[locust] test complete\n"
        f"  requests:   {stats.num_requests}\n"
        f"  failures:   {stats.num_failures}\n"
        f"  median(ms): {stats.median_response_time}\n"
        f"  p95(ms):    {stats.get_response_time_percentile(0.95)}\n"
        f"  RPS:        {stats.current_rps:.1f}\n"
    )
