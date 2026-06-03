// PURE: @anthropic-ai/claude-agent-sdk message → canonical stream-json frame(s).
//
// The Claude Agent SDK already emits the canonical wire (it IS the claude CLI's
// stream-json), so this is mostly a forward + normalize:
//   - `system`      → dropped (the session emits its own init line)
//   - `assistant`   → forwarded (content blocks pass through unchanged)
//   - `user`        → forwarded (tool-result echoes threaded back)
//   - `stream_event`→ forwarded (partial deltas)
//   - `result`      → forwarded with canonical fields
//   - anything else → dropped (forward-compatible)
//
// `session_id` is rewritten to OUR session id so every frame in a turn agrees.
export function toFrames(msg, { sessionId }) {
  if (!msg || typeof msg !== "object") return [];

  switch (msg.type) {
    case "system":
      return [];

    case "assistant":
      return [
        {
          type: "assistant",
          message: { model: msg.message?.model, content: msg.message?.content ?? [] },
          parent_tool_use_id: msg.parent_tool_use_id ?? null,
        },
      ];

    case "user":
      return [{ type: "user", message: msg.message }];

    case "stream_event":
      return [{ type: "stream_event", session_id: sessionId, event: msg.event }];

    case "result":
      return [
        {
          type: "result",
          subtype: msg.subtype ?? (msg.is_error ? "error_during_execution" : "success"),
          session_id: sessionId,
          duration_ms: msg.duration_ms ?? 0,
          duration_api_ms: msg.duration_api_ms ?? 0,
          is_error: Boolean(msg.is_error),
          num_turns: msg.num_turns ?? 1,
          total_cost_usd: msg.total_cost_usd ?? 0,
          usage: msg.usage ?? {},
          result: msg.result ?? "",
        },
      ];

    default:
      return [];
  }
}
