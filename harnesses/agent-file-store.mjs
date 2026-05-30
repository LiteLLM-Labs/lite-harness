/**
 * agent-file-store.mjs
 *
 * File CRUD for agent-attached Python files. Storage is SQLite via loop-store.mjs.
 * Validation is enforced here — the DB layer just stores bytes.
 */

import { getDb } from "./loop-store.mjs";

const MAX_FILE_SIZE_BYTES = 512_000; // 500 KB per file
const MAX_FILES_PER_AGENT = 50;
const VALID_PATH_RE = /^[\w][\w.\-/]*\.py$/; // .py only, no .. traversal

function _assertValidPath(filePath) {
  if (!VALID_PATH_RE.test(filePath) || filePath.includes("..")) {
    const err = new Error(`invalid path: "${filePath}" — must match [\\w][\\w./-]*.py with no ".." segments`);
    err.status = 400;
    throw err;
  }
}

function _assertValidContent(content) {
  const size = Buffer.byteLength(content, "utf-8");
  if (size > MAX_FILE_SIZE_BYTES) {
    const err = new Error(`file too large: ${size} bytes (max ${MAX_FILE_SIZE_BYTES})`);
    err.status = 413;
    throw err;
  }
}

function _assertCountCap(agentId, excludePath) {
  const count = getDb()
    .prepare("SELECT COUNT(*) as n FROM agent_files WHERE agent_id = ? AND path != ?")
    .get(agentId, excludePath ?? "").n;
  if (count >= MAX_FILES_PER_AGENT) {
    const err = new Error(`agent already has ${MAX_FILES_PER_AGENT} files (max)`);
    err.status = 422;
    throw err;
  }
}

/**
 * Upsert a file for an agent. Validates path, size, and count cap.
 * Returns the stored row.
 */
export function upsertAgentFile(agentId, filePath, content) {
  _assertValidPath(filePath);
  _assertValidContent(content);
  _assertCountCap(agentId, filePath); // exclude self so updates don't count against cap

  const now = Date.now();
  const sizeBytes = Buffer.byteLength(content, "utf-8");

  getDb().prepare(`
    INSERT INTO agent_files (agent_id, path, content, size_bytes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, path) DO UPDATE SET
      content    = excluded.content,
      size_bytes = excluded.size_bytes,
      updated_at = excluded.updated_at
  `).run(agentId, filePath, content, sizeBytes, now, now);

  return getAgentFile(agentId, filePath);
}

/**
 * List files for an agent (path + metadata, NOT content).
 */
export function listAgentFiles(agentId) {
  return getDb()
    .prepare(
      "SELECT agent_id, path, size_bytes, created_at, updated_at FROM agent_files WHERE agent_id = ? ORDER BY path ASC",
    )
    .all(agentId);
}

/**
 * Get a single file including content, or null if not found.
 */
export function getAgentFile(agentId, filePath) {
  return getDb()
    .prepare("SELECT * FROM agent_files WHERE agent_id = ? AND path = ?")
    .get(agentId, filePath) ?? null;
}

/**
 * Delete a single file.
 */
export function deleteAgentFile(agentId, filePath) {
  getDb()
    .prepare("DELETE FROM agent_files WHERE agent_id = ? AND path = ?")
    .run(agentId, filePath);
}

/**
 * Delete ALL files for an agent (used when agent is deleted).
 */
export function deleteAllAgentFiles(agentId) {
  getDb()
    .prepare("DELETE FROM agent_files WHERE agent_id = ?")
    .run(agentId);
}

/** Exported limits for capabilities endpoint */
export const FILE_LIMITS = {
  max_file_size_bytes: MAX_FILE_SIZE_BYTES,
  max_files_per_agent: MAX_FILES_PER_AGENT,
  allowed_extensions: [".py"],
};
