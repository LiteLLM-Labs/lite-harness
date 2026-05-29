/**
 * Loop store — SQLite persistence for the loop scheduler.
 *
 * Schema (single table `loops`):
 *   id               TEXT PRIMARY KEY  -- "loop_" + 6 random alphanum chars
 *   session_id       TEXT NOT NULL
 *   prompt           TEXT NOT NULL
 *   interval_seconds INTEGER NOT NULL
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
  initSessionSchema(_db);

  return _db;
}

/**
 * Insert a new loop row and return the full row object.
 *
 * @param {{ sessionId: string, prompt: string, intervalSeconds: number, maxIterations?: number|null }} opts
 * @returns {object}
 */
export function createLoop({ sessionId, prompt, intervalSeconds, maxIterations = null }) {
  assertDb();

  const id = generateId();
  const now = Date.now();
  const nextRunAt = now + intervalSeconds * 1000;

  _db.prepare(`
    INSERT INTO loops (id, session_id, prompt, interval_seconds, max_iterations, iteration_count, next_run_at, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `).run(id, sessionId, prompt, intervalSeconds, maxIterations ?? null, nextRunAt, now);

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
 * Atomically increment iteration_count and advance next_run_at by
 * interval_seconds * 1000 ms.
 *
 * @param {string} id
 * @param {number} nowMs  Current epoch ms (used as the base for next_run_at).
 */
export function tickLoop(id, nowMs) {
  assertDb();
  _db.prepare(`
    UPDATE loops
    SET iteration_count = iteration_count + 1,
        next_run_at     = ? + interval_seconds * 1000
    WHERE id = ?
  `).run(nowMs, id);
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
