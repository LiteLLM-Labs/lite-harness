/**
 * Skill store — SQLite persistence for reusable skills.
 *
 * A skill is a named capability document (markdown `content`, e.g. a SKILL.md)
 * that exists on its own and can be attached to any number of agents via
 * agents.skill_ids. This keeps the three agent concepts distinct:
 *   - prompt  — the agent's own task/instructions
 *   - skills  — shared capability docs attached to the agent
 *   - tools   — MCP integrations the agent can call
 *
 * Reuses the shared database opened by loop-store.mjs (via getDb()); the
 * `skills` table is created in loop-store's initDb. Owns no connection itself.
 *
 *   skills (
 *     id          TEXT PRIMARY KEY  -- "skill_" + 6 random alphanum chars
 *     name        TEXT NOT NULL
 *     description TEXT
 *     content     TEXT NOT NULL     -- the markdown body
 *     owner_id    TEXT
 *     created_at  INTEGER NOT NULL  -- epoch ms
 *   )
 *
 * All exports are synchronous (better-sqlite3 is fully sync).
 */

import { getDb } from "./loop-store.mjs";

function generateId() {
  return "skill_" + Math.random().toString(36).slice(2, 8);
}

/**
 * Insert a new skill row and return the full row object.
 *
 * @param {{ name: string, content: string, description?: string|null, owner_id?: string|null }} opts
 * @returns {object}
 */
export function createSkill({ name, content, description = null, owner_id = null }) {
  const id = generateId();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO skills (id, name, description, content, owner_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, name, description ?? null, content, owner_id ?? null, now);
  return getSkill(id);
}

/** Return the skill row for `id`, or null if not found. */
export function getSkill(id) {
  return getDb().prepare("SELECT * FROM skills WHERE id = ?").get(id) ?? null;
}

/**
 * Return many skills by id (in arbitrary order). Missing ids are skipped.
 *
 * @param {string[]} ids
 * @returns {object[]}
 */
export function getSkillsByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return getDb()
    .prepare(`SELECT * FROM skills WHERE id IN (${placeholders})`)
    .all(...ids);
}

/** Return all skills (optionally scoped to an owner) ordered by created_at asc. */
export function listSkills(ownerId) {
  return ownerId
    ? getDb().prepare("SELECT * FROM skills WHERE owner_id = ? ORDER BY created_at ASC").all(ownerId)
    : getDb().prepare("SELECT * FROM skills ORDER BY created_at ASC").all();
}

/** Update allowed fields (name/description/content) on a skill. */
export function updateSkill(id, fields) {
  const allowed = ["name", "description", "content"];
  const setClauses = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    setClauses.push(`${k} = ?`);
    vals.push(v ?? null);
  }
  if (!setClauses.length) return;
  vals.push(id);
  getDb().prepare(`UPDATE skills SET ${setClauses.join(", ")} WHERE id = ?`).run(...vals);
}

/** Delete the skill with the given id. */
export function deleteSkill(id) {
  getDb().prepare("DELETE FROM skills WHERE id = ?").run(id);
}
