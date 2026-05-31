/**
 * Unit tests for HarnessSDK.
 * Run with: node --test harnesses/harness-sdk.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HarnessSDK } from "./harness-sdk.mjs";

function makeSDK(overrides = {}) {
  const ccSessions = new Map([
    ["ses_cc1", { history: [
      { info: { id: "m1", role: "user" },      parts: [{ type: "text", text: "hello" }] },
      { info: { id: "m2", role: "assistant" },  parts: [{ type: "text", text: "world from cc" }] },
    ]}],
  ]);
  const copilotSessions = new Map([
    ["ses_cop1", { history: [
      { info: { id: "m3", role: "assistant" },  parts: [{ type: "text", text: "world from copilot" }] },
    ]}],
  ]);
  const codexSessions = new Map([
    ["ses_cdx1", { history: [
      { info: { id: "m4", role: "assistant" },  parts: [{ type: "text", text: "world from codex" }] },
    ]}],
  ]);
  const sessionHarness = new Map([
    ["ses_cc1",  "cc"],
    ["ses_cop1", "github-copilot"],
    ["ses_cdx1", "codex"],
    ["ses_oc1",  "opencode"],
  ]);
  return new HarnessSDK({
    sessionHarness,
    ccSessions,
    copilotSessions,
    codexSessions,
    getOcMessages: async (sid) => [
      { info: { id: "m5", role: "assistant" }, parts: [{ type: "text", text: `world from opencode (${sid})` }] },
    ],
    ...overrides,
  });
}

describe("HarnessSDK.getMessages", () => {
  it("returns cc history without calling getOcMessages", async () => {
    let ocCalled = false;
    const sdk = makeSDK({ getOcMessages: async () => { ocCalled = true; return []; } });
    const msgs = await sdk.getMessages("ses_cc1");
    assert.equal(msgs.length, 2);
    assert.equal(ocCalled, false, "should not call getOcMessages for cc harness");
  });

  it("returns github-copilot history", async () => {
    const sdk = makeSDK();
    const msgs = await sdk.getMessages("ses_cop1");
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].parts[0].text, "world from copilot");
  });

  it("returns codex history", async () => {
    const sdk = makeSDK();
    const msgs = await sdk.getMessages("ses_cdx1");
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].parts[0].text, "world from codex");
  });

  it("delegates opencode sessions to getOcMessages", async () => {
    let capturedSid;
    const sdk = makeSDK({ getOcMessages: async (sid) => { capturedSid = sid; return []; } });
    await sdk.getMessages("ses_oc1");
    assert.equal(capturedSid, "ses_oc1");
  });

  it("falls back to opencode for unknown session IDs", async () => {
    let ocCalled = false;
    const sdk = makeSDK({ getOcMessages: async () => { ocCalled = true; return []; } });
    await sdk.getMessages("ses_unknown_xyz");
    assert.equal(ocCalled, true, "unknown sessions should delegate to opencode path");
  });
});

describe("HarnessSDK.latestAssistantText", () => {
  it("returns text from the last assistant message", () => {
    const sdk = makeSDK();
    const msgs = [
      { info: { role: "user" },      parts: [{ type: "text", text: "hi" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "first reply" }] },
      { info: { role: "user" },      parts: [{ type: "text", text: "follow-up" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "second reply" }] },
    ];
    assert.equal(sdk.latestAssistantText(msgs), "second reply");
  });

  it("skips assistant messages with no text parts", () => {
    const sdk = makeSDK();
    const msgs = [
      { info: { role: "assistant" }, parts: [{ type: "tool", text: "" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "actual reply" }] },
    ];
    assert.equal(sdk.latestAssistantText(msgs), "actual reply");
  });

  it("returns empty string for empty history", () => {
    const sdk = makeSDK();
    assert.equal(sdk.latestAssistantText([]), "");
  });

  it("returns empty string when no assistant messages exist", () => {
    const sdk = makeSDK();
    const msgs = [{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] }];
    assert.equal(sdk.latestAssistantText(msgs), "");
  });

  it("handles null/undefined gracefully", () => {
    const sdk = makeSDK();
    assert.equal(sdk.latestAssistantText(null), "");
    assert.equal(sdk.latestAssistantText(undefined), "");
  });
});

describe("HarnessSDK.harnessFor", () => {
  it("returns registered harness type", () => {
    const sdk = makeSDK();
    assert.equal(sdk.harnessFor("ses_cc1"), "cc");
    assert.equal(sdk.harnessFor("ses_cop1"), "github-copilot");
    assert.equal(sdk.harnessFor("ses_cdx1"), "codex");
    assert.equal(sdk.harnessFor("ses_oc1"), "opencode");
  });

  it("defaults to opencode for unknown sessions", () => {
    const sdk = makeSDK();
    assert.equal(sdk.harnessFor("ses_nobody"), "opencode");
  });
});
