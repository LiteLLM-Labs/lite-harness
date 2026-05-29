/**
 * Agent store — SQLite persistence for named reusable agents.
 *
 * Schema (single table `agents`):
 *   id            TEXT PRIMARY KEY  -- "agent_" + 6 random alphanum chars
 *   name          TEXT UNIQUE NOT NULL
 *   system_prompt TEXT NOT NULL
 *   base_agent    TEXT NOT NULL DEFAULT 'cc'
 *   created_at    INTEGER NOT NULL  -- epoch ms
 *
 * All exports are synchronous (better-sqlite3 is fully sync).
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

// Resolve better-sqlite3 from harnesses/node_modules where it is installed.
const _require = createRequire(new URL("../../harnesses/inline-adapter.mjs", import.meta.url));

// Module-level db handle; populated by initDb().
let _db = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateId() {
  return "agent_" + Math.random().toString(36).slice(2, 8);
}

function assertDb() {
  if (!_db) throw new Error("agent-store: call initDb() before using the store");
}

// ── Default DB path ───────────────────────────────────────────────────────────

const DEFAULT_DB_PATH =
  process.env.AGENT_DB_PATH ||
  path.join(process.env.HOME || "/home/sandbox", ".local", "share", "opencode", "agents.db");

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Open (or create) the SQLite database at `dbPath`, run CREATE TABLE IF NOT
 * EXISTS, and store the handle at module level.  Safe to call multiple times —
 * no-op after the first call, returns the existing handle.
 *
 * @param {string} [dbPath]  Absolute path to the .db file. Defaults to DEFAULT_DB_PATH.
 * @returns {import("better-sqlite3").Database}
 */
export function initDb(dbPath = DEFAULT_DB_PATH) {
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
    CREATE TABLE IF NOT EXISTS agents (
      id            TEXT PRIMARY KEY,
      name          TEXT UNIQUE NOT NULL,
      system_prompt TEXT NOT NULL,
      base_agent    TEXT NOT NULL DEFAULT 'cc',
      created_at    INTEGER NOT NULL
    )
  `);

  return _db;
}

/**
 * Insert a new agent row and return the full row object.
 *
 * @param {string} name
 * @param {string} systemPrompt
 * @param {string} [baseAgent="cc"]
 * @returns {object}
 */
export function saveAgent(name, systemPrompt, baseAgent = "cc") {
  assertDb();

  const id = generateId();
  const now = Date.now();

  _db.prepare(`
    INSERT INTO agents (id, name, system_prompt, base_agent, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, systemPrompt, baseAgent, now);

  return _db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
}

/**
 * Return the agent row matching `nameOrId` (checked against both name and id),
 * or null if not found.
 *
 * @param {string} nameOrId
 * @returns {object|null}
 */
export function getAgent(nameOrId) {
  assertDb();
  return (
    _db.prepare("SELECT * FROM agents WHERE name = ? OR id = ?").get(nameOrId, nameOrId) ?? null
  );
}

/**
 * Return all agent rows ordered by created_at ascending.
 *
 * @returns {object[]}
 */
export function listAgents() {
  assertDb();
  return _db.prepare("SELECT * FROM agents ORDER BY created_at ASC").all();
}

/**
 * Delete the agent matching `nameOrId` (checked against both name and id).
 *
 * @param {string} nameOrId
 */
export function deleteAgent(nameOrId) {
  assertDb();
  _db.prepare("DELETE FROM agents WHERE name = ? OR id = ?").run(nameOrId, nameOrId);
}
