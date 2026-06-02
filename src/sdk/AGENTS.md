# AGENTS.md — `src/sdk`

Client SDKs for lite-harness. Inherits the repo root `CODING_STANDARDS.md`; this
file adds local detail.

## What this is

A **thin client**, nothing more. The SDK does not run agents, hold sessions, or
talk to model providers. It:

1. spawns the lite-harness server as a child process,
2. speaks newline-delimited JSON-RPC to it over stdio,
3. correlates responses to requests and routes streamed events,
4. decodes wire JSON into typed messages, and
5. tears the process down on exit.

The **server owns everything hard** — agent runtimes (claude-code, codex,
opencode), sessions, cancellation, tools. If you find yourself adding agent
logic, provider calls, or session state to the SDK, it belongs in the server
instead.

```
your code ──> lite-harness SDK ──(stdio JSON-RPC)──> lite-harness server ──> agent runtime
```

## Hard rules

- **Drop-in compatible with the Claude Agent SDK.** Public names, signatures, and
  option fields match upstream per language. A parity test asserts this — do not
  rename or reshape the public surface to "improve" it. Diverge only where
  upstream diverges.
- **Mirror each language's native shape.** Python exposes the stateful
  `ClaudeSDKClient` class; JS/TS exposes only `query()` returning a controllable
  `Query`. Do not add a client class to JS or drop it from Python.
- **No business logic in the SDK.** It is process + wire + type-decode glue only.
- **One transport concern, one place.** Process spawn, JSON-RPC framing, id
  correlation, and event routing live in the transport module — not scattered
  across the public API.
- **Keep the public surface in the package entrypoint** (`__init__.py` /
  `index.ts`); everything else is internal plumbing.

## Layout

```
src/sdk/
├── interface.html   # side-by-side interface reference (Claude Agent SDK vs this)
├── python/          # lite-agent-sdk      (Python drop-in)
└── typescript/      # @lite-harness/sdk   (JS/TS drop-in)
```
