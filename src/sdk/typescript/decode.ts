/**
 * Wire-object -> typed message decoding. This is the ONE place the SDK turns
 * raw JSON into the typed {@link SDKMessage} union.
 *
 * Fallback policy (so the SDK never throws on a payload it doesn't recognize):
 *   - An unknown top-level message `type` is mapped to a synthetic
 *     `SDKSystemMessage` with `subtype: "unknown"` and the raw object preserved
 *     under the original fields (via the index signature). This keeps the
 *     async iterator alive instead of crashing the caller.
 *   - An unknown content-block `type` is mapped to a `TextBlock` whose `text`
 *     is the JSON-stringified original, so the data survives in a renderable
 *     form.
 */

import type {
  ContentBlock,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKResultSubtype,
  SDKSystemMessage,
  SDKUserMessage,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "./messages.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function decodeBlock(raw: unknown): ContentBlock {
  if (!isObject(raw)) {
    return { type: "text", text: typeof raw === "string" ? raw : JSON.stringify(raw) };
  }
  switch (raw.type) {
    case "text": {
      const block: TextBlock = { type: "text", text: asString(raw.text) };
      return block;
    }
    case "thinking": {
      const block: ThinkingBlock = {
        type: "thinking",
        thinking: asString(raw.thinking),
        signature: asString(raw.signature),
      };
      return block;
    }
    case "tool_use": {
      const block: ToolUseBlock = {
        type: "tool_use",
        id: asString(raw.id),
        name: asString(raw.name),
        input: isObject(raw.input) ? raw.input : {},
      };
      return block;
    }
    case "tool_result": {
      const content = raw.content;
      let normalized: ToolResultBlock["content"];
      if (typeof content === "string") {
        normalized = content;
      } else if (Array.isArray(content)) {
        normalized = content.filter(isObject);
      } else {
        normalized = null;
      }
      const block: ToolResultBlock = {
        type: "tool_result",
        tool_use_id: asString(raw.tool_use_id),
        content: normalized,
      };
      if (typeof raw.is_error === "boolean") {
        block.is_error = raw.is_error;
      }
      return block;
    }
    default:
      // Unknown block type: preserve the data in a renderable text block.
      return { type: "text", text: JSON.stringify(raw) };
  }
}

function decodeBlocks(raw: unknown): ContentBlock[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map(decodeBlock);
}

function decodeResultSubtype(value: unknown): SDKResultSubtype {
  if (value === "success" || value === "error_max_turns" || value === "error_during_execution") {
    return value;
  }
  return "error_during_execution";
}

/**
 * Decode a single wire message object into the typed {@link SDKMessage} union.
 * Never throws on unknown shapes — see the fallback policy at the top of this
 * file.
 */
export function decodeMessage(raw: unknown): SDKMessage {
  if (!isObject(raw)) {
    return { type: "system", subtype: "unknown", value: raw } as SDKSystemMessage;
  }

  switch (raw.type) {
    case "assistant": {
      const inner = isObject(raw.message) ? raw.message : {};
      const message: SDKAssistantMessage = {
        type: "assistant",
        message: {
          model: asString(inner.model),
          content: decodeBlocks(inner.content),
        },
        parent_tool_use_id:
          typeof raw.parent_tool_use_id === "string" ? raw.parent_tool_use_id : null,
      };
      if (typeof raw.session_id === "string") {
        message.session_id = raw.session_id;
      }
      if (typeof raw.uuid === "string") {
        message.uuid = raw.uuid;
      }
      return message;
    }

    case "user": {
      const inner = isObject(raw.message) ? raw.message : {};
      const content = typeof inner.content === "string" ? inner.content : decodeBlocks(inner.content);
      const message: SDKUserMessage = {
        type: "user",
        message: { content },
        parent_tool_use_id:
          typeof raw.parent_tool_use_id === "string" ? raw.parent_tool_use_id : null,
      };
      if (typeof raw.session_id === "string") {
        message.session_id = raw.session_id;
      }
      if (typeof raw.uuid === "string") {
        message.uuid = raw.uuid;
      }
      return message;
    }

    case "result": {
      const message: SDKResultMessage = {
        type: "result",
        subtype: decodeResultSubtype(raw.subtype),
        duration_ms: asNumber(raw.duration_ms),
        duration_api_ms: asNumber(raw.duration_api_ms),
        is_error: asBoolean(raw.is_error),
        num_turns: asNumber(raw.num_turns),
        session_id: asString(raw.session_id),
      };
      if (typeof raw.total_cost_usd === "number") {
        message.total_cost_usd = raw.total_cost_usd;
      }
      if (isObject(raw.usage)) {
        message.usage = raw.usage;
      }
      if (typeof raw.result === "string") {
        message.result = raw.result;
      }
      return message;
    }

    case "stream_event": {
      const message: SDKPartialAssistantMessage = {
        type: "stream_event",
        event: raw.event,
        session_id: asString(raw.session_id),
        parent_tool_use_id:
          typeof raw.parent_tool_use_id === "string" ? raw.parent_tool_use_id : null,
      };
      return message;
    }

    case "system": {
      // Preserve all extra fields via the index signature.
      const message = { ...raw, type: "system", subtype: asString(raw.subtype) } as SDKSystemMessage;
      return message;
    }

    default: {
      // Unknown top-level type: keep the iterator alive, preserve raw data.
      const message = { ...raw, type: "system", subtype: "unknown" } as SDKSystemMessage;
      return message;
    }
  }
}
