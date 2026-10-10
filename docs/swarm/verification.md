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

`npm run check --prefix src/swarm` and `npm test --prefix src/swarm` pass: 45 tests cover the organization protocol, timed concurrency, actual ballot accounting, identity ownership, broadcasts, output retention, lifecycle cleanup, guarded tools, real CLI stream formats, persistence and authenticated HTTP/SSE.

The package dry-run excludes `.env`, `.swarm`, installed CLI dependencies and run data. The source check includes browser helper modules and the constellation assets.

## Browser QA

See [qa.md](qa.md) for desktop, tablet and mobile interaction checks. The UI was checked with a real 30-second simulated run, including ten peers, repeated answer updates, role changes, proposal tallies, guidance, stop, history, settings, transcript scroll preservation, keyboard access and narrow layouts.
