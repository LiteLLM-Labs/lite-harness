# AGENTS.md — Platform MCP server

> Follow the repo-wide [`/CODING_STANDARDS.md`](../CODING_STANDARDS.md) — the rules below
> are the MCP-specific detail on top of it.

The built-in MCP server that exposes **platform tools** (save_agent, human
approval, agent memory…) to every harness in this process. Runs in-process — the
inline adapter calls `handleMcpRequest` directly, no HTTP round-trip — and is
also reachable over MCP at `POST /mcp` (Streamable HTTP) and `GET /mcp/sse` +
`POST /mcp/message` (legacy HTTP+SSE).

Keep it organized; don't grow one big file.

## Structure

```
index.mjs            public exports (handleMcpRequest, registerTool, PLATFORM_MCP_URL)
server.mjs           tool registry + JSON-RPC handler + both MCP transports
tools.mjs            barrel — imports every tool module so it registers (no logic)
tools/
  save-agent.mjs     save_agent          — persist a named, reusable agent
  human-approval.mjs request_human_approval — block on a human decision
  memory.mjs         memory_store/get/list/delete — durable per-agent notes
approvals.mjs        approval lifecycle (queue, accept/reject, edited args)
approvals.test.mjs   tests for the approval lifecycle
agents/
  store.mjs          SQLite store for save_agent (named agents, own DB)
```

## How it fits together

- **One tool group = one file in `tools/`** that calls `registerTool(definition, handler)`
  at import time, plus **one import line in `tools.mjs`**. That barrel is imported once
  for its side effects (`import "../mcp/tools.mjs"`) by the adapter and pylon host.
- `registerTool` fills a `Map` in `server.mjs`; `handleMcpRequest` answers
  `initialize` / `tools/list` / `tools/call` from it. Tools appear automatically in
  the harness's `/capabilities` under the `platform` MCP server — no extra wiring.
- A tool **handler returns a plain JS value**; `server.mjs` wraps it as MCP
  `content` and serializes errors as `{ isError: true }`. Don't format MCP envelopes
  inside a handler.

## Rules

- **`tools.mjs` stays a barrel.** Only `import "./tools/<x>.mjs"` lines — never a tool
  definition. Defining a tool here is the thing this refactor exists to prevent.
- **Persistence belongs in a store, not a tool.** Tools call into a store module
  (`agents/store.mjs`, `../harnesses/memory-store.mjs`); they don't open DBs or write SQL.
- **Stores reuse the shared DB** via `getDb()` from `../harnesses/loop-store.mjs`
  (the `agent_memories`, `skills`, `agents` tables live there). `agents/store.mjs` is
  the one exception — a separate `agents.db` for `save_agent`, kept for historical reasons.
- **Shared, per-agent tools take an `agent_id` argument.** The MCP server is shared
  across all agents in the process, so a tool can't infer who's calling. The adapter
  injects each agent's id into its system prompt (`memoryPromptNote`) and the agent
  passes it back. Validate it (`if (!agent_id) throw`).
- **ESM, `.mjs`, named exports.** Node built-ins + the harness deps only.
- **Keep descriptions task-oriented.** The `description` is the model's only guide to
  when to call a tool — say when to use it and what it returns, not how it's implemented.
