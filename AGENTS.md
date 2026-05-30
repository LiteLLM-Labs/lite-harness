# AGENTS.md — Agent Inbox

How agents talk to a human and how that surfaces in the UI's **Inbox**.

Agents on lite-harness reach a human through two platform MCP tools. Both are
registered in `mcp/tools.mjs` and exposed on the platform MCP server (`/mcp`).

| Tool                     | Blocks? | Use when                                                        |
| ------------------------ | ------- | -------------------------------------------------------------- |
| `request_human_approval` | yes     | You need a yes/no before a sensitive action (write, send, spend). |
| `file_issue`             | no      | You want a human to see/decide something later — not blocking.  |

Both land in one place: the **Inbox** (sidebar → Inbox). "Needs Attention" =
pending approvals + open issues; "Completed" = resolved history.

## `request_human_approval`

```jsonc
// args
{ "action": "pylon_update_issue",                 // shown as the title
  "arguments": { "issue_id": "…", "state": "open" } } // editable fields the human sees
// returns (the call blocks until a human answers)
{ "approved": true,  "arguments": { … } }   // accepted — use these (possibly edited) args
{ "approved": false, "feedback": "…" }      // rejected — do NOT act; address the feedback
```

The human opens the item, edits the fields if needed, and hits **Accept** or
**Reject** (with feedback). The edited args / feedback flow straight back to your
blocked call. Times out to a reject after `HITL_APPROVAL_TIMEOUT_MS` (30 min).

## `file_issue`

```jsonc
{ "title": "Pylon API key missing", "body": "Add PYLON_API_KEY to secrets…" }
// returns immediately
{ "issue_id": "iss_…", "filed": true }
```

The human reviews on their own time and marks it **resolved**.

## How a turn is attributed to its session

Each harness connects to the platform MCP with `?session=<id>` appended to the
URL (set in `inline-adapter.mjs` for cc/codex; read back in the `/mcp` route).
That id rides along to `requestApproval` / `fileIssue`, so an inbox item knows
which session it came from — that's the **Open session** link in the UI.

## Architecture

```
agent ──MCP──▶ request_human_approval / file_issue   (mcp/tools.mjs)
                       │
        approvals.mjs (blocks)   issues.mjs (fire-and-forget)
                       │                  │
                       ▼                  ▼
            inbox-service.wireInbox()  ── persists ──▶ inbox-store.mjs ─▶ SQLite (inbox_items)
                       │                                                    schema: loop-store.mjs
                       └── broadcasts SSE (tool.approval.*, inbox.updated) ─▶ /event ─▶ UI
human ──HTTP──▶ /api/inbox, /api/approvals/:id/{accept,reject}, /api/inbox/:id/resolve
                       └── all handled by inbox-service.handleInboxRoute()
```

### Files

| File                                | Responsibility                                            |
| ----------------------------------- | --------------------------------------------------------- |
| `mcp/tools.mjs`                     | Tool definitions (`request_human_approval`, `file_issue`).|
| `mcp/approvals.mjs`                 | In-memory blocking approval promises + lifecycle events.  |
| `mcp/issues.mjs`                    | Issue id + sink (non-blocking).                           |
| `harnesses/inbox-store.mjs`         | SQLite CRUD over `inbox_items`.                           |
| `harnesses/inbox-service.mjs`       | Persistence wiring + all `/api/inbox`,`/api/approvals` routes. |
| `harnesses/loop-store.mjs`          | `inbox_items` table schema (`initInboxSchema`).           |
| `harnesses/inline-adapter.mjs`      | Calls `wireInbox()` once + `handleInboxRoute()` per request. |
| `ui/src/app/inbox/page.tsx`         | The Inbox page (tabs, list, detail).                      |
| `ui/src/components/tool-approval-panel.tsx` | Editable accept/reject card (reused in chat + inbox). |

### HTTP API

| Method | Route                          | Purpose                              |
| ------ | ------------------------------ | ------------------------------------ |
| GET    | `/api/inbox?filter=…`          | List items (`attention`/`completed`/`all`). |
| POST   | `/api/inbox/:id/resolve`       | Mark an issue done.                  |
| GET    | `/api/approvals`               | Live pending approvals.             |
| POST   | `/api/approvals/:id/accept`    | Accept (optional edited `arguments`).|
| POST   | `/api/approvals/:id/reject`    | Reject (optional `feedback`).        |

## Extending

- **New agent→human tool:** add it in `mcp/tools.mjs`. If it needs persistence,
  route it through `inbox-store` via a sink (see `issues.mjs`) rather than
  importing the DB into `mcp/`.
- **New inbox route:** add it to `inbox-service.handleInboxRoute` — keep HTTP
  surface out of `inline-adapter.mjs`.
- **New file under `harnesses/` or `mcp/`:** add a `COPY` line to the Dockerfile
  (each file is copied individually).
- **Schema change:** edit `initInboxSchema` in `loop-store.mjs`; use idempotent
  `ALTER TABLE … ` in a try/catch for added columns (SQLite has no `IF NOT EXISTS`).

## Pull requests

- **UI PRs:** include screenshots in the PR before handing it off.
- **Merge readiness:** before saying a PR is ready, merge or rebase the latest
  `origin/main`, resolve conflicts, push the branch, and verify GitHub no longer
  reports merge conflicts.
- **Verification:** run the relevant build or tests and note any repo-level
  command caveats in the PR.

## Tests

```bash
node --test harnesses/inbox-store.test.mjs harnesses/inbox-service.test.mjs \
            mcp/issues.test.mjs mcp/approvals.test.mjs
```
