// Runtime export-parity test against the real upstream Claude Agent SDK.
//
// The upstream package (@anthropic-ai/claude-agent-sdk) may be absent in CI.
// If it cannot be imported, this test SKIPS (and therefore passes). When it is
// present, we assert that our compiled ../dist/index.js exports the core VALUE
// names that upstream also exports — at minimum `query` (a function) — plus our
// error classes. This proves the drop-in swap works at the value level.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as ours from "../dist/index.js";

let upstream;
try {
  upstream = await import("@anthropic-ai/claude-agent-sdk");
} catch {
  upstream = undefined;
}

test("runtime export parity with @anthropic-ai/claude-agent-sdk", { skip: upstream ? false : "@anthropic-ai/claude-agent-sdk not installed" }, () => {
  // `query` must be exported by both and be callable.
  assert.equal(typeof upstream.query, "function", "upstream should export query()");
  assert.equal(typeof ours.query, "function", "ours should export query()");

  // For every core VALUE name upstream exports that we also claim to provide,
  // ensure ours exists. We only enforce the names we intend to be drop-in for;
  // upstream may legitimately export extras we do not implement.
  const coreValueNames = [
    "query",
    "ClaudeSDKError",
    "AbortError",
    "CLINotFoundError",
    "CLIConnectionError",
    "ProcessError",
    "CLIJSONDecodeError",
  ];

  for (const name of coreValueNames) {
    if (typeof upstream[name] !== "undefined") {
      assert.notEqual(
        typeof ours[name],
        "undefined",
        `ours is missing core export present upstream: ${name}`,
      );
    }
  }
});

test("our error classes exist and are Error subclasses", () => {
  const errorNames = [
    "ClaudeSDKError",
    "AbortError",
    "CLINotFoundError",
    "CLIConnectionError",
    "ProcessError",
    "CLIJSONDecodeError",
  ];

  for (const name of errorNames) {
    assert.equal(typeof ours[name], "function", `ours should export ${name}`);
    assert.ok(
      Object.create(ours[name].prototype) instanceof Error,
      `${name} should be an Error subclass`,
    );
  }
});
