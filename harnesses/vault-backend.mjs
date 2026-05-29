/**
 * Vault backend — encrypted secret storage shared between inline-adapter
 * (writes via VaultPlugin) and sandbox-mcp (reads at provision time).
 *
 * v0: SQLite via better-sqlite3. AES-256-GCM encryption with MASTER_KEY.
 *
 * Env vars:
 *   VAULT_DB_PATH  — path to vault.db (default: ~/.local/share/lite-harness/vault.db)
 *   MASTER_KEY     — encryption key; plaintext fallback if unset (with warning)
 *
 * Future extensibility: set VAULT_BACKEND=clawpatrol|lap to swap backends.
 */

import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const _require = createRequire(import.meta.url);

export const VAULT_DB_PATH =
  process.env.VAULT_DB_PATH ||
  path.join(process.env.HOME || os.homedir(), ".local/share/lite-harness/vault.db");

// ── Encryption ────────────────────────────────────────────────────────────────

function deriveKey(masterKey) {
  return crypto.createHash("sha256").update(masterKey).digest().slice(0, 32);
}

function encryptValue(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    enc: enc.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptValue(enc, iv, tag, key) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(enc, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

// ── VaultBackend base ─────────────────────────────────────────────────────────

export class VaultBackend {
  async set(_key, _value) {}
  async get(_key) { return null; }
  async getAll() { return {}; }    // used by sandbox-mcp at provision time
  async list() { return []; }       // [{key, updatedAt}] — never values
  async delete(_key) {}
  async clear() {}
}

// ── SqliteBackend ─────────────────────────────────────────────────────────────

export class SqliteBackend extends VaultBackend {
  constructor(masterKey, dbPath = VAULT_DB_PATH) {
    super();
    this._encKey = masterKey ? deriveKey(masterKey) : null;
    if (!this._encKey) {
      console.warn("[vault-backend] MASTER_KEY not set — secrets stored as plaintext");
    }

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    let Database;
    try {
      Database = _require("better-sqlite3");
    } catch {
      throw new Error(
        "better-sqlite3 not found. Add it to harnesses/opencode/package.json and rebuild.",
      );
    }

    this._db = new Database(dbPath);
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS vault_secrets (
        key        TEXT PRIMARY KEY,
        enc_value  TEXT NOT NULL,
        iv         TEXT,
        tag        TEXT,
        plaintext  INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  async set(key, value) {
    const now = Date.now();
    if (this._encKey) {
      const { enc, iv, tag } = encryptValue(String(value), this._encKey);
      this._db.prepare(`
        INSERT INTO vault_secrets (key, enc_value, iv, tag, plaintext, updated_at)
        VALUES (?, ?, ?, ?, 0, ?)
        ON CONFLICT(key) DO UPDATE SET
          enc_value = excluded.enc_value, iv = excluded.iv,
          tag = excluded.tag, plaintext = 0, updated_at = excluded.updated_at
      `).run(key, enc, iv, tag, now);
    } else {
      const enc = Buffer.from(String(value)).toString("base64");
      this._db.prepare(`
        INSERT INTO vault_secrets (key, enc_value, iv, tag, plaintext, updated_at)
        VALUES (?, ?, NULL, NULL, 1, ?)
        ON CONFLICT(key) DO UPDATE SET
          enc_value = excluded.enc_value, iv = NULL,
          tag = NULL, plaintext = 1, updated_at = excluded.updated_at
      `).run(key, enc, now);
    }
  }

  async get(key) {
    const row = this._db
      .prepare("SELECT enc_value, iv, tag, plaintext FROM vault_secrets WHERE key = ?")
      .get(key);
    if (!row) return null;
    return this._decode(row);
  }

  async getAll() {
    const rows = this._db
      .prepare("SELECT key, enc_value, iv, tag, plaintext FROM vault_secrets")
      .all();
    const out = {};
    for (const row of rows) {
      try { out[row.key] = this._decode(row); } catch {}
    }
    return out;
  }

  async list() {
    return this._db
      .prepare("SELECT key, updated_at FROM vault_secrets ORDER BY key")
      .all()
      .map(r => ({ key: r.key, updatedAt: r.updated_at }));
  }

  async delete(key) {
    this._db.prepare("DELETE FROM vault_secrets WHERE key = ?").run(key);
  }

  async clear() {
    this._db.prepare("DELETE FROM vault_secrets").run();
  }

  _decode(row) {
    if (row.plaintext) return Buffer.from(row.enc_value, "base64").toString("utf8");
    if (!this._encKey) throw new Error("MASTER_KEY required to decrypt");
    return decryptValue(row.enc_value, row.iv, row.tag, this._encKey);
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function buildBackend(masterKey, dbPath) {
  return new SqliteBackend(masterKey, dbPath);
}
