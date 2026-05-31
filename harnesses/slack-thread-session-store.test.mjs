import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  initDb,
  getSlackThreadSession,
  upsertSlackThreadSession,
} from "./loop-store.mjs";

const DB_PATH = path.join(os.tmpdir(), `slack-thread-session-${randomUUID().slice(0, 8)}.db`);
initDb(DB_PATH);
test.after(() => { try { fs.unlinkSync(DB_PATH); } catch {} });

test("slack thread sessions are keyed by agent, channel, and thread timestamp", () => {
  assert.equal(getSlackThreadSession("agent_1", "C1", "111.222"), null);

  const created = upsertSlackThreadSession("agent_1", "C1", "111.222", "ses_first");
  assert.equal(created.session_id, "ses_first");

  assert.equal(getSlackThreadSession("agent_1", "C1", "111.222").session_id, "ses_first");
  assert.equal(getSlackThreadSession("agent_1", "C2", "111.222"), null);
  assert.equal(getSlackThreadSession("agent_2", "C1", "111.222"), null);

  const updated = upsertSlackThreadSession("agent_1", "C1", "111.222", "ses_second");
  assert.equal(updated.session_id, "ses_second");
  assert.equal(getSlackThreadSession("agent_1", "C1", "111.222").session_id, "ses_second");
});
