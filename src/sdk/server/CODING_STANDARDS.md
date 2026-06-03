# Coding Standards — SDK backend server

This directory is a low-overhead, process-per-session stdio server. It speaks
the Claude Agent SDK **stream-json** control protocol (see `../PROTOCOL.md`) and
fronts multiple provider agent SDKs behind one contract. Keep the code explicit,
boring, and cheap to start.

## Architecture

- The **wire** lives in `protocol.mjs` (stdin/stdout framing, `type` demux,
  `control_request`↔`control_response` correlation, turn lifecycle, canonical
  frame builders). It is one adapter into the core — no provider logic here.
- **Session state** lives in `session.mjs`: one process = one session
  (sessionId, model, permission mode, cwd, turns, history, mcp). It dispatches
  control requests and orchestrates a turn; it does not know how a provider runs.
- A **provider** is a self-contained folder under `providers/<name>/`:
  - `index.mjs` — declares `id` (+ optional `aliases`) and `createRuntime(opts)`
    that drives the provider's native agent SDK in-process.
  - `transformation.mjs` — the provider's shape boundary: **pure** functions
    mapping native SDK events → canonical stream-json frames.
- **Add a provider by dropping a folder**, not by branching through the app.
  `providers/index.mjs` auto-discovers folders and maps `id`/alias → provider.
- The **canonical wire is Claude Agent SDK stream-json**. Every provider
  transforms to it; nothing downstream re-learns a provider's native shape.
- Never spawn a CLI. Drive the provider's native SDK programmatically.

## Performance

- One process serves one session — keep **cold start cheap**: minimal top-level
  imports, lazy provider load (discovery imports only what's needed), no heavy
  per-process init.
- **Stream frames as they arrive.** A turn is an async generator; never buffer a
  whole turn into an array before writing.
- Do not parse model output on the hot path beyond the transformation itself.
- One provider runtime per process; hold only this session's state in memory.

## Routing

- LiteLLM is **optional**. A provider may go straight to its vendor endpoint.
- **Only when both `LITELLM_API_BASE` and `LITELLM_API_KEY` are set**, route
  through the gateway: anthropic via `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`;
  OpenAI-style via a default client at the LiteLLM `/v1` base. Otherwise leave
  the native SDK's own env/client in place (direct via `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY`). A pre-set `ANTHROPIC_BASE_URL` is always honored.
- Models keep the `provider/model` convention; pass through as given.

## Comments

- Write no comments by default. Well-named identifiers are the documentation.
- Add a comment only when the WHY is non-obvious: a hidden constraint, a wire
  quirk, a captured event shape, or behavior that would surprise a reader.
- Never describe WHAT the code does, and never reference the current task or
  PR ("added for X") — that rots; it belongs in the commit message.

## JS / ESM style

- ESM `.mjs`, **named exports only** (no default exports). Node built-ins +
  declared deps only; add a dependency only with cause.
- Small, single-purpose files. Entry (`server.mjs`) is wiring only — no logic.
- **Transformations are pure**: no IO, no spawning, no network. They take a
  native event and return canonical frames; unknown inputs return `[]`.
- Errors thrown in a turn surface as one place — the session/protocol maps them
  to an error `result` or `control_response`; runtimes don't write frames.
- **Forward-compatible:** ignore unknown frame `type`s and event shapes rather
  than throwing, so a newer provider never breaks an older client.

## Tests

- Tests live in the **repo-root `tests/`** folder, mirroring the full source
  path **1:1** (e.g. `tests/src/sdk/server/providers/codex/transformation.test.mjs`),
  to keep core uncluttered.
- `node:test` + `node:assert/strict`. Run with `npm test` from this dir.
- Unit tests hit **no network**. Test pure transformations against **captured**
  native-event fixtures. Cover control dispatch, ordered/streamed frames, and
  provider discovery before adding behavior.

## Compatibility

- `../PROTOCOL.md` is the contract with the SDKs — change it and both SDKs
  together, never one side silently.
- New control subtypes / providers go behind focused modules + tests, not
  branches in the wire layer.
