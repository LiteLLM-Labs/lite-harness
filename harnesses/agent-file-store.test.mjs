/**
 * Tests for agent-file-store.mjs — persisted workspace files for agents.
 *
 * Run: node --test harnesses/agent-file-store.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { initDb } from "./loop-store.mjs";
import {
  getAgentFile,
  isBinaryAgentFile,
  listAgentFiles,
  listAgentFilesWithContent,
  upsertAgentFile,
} from "./agent-file-store.mjs";

const DB_PATH = path.join(os.tmpdir(), `agent-files-test-${randomUUID().slice(0, 8)}.db`);
initDb(DB_PATH);
test.after(() => { try { fs.unlinkSync(DB_PATH); } catch {} });

test("stores workspace files with safe nested paths", () => {
  const agentId = `agent_${randomUUID().slice(0, 8)}`;

  upsertAgentFile(agentId, ".cursor/skills/litellm-pricing/SKILL.md", "# Skill\n");
  upsertAgentFile(agentId, "deals/_template/context/README.md", "Drop context here.\n");

  const files = listAgentFiles(agentId);
  assert.deepEqual(files.map((f) => f.path), [
    ".cursor/skills/litellm-pricing/SKILL.md",
    "deals/_template/context/README.md",
  ]);
  assert.equal(files[0].encoding, "utf8");

  const full = listAgentFilesWithContent(agentId);
  assert.equal(full[0].content, "# Skill\n");
});

test("stores xlsx files as base64 with decoded size", () => {
  const agentId = `agent_${randomUUID().slice(0, 8)}`;
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const encoded = bytes.toString("base64");

  const row = upsertAgentFile(
    agentId,
    "calculator/LiteLLM - Request Based Calculator with Tiers.xlsx",
    encoded,
    { encoding: "base64" },
  );

  assert.equal(isBinaryAgentFile(row.path), true);
  assert.equal(row.encoding, "base64");
  assert.equal(row.size_bytes, bytes.length);
  assert.equal(getAgentFile(agentId, row.path).content, encoded);
});

test("rejects unsafe paths", () => {
  assert.throws(
    () => upsertAgentFile("agent_bad", "../secret.md", "nope"),
    /invalid path/,
  );
  assert.throws(
    () => upsertAgentFile("agent_bad", "notes/secret.pem", "nope"),
    /invalid path/,
  );
});
