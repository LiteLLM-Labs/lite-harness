/**
 * agent-file-store.mjs
 *
 * File CRUD for agent-attached workspace files. Storage is SQLite via loop-store.mjs.
 * Validation is enforced here — the DB layer just stores bytes.
 */

import { getDb } from "./loop-store.mjs";

const MAX_FILE_SIZE_BYTES = 2_000_000;
const MAX_FILES_PER_AGENT = 100;
const ALLOWED_EXTENSIONS = [
  ".py", ".md", ".txt", ".json", ".yaml", ".yml", ".csv", ".xlsx", ".sh", ".example",
];
const ALLOWED_BASENAMES = new Set([".gitignore"]);
const BINARY_EXTENSIONS = new Set([".xlsx"]);

function _basename(filePath) {
  return filePath.split("/").at(-1) || "";
}

function _extension(filePath) {
  const base = _basename(filePath).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot) : "";
}

export function isBinaryAgentFile(filePath) {
  return BINARY_EXTENSIONS.has(_extension(filePath));
}

function _assertValidPath(filePath) {
  const raw = String(filePath || "");
  const segments = raw.split("/");
  const basename = _basename(raw);
  const ext = _extension(raw);
  const valid =
    raw.length > 0 &&
    raw.length <= 240 &&
    !raw.startsWith("/") &&
    !raw.includes("\\") &&
    /^[A-Za-z0-9._/ -]+$/.test(raw) &&
    segments.every((seg) => seg && seg !== "." && seg !== "..") &&
    (ALLOWED_EXTENSIONS.includes(ext) || ALLOWED_BASENAMES.has(basename));
  if (!valid) {
    const err = new Error(`invalid path: "${filePath}" — must be a safe relative workspace path with an allowed extension`);
    err.status = 400;
    throw err;
  }
}

function _contentSize(content, encoding) {
  if (encoding === "base64") return Buffer.byteLength(Buffer.from(content, "base64"));
  return Buffer.byteLength(content, "utf-8");
}

function _assertValidContent(content, encoding) {
  if (!["utf8", "base64"].includes(encoding)) {
    const err = new Error(`invalid encoding: "${encoding}"`);
    err.status = 400;
    throw err;
  }
  if (encoding === "base64" && !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) {
    const err = new Error("invalid base64 content");
    err.status = 400;
    throw err;
  }
  const size = _contentSize(content, encoding);
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
export function upsertAgentFile(agentId, filePath, content, { encoding = "utf8" } = {}) {
  _assertValidPath(filePath);
  _assertValidContent(content, encoding);
  _assertCountCap(agentId, filePath); // exclude self so updates don't count against cap

  const now = Date.now();
  const sizeBytes = _contentSize(content, encoding);

  getDb().prepare(`
    INSERT INTO agent_files (agent_id, path, content, encoding, size_bytes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, path) DO UPDATE SET
      content    = excluded.content,
      encoding   = excluded.encoding,
      size_bytes = excluded.size_bytes,
      updated_at = excluded.updated_at
  `).run(agentId, filePath, content, encoding, sizeBytes, now, now);

  return getAgentFile(agentId, filePath);
}

/**
 * List files for an agent (path + metadata, NOT content).
 */
export function listAgentFiles(agentId) {
  return getDb()
    .prepare(
      "SELECT agent_id, path, encoding, size_bytes, created_at, updated_at FROM agent_files WHERE agent_id = ? ORDER BY path ASC",
    )
    .all(agentId);
}

/**
 * List files including content for sandbox materialization.
 */
export function listAgentFilesWithContent(agentId) {
  return getDb()
    .prepare(
      "SELECT agent_id, path, content, encoding, size_bytes, created_at, updated_at FROM agent_files WHERE agent_id = ? ORDER BY path ASC",
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
  allowed_extensions: ALLOWED_EXTENSIONS,
  binary_extensions: [...BINARY_EXTENSIONS],
};
