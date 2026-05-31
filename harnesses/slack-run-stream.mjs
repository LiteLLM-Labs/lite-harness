const DEFAULT_MIN_UPDATE_MS = 1500;
const DEFAULT_MAX_SLACK_TEXT = 39000;

function slackText(text) {
  const value = typeof text === "string" ? text.trim() : "";
  return value || "Working...";
}

function eventSessionId(event) {
  return event?.properties?.sessionID || event?.properties?.part?.sessionID || null;
}

export function createAssistantTextAccumulator(sessionId) {
  const assistantMessageIds = new Set();
  const partToMessage = new Map();
  const partTexts = new Map();
  let latestMessageId = null;

  return {
    ingestLine(line) {
      if (!line?.startsWith?.("data: ")) return "";
      let event;
      try {
        event = JSON.parse(line.slice(6));
      } catch {
        return "";
      }

      const sid = eventSessionId(event);
      if (sid && sid !== sessionId) return "";

      if (event.type === "message.updated" && event.properties?.info?.role === "assistant") {
        const messageId = event.properties.info.id;
        if (messageId) {
          assistantMessageIds.add(messageId);
          latestMessageId = messageId;
        }
      }

      if (event.type === "message.part.updated" && event.properties?.part?.type === "text") {
        const part = event.properties.part;
        if (!part.messageID || !assistantMessageIds.has(part.messageID)) return "";
        partToMessage.set(part.id, part.messageID);
        if (typeof part.text === "string") partTexts.set(part.id, part.text);
        latestMessageId = part.messageID;
      }

      if (event.type === "message.part.delta" && event.properties?.field === "text") {
        const { partID, delta } = event.properties;
        if (!partID || typeof delta !== "string") return "";
        const messageId = partToMessage.get(partID);
        if (!messageId || !assistantMessageIds.has(messageId)) return "";
        partTexts.set(partID, `${partTexts.get(partID) || ""}${delta}`);
        latestMessageId = messageId;
      }

      if (!latestMessageId) return "";
      return [...partTexts.entries()]
        .filter(([partId]) => partToMessage.get(partId) === latestMessageId)
        .map(([, text]) => text)
        .join("\n")
        .trim();
    },
  };
}

export function createSlackRunStreamer({
  slackApi,
  botToken,
  channel,
  threadTs,
  minUpdateMs = DEFAULT_MIN_UPDATE_MS,
  maxSlackText = DEFAULT_MAX_SLACK_TEXT,
}) {
  let messageTs = null;
  let startPromise = null;
  let updateQueue = Promise.resolve();
  let lastText = "";
  let lastUpdateAt = 0;

  async function start(initialText = "Working...") {
    if (messageTs) return messageTs;
    if (!startPromise) {
      startPromise = slackApi("chat.postMessage", botToken, {
        channel,
        text: slackText(initialText).slice(0, maxSlackText),
        thread_ts: threadTs,
        unfurl_links: false,
        unfurl_media: false,
      }).then((body) => {
        messageTs = body?.ts || body?.message?.ts || null;
        lastText = slackText(initialText);
        lastUpdateAt = Date.now();
        return messageTs;
      });
    }
    await startPromise;
    return messageTs;
  }

  async function applyUpdate(text, { force = false } = {}) {
    const nextText = slackText(text).slice(0, maxSlackText);
    if (nextText === lastText) return;
    if (!messageTs) await start();
    if (!messageTs) return;
    const now = Date.now();
    if (!force && minUpdateMs > 0 && now - lastUpdateAt < minUpdateMs) return;
    await slackApi("chat.update", botToken, {
      channel,
      ts: messageTs,
      text: nextText,
      unfurl_links: false,
      unfurl_media: false,
    });
    lastText = nextText;
    lastUpdateAt = now;
  }

  function update(text, options) {
    updateQueue = updateQueue.then(() => applyUpdate(text, options));
    return updateQueue;
  }

  return {
    start,
    update,
    async finish(text) {
      await updateQueue;
      await update(text, { force: true });
    },
  };
}
