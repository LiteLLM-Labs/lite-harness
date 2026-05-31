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

function decodeRowWithKey(row, key) {
  if (row.plaintext) return Buffer.from(row.enc_value, "base64").toString("utf8");
  if (!key) throw new Error("MASTER_KEY required to decrypt");
  return decryptValue(row.enc_value, row.iv, row.tag, key);
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
    if (!row) {
      // Fall back to process.env — strip any userId prefix (e.g. "local:GITHUB_TOKEN" → "GITHUB_TOKEN")
      const envKey = key.includes(":") ? key.slice(key.lastIndexOf(":") + 1) : key;
      return process.env[envKey] ?? null;
    }
    try {
      return this._decode(row);
    } catch (e) {
      console.warn(`[vault-backend] failed to decrypt ${key}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  async getAll() {
    const rows = this._db
      .prepare("SELECT key, enc_value, iv, tag, plaintext FROM vault_secrets")
      .all();
    // Start with process.env as low-priority baseline (vault values override)
    const out = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) out[k] = v;
    }
    for (const row of rows) {
      // Strip userId prefix so callers get bare key names
      const keyName = row.key.includes(":") ? row.key.slice(row.key.lastIndexOf(":") + 1) : row.key;
      try { out[keyName] = this._decode(row); } catch {}
    }
    return out;
  }

  async list() {
    const dbRows = this._db
      .prepare("SELECT key, updated_at FROM vault_secrets ORDER BY key")
      .all()
      .map(r => ({ key: r.key, updatedAt: r.updated_at }));
    return dbRows;
  }

  // Returns env var key names (bare, no userId prefix) not already stored in vault
  envFallbackKeys(userId) {
    const prefix = userId ? `${userId}:` : "";
    const dbKeys = new Set(
      this._db
        .prepare("SELECT key FROM vault_secrets")
        .all()
        .map(r => (r.key.startsWith(prefix) ? r.key.slice(prefix.length) : r.key))
    );
    return Object.keys(process.env).filter(k => !dbKeys.has(k) && process.env[k]);
  }

  async delete(key) {
    this._db.prepare("DELETE FROM vault_secrets WHERE key = ?").run(key);
  }

  async clear() {
    this._db.prepare("DELETE FROM vault_secrets").run();
  }

  async rotateMasterKey(oldMasterKey) {
    if (!oldMasterKey) throw new Error("oldMasterKey required");
    if (!this._encKey) throw new Error("current MASTER_KEY required");
    const oldKey = deriveKey(oldMasterKey);
    const rows = this._db
      .prepare("SELECT key, enc_value, iv, tag, plaintext FROM vault_secrets ORDER BY key")
      .all();
    let rotated = 0;
    let alreadyCurrent = 0;
    const failed = [];
    const update = this._db.prepare(`
      UPDATE vault_secrets
      SET enc_value = ?, iv = ?, tag = ?, plaintext = 0, updated_at = ?
      WHERE key = ?
    `);
    const tx = this._db.transaction(() => {
      for (const row of rows) {
        let plaintext;
        try {
          plaintext = decodeRowWithKey(row, oldKey);
        } catch (oldErr) {
          try {
            this._decode(row);
            alreadyCurrent += 1;
            continue;
          } catch {
            failed.push({
              key: row.key,
              error: oldErr instanceof Error ? oldErr.message : String(oldErr),
            });
            continue;
          }
        }
        const { enc, iv, tag } = encryptValue(plaintext, this._encKey);
        update.run(enc, iv, tag, Date.now(), row.key);
        rotated += 1;
      }
    });
    tx();
    return { scanned: rows.length, rotated, alreadyCurrent, failed };
  }

  _decode(row) {
    return decodeRowWithKey(row, this._encKey);
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function buildBackend(masterKey, dbPath) {
  return new SqliteBackend(masterKey, dbPath);
}
