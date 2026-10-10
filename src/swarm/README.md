# swarm

One task. Ten peers. Every contribution in view.

A small CLI for a team of **Claude Code, Codex, OpenCode, and Pi** agents. They start as equal peers without assigned names or specialties, choose roles from the task, briefly vote for a coordinator, then work concurrently for the requested duration. They exchange public findings and directed messages, review proposals, and produce a continuously updated answer. There is no fixed Lead or round-robin work queue.

**Node 22+. No UI build step. Local files and a local browser view.**

## Start

```sh
npm run setup:harnesses # installs the pinned Pi CLI locally
./swarm doctor
./swarm demo --open
./swarm run "Review this project and propose the three most useful improvements" --duration 600 --open
```

The default is ten peers: three Claude Code, three Codex, two OpenCode, and two Pi. Codex, Claude Code, and OpenCode use their installed executables. The setup command installs and verifies Pi 1.1.0 inside the ignored `.swarm/tools/pi` directory; it changes no global packages or user configuration. Authenticate the harnesses you use; `doctor` checks availability. A missing binary or failed call stays visible. The 30-second demo is explicitly simulated and makes no model calls or file changes.

To use a single installed harness for all ten peers:

```sh
./swarm run "Explain this project" --harness codex --cwd /path/to/project --duration 120 --open
```

For a global `swarm` command, run `npm install --global .`. You can also run `node bin/swarm.mjs`. The local `./swarm` launcher prefers the bundled Codex Node runtime when available; `SWARM_NODE` overrides it.

## Models and inference

Defaults verified against the installed Codex and LiteLLM model catalogs on October 10, 2026:

| Harness | Default model | Authentication |
| --- | --- | --- |
| Codex | `gpt-6.1-sol` → `openai/gpt-6.1-sol` on gateway | LiteLLM when configured; otherwise installed Codex account |
| Claude Code | `opus` (current Opus alias) | Installed Claude Code account |
| OpenCode | `openai/gpt-6-astra` | LiteLLM gateway key |
| Pi | `openai/gpt-6-astra` | LiteLLM gateway key |
| Built-in `native` (optional) | `openai/gpt-6-astra` | LiteLLM gateway key |

Codex uses an explicit current coding model. Claude's alias follows its installed CLI. OpenCode and Pi use their real harness loops with a private OpenAI-compatible gateway profile. When the gateway key is configured, Codex also uses an isolated Responses provider with the explicit gateway model alias. Without a gateway key, its installed account must support the selected model; catalog presence alone does not prove account access. These are explicit defaults, not an automatic promise to track every future release; change a model in the team settings or JSON config. Resolved model names are shown when the harness reports them.

```sh
export LITELLM_BASE_URL=https://gateway-dev.litellm-sandbox.ai
# Set LITELLM_API_KEY securely in your environment.
./swarm models
# Optional: export LITELLM_MODEL=your-gateway-alias
```

`LITELLM_MODEL` overrides the gateway model for OpenCode, Pi, and `native`; it does not alter Claude/Codex account models. `swarm models` lists the aliases accessible to your key. No model is silently substituted, and failed inference never becomes a simulated answer.

`--env-file FILE` privately reads the three `LITELLM_*` settings above, overriding inherited values. The local launcher loads `.env` beside itself if present; keep it git-ignored and private (`chmod 600 .env`). Credentials never enter browser state or team JSON.

## How the organization works

1. Every peer receives the task, harness/model roster, and an explicit instruction to collaborate. Defaults begin as Agent 01–10 with the same neutral instructions; the models propose their own names and roles and may revise them later. Stable peer IDs preserve attribution. All vote requests start together; the election is bounded to a small part of the budget.
2. Valid ballots select a coordinator by plurality. Ties use sorted agent IDs. Missing/invalid votes are abstentions; if none arrive, the deterministic fallback is labeled as such. The coordinator is a working peer, not a preassigned Lead.
3. All peers start independent work loops. Each new cycle receives shared findings, directed messages, assignments, proposals, votes, and human directions. Faster peers keep working while other calls remain in flight.
4. The coordinator coordinates the roles and work the peers propose, then publishes provisional human-facing answer updates. Peers can propose decisions and independently agree, disagree, or abstain. A proposal is accepted only after a strict majority of the *other* peers explicitly agrees; missing votes never count as agreement. This is a collaboration protocol, not a distributed fault-tolerance guarantee.
5. Work continues until the requested duration expires. Peers review, verify, refine, and address gaps instead of ending after one answer. The deadline cancels remaining calls and preserves the latest answer plus partial contributions. A completed time budget does not imply every task claim was verified.

Repeated call failures retire the affected peer and remain visible. If the coordinator fails, a replacement uses the original ballots restricted to surviving peers, with the method displayed. If every peer fails, the run fails honestly instead of pretending to work for the remaining time. Provider availability and rate limits can prevent productive work.

The default live budget is ten minutes (`--duration 600`, or the older `--timeout` alias); up to 24 hours. Keep the process and computer running. Stop cancels immediately instead of using the remaining budget.

## See and steer

- The brain view shows every peer's harness, model, assignment, live activity, and latest output. Select a card for the full public contribution and transcript.
- The live feed shows harness and model marks alongside public messages, tool activity, votes, and status changes. The separate **For you** feed keeps the evolving answer readable.
- Inspect the election and decision votes rather than inferring agreement from animation. Stars are decorative, not usage metrics or private model reasoning.
- Send a direction from the terminal or browser. Every peer receives it on its next cycle; a model request already in flight is not interrupted.
- Use `/stop`, the Stop button, or Ctrl+C to cancel. `/quit` closes the local server. Successful and partial output is retained.
- `./swarm logs` prints the latest public conversation; `./swarm list` lists saved runs. `logs RUN-ID` selects history; `--json` prints structured records/events.
- `./swarm run "Refine the result" --follow-up RUN-ID` includes the previous task and answer.
- `./swarm ui --open` starts the local workspace and restores the latest run. Refresh reconnects without restarting agents. Ports are chosen automatically; `--port 4328` uses a fixed address.

## Configure a team

```sh
./swarm init
# Edit names, roles, harnesses, and models in swarm.json.
./swarm run "Solve this task" --config swarm.json --duration 300 --open
```

See [examples/mixed-team.json](examples/mixed-team.json). A team has 2–12 peers with unique IDs. The default has no fixed identities or specialties; a custom config can supply your own instructions. Harness IDs are `claude`, `codex`, `opencode`, `pi`, and optional `native`. Every peer needs an explicit model or uses the current default for its harness. Old nonempty `dependsOn` pipelines are rejected with a migration message: remove dependencies to use peer collaboration.

## Workspace and persistence

Agents inspect `--cwd` (current directory by default). Writes are off unless you pass `--tools`. Give concurrent writers distinct files; the collaboration prompt asks them to coordinate ownership, but a proposal vote is not a filesystem lock.

The built-in harness exposes bounded list/read/write tools with traversal and symlink checks. Pi and OpenCode use the same bounded workspace tools via isolated harness profiles; their shell, external plugins, and unrelated MCP servers are disabled. Codex uses its own read-only/workspace-write sandbox. Claude uses a restricted file-tool allowlist. These harness permissions are not equivalent OS isolation; use a disposable workspace for untrusted projects.

Runs are private JSON files in `.swarm/runs` (`--data-dir` changes this). One process owns a data directory; one run is active per process. A restart marks unfinished runs interrupted rather than silently replaying calls. Public messages and tool activity are retained within bounded history limits; hidden reasoning is not collected. Do not put secrets in prompts or files agents are asked to inspect.

The server binds only to `127.0.0.1`, validates Host/Origin, and requires a session bearer token for every API route. The local page receives it automatically. This is a local tool; no public deployment, tunnel, or account service is included.

## Development

```sh
npm run check
npm test
```

Tests cover ten-way concurrency, election and vote validation, continued work through the deadline, steering, failure/replacement behavior, cancellation and process cleanup, persistence/recovery, API authentication and origin checks, gateway streaming, workspace file boundaries, and real CLI stream formats. Fixture tests do not prove live provider access.

Visual and logo provenance: [web/assets/PROVENANCE.md](web/assets/PROVENANCE.md). Harness and model marks identify the selected runtime/provider; they do not imply endorsement.

Harness configuration references: [Codex](https://learn.chatgpt.com/docs/config-file/config-reference), [Claude Code](https://code.claude.com/docs/en/model-config), [OpenCode](https://opencode.ai/docs/providers/), and [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent). Model availability above was additionally checked with actual calls to the configured accounts/gateway.
