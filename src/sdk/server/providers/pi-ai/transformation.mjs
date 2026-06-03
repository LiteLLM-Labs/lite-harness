// PURE: @earendil-works/pi-agent-core AgentEvent → canonical stream-json frame(s).
//
// Pi AI AgentEvent union:
//   agent_start | agent_end | turn_start | turn_end         → dropped
//   message_start                                            → dropped
//   message_update { message, assistantMessageEvent }        → stream_event (text delta)
//   message_end    { message }                               → assistant frame
//   tool_execution_start { toolCallId, toolName, args }      → assistant frame (tool_use)
//   tool_execution_update                                    → dropped
//   tool_execution_end   { toolCallId, toolName, result, isError } → user frame (tool_result)
//
// Unknown event types and unknown block types must NOT crash — forward-compatible.
export function eventToFrames(event, { sessionId, model }) {
  if (!event || typeof event !== "object") return [];

  switch (event.type) {
    case "message_update": {
      const evt = event.assistantMessageEvent;
      if (!evt || typeof evt !== "object") return [];
      const delta = typeof evt.delta === "string" ? evt.delta : null;
      if (delta === null) return [];
      return [
        {
          type: "stream_event",
          session_id: sessionId,
          event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } },
        },
      ];
    }

    case "message_end": {
      const msg = event.message;
      if (!msg || msg.role !== "assistant") return [];
      const content = Array.isArray(msg.content)
        ? msg.content
            .filter((b) => b?.type === "text" && typeof b.text === "string")
            .map((b) => ({ type: "text", text: b.text }))
        : typeof msg.content === "string" && msg.content.length > 0
        ? [{ type: "text", text: msg.content }]
        : [];
      if (content.length === 0) return [];
      return [{ type: "assistant", message: { model, content }, parent_tool_use_id: null }];
    }

    case "tool_execution_start": {
      return [
        {
          type: "assistant",
          message: {
            model,
            content: [
              {
                type: "tool_use",
                id: event.toolCallId ?? "",
                name: event.toolName ?? "",
                input: event.args ?? {},
              },
            ],
          },
          parent_tool_use_id: null,
        },
      ];
    }

    case "tool_execution_end": {
      const resultStr =
        typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? null);
      return [
        {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: event.toolCallId ?? "",
                content: resultStr,
                is_error: Boolean(event.isError),
              },
            ],
          },
        },
      ];
    }

    default:
      return [];
  }
}
