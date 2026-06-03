/**
 * The streamed message + content-block types. These mirror the Claude CLI
 * `stream-json` shape (see PROTOCOL.md "Message") so decoding stays faithful to
 * the Claude Agent SDK.
 *
 * All members are exported individually; the unions (`SDKMessage`,
 * `ContentBlock`) are discriminated on their `type` field.
 */

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<Record<string, unknown>> | null;
  is_error?: boolean;
}

/** Discriminated union of all content blocks, keyed on `type`. */
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface SDKAssistantMessage {
  type: "assistant";
  message: {
    model: string;
    content: ContentBlock[];
  };
  parent_tool_use_id: string | null;
  /** Session id upstream attaches to the message (optional; decode is lenient). */
  session_id?: string;
  /** Per-message uuid upstream attaches (optional; decode is lenient). */
  uuid?: string;
}

export interface SDKUserMessage {
  type: "user";
  message: {
    content: string | ContentBlock[];
  };
  parent_tool_use_id?: string | null;
  /** Session id upstream attaches to the message (optional; decode is lenient). */
  session_id?: string;
  /** Per-message uuid upstream attaches (optional; decode is lenient). */
  uuid?: string;
}

export interface SDKSystemMessage {
  type: "system";
  subtype: string;
  session_id?: string;
  /** The system message carries arbitrary extra fields per PROTOCOL.md. */
  [key: string]: unknown;
}

export type SDKResultSubtype = "success" | "error_max_turns" | "error_during_execution";

export interface SDKResultMessage {
  type: "result";
  subtype: SDKResultSubtype;
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  session_id: string;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
  result?: string;
}

export interface SDKPartialAssistantMessage {
  type: "stream_event";
  event: unknown;
  session_id: string;
  parent_tool_use_id?: string | null;
}

/** Discriminated union of all streamed messages, keyed on `type`. */
export type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKSystemMessage
  | SDKResultMessage
  | SDKPartialAssistantMessage;
