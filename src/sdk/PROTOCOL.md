# SDK ⇄ Server wire protocol

The SDK is a thin client. It spawns the lite-harness agent server as a child
process and speaks the **Claude Agent SDK stream-json control protocol** to it —
the exact wire language the official `claude` CLI uses in
`--input-format stream-json --output-format stream-json` mode. This is what makes
the SDKs true drop-ins: our server only has to emulate the claude CLI's stdio
interface, and the real `claude` binary can be driven by these SDKs unchanged.

This document is the single source of truth both the Python and TypeScript SDKs
implement against. Keep them identical.

## Framing

- **One JSON object per line (NDJSON)** on the server's `stdin` (SDK → server)
  and `stdout` (server → SDK). UTF-8, compact (no embedded newlines), `\n`
  terminated. Flush after every line.
- **Everything is multiplexed on this one stream** — user messages, assistant
  messages, results, system events, AND control requests/responses. The receiver
  demultiplexes on the top-level `type` field. There is no second channel and no
  JSON-RPC envelope.
- The server's `stderr` is free-form diagnostics, surfaced via the `stderr`
  option. It is never parsed.

## Launch

The SDK spawns the server in stream-json mode, mirroring the CLI:

```
<server> --input-format stream-json --output-format stream-json --verbose \
         [--agent <agent>] [--model <model>] [--permission-mode <mode>] [--cwd <dir>]
```

`--agent` selects the lite-harness runtime (e.g. `claude`, `openai`); it mirrors
the Claude Agent SDK's own optional `agent` option and is omitted when unset (the
server picks its default). Everything else matches the CLI flags. Options that
have no flag are applied at runtime via control requests (below). Server command resolution: explicit arg →
`LITE_HARNESS_SERVER` env → bundled default. See bottom.

## Control requests (SDK → server)

`request_id` is a unique string (`req_<counter>_<hex>`); the server replies with a
`control_response` carrying the same `request_id`.

```jsonc
// initialize — sent ONCE immediately after spawn, before any prompt
{ "type": "control_request", "request_id": "req_1_a3f7",
  "request": { "subtype": "initialize", "hooks": {}, "sdk_mcp_servers": [] } }

// interrupt the in-flight turn
{ "type": "control_request", "request_id": "req_2_b1c4",
  "request": { "subtype": "interrupt" } }

// set permission mode
{ "type": "control_request", "request_id": "req_3_c2d5",
  "request": { "subtype": "set_permission_mode", "permission_mode": "acceptEdits" } }

// set model (model omitted/null clears override)
{ "type": "control_request", "request_id": "req_4_d3e6",
  "request": { "subtype": "set_model", "model": "claude-opus-4-1" } }
```

## Prompts (SDK → server)

A turn is started by writing a user message line. No method call — the open
process *is* the session.

```jsonc
{ "type": "user", "message": { "role": "user", "content": "What is 2 + 2?" },
  "session_id": null, "parent_tool_use_id": null }
```

- One-shot `query()`: write one user line, read until the `result`, then close
  stdin so the server exits.
- Long-lived session (`ClaudeSDKClient` / a reused `Query`): keep the process
  open and write additional user lines for each turn.

## Server → SDK lines

```jsonc
// system init — first line of a turn
{ "type": "system", "subtype": "init", "session_id": "sess_abc",
  "model": "claude-…", "tools": [ … ], "mcp_servers": [ … ] }

// assistant message
{ "type": "assistant",
  "message": { "model": "claude-…", "content": [ <block>, … ] },
  "parent_tool_use_id": null }

// user echo / tool results threaded back
{ "type": "user", "message": { "role": "user", "content": "…" | [ <block>, … ] } }

// partial streaming delta (only when include_partial_messages)
{ "type": "stream_event", "session_id": "sess_abc",
  "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "…" } } }

// result — TERMINATES the turn
{ "type": "result", "subtype": "success", "session_id": "sess_abc",
  "duration_ms": 0, "duration_api_ms": 0, "is_error": false, "num_turns": 1,
  "total_cost_usd": 0.0, "usage": {}, "result": "…final text…" }
// result.subtype ∈ "success" | "error_max_turns" | "error_during_execution"

// control response — replies to an SDK control_request, matched by request_id
{ "type": "control_response",
  "response": { "request_id": "req_2_b1c4", "subtype": "success" } }
// on failure: "subtype": "error", "error": "…message…"
```

The SDK ends the message iterator after delivering the `result` line. Control
responses are routed to the matching pending request, never yielded to the user.

### Content blocks

```jsonc
{ "type": "text",        "text": "…" }
{ "type": "thinking",    "thinking": "…", "signature": "…" }
{ "type": "tool_use",    "id": "toolu_…", "name": "Read", "input": { … } }
{ "type": "tool_result", "tool_use_id": "toolu_…", "content": "…" | [ … ] | null, "is_error": false }
```

## Decoding rules

- Demux every incoming line on `type`. `control_response` → resolve the pending
  `request_id`. Everything else → decode into a typed message and deliver to the
  active turn's iterator.
- A turn is complete when a `result` line arrives.
- **Forward compatibility:** unknown message `type`s and unknown block `type`s
  must NOT crash the client — decode them to a safe fallback (e.g. a system
  message / text block carrying the raw payload) so a newer server never breaks
  an older SDK.

## Lifecycle

```
spawn server (stream-json flags)
control_request: initialize           -> control_response success
write user message line               -> system/init, assistant…, result   (one turn)
  control_request: interrupt          -> control_response (cancels the turn)
… more user lines for a long-lived session …
close stdin                           -> server exits
```

## Server command resolution

The SDK does not hardcode a server path. It resolves the spawn command in order:

1. explicit transport argument (tests inject a fake server here),
2. `LITE_HARNESS_SERVER` env var (a command line), else
3. the bundled default (`node <server>` / packaged binary).
