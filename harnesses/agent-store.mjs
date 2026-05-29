/**
 * Agent store — SQLite persistence for the /agent builder.
 *
 * Reuses the shared database opened by loop-store.mjs (via getDb()); the
 * `agents` table is created in loop-store's initDb alongside loops/sessions.
 * This module owns no connection of its own — same pattern as session-store.mjs.
 *
 * The first four columns deliberately mirror the Anthropic Managed Agents
 * request body (`POST /v1/agents`: name, model, system, tools) so a stored row
 * IS an agent definition — nothing bespoke is invented. The only field we add
 * on top is `cadence` (how often to run), plus the bookkeeping needed to
 * schedule it (interval_seconds, session_id, loop_id).
 *
 *   agents (
 *     id               TEXT PRIMARY KEY  -- "agent_" + 6 random alphanum chars
 *     name             TEXT NOT NULL     -- /v1/agents: name
 *     model            TEXT NOT NULL     -- /v1/agents: model
 *     system           TEXT NOT NULL     -- /v1/agents: system
 *     tools            TEXT NOT NULL     -- /v1/agents: tools (JSON array string)
 *     cadence          TEXT              -- raw interval ("1h", "daily"); NULL = on-demand
 *     interval_seconds INTEGER           -- parsed cadence; NULL = on-demand
 *     session_id       TEXT NOT NULL     -- session the agent was built in
 *     loop_id          TEXT              -- loops.id once scheduled; NULL = not scheduled
 *     created_at       INTEGER NOT NULL  -- epoch ms
 *   )
 *
 * All exports are synchronous (better-sqlite3 is fully sync).
 */

import { getDb } from "./loop-store.mjs";

function generateId() {
  return "agent_" + Math.random().toString(36).slice(2, 8);
}

/**
 * Insert a new agent row and return the full (hydrated) row object.
 *
 * @param {{ name: string, model: string, system: string, tools: object[],
 *           cadence?: string|null, intervalSeconds?: number|null,
 *           sessionId: string, loopId?: string|null }} opts
 * @returns {object}
 */
export function createAgent({
  name,
  model,
  system,
  tools,
  cadence = null,
  intervalSeconds = null,
  sessionId,
  loopId = null,
}) {
  const id = generateId();
  const now = Date.now();

  getDb()
    .prepare(
      `INSERT INTO agents (id, name, model, system, tools, cadence, interval_seconds, session_id, loop_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      name,
      model,
      system,
      JSON.stringify(tools ?? []),
      cadence ?? null,
      intervalSeconds ?? null,
      sessionId,
      loopId ?? null,
      now,
    );

  return getAgent(id);
}

/**
 * Attach a scheduler loop id to an existing agent.
 *
 * @param {string} id
 * @param {string} loopId
 */
export function setAgentLoop(id, loopId) {
  getDb().prepare("UPDATE agents SET loop_id = ? WHERE id = ?").run(loopId, id);
}

/**
 * Delete the agent with the given id.
 *
 * @param {string} id
 */
export function deleteAgent(id) {
  getDb().prepare("DELETE FROM agents WHERE id = ?").run(id);
}

/**
 * Return all agent rows ordered by created_at ascending (`tools` parsed).
 *
 * @returns {object[]}
 */
export function listAgents() {
  return getDb()
    .prepare("SELECT * FROM agents ORDER BY created_at ASC")
    .all()
    .map(hydrate);
}

/**
 * Return the agent row for `id` (with `tools` parsed), or null if not found.
 *
 * @param {string} id
 * @returns {object|null}
 */
export function getAgent(id) {
  const row = getDb().prepare("SELECT * FROM agents WHERE id = ?").get(id);
  return row ? hydrate(row) : null;
}

function hydrate(row) {
  let tools = [];
  try {
    tools = JSON.parse(row.tools);
  } catch {}
  return { ...row, tools };
}
