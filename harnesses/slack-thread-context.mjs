const MAX_SLACK_THREAD_MESSAGES = 20;
const MAX_SLACK_THREAD_CHARS = 12000;
const MAX_SLACK_MESSAGE_CHARS = 1200;

function asString(value) {
  return typeof value === "string" ? value : "";
}

function slackAuthor(message) {
  if (message.bot_id) return message.username || message.bot_profile?.name || `bot:${message.bot_id}`;
  return message.user || "unknown";
}

function cleanSlackText(text) {
  return asString(text).replace(/\s+/g, " ").trim();
}

function trimMessage(text) {
  if (text.length <= MAX_SLACK_MESSAGE_CHARS) return text;
  return `${text.slice(0, MAX_SLACK_MESSAGE_CHARS - 1).trimEnd()}...`;
}

export function formatSlackThreadContext(messages, currentTs) {
  if (!Array.isArray(messages) || messages.length === 0) return "";

  const sorted = messages
    .filter((message) => message && typeof message === "object")
    .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
    .slice(-MAX_SLACK_THREAD_MESSAGES);

  const lines = [];
  for (const message of sorted) {
    const text = trimMessage(cleanSlackText(message.text));
    if (!text) continue;
    const marker = message.ts === currentTs ? " (current message)" : "";
    lines.push(`- ${slackAuthor(message)}${marker}: ${text}`);
  }

  const transcript = lines.join("\n");
  if (transcript.length <= MAX_SLACK_THREAD_CHARS) return transcript;
  return transcript.slice(transcript.length - MAX_SLACK_THREAD_CHARS).replace(/^[^\n]*\n?/, "");
}

export async function fetchSlackThreadContext({ slackApi, botToken, channel, threadTs, currentTs }) {
  if (!slackApi || !botToken || !channel || !threadTs) return "";
  const body = await slackApi("conversations.replies", botToken, {
    channel,
    ts: threadTs,
    limit: MAX_SLACK_THREAD_MESSAGES,
    inclusive: true,
  });
  return formatSlackThreadContext(body.messages || [], currentTs);
}
