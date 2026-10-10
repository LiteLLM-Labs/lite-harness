# Swarm verification — October 10, 2026

The screenshots show a labeled simulated demo through the real runner and local browser view. Live inference was verified separately on the configured development gateway and installed harnesses; no keys or private run data are included here.

## Live runs

- Ten peers across Claude Code (3), Codex (3), OpenCode (2), and Pi (2).
- Final neutral-peer run: 60-second work budget, 60.52 seconds including cleanup, 10 explicit election ballots, no abstentions, 42 completed work cycles (2–6 per peer), 206 shared records, 2 human-facing answer updates, zero peer call failures.
- All peers chose their own names and responsibilities; the elected coordinator assigned distinct tasks and reviews. IDs, harness selections and model settings remained fixed.
- An earlier 90-second run completed all ten peers with repeated concurrent cycles and multiple result updates. Failure/replacement behavior was additionally observed while resolving an account-model mismatch.
- Live resolved models: Claude Code `claude-opus-5-5`; Codex via LiteLLM `openai/gpt-6.1-sol`; Pi and OpenCode via LiteLLM `openai/gpt-6-astra`.
- Pi 1.1.0 and OpenCode 1.14.41 performed verified workspace reads and writes. Codex 0.135.0 passed three concurrent gateway cleanup checks after disabling bundled background plugins and adding cleanup retries.

## Automated checks

`npm run check --prefix src/swarm` and `npm test --prefix src/swarm` pass (138 tests passed; one unsupported-platform branch skipped on macOS). Tests cover the organization protocol, timed concurrency, actual ballot accounting, identity ownership, broadcasts, output retention, lifecycle cleanup, guarded tools, real CLI stream formats, persistence and authenticated HTTP/SSE. Conversation tests cover simultaneous chats, isolated steering and cancellation, saved/live selection, history without subscribers, explicit follow-up context, the four-chat limit, terminal event attribution and shutdown of every active chat.

A separate terminal smoke test started two simulated chats, selected the first through the browser API, and sent guidance and `/stop` from the terminal. Only the selected chat received the guidance and stopped; the other remained running until `/quit` shut down the workspace. A real PTY check also confirms Ctrl+C closes the server and releases its store lock.

Additional scaling checks cover initial 24-peer concurrency, dynamic worker cleanup, additions during election, atomic input and persistence failures, frozen proposal electorates, and valid bounded context for all 100 peers. HTTP checks cover isolated additions, initial 30-peer teams and 100-peer custom configurations. A terminal smoke test started 20 simulated peers, used `/add 5`, and verified 25 active peers with the same leader and exact deadline; `/quit` stopped the expanded team cleanly.

Group-chat checks cover canonical message/event deduplication, chronological authors and recipients, incremental public JSON text, truthful streaming timestamps, retained partials after stop/failure, preserved guidance, and 100-peer feed bounds.

The package dry-run excludes `.env`, `.swarm`, installed CLI dependencies and run data. The source check includes browser helper modules and the constellation assets.

## Browser QA

See [qa.md](qa.md) for desktop, tablet and mobile interaction checks. The UI was checked with a real 30-second simulated run, including ten peers, repeated answer updates, role changes, proposal tallies, guidance, stop, history, settings, transcript scroll preservation, keyboard access and narrow layouts.

The Brain view now prioritizes leadership and activity. A shared presence rule drives the Active/Inactive labels, counts, and animation; terminal run status overrides stale peer status. Independent checks covered 42 run/peer-status combinations, absent leaders, and leader replacement. Leadership is read from the recorded coordinator ID, independently of whether that agent is active.

Teams now start with 2–100 peers and can grow during a run. Browser QA exercised 20→25 live demo additions without changing the run ID, leader or deadline; 50-peer mobile layouts and the final peer’s detail view; explicit harness/model additions; and 100-peer layout bounds. The Brain retains simple leader and Active/Inactive indicators as the spatial canvas expands.

The main Chat view now shows the agents’ authored group conversation, recipient labels, harness/model identity, leadership and activity. Human-facing answers have a separate Result view. The chat uses recorded peer messages rather than mirrored tool events; long contributions can be expanded and current public text streams into its author’s message. Screenshots are labeled simulations.

Completed, stopped, failed and interrupted browser chats accept normal messages from either composer. A message racing the deadline falls back from the exact finished run to an explicit follow-up; authentication and other errors do not launch new work. Follow-up prompt checks cover recent user directions, same-peer partial work, election context, bounded 100-peer prompts, and isolation from fresh chats.

## Local actions, workstreams and changes

Real runs enable the installed harnesses' standard tools by default, with an explicit inspect-only option and the selected project visible in the composer. Election turns and simulations cannot enable writes or commands. Claude Code, Codex, OpenCode and Pi use their own file and shell tools; custom MCP command routing and the Pi tool extension have been removed. Provider configuration supplies gateway authentication and model selection without modifying installed user configuration. Codex retains its native workspace-write sandbox with networking enabled for work.

Each of the four harnesses passed a live check in a separate disposable project: read AGENTS.md, edit a text file, fetch https://example.com through its native shell, check the fetched page and edited contents, and write a command-generated receipt. Files and receipts were checked independently of the model's answer. Browser/desktop automation and this assistant's connected apps are not automatically inherited.

The optional gateway-native adapter retains its own bounded macOS command implementation, with networking enabled in standard mode. Its filesystem boundaries, output bounds, explicit offline mode, timeout and cancellation are tested separately; those restrictions do not replace the installed CLIs' execution behavior.

Live access changes apply to subsequent work cycles while in-flight calls retain their captured mode. Tests cover preserved leader, deadline and history, targeting a background chat without changing selection, invalid requests, simulations, terminal runs and HTTP authentication. Desktop/mobile browser QA confirms both mode transitions and that a delayed Apply response cannot overwrite a new draft.

Workstreams are declared by peers and recorded by the runner. Tests cover validated IDs/names, membership belonging only to the responding peer, stable names, duplicate-name reuse, immutable historical message stamps, prior context and fresh-chat isolation. Peers added during asynchronous baseline preparation stay outside the original election roster.

Changes records a bounded text baseline before any model work, then freezes the final diff after all workers finish cleanup. Real filesystem tests cover additions/modifications/deletions, pre-existing content, file exclusions, explicit incomplete previews, unavailable older/interrupted history, idempotent final snapshots and authenticated API access without changing chat selection. Diffs are observed project changes and do not infer agent ownership across concurrent edits.

An integrated 45-second real swarm, before the native-tool simplification, completed naturally with four ballots, 12 completed work cycles, 16 successful command events and zero peer failures. Claude Code, Codex, OpenCode and Pi each produced a separate exact-content file and verified it with a command. The peers joined two explicit workstreams, and the frozen Changes report showed exactly those four added files. This check used a disposable project and did not modify the user's working files. The native-tool checks above validate the current execution path separately.

A larger resumed run exposed OpenCode’s headless external-directory prompt: its default prompt auto-rejected and exited before a final response. A disposable nested-project reproduction confirmed this. One explicit native denial rule lets the model receive the tool error and continue local work; it does not grant access outside the project. Six concurrent real OpenCode runs then returned completed answers after the denial and a successful local read, using the shared native database. Regressions verify the rule and preserve a useful diagnostic when a CLI exits without a completed answer.
