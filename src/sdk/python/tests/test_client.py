"""Tests for the stateful ClaudeSDKClient against the fake server."""

from __future__ import annotations

import pytest

from lite_harness import (
    AssistantMessage,
    ClaudeSDKClient,
    CLIConnectionError,
    ResultMessage,
)
from transport import SubprocessTransport


async def test_client_context_manager(fake_server_command: list[str]) -> None:
    transport = SubprocessTransport(command=fake_server_command)
    async with ClaudeSDKClient(transport=transport) as client:
        await client.query("hi there")
        messages = [m async for m in client.receive_response()]

    assert any(isinstance(m, AssistantMessage) for m in messages)
    assert isinstance(messages[-1], ResultMessage)


async def test_receive_response_stops_at_result(fake_server_command: list[str]) -> None:
    transport = SubprocessTransport(command=fake_server_command)
    async with ClaudeSDKClient(transport=transport) as client:
        await client.query("one")
        count = 0
        last = None
        async for message in client.receive_response():
            count += 1
            last = message
        assert isinstance(last, ResultMessage)
        # init + assistant + result
        assert count == 3


async def test_multiple_prompts_same_session(fake_server_command: list[str]) -> None:
    transport = SubprocessTransport(command=fake_server_command)
    async with ClaudeSDKClient(transport=transport) as client:
        await client.query("first")
        first = [m async for m in client.receive_response()]
        await client.query("second")
        second = [m async for m in client.receive_response()]

    assert isinstance(first[-1], ResultMessage)
    assert first[-1].result == "echo: first"
    assert isinstance(second[-1], ResultMessage)
    assert second[-1].result == "echo: second"


async def test_runtime_controls(fake_server_command: list[str]) -> None:
    transport = SubprocessTransport(command=fake_server_command)
    async with ClaudeSDKClient(transport=transport) as client:
        # These just need to round-trip without error against the fake server.
        await client.set_permission_mode("acceptEdits")
        await client.set_model("claude-y")
        await client.set_model(None)
        await client.interrupt()


async def test_query_before_connect_raises() -> None:
    client = ClaudeSDKClient()
    with pytest.raises(CLIConnectionError):
        await client.query("nope")


async def test_connect_with_eager_prompt(fake_server_command: list[str]) -> None:
    transport = SubprocessTransport(command=fake_server_command)
    client = ClaudeSDKClient(transport=transport)
    await client.connect(prompt="eager")
    try:
        messages = [m async for m in client.receive_response()]
    finally:
        await client.disconnect()
    assert isinstance(messages[-1], ResultMessage)
    assert messages[-1].result == "echo: eager"
