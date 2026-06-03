// PURE: @openai/agents RunStreamEvent → canonical stream-json frame(s).
//
// Captured event shapes (chat-completions via LiteLLM):
//   raw_model_stream_event { data: { type:"output_text_delta", delta:"…" } }
//   run_item_stream_event  { name:"message_output_created",
//                            item:{ rawItem:{ content:[{type:"output_text",text:"…"}] } } }
//   raw_model_stream_event { data:{ type:"response_started"|"model"|"response_done" } } → ignored
//   agent_updated_stream_event → ignored
//
// Text deltas become `stream_event` content_block_delta frames; the completed
// message becomes an `assistant` frame. The runtime/session synthesize the
// terminating `result`. Unknown events are ignored (forward-compatible).
export function eventToFrames(event, { sessionId, model }) {
  if (!event || typeof event !== "object") return [];

  switch (event.type) {
    case "raw_model_stream_event": {
      const data = event.data;
      if (data?.type === "output_text_delta" && typeof data.delta === "string") {
        return [
          {
            type: "stream_event",
            session_id: sessionId,
            event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: data.delta } },
          },
        ];
      }
      return [];
    }

    case "run_item_stream_event": {
      if (event.name !== "message_output_created") return [];
      const raw = event.item?.rawItem;
      const content = Array.isArray(raw?.content)
        ? raw.content
            .filter((b) => b?.type === "output_text" && typeof b.text === "string")
            .map((b) => ({ type: "text", text: b.text }))
        : [];
      if (content.length === 0) return [];
      return [{ type: "assistant", message: { model, content }, parent_tool_use_id: null }];
    }

    default:
      return [];
  }
}
