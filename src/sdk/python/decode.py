"""Wire dict -> typed Message/block decoding.

This is the ONE place wire JSON becomes typed objects. Everything else in the
package consumes already-typed values.

Unknown handling (documented choice):

* Unknown *block* types are skipped (dropped from the content list) rather than
  raising, so a newer server adding a block type does not crash older clients.
* Unknown *message* types are surfaced as a :class:`SystemMessage` with the
  original ``type`` as ``subtype`` and the full payload as ``data``. This keeps
  the run alive and the data inspectable instead of crashing or silently
  vanishing. ``stream_event`` partial deltas use this same fallback.
"""

from __future__ import annotations

from typing import Any

from blocks import (
    ContentBlock,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
)
from messages import (
    AssistantMessage,
    Message,
    ResultMessage,
    SystemMessage,
    UserMessage,
)


def decode_block(raw: dict[str, Any]) -> ContentBlock | None:
    """Decode a single content block. Returns ``None`` for unknown types."""

    block_type = raw.get("type")
    if block_type == "text":
        return TextBlock(text=raw.get("text", ""))
    if block_type == "thinking":
        return ThinkingBlock(
            thinking=raw.get("thinking", ""),
            signature=raw.get("signature", ""),
        )
    if block_type == "tool_use":
        return ToolUseBlock(
            id=raw.get("id", ""),
            name=raw.get("name", ""),
            input=raw.get("input", {}) or {},
        )
    if block_type == "tool_result":
        return ToolResultBlock(
            tool_use_id=raw.get("tool_use_id", ""),
            content=raw.get("content"),
            is_error=raw.get("is_error"),
        )
    return None


def _decode_blocks(raw_content: Any) -> list[ContentBlock]:
    if not isinstance(raw_content, list):
        return []
    blocks: list[ContentBlock] = []
    for item in raw_content:
        if isinstance(item, dict):
            block = decode_block(item)
            if block is not None:
                blocks.append(block)
    return blocks


def decode_message(raw: dict[str, Any]) -> Message:
    """Decode a wire ``message`` dict into a typed :data:`Message`.

    Unknown message types fall back to a :class:`SystemMessage`.
    """

    msg_type = raw.get("type")

    if msg_type == "assistant":
        inner = raw.get("message", {}) or {}
        return AssistantMessage(
            content=_decode_blocks(inner.get("content")),
            model=inner.get("model", ""),
            parent_tool_use_id=raw.get("parent_tool_use_id"),
        )

    if msg_type == "user":
        inner = raw.get("message", {}) or {}
        content = inner.get("content")
        decoded: str | list[ContentBlock]
        if isinstance(content, str):
            decoded = content
        else:
            decoded = _decode_blocks(content)
        return UserMessage(
            content=decoded,
            parent_tool_use_id=raw.get("parent_tool_use_id"),
        )

    if msg_type == "result":
        return ResultMessage(
            subtype=raw.get("subtype", ""),
            duration_ms=raw.get("duration_ms", 0),
            duration_api_ms=raw.get("duration_api_ms", 0),
            is_error=raw.get("is_error", False),
            num_turns=raw.get("num_turns", 0),
            session_id=raw.get("session_id", ""),
            total_cost_usd=raw.get("total_cost_usd"),
            usage=raw.get("usage"),
            result=raw.get("result"),
        )

    if msg_type == "system":
        subtype = raw.get("subtype", "")
        data = {k: v for k, v in raw.items() if k not in ("type", "subtype")}
        return SystemMessage(subtype=subtype, data=data)

    # Unknown type (including stream_event): keep the payload, do not crash.
    subtype = str(msg_type) if msg_type is not None else "unknown"
    data = {k: v for k, v in raw.items() if k != "type"}
    return SystemMessage(subtype=subtype, data=data)


def is_result(message: Message) -> bool:
    """True if the message terminates a run."""

    return isinstance(message, ResultMessage)
