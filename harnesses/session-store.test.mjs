import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { initDb } from "./loop-store.mjs";
import { getSessionAgentId, loadOcSessions, persistSession } from "./session-store.mjs";

const DB_PATH = path.join(os.tmpdir(), `session-store-${randomUUID().slice(0, 8)}.db`);
initDb(DB_PATH);
test.after(() => { try { fs.unlinkSync(DB_PATH); } catch {} });

test("persistSession stores the owning platform agent id", () => {
  persistSession({
    id: "ses_agent_owned",
    harness: "opencode",
    title: "agent-run-agent_123",
    createdAt: Date.now(),
    agentId: "agent_123",
  });

  assert.equal(getSessionAgentId("ses_agent_owned"), "agent_123");
  assert.equal(loadOcSessions().find((s) => s.id === "ses_agent_owned")?.agent_id, "agent_123");
});
