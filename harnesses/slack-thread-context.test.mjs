import assert from "node:assert/strict";
import test from "node:test";
import { fetchSlackThreadContext, formatSlackThreadContext } from "./slack-thread-context.mjs";

test("formatSlackThreadContext preserves ordered thread history and marks current message", () => {
  const transcript = formatSlackThreadContext([
    { ts: "3.0", user: "U3", text: "what customer are we chatting about rn?" },
    { ts: "1.0", user: "U1", text: "hi how much to charge Evernorth" },
    { ts: "2.0", bot_id: "B1", username: "Shin Pricing Calculator", text: "I need volume and app count." },
  ], "3.0");

  assert.equal(transcript, [
    "- U1: hi how much to charge Evernorth",
    "- Shin Pricing Calculator: I need volume and app count.",
    "- U3 (current message): what customer are we chatting about rn?",
  ].join("\n"));
});

test("fetchSlackThreadContext calls Slack replies with root thread timestamp", async () => {
  const calls = [];
  const transcript = await fetchSlackThreadContext({
    botToken: "xoxb-test",
    channel: "C123",
    threadTs: "1.0",
    currentTs: "2.0",
    slackApi: async (method, token, payload) => {
      calls.push({ method, token, payload });
      return { messages: [
        { ts: "1.0", user: "U1", text: "Evernorth details" },
        { ts: "2.0", user: "U2", text: "what customer?" },
      ] };
    },
  });

  assert.deepEqual(calls, [{
    method: "conversations.replies",
    token: "xoxb-test",
    payload: { channel: "C123", ts: "1.0", limit: 20, inclusive: true },
  }]);
  assert.match(transcript, /Evernorth details/);
  assert.match(transcript, /U2 \(current message\): what customer\?/);
});
