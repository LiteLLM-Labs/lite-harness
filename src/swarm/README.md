# swarm

One task. A team of agents. Every conversation in view.

A small CLI that runs agents in parallel, shares their contributions, asks a critic to review, and combines the work into one answer. Mix **Codex**, **Claude Code**, and the built-in **LiteLLM** harness in one team. An optional local view shows the team as a moving constellation, with real harness marks, public conversations, tool activity, and handoffs.

**Node 22+. Zero npm dependencies. No build step or background service.**

## Start

From this directory:

```sh
./swarm demo --open
```

The demo is a clearly labeled simulation. It makes no model calls and changes no project files. It uses the real runner, event stream, persistence, and interface.

Run real work using an installed, authenticated harness:

```sh
./swarm run "Review this project and suggest the three most useful improvements" --harness claude --open
./swarm run "Explain the architecture of this project" --harness codex --cwd /path/to/project
```

For a global `swarm` command, run `npm install --global .`. You can also run `node bin/swarm.mjs` directly. The local `./swarm` launcher prefers the bundled Codex runtime when available, otherwise your Node installation; `SWARM_NODE` overrides it.

## Use the LiteLLM gateway

Set credentials in your terminal or secret manager, never in a team JSON file:

```sh
export LITELLM_BASE_URL=https://gateway-dev.litellm-sandbox.ai
# Set LITELLM_API_KEY securely in your environment.
./swarm models
export LITELLM_MODEL=your-gateway-model-alias
./swarm run "Write a concrete implementation plan" --open
```

The gateway must expose OpenAI-compatible streaming chat completions with tool calling. `LITELLM_MODEL` must be an alias available to your key; the fallback `gpt-4.1-mini` is an example, not a guaranteed deployment. `swarm models` verifies model discovery and lists the actual aliases. A 401, missing binary, or failed model call stays visible as a failure; there is no automatic simulated fallback.

The native harness routes through LiteLLM. Codex and Claude Code use their installed CLI authentication and provider configuration; choosing a logo does not reroute those harnesses through the gateway.

For a private local setup, `--env-file FILE` reads only the three `LITELLM_*` settings above, overriding inherited values. The local `./swarm` launcher loads a `.env` beside itself when present. That file is git-ignored; keep its permissions private (`chmod 600 .env`). No key is bundled in the package.

## Mix harnesses and models

```sh
./swarm init
# Edit each agent's harness and model in swarm.json.
./swarm run "Solve this task" --config swarm.json --open
```

See [examples/mixed-team.json](examples/mixed-team.json). Supported harness IDs are `native`, `codex`, and `claude`. Empty Codex model means its default; Claude defaults to `sonnet`. Model aliases and availability depend on your installed harness and account.

A team contains 2–12 agents with unique IDs, roles, and `dependsOn` lists. Independent agents start together. Downstream agents receive the completed public contributions of their dependencies. The graph must have one final agent that combines the work. Failed dependencies block dependent work; successful partial contributions remain available.

The default team is Scout + Builder in parallel → Critic → Lead. In the browser, **Configure swarm** changes each harness and model; a JSON configuration also lets you change names, roles, and dependencies.

## See and steer the work

- `--open` starts the local view alongside a terminal run. Select a logo to inspect that agent; select the center to see the whole team. Progress counts completed agents, not elapsed time.
- Type a direction in the terminal or browser. It is included in agents that have **not started** their next contribution. It does not interrupt a running model request.
- Use `/stop`, the browser Stop button, or Ctrl+C to cancel. Completed and partial work is retained. `/quit` closes the local server.
- `./swarm logs` prints the latest public conversation. `./swarm list` lists saved runs. Pass a run ID to `logs` to inspect an older one.
- `./swarm run "Refine the result" --follow-up RUN-ID` includes the previous task and final answer.
- `./swarm ui --open` starts an empty local workspace. Browser refresh reconnects to the same run. Recent runs reopen saved output.
- `--json` emits newline-delimited lifecycle, tool, and text events for scripts. A terminal-only run exits nonzero on failure or cancellation.

## Workspace and limits

Agents inspect `--cwd` (the current directory by default). **Writes are disabled by default.** Add `--tools` to permit writes relevant to the task. Give concurrent writers separate files or responsibilities in their roles.

The native harness provides only list/read/write file tools: no shell, browser, or external messaging. Its file paths reject traversal and symlinks and protect `.git`/`.swarm`; this is a path guard, not an OS sandbox against hostile concurrent processes. Codex uses its own read-only/workspace-write sandbox; Claude uses its restricted file-tool allowlist. Those harness permissions are not equivalent OS isolation. Use a disposable workspace for untrusted projects.

Runs are saved as private JSON files in `.swarm/runs` (override with `--data-dir`). One process owns a data directory and one run is active per process. Private model reasoning is not captured. Public contributions and tool activity are saved; do not put secrets in prompts or project files you ask agents to inspect.

The browser server binds to `127.0.0.1`, checks Host/Origin, and requires an ephemeral bearer token for every API request. The local page receives that token automatically; gateway keys never enter browser state. It is a local tool, not a public multiuser service. No tunnel, deployment, or account system is included.

The default whole-run limit is 10 minutes (`--timeout 600`); configurable up to 24 hours. Native agents stop after 12 model/tool rounds. Agent output and file reads are bounded. The event timeline retains the latest 600 entries; each agent's public transcript is also retained. A process restart marks unfinished runs interrupted; it does not replay model calls automatically. Keep the terminal and computer running for active tasks.

## Development

```sh
npm run check
npm test
```

The checks use Node built-ins. Tests cover DAG handoffs and concurrency, steering, cancellation and descendant cleanup, failure propagation, persistence/recovery, HTTP authentication and origin checks, gateway streaming/tool calls, file boundaries, and real CLI stream fixtures. Gateway fixtures are tests, not evidence of live gateway access.

`swarm doctor` checks executable availability and whether a gateway key is present; it does not validate that key. The CLI selects an available local port automatically; use `--port 4328` when you want a fixed address.

Visual provenance and harness logo sources are in [web/assets/PROVENANCE.md](web/assets/PROVENANCE.md). The constellation adapts the original Lens artwork; particles are decorative, not usage metrics. Harness marks identify runtimes, not endorsements.
