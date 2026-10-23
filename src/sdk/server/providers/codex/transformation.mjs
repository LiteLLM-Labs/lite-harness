// Stateful transformer: @openai/codex-sdk ThreadEvent → canonical stream-json frame(s).
//
// The Codex SDK emits full accumulated text on each agent_message update rather
// than deltas, so we track the last-seen character offset per item id to compute
// the delta ourselves.
//
// Handled events:
//   item.started / item.updated  { item: { type:"agent_message", id, text } }
//     → stream_event content_block_delta frame for each new character slice
//   item.completed               { item: { type:"agent_message", id, text } }
//     → assistant frame with the complete text content block
//   item.completed               { item: { type:"reasoning", text } }
//     → assistant frame with a thinking block
//   item.started / item.completed { item: { type:"command_execution" | "mcp_tool_call" } }
//     → assistant tool_use frame on start, user tool_result frame on completion
//   item.completed               { item: { type:"file_change", changes } }
//     → assistant tool_use frame + user tool_result frame
//   turn.completed / turn.failed
//     → result frame (usage mapped to Claude field names)
//
// All other events are ignored (forward-compatible).
import { resultFrame } from "../../protocol.mjs";

function toolUse(model, id, name, input) {
  return { type: "assistant", message: { model, content: [{ type: "tool_use", id, name, input }] }, parent_tool_use_id: null };
}

function toolResult(id, content, isError) {
  return { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } };
}

function toolCall(item) {
  switch (item.type) {
    case "command_execution":
      return { name: "Bash", input: { command: item.command } };
    case "mcp_tool_call":
      return { name: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {} };
    default:
      return null;
  }
}

function toolOutcome(item) {
  if (item.type === "command_execution") {
    const failed = item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0);
    return { content: item.aggregated_output ?? "", isError: failed };
  }
  if (item.error) return { content: item.error.message, isError: true };
  const blocks = item.result?.content ?? [];
  const text = blocks.map((b) => (b && b.type === "text" ? b.text : "")).join("");
  return { content: text, isError: item.status === "failed" };
}

function mapUsage(usage) {
  if (!usage) return {};
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_read_input_tokens: usage.cached_input_tokens ?? 0,
  };
}

export function createEventTransformer({ startedAt = Date.now() } = {}) {
  const textPositions = new Map(); // item.id → character offset of last emitted delta
  const startedTools = new Set(); // tool item ids whose tool_use frame was already emitted
  let lastText = "";
  let lastError = null;

  return function eventToFrames(event, { sessionId, model }) {
    if (!event || typeof event !== "object") return [];

    switch (event.type) {
      case "item.started":
      case "item.updated": {
        const item = event.item;
        const call = item ? toolCall(item) : null;
        if (call) {
          if (startedTools.has(item.id)) return [];
          startedTools.add(item.id);
          return [toolUse(model, item.id, call.name, call.input)];
        }
        if (item?.type !== "agent_message" || typeof item.text !== "string") return [];
        const prev = textPositions.get(item.id) ?? 0;
        const delta = item.text.slice(prev);
        if (!delta) return [];
        textPositions.set(item.id, item.text.length);
        return [
          {
            type: "stream_event",
            session_id: sessionId,
            event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } },
          },
        ];
      }

      case "item.completed": {
        const item = event.item;
        if (!item) return [];
        const call = toolCall(item);
        if (call) {
          const frames = startedTools.has(item.id) ? [] : [toolUse(model, item.id, call.name, call.input)];
          startedTools.delete(item.id);
          const { content, isError } = toolOutcome(item);
          frames.push(toolResult(item.id, content, isError));
          return frames;
        }
        if (item.type === "file_change") {
          const changes = Array.isArray(item.changes) ? item.changes : [];
          const summary = changes.map((c) => `${c.kind} ${c.path}`).join("\n");
          return [
            toolUse(model, item.id, "ApplyPatch", { changes }),
            toolResult(item.id, summary, item.status === "failed"),
          ];
        }
        if (item.type === "reasoning" && typeof item.text === "string" && item.text) {
          return [{ type: "assistant", message: { model, content: [{ type: "thinking", thinking: item.text }] }, parent_tool_use_id: null }];
        }
        if (item.type !== "agent_message" || typeof item.text !== "string") return [];
        lastText = item.text;
        return [{ type: "assistant", message: { model, content: [{ type: "text", text: item.text }] }, parent_tool_use_id: null }];
      }

      case "turn.completed":
        return [resultFrame({ sessionId, startedAt, text: lastText, usage: mapUsage(event.usage) })];

      case "turn.failed":
        return [resultFrame({ sessionId, startedAt, text: event.error?.message ?? lastError ?? "turn failed", isError: true })];

      // Codex also reports transient conditions ("Reconnecting... 2/5") as
      // `error`, so it never ends the turn; turn.failed carries the fatal case.
      case "error":
        lastError = event.message ?? lastError;
        return [];

      default:
        return [];
    }
  };
}
