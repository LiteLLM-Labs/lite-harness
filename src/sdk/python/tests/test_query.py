"""End-to-end tests for query() against the fake server."""

from __future__ import annotations

from lite_harness import (
    AgentOptions,
    AssistantMessage,
    ResultMessage,
    SystemMessage,
    TextBlock,
    query,
)
from transport import SubprocessTransport


async def test_query_full_lifecycle(fake_server_command: list[str]) -> None:
    transport = SubprocessTransport(command=fake_server_command)
    messages = [
        m
        async for m in query(prompt="hello world", transport=transport)
    ]

    # system init, assistant echo, result.
    assert isinstance(messages[0], SystemMessage)
    assert messages[0].subtype == "init"

    assert isinstance(messages[1], AssistantMessage)
    assert messages[1].content == [TextBlock(text="echo: hello world")]

    assert isinstance(messages[-1], ResultMessage)
    assert messages[-1].result == "echo: hello world"


async def test_query_ends_on_result(fake_server_command: list[str]) -> None:
    transport = SubprocessTransport(command=fake_server_command)
    seen_result = False
    async for message in query(prompt="x", transport=transport):
        if isinstance(message, ResultMessage):
            seen_result = True
    assert seen_result


async def test_query_resolves_via_env(fake_server_env: None) -> None:
    # No explicit transport: command comes from LITE_HARNESS_SERVER.
    messages = [m async for m in query(prompt="env-prompt")]
    assert isinstance(messages[-1], ResultMessage)
    assert messages[-1].result == "echo: env-prompt"


async def test_query_with_options(fake_server_command: list[str]) -> None:
    transport = SubprocessTransport(command=fake_server_command)
    opts = AgentOptions(model="claude-x", allowed_tools=["Read"])
    messages = [m async for m in query(prompt="hi", options=opts, transport=transport)]
    assert isinstance(messages[-1], ResultMessage)


def test_options_to_wire_drops_transport_only_fields() -> None:
    opts = AgentOptions(
        model="m",
        stderr=lambda s: None,
        harness="openai",
        agent="codex",
        cwd="/tmp",
    )
    wire = opts.to_wire()
    assert "stderr" not in wire
    assert "harness" not in wire
    assert "agent" not in wire
    assert opts.selected_harness == "openai"
    assert wire["model"] == "m"
    assert wire["cwd"] == "/tmp"
