import test from "node:test";
import assert from "node:assert/strict";

import { parseLaunchArgs } from "../../../../src/sdk/server/protocol.mjs";

test("parseLaunchArgs parses effort launch flag", () => {
  const options = parseLaunchArgs([
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--agent",
    "codex",
    "--model",
    "gpt-5.5",
    "--effort",
    "high",
  ]);

  assert.equal(options.agent, "codex");
  assert.equal(options.model, "gpt-5.5");
  assert.equal(options.effort, "high");
});

test("parseLaunchArgs defaults effort to null", () => {
  const options = parseLaunchArgs([]);

  assert.equal(options.effort, null);
});
