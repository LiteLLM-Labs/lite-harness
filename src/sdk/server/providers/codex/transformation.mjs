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
//
// All other events are ignored (forward-compatible).
export function createEventTransformer() {
  const textPositions = new Map(); // item.id → character offset of last emitted delta

  return function eventToFrames(event, { sessionId, model }) {
    if (!event || typeof event !== "object") return [];

    switch (event.type) {
      case "item.started":
      case "item.updated": {
        const item = event.item;
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
        if (item?.type !== "agent_message" || typeof item.text !== "string") return [];
        return [{ type: "assistant", message: { model, content: [{ type: "text", text: item.text }] }, parent_tool_use_id: null }];
      }

      default:
        return [];
    }
  };
}
