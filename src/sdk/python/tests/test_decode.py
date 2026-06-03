"""Unit tests for the wire -> typed decoder."""

from __future__ import annotations

from lite_harness import (
    AssistantMessage,
    ResultMessage,
    SystemMessage,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from decode import decode_block, decode_message, is_result


def test_decode_text_block() -> None:
    block = decode_block({"type": "text", "text": "hi"})
    assert block == TextBlock(text="hi")


def test_decode_thinking_block() -> None:
    block = decode_block({"type": "thinking", "thinking": "hmm", "signature": "sig"})
    assert block == ThinkingBlock(thinking="hmm", signature="sig")


def test_decode_tool_use_block() -> None:
    block = decode_block(
        {"type": "tool_use", "id": "toolu_1", "name": "Read", "input": {"path": "/x"}}
    )
    assert block == ToolUseBlock(id="toolu_1", name="Read", input={"path": "/x"})


def test_decode_tool_result_block() -> None:
    block = decode_block(
        {"type": "tool_result", "tool_use_id": "toolu_1", "content": "ok", "is_error": False}
    )
    assert block == ToolResultBlock(tool_use_id="toolu_1", content="ok", is_error=False)


def test_unknown_block_is_skipped() -> None:
    assert decode_block({"type": "totally_new"}) is None


def test_decode_assistant_message() -> None:
    msg = decode_message(
        {
            "type": "assistant",
            "message": {
                "model": "claude-x",
                "content": [
                    {"type": "text", "text": "a"},
                    {"type": "mystery"},
                    {"type": "text", "text": "b"},
                ],
            },
            "parent_tool_use_id": "toolu_9",
        }
    )
    assert isinstance(msg, AssistantMessage)
    assert msg.model == "claude-x"
    assert msg.parent_tool_use_id == "toolu_9"
    # Unknown block dropped, known ones kept in order.
    assert msg.content == [TextBlock(text="a"), TextBlock(text="b")]


def test_decode_user_message_string() -> None:
    msg = decode_message({"type": "user", "message": {"content": "hello"}})
    assert isinstance(msg, UserMessage)
    assert msg.content == "hello"


def test_decode_user_message_blocks() -> None:
    msg = decode_message(
        {"type": "user", "message": {"content": [{"type": "text", "text": "x"}]}}
    )
    assert isinstance(msg, UserMessage)
    assert msg.content == [TextBlock(text="x")]


def test_decode_result_message() -> None:
    msg = decode_message(
        {
            "type": "result",
            "subtype": "success",
            "duration_ms": 5,
            "duration_api_ms": 3,
            "is_error": False,
            "num_turns": 2,
            "session_id": "s1",
            "total_cost_usd": 0.01,
            "usage": {"input_tokens": 10},
            "result": "done",
        }
    )
    assert isinstance(msg, ResultMessage)
    assert is_result(msg)
    assert msg.session_id == "s1"
    assert msg.total_cost_usd == 0.01
    assert msg.result == "done"


def test_decode_system_message() -> None:
    msg = decode_message(
        {"type": "system", "subtype": "init", "session_id": "s1", "model": "claude-x"}
    )
    assert isinstance(msg, SystemMessage)
    assert msg.subtype == "init"
    assert msg.data == {"session_id": "s1", "model": "claude-x"}


def test_unknown_message_falls_back_to_system() -> None:
    msg = decode_message({"type": "stream_event", "session_id": "s1", "event": {"k": 1}})
    assert isinstance(msg, SystemMessage)
    assert msg.subtype == "stream_event"
    assert msg.data == {"session_id": "s1", "event": {"k": 1}}
    assert not is_result(msg)
