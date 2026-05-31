import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SqliteBackend } from "./vault-backend.mjs";

function tempDb() {
  return path.join(os.tmpdir(), `vault-${randomUUID().slice(0, 8)}.db`);
}

test("get returns null instead of throwing for undecryptable rows", async () => {
  const dbPath = tempDb();
  try {
    const oldBackend = new SqliteBackend("old-master-key", dbPath);
    await oldBackend.set("default:BROKEN_SECRET", "secret-value");

    const newBackend = new SqliteBackend("new-master-key", dbPath);
    assert.equal(await newBackend.get("default:BROKEN_SECRET"), null);
  } finally {
    try { fs.unlinkSync(dbPath); } catch {}
  }
});
