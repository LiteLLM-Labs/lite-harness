/**
 * Session store — SQLite persistence for cc/copilot/codex sessions.
 *
 * Schema (tables created by loop-store.mjs initDb):
 *
 *   sessions (
 *     id             TEXT PRIMARY KEY,
 *     harness        TEXT NOT NULL,     -- "cc" | "github-copilot" | "codex"
 *     title          TEXT NOT NULL,
 *     created_at     INTEGER NOT NULL,
 *     updated_at     INTEGER,
 *     sdk_session_id TEXT               -- cc only: Claude SDK resume token
 *   )
 *
 *   session_messages (
 *     id         TEXT PRIMARY KEY,      -- msg.info.id
 *     session_id TEXT NOT NULL,
 *     seq        INTEGER NOT NULL,      -- s.history.length - 1 at push time
 *     info_json  TEXT NOT NULL,
 *     parts_json TEXT NOT NULL
 *   )
 *
 * All exports are synchronous (better-sqlite3 is fully sync).
 * All write functions swallow errors so a DB failure never kills a request.
 */

import { getDb } from "./loop-store.mjs";

const log = (...a) => console.error("[session-store]", ...a);

/**
 * Persist a new session row. Silently ignored if the id already exists.
 *
 * @param {{ id: string, harness: string, title: string, createdAt: number }} opts
 */
export function persistSession({ id, harness, title, createdAt }) {
  try {
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO sessions (id, harness, title, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(id, harness, title, createdAt);
  } catch (e) {
    log("persistSession error:", e.message);
  }
}

/**
 * Append a message to session_messages and bump sessions.updated_at.
 * INSERT OR IGNORE on the message id so duplicate calls (e.g. retry path) are no-ops.
 *
 * @param {string} sessionId
 * @param {{ info: object, parts: object[] }} msg
 * @param {number} seq
 */
export function appendMessage(sessionId, msg, seq) {
  try {
    const db = getDb();
    db.prepare(
      `INSERT OR IGNORE INTO session_messages (id, session_id, seq, info_json, parts_json) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      msg.info.id,
      sessionId,
      seq,
      JSON.stringify(msg.info),
      JSON.stringify(msg.parts),
    );
    const ts = msg.info.time?.completed ?? msg.info.time?.created ?? Date.now();
    db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(ts, sessionId);
  } catch (e) {
    log("appendMessage error:", e.message);
  }
}

/**
 * Remove a message row by its message id. Used when ccRunTurn retries
 * and pops the user message it already persisted.
 *
 * @param {string} msgId
 */
export function deleteMessage(msgId) {
  try {
    getDb().prepare(`DELETE FROM session_messages WHERE id = ?`).run(msgId);
  } catch (e) {
    log("deleteMessage error:", e.message);
  }
}

/**
 * Update the Claude SDK internal session id for a cc session.
 * Only called once per session (when sdk_session_id is first observed).
 *
 * @param {string} sessionId
 * @param {string} sdkSessionId
 */
export function updateSdkSessionId(sessionId, sdkSessionId) {
  try {
    getDb()
      .prepare(`UPDATE sessions SET sdk_session_id = ? WHERE id = ?`)
      .run(sdkSessionId, sessionId);
  } catch (e) {
    log("updateSdkSessionId error:", e.message);
  }
}

/**
 * Load all persisted cc/copilot/codex sessions and their message histories,
 * returning three Maps keyed by session id ready to be merged into the
 * in-process session Maps on startup.
 *
 * Opencode sessions are not stored here (opencode owns its own DB).
 *
 * @returns {{ cc: Map, copilot: Map, codex: Map }}
 */
export function hydrateFromDb() {
  const empty = { cc: new Map(), copilot: new Map(), codex: new Map() };
  try {
    const db = getDb();
    const rows = db.prepare(`SELECT * FROM sessions ORDER BY created_at ASC`).all();
    const msgStmt = db.prepare(
      `SELECT * FROM session_messages WHERE session_id = ? ORDER BY seq ASC`,
    );
    for (const row of rows) {
      const history = msgStmt.all(row.id).map((r) => ({
        info: JSON.parse(r.info_json),
        parts: JSON.parse(r.parts_json),
      }));
      const base = {
        id: row.id,
        title: row.title,
        time: {
          created: row.created_at,
          ...(row.updated_at != null ? { updated: row.updated_at } : {}),
        },
        history,
        busSubscribers: new Set(),
      };
      if (row.harness === "cc") {
        empty.cc.set(row.id, {
          ...base,
          sdkSessionId: row.sdk_session_id ?? null,
          abortController: null,
        });
      } else if (row.harness === "github-copilot") {
        empty.copilot.set(row.id, base);
      } else if (row.harness === "codex") {
        empty.codex.set(row.id, { ...base, activeProcess: null });
      }
    }
    return empty;
  } catch (e) {
    log("hydrateFromDb error (starting with empty session state):", e.message);
    return empty;
  }
}
