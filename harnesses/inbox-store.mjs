/**
 * Inbox store — SQLite persistence for the agent inbox.
 *
 * One table (`inbox_items`, created by loop-store.initInboxSchema) holds two
 * kinds of items that share a list:
 *
 *   kind="approval"  — a human-in-the-loop tool-call gate. The live blocking
 *                      promise lives in mcp/approvals.mjs; this row is the
 *                      durable record (so the Inbox can show resolved history).
 *                      status: "pending" → "accepted" | "rejected".
 *   kind="issue"     — an informational issue an agent filed for a human.
 *                      status: "open" → "resolved".
 *
 * "Needs attention" = status in (pending, open); "completed" = the rest.
 *
 * All exports are synchronous (better-sqlite3 is fully sync) and swallow errors
 * so a DB failure never kills a request — mirroring session-store.mjs.
 */

import { getDb } from "./loop-store.mjs";

const log = (...a) => console.error("[inbox-store]", ...a);

const ATTENTION_STATUSES = ["pending", "open"];
const COMPLETED_STATUSES = ["accepted", "rejected", "resolved"];

function rowToItem(r) {
  let args;
  if (r.args_json) {
    try { args = JSON.parse(r.args_json); } catch { args = undefined; }
  }
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    sessionId: r.session_id ?? null,
    agent: r.agent ?? null,
    body: r.body ?? null,
    args,
    status: r.status,
    feedback: r.feedback ?? null,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at ?? null,
  };
}

/**
 * Persist a newly-requested approval as a pending inbox item.
 * INSERT OR IGNORE so a duplicate emit (or restart replay) is a no-op.
 *
 * @param {{ id: string, tool: string, args?: object, sessionId?: string|null, agent?: string|null, createdAt: number }} a
 */
export function recordApprovalRequested({ id, tool, args, sessionId, agent, createdAt }) {
  try {
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO inbox_items
           (id, kind, title, session_id, agent, body, args_json, status, created_at)
         VALUES (?, 'approval', ?, ?, ?, NULL, ?, 'pending', ?)`,
      )
      .run(id, tool, sessionId ?? null, agent ?? null, args ? JSON.stringify(args) : null, createdAt);
  } catch (e) {
    log("recordApprovalRequested error:", e.message);
  }
}

/**
 * Mark a pending approval row resolved. No-op if the row is missing or already
 * resolved (so accept/reject is idempotent across the in-memory + DB paths).
 *
 * @param {{ id: string, decision: "accept"|"reject", feedback?: string, args?: object }} a
 */
export function recordApprovalResolved({ id, decision, feedback, args }) {
  try {
    getDb()
      .prepare(
        `UPDATE inbox_items
            SET status = ?, feedback = ?, args_json = COALESCE(?, args_json), resolved_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(
        decision === "accept" ? "accepted" : "rejected",
        feedback ?? null,
        args ? JSON.stringify(args) : null,
        Date.now(),
        id,
      );
  } catch (e) {
    log("recordApprovalResolved error:", e.message);
  }
}

/**
 * Persist an agent-filed issue as an open inbox item.
 *
 * @param {{ id: string, title: string, body?: string, sessionId?: string|null, agent?: string|null, createdAt: number }} i
 */
export function recordIssue({ id, title, body, sessionId, agent, createdAt }) {
  try {
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO inbox_items
           (id, kind, title, session_id, agent, body, status, created_at)
         VALUES (?, 'issue', ?, ?, ?, ?, 'open', ?)`,
      )
      .run(id, title, sessionId ?? null, agent ?? null, body ?? null, createdAt);
  } catch (e) {
    log("recordIssue error:", e.message);
  }
}

/**
 * Resolve an issue (mark it done). Returns true if a row was updated.
 *
 * @param {string} id
 * @param {string} [note]  optional resolution note stored in feedback
 * @returns {boolean}
 */
export function resolveItem(id, note) {
  try {
    const info = getDb()
      .prepare(
        `UPDATE inbox_items
            SET status = 'resolved', feedback = COALESCE(?, feedback), resolved_at = ?
          WHERE id = ? AND status NOT IN ('resolved', 'accepted', 'rejected')`,
      )
      .run(note ?? null, Date.now(), id);
    return info.changes > 0;
  } catch (e) {
    log("resolveItem error:", e.message);
    return false;
  }
}

/**
 * List inbox items, newest first.
 *
 * @param {"attention"|"completed"|"all"} [filter="all"]
 * @returns {Array<object>}
 */
export function listItems(filter = "all") {
  try {
    const db = getDb();
    if (filter === "attention" || filter === "completed") {
      const statuses = filter === "attention" ? ATTENTION_STATUSES : COMPLETED_STATUSES;
      const placeholders = statuses.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT * FROM inbox_items WHERE status IN (${placeholders}) ORDER BY created_at DESC`,
        )
        .all(...statuses);
      return rows.map(rowToItem);
    }
    return db
      .prepare(`SELECT * FROM inbox_items ORDER BY created_at DESC`)
      .all()
      .map(rowToItem);
  } catch (e) {
    log("listItems error:", e.message);
    return [];
  }
}

/** Count of items needing attention — drives the sidebar unread badge. */
export function attentionCount() {
  try {
    const placeholders = ATTENTION_STATUSES.map(() => "?").join(", ");
    return getDb()
      .prepare(`SELECT COUNT(*) AS n FROM inbox_items WHERE status IN (${placeholders})`)
      .get(...ATTENTION_STATUSES).n;
  } catch (e) {
    log("attentionCount error:", e.message);
    return 0;
  }
}

/** @returns {object|null} */
export function getItem(id) {
  try {
    const r = getDb().prepare(`SELECT * FROM inbox_items WHERE id = ?`).get(id);
    return r ? rowToItem(r) : null;
  } catch (e) {
    log("getItem error:", e.message);
    return null;
  }
}
