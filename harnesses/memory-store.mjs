/**
 * Memory store — SQLite persistence for per-agent memory.
 *
 * Memory is the durable notebook an agent writes to and reads back across
 * sessions and scheduled runs. Each entry is a key→value note scoped to one
 * agent_id; storing under an existing key overwrites it (upsert). This is the
 * concept exposed to agents through the platform MCP tools memory_store /
 * memory_get / memory_list / memory_delete, and to the UI through
 * GET/POST/DELETE /api/agents/:id/memory.
 *
 * Reuses the shared database opened by loop-store.mjs (via getDb()); the
 * `agent_memories` table is created in loop-store's initDb. Owns no connection
 * itself — same pattern as skills-store.mjs / agent-store.mjs.
 *
 *   agent_memories (
 *     id          TEXT PRIMARY KEY  -- "mem_" + 6 random alphanum chars
 *     agent_id    TEXT NOT NULL
 *     key         TEXT NOT NULL     -- unique per agent_id
 *     value       TEXT NOT NULL
 *     always_on   INTEGER NOT NULL  -- included unconditionally in future context
 *     created_at  INTEGER NOT NULL  -- epoch ms
 *     updated_at  INTEGER NOT NULL  -- epoch ms
 *   )
 *
 * All exports are synchronous (better-sqlite3 is fully sync).
 */

import { getDb } from "./loop-store.mjs";

function generateId() {
  return "mem_" + Math.random().toString(36).slice(2, 8);
}

/**
 * Store (upsert) a memory entry for an agent. If a row already exists for
 * (agent_id, key) its value and updated_at are refreshed; otherwise a new row
 * is inserted. Returns the resulting row.
 *
 * @param {{ agentId: string, key: string, value: string, alwaysOn?: boolean }} opts
 * @returns {object}
 */
export function storeMemory({ agentId, key, value, alwaysOn }) {
  const now = Date.now();
  const existing = getMemory(agentId, key);
  const nextAlwaysOn =
    typeof alwaysOn === "boolean" ? (alwaysOn ? 1 : 0) : Number(existing?.always_on ?? 0);
  // Single atomic upsert keyed on the (agent_id, key) UNIQUE constraint: insert
  // a new note, or overwrite the value/updated_at of the existing one in place.
  getDb()
    .prepare(
      `INSERT INTO agent_memories (id, agent_id, key, value, always_on, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, key)
       DO UPDATE SET
         value = excluded.value,
         always_on = excluded.always_on,
         updated_at = excluded.updated_at`,
    )
    .run(generateId(), agentId, key, value, nextAlwaysOn, now, now);
  return getMemory(agentId, key);
}

/** Return the memory row for (agentId, key), or null if not found. */
export function getMemory(agentId, key) {
  return (
    getDb()
      .prepare("SELECT * FROM agent_memories WHERE agent_id = ? AND key = ?")
      .get(agentId, key) ?? null
  );
}

/** Return all memory rows for an agent, most-recently-updated first. */
export function listMemory(agentId) {
  return getDb()
    .prepare("SELECT * FROM agent_memories WHERE agent_id = ? ORDER BY updated_at DESC")
    .all(agentId);
}

/**
 * Delete the memory entry for (agentId, key).
 * @returns {boolean} true if a row was deleted.
 */
export function deleteMemory(agentId, key) {
  const info = getDb()
    .prepare("DELETE FROM agent_memories WHERE agent_id = ? AND key = ?")
    .run(agentId, key);
  return info.changes > 0;
}

/** Delete every memory entry for an agent (used when an agent is deleted). */
export function deleteAllMemory(agentId) {
  getDb().prepare("DELETE FROM agent_memories WHERE agent_id = ?").run(agentId);
}
