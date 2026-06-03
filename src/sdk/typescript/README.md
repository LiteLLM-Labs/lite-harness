# @lite-harness/sdk

Drop-in replacement for the official Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`) for JavaScript / TypeScript.

Swap the import — nothing else changes:

```ts
// before
import { query } from "@anthropic-ai/claude-agent-sdk";
// after
import { query } from "@lite-harness/sdk";
```

## Usage

```ts
import { query } from "@lite-harness/sdk";

const q = query({ prompt: "What files are in this repo?" });

for await (const message of q) {
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "text") console.log(block.text);
    }
  }
  if (message.type === "result") {
    console.log("done:", message.result);
  }
}
```

The returned `Query` IS the async generator (iterate it with `for await`) and
also carries control methods to steer the live run:

```ts
await q.interrupt();
await q.setPermissionMode("acceptEdits");
await q.setModel("claude-...");
q.close();
```

There is **no client class** — this matches the upstream JS SDK shape exactly.

## How it works

The SDK is a thin client. It launches the selected harness for you and speaks
newline-delimited JSON-RPC over stdio (see [`../PROTOCOL.md`](../PROTOCOL.md)).
The SDK owns only process + wire + type-decode glue.

Harness command resolution order:

1. an explicit transport command (used by tests),
2. the `LITE_HARNESS_SERVER` env var (a command line), else
3. the bundled default.

## Development

```bash
npm install      # dev deps only (typescript, @types/node)
npm run typecheck   # tsc --noEmit, strict
npm run build       # emits dist/*.js + dist/*.d.ts
npm test            # builds, then runs node --test against the fake server
```

Tests use a deterministic in-repo fake harness (`test/fake-server.mjs`) injected
via `LITE_HARNESS_SERVER`. No network or real model access is required.

## Not yet implemented (v0)

This SDK is a drop-in for the common `query()` path, **not** full parity with
`@anthropic-ai/claude-agent-sdk`. The following upstream surface is intentionally
not implemented yet:

- **Top-level helpers**: `tool()` and `createSdkMcpServer()` (in-process SDK MCP
  servers / tool definitions).
- **Session-management functions**: `listSessions`, `getSessionMessages`,
  `getSessionInfo`, `renameSession`, `tagSession`, `deleteSession`, and the rest
  of the session-store API.
- **`Query` control methods**: this SDK currently implements
  `interrupt` / `setPermissionMode` / `setModel` / `close`. The larger upstream
  control-method set (the other ~19 methods) is not implemented.

The `Options` type IS a true superset of the upstream `Options` — every upstream
field type-checks here — but advanced fields beyond the launch flags
(`agent` / `model` / `permissionMode` / `cwd` / `env`) are accepted for drop-in
compatibility and **not yet honored** by the runtime. The exported helper/callback
type aliases (`CanUseTool`, `HookCallback`, `McpServerConfig`, …) are permissive
compatibility stand-ins, not full upstream models.

## Design notes

- **Strict types, no `any` in the public surface.** `SDKMessage` and
  `ContentBlock` are discriminated unions keyed on `type`.
- **All decoding lives in `src/decode.ts`.** Unknown message/block types never
  throw — they fall back to a safe `system` message / `text` block so the
  iterator stays alive.
- Zero runtime dependencies. ESM only. Node 20+.
