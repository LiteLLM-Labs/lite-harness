/**
 * Loop store — SQLite persistence for the loop scheduler.
 *
 * Schema (single table `loops`):
 *   id               TEXT PRIMARY KEY  -- "loop_" + 6 random alphanum chars
 *   session_id       TEXT NOT NULL
 *   prompt           TEXT NOT NULL
 *   interval_seconds INTEGER NOT NULL  -- -1 for cron-only loops
 *   cron_expr        TEXT              -- cron expression, e.g. "0 9 * * 1-5"
 *   tz               TEXT              -- IANA timezone, e.g. "America/New_York"
 *   max_iterations   INTEGER           -- NULL = infinite
 *   iteration_count  INTEGER NOT NULL DEFAULT 0
 *   next_run_at      INTEGER NOT NULL  -- epoch ms
 *   created_at       INTEGER NOT NULL  -- epoch ms
 *
 * All exports are synchronous (better-sqlite3 is fully sync).
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const _require = createRequire(import.meta.url);

// Module-level db handle; populated by initDb().
let _db = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateId() {
  return "loop_" + Math.random().toString(36).slice(2, 8);
}

function assertDb() {
  if (!_db) throw new Error("loop-store: call initDb() before using the store");
}

function initSessionSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id             TEXT PRIMARY KEY,
      harness        TEXT NOT NULL,
      title          TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER,
      sdk_session_id TEXT
    );
    CREATE TABLE IF NOT EXISTS session_messages (
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      seq        INTEGER NOT NULL,
      info_json  TEXT NOT NULL,
      parts_json TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS session_messages_sid_seq
      ON session_messages(session_id, seq);
  `);
}

function initAgentFilesSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_files (
      agent_id   TEXT NOT NULL,
      path       TEXT NOT NULL,
      content    TEXT NOT NULL,
      encoding   TEXT NOT NULL DEFAULT 'utf8',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id, path)
    )
  `);
  for (const stmt of [
    "ALTER TABLE agent_files ADD COLUMN encoding TEXT NOT NULL DEFAULT 'utf8'",
  ]) {
    try { db.exec(stmt); } catch {}
  }
}

function initAgentSchema(db) {
  // Columns name/model/system/tools mirror the Anthropic Managed Agents
  // request body (POST /v1/agents); `cadence` is the only field we add on top.
  // See agent-store.mjs for the full contract.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      model            TEXT NOT NULL,
      system           TEXT NOT NULL,
      tools            TEXT NOT NULL,
      cadence          TEXT,
      interval_seconds INTEGER,
      session_id       TEXT NOT NULL,
      loop_id          TEXT,
      created_at       INTEGER NOT NULL
    )
  `);

  // Migrate new columns — SQLite has no ADD COLUMN IF NOT EXISTS; swallow errors.
  const _newAgentCols = [
    "ALTER TABLE agents ADD COLUMN prompt TEXT",
    "ALTER TABLE agents ADD COLUMN cron TEXT",
    "ALTER TABLE agents ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'",
    "ALTER TABLE agents ADD COLUMN vault_keys TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE agents ADD COLUMN setup_commands TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE agents ADD COLUMN max_runtime_minutes INTEGER NOT NULL DEFAULT 30",
    "ALTER TABLE agents ADD COLUMN on_failure TEXT NOT NULL DEFAULT 'pause_and_notify'",
    "ALTER TABLE agents ADD COLUMN config TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE agents ADD COLUMN owner_id TEXT",
    "ALTER TABLE agents ADD COLUMN status TEXT NOT NULL DEFAULT 'paused'",
    "ALTER TABLE agents ADD COLUMN description TEXT",
    "ALTER TABLE agents ADD COLUMN harness TEXT NOT NULL DEFAULT 'claude-code'",
    // skill_ids — JSON array of skills.id attached to this agent.
    "ALTER TABLE agents ADD COLUMN skill_ids TEXT NOT NULL DEFAULT '[]'",
  ];
  for (const sql of _newAgentCols) {
    try { db.exec(sql); } catch {}
  }
}

function initSkillSchema(db) {
  // Skills are reusable capability docs (a name + markdown content, e.g. a
  // SKILL.md) that exist independently and can be attached to agents via
  // agents.skill_ids. Separating skills from an agent's own `system`/`prompt`
  // lets one skill be shared across many agents.
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      content     TEXT NOT NULL,
      owner_id    TEXT,
      created_at  INTEGER NOT NULL
    )
  `);
}

function initMemorySchema(db) {
  // Agent memory — durable key→value notes an agent stores and recalls across
  // sessions/runs. Scoped per agent_id; (agent_id, key) is unique so a repeated
  // store under the same key overwrites (upsert). This is what the platform's
  // memory_store / memory_get / memory_list / memory_delete tools read & write.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_memories (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL,
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      always_on   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      UNIQUE (agent_id, key)
    )
  `);
  try { db.exec("ALTER TABLE agent_memories ADD COLUMN always_on INTEGER NOT NULL DEFAULT 0"); } catch {}
  // Listing an agent's memory is the hot path — index the scope column.
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_agent_memories_agent ON agent_memories(agent_id)"); } catch {}
}

function initInboxSchema(db) {
  // Unified agent-inbox items. Two kinds share one table:
  //   kind='approval' — a human-in-the-loop tool-call gate (request_human_approval).
  //                     status: 'pending' → 'accepted' | 'rejected'.
  //   kind='issue'    — an informational issue an agent filed for a human to read.
  //                     status: 'open' → 'resolved'.
  // The live blocking promise for an approval lives in mcp/approvals.mjs; this
  // table is the durable record so the Inbox can show resolved history too.
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox_items (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,
      title       TEXT NOT NULL,
      session_id  TEXT,
      agent       TEXT,
      body        TEXT,
      args_json   TEXT,
      status      TEXT NOT NULL,
      feedback    TEXT,
      created_at  INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS inbox_items_status_created
      ON inbox_items(status, created_at);
  `);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return the shared db handle. Throws if initDb() hasn't been called.
 *
 * @returns {import("better-sqlite3").Database}
 */
export function getDb() {
  assertDb();
  return _db;
}

/**
 * Open (or create) the SQLite database at `dbPath`, run CREATE TABLE IF NOT
 * EXISTS, and store the handle at module level.  Call once at startup.
 * Subsequent calls with the same path are no-ops (returns existing handle).
 *
 * @param {string} dbPath  Absolute path to the .db file.
 * @returns {import("better-sqlite3").Database}
 */
export function initDb(dbPath) {
  if (_db) return _db;

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  let Database;
  try {
    Database = _require("better-sqlite3");
  } catch {
    throw new Error(
      "better-sqlite3 not found. Add it to harnesses/opencode/package.json and rebuild.",
    );
  }

  _db = new Database(dbPath);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS loops (
      id               TEXT PRIMARY KEY,
      session_id       TEXT NOT NULL,
      prompt           TEXT NOT NULL,
      interval_seconds INTEGER NOT NULL,
      max_iterations   INTEGER,
      iteration_count  INTEGER NOT NULL DEFAULT 0,
      next_run_at      INTEGER NOT NULL,
      created_at       INTEGER NOT NULL
    )
  `);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id               TEXT PRIMARY KEY,
      agent_id         TEXT NOT NULL,
      session_id       TEXT,
      status           TEXT NOT NULL DEFAULT 'starting',
      started_at       INTEGER NOT NULL,
      finished_at      INTEGER,
      summary          TEXT,
      error            TEXT,
      config_overrides TEXT NOT NULL DEFAULT '{}'
    )
  `);
  // Migrations — idempotent (ALTER TABLE fails silently if column exists).
  try { _db.exec("ALTER TABLE loops ADD COLUMN cron_expr TEXT"); } catch {}
  try { _db.exec("ALTER TABLE loops ADD COLUMN tz TEXT"); } catch {}
  initSessionSchema(_db);
  initAgentSchema(_db);
  initSkillSchema(_db);
  initMemorySchema(_db);
  initInboxSchema(_db);
  initAgentFilesSchema(_db);
  // Migrate sandbox_id onto agent_runs if not present
  try { _db.exec("ALTER TABLE agent_runs ADD COLUMN sandbox_id TEXT"); } catch {}
  try { _db.exec("ALTER TABLE sessions ADD COLUMN tz TEXT"); } catch {}

  return _db;
}

/**
 * Insert a new loop row and return the full row object.
 *
 * @param {{ sessionId: string, prompt: string, intervalSeconds?: number|null, cronExpr?: string|null, tz?: string|null, nextRunAt?: number|null, maxIterations?: number|null }} opts
 * @returns {object}
 */
export function createLoop({ sessionId, prompt, intervalSeconds = null, cronExpr = null, tz = null, nextRunAt = null, maxIterations = null }) {
  assertDb();

  const id = generateId();
  const now = Date.now();
  // Caller must supply nextRunAt for cron loops; interval loops compute it here.
  const resolvedNextRunAt = nextRunAt ?? (now + (intervalSeconds ?? 0) * 1000);
  // -1 sentinel for cron-only loops (interval_seconds is NOT NULL in schema).
  const storedInterval = cronExpr ? -1 : (intervalSeconds ?? 0);

  _db.prepare(`
    INSERT INTO loops (id, session_id, prompt, interval_seconds, cron_expr, tz, max_iterations, iteration_count, next_run_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(id, sessionId, prompt, storedInterval, cronExpr ?? null, tz ?? null, maxIterations ?? null, resolvedNextRunAt, now);

  return _db.prepare("SELECT * FROM loops WHERE id = ?").get(id);
}

/**
 * Return all loop rows whose next_run_at is <= nowMs and that have not yet
 * reached their max_iterations (if set).
 *
 * @param {number} nowMs  Current epoch ms.
 * @returns {object[]}
 */
export function dueLoops(nowMs) {
  assertDb();
  return _db.prepare(`
    SELECT * FROM loops
    WHERE next_run_at <= ?
      AND (max_iterations IS NULL OR iteration_count < max_iterations)
  `).all(nowMs);
}

/**
 * Increment iteration_count and set next_run_at to the provided value.
 * Caller is responsible for computing nextRunAt (supports both interval and cron).
 *
 * @param {string} id
 * @param {number} nextRunAt  Next fire time in epoch ms.
 */
export function tickLoop(id, nextRunAt) {
  assertDb();
  _db.prepare(`
    UPDATE loops
    SET iteration_count = iteration_count + 1,
        next_run_at     = ?
    WHERE id = ?
  `).run(nextRunAt, id);
}

/**
 * Delete the loop with the given id.
 *
 * @param {string} id
 */
export function deleteLoop(id) {
  assertDb();
  _db.prepare("DELETE FROM loops WHERE id = ?").run(id);
}

/**
 * Return all loop rows ordered by created_at ascending.
 *
 * @returns {object[]}
 */
export function listLoops() {
  assertDb();
  return _db.prepare("SELECT * FROM loops ORDER BY created_at ASC").all();
}

/**
 * Return the loop row for `id`, or null if not found.
 *
 * @param {string} id
 * @returns {object|null}
 */
export function getLoop(id) {
  assertDb();
  return _db.prepare("SELECT * FROM loops WHERE id = ?").get(id) ?? null;
}

// ── Agent Run CRUD ─────────────────────────────────────────────────────────────

function generateRunId() {
  return "run_" + Math.random().toString(36).slice(2, 10);
}

export function createAgentRun({ agentId, sessionId = null, configOverrides = {} }) {
  assertDb();
  const id = generateRunId();
  const now = Date.now();
  _db.prepare(`
    INSERT INTO agent_runs (id, agent_id, session_id, status, started_at, config_overrides)
    VALUES (?, ?, ?, 'starting', ?, ?)
  `).run(id, agentId, sessionId, now, JSON.stringify(configOverrides));
  return getAgentRun(id);
}

export function getAgentRun(id) {
  assertDb();
  const row = _db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id);
  if (!row) return null;
  return { ...row, config_overrides: JSON.parse(row.config_overrides || '{}') };
}

export function updateAgentRun(id, { status, finishedAt, summary, error, sessionId } = {}) {
  assertDb();
  const fields = [];
  const vals = [];
  if (status !== undefined) { fields.push("status = ?"); vals.push(status); }
  if (finishedAt !== undefined) { fields.push("finished_at = ?"); vals.push(finishedAt); }
  if (summary !== undefined) { fields.push("summary = ?"); vals.push(summary); }
  if (error !== undefined) { fields.push("error = ?"); vals.push(error); }
  if (sessionId !== undefined) { fields.push("session_id = ?"); vals.push(sessionId); }
  if (!fields.length) return;
  vals.push(id);
  _db.prepare(`UPDATE agent_runs SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
}

export function listAgentRuns(agentId, limit = 10) {
  assertDb();
  return _db.prepare("SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?")
    .all(agentId, Math.min(limit, 100))
    .map(row => ({ ...row, config_overrides: JSON.parse(row.config_overrides || '{}') }));
}
