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
  prompt = null,
  cron = null,
  timezone = 'UTC',
  vault_keys = [],
  setup_commands = [],
  max_runtime_minutes = 30,
  on_failure = 'pause_and_notify',
  config = {},
  owner_id = null,
  status = 'paused',
  description = null,
  harness = 'claude-code',
}) {
  const id = generateId();
  const now = Date.now();

  getDb()
    .prepare(
      `INSERT INTO agents (
        id, name, model, system, tools, cadence, interval_seconds, session_id, loop_id, created_at,
        prompt, cron, timezone, vault_keys, setup_commands, max_runtime_minutes,
        on_failure, config, owner_id, status, description, harness
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      prompt ?? null,
      cron ?? null,
      timezone,
      JSON.stringify(Array.isArray(vault_keys) ? vault_keys : []),
      JSON.stringify(Array.isArray(setup_commands) ? setup_commands : []),
      max_runtime_minutes,
      on_failure,
      JSON.stringify(typeof config === 'object' ? config : {}),
      owner_id ?? null,
      status,
      description ?? null,
      harness,
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
 * Update allowed fields on an existing agent row.
 *
 * @param {string} id
 * @param {object} fields
 */
export function updateAgent(id, fields) {
  const allowed = [
    'name', 'model', 'system', 'tools', 'cadence', 'interval_seconds', 'loop_id',
    'status', 'prompt', 'cron', 'timezone', 'vault_keys', 'setup_commands',
    'max_runtime_minutes', 'on_failure', 'config', 'owner_id', 'description', 'harness',
  ];
  const setClauses = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    setClauses.push(`${k} = ?`);
    if (['tools', 'vault_keys', 'setup_commands', 'config'].includes(k) && typeof v !== 'string') {
      vals.push(JSON.stringify(v));
    } else {
      vals.push(v ?? null);
    }
  }
  if (!setClauses.length) return;
  vals.push(id);
  getDb().prepare(`UPDATE agents SET ${setClauses.join(', ')} WHERE id = ?`).run(...vals);
}

/**
 * Return all agent rows ordered by created_at ascending (JSON columns parsed).
 *
 * @param {string} [ownerId]
 * @returns {object[]}
 */
export function listAgents(ownerId) {
  const rows = ownerId
    ? getDb().prepare("SELECT * FROM agents WHERE owner_id = ? ORDER BY created_at ASC").all(ownerId)
    : getDb().prepare("SELECT * FROM agents ORDER BY created_at ASC").all();
  return rows.map(hydrate);
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
  let vault_keys = [];
  let setup_commands = [];
  let config = {};
  try { tools = JSON.parse(row.tools); } catch {}
  try { vault_keys = JSON.parse(row.vault_keys || '[]'); } catch {}
  try { setup_commands = JSON.parse(row.setup_commands || '[]'); } catch {}
  try { config = JSON.parse(row.config || '{}'); } catch {}
  return { ...row, tools, vault_keys, setup_commands, config };
}
