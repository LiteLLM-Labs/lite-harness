/**
 * Session store — SQLite persistence for cc/copilot/codex/opencode sessions.
 *
 * Schema (tables created by loop-store.mjs initDb):
 *
 *   sessions (
 *     id             TEXT PRIMARY KEY,
 *     harness        TEXT NOT NULL,     -- "cc" | "github-copilot" | "codex" | "opencode"
 *     agent_id       TEXT,              -- platform agent id for agent-run sessions
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
 * @param {{ id: string, harness: string, title: string, createdAt: number, tz?: string|null, agentId?: string|null }} opts
 */
export function persistSession({ id, harness, title, createdAt, tz = null, agentId = null }) {
  try {
    const db = getDb();
    db.prepare(
      `INSERT OR IGNORE INTO sessions (id, harness, agent_id, title, created_at, tz) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, harness, agentId ?? null, title, createdAt, tz ?? null);
    if (agentId) {
      db.prepare(`UPDATE sessions SET agent_id = COALESCE(agent_id, ?) WHERE id = ?`).run(agentId, id);
    }
  } catch (e) {
    log("persistSession error:", e.message);
  }
}

export function getSessionAgentId(sessionId) {
  try {
    const row = getDb().prepare("SELECT agent_id FROM sessions WHERE id = ?").get(sessionId);
    return row?.agent_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Return the IANA timezone stored for a session, or null if unset.
 *
 * @param {string} sessionId
 * @returns {string|null}
 */
export function getSessionTz(sessionId) {
  try {
    const row = getDb().prepare("SELECT tz FROM sessions WHERE id = ?").get(sessionId);
    return row?.tz ?? null;
  } catch {
    return null;
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
 * Batch-upsert a snapshot of messages for an opencode session.
 * Called on session.idle — idempotent via INSERT OR IGNORE on message id.
 *
 * @param {string} sessionId  Our session id (not the opencode child id)
 * @param {{ info: object, parts: object[] }[]} messages
 */
export function saveOcMessages(sessionId, messages) {
  try {
    const db = getDb();
    const ins = db.prepare(
      `INSERT OR IGNORE INTO session_messages (id, session_id, seq, info_json, parts_json) VALUES (?, ?, ?, ?, ?)`,
    );
    const upd = db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`);
    db.transaction(() => {
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        ins.run(m.info.id, sessionId, i, JSON.stringify(m.info), JSON.stringify(m.parts));
      }
      if (messages.length > 0) {
        const last = messages[messages.length - 1];
        const ts = last.info.time?.completed ?? last.info.time?.created ?? Date.now();
        upd.run(ts, sessionId);
      }
    })();
  } catch (e) {
    log("saveOcMessages error:", e.message);
  }
}

/**
 * Store the opencode child session id after rehydration.
 * Reuses the sdk_session_id column (opencode-specific meaning).
 *
 * @param {string} sessionId   Our session id
 * @param {string} childSid    New opencode child session id
 */
export function setOcSessionChildId(sessionId, childSid) {
  try {
    getDb()
      .prepare(`UPDATE sessions SET sdk_session_id = ? WHERE id = ?`)
      .run(childSid, sessionId);
  } catch (e) {
    log("setOcSessionChildId error:", e.message);
  }
}

/**
 * Return all opencode session rows for listing and remap hydration.
 *
 * @returns {{ id: string, title: string, created_at: number, updated_at: number|null, sdk_session_id: string|null, agent_id: string|null }[]}
 */
export function loadMessages(sessionId) {
  try {
    return getDb()
      .prepare("SELECT * FROM session_messages WHERE session_id = ? ORDER BY seq ASC")
      .all(sessionId);
  } catch (e) {
    log("loadMessages error:", e.message);
    return [];
  }
}

export function loadOcSessions() {
  try {
    return getDb()
      .prepare(`SELECT id, title, created_at, updated_at, sdk_session_id, agent_id FROM sessions WHERE harness = 'opencode' ORDER BY created_at ASC`)
      .all();
  } catch (e) {
    log("loadOcSessions error:", e.message);
    return [];
  }
}

/**
 * Load all persisted cc/copilot/codex sessions and their message histories,
 * returning three Maps keyed by session id ready to be merged into the
 * in-process session Maps on startup.
 *
 * Opencode sessions are handled separately via loadOcSessions() + ocSidRemap.
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
