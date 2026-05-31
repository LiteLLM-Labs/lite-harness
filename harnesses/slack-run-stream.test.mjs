import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssistantTextAccumulator,
  createSlackRunStreamer,
  markdownToSlackMrkdwn,
} from "./slack-run-stream.mjs";

function line(event) {
  return `data: ${JSON.stringify(event)}`;
}

test("assistant accumulator streams text deltas for the target session only", () => {
  const acc = createAssistantTextAccumulator("ses_target");

  assert.equal(acc.ingestLine(line({
    type: "message.updated",
    properties: { sessionID: "ses_other", info: { id: "m0", role: "assistant" } },
  })), "");

  acc.ingestLine(line({
    type: "message.updated",
    properties: { sessionID: "ses_target", info: { id: "m1", role: "assistant" } },
  }));
  assert.equal(acc.ingestLine(line({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_target",
      part: { id: "p1", messageID: "m1", type: "text", text: "Hel" },
    },
  })), "Hel");
  assert.equal(acc.ingestLine(line({
    type: "message.part.delta",
    properties: { messageID: "m1", partID: "p1", field: "text", delta: "lo" },
  })), "Hello");
});

test("slack run streamer posts once and updates the same thread reply", async () => {
  const calls = [];
  const streamer = createSlackRunStreamer({
    botToken: "xoxb-test",
    channel: "C123",
    threadTs: "1.0",
    minUpdateMs: 0,
    slackApi: async (method, token, payload) => {
      calls.push({ method, token, payload });
      return method === "chat.postMessage" ? { ts: "2.0" } : { ok: true };
    },
  });

  await streamer.start("Working...");
  await streamer.update("Partial");
  await streamer.finish("Final");

  assert.deepEqual(calls.map((c) => c.method), ["chat.postMessage", "chat.update", "chat.update"]);
  assert.equal(calls[0].payload.thread_ts, "1.0");
  assert.equal(calls[1].payload.ts, "2.0");
  assert.equal(calls[2].payload.text, "Final");
});

test("markdownToSlackMrkdwn converts common agent markdown for Slack", () => {
  const input = `Here's the generated quote:

---

**SurveyMonkey - LiteLLM Enterprise Quote**

**Plan:** LiteLLM Enterprise: Scale
**Annual subscription:** $150,000/year, billed annually

## Internal note

- **3 deployments** is the binding constraint`;

  assert.equal(markdownToSlackMrkdwn(input), `Here's the generated quote:

*SurveyMonkey - LiteLLM Enterprise Quote*

*Plan:* LiteLLM Enterprise: Scale
*Annual subscription:* $150,000/year, billed annually

*Internal note*

- *3 deployments* is the binding constraint`);
});
