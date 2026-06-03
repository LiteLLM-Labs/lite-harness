"""The one-shot :func:`query` entrypoint.

Runs the full stream-json lifecycle for a single prompt and tears the process
down: spawn → ``control_request: initialize`` → write one ``user`` line →
iterate the incoming messages (yielding each decoded message, stopping after the
terminating ``result``) → close stdin so the server exits → close the transport.
Teardown always runs, even on exception or early generator close.
"""

from __future__ import annotations

from typing import Any, AsyncIterable, AsyncIterator

from decode import decode_message, is_result
from transport import Transport
from transport import SubprocessTransport
from messages import Message
from options import AgentOptions


async def query(
    *,
    prompt: str | AsyncIterable[dict[str, Any]],
    options: AgentOptions | None = None,
    transport: Transport | None = None,
) -> AsyncIterator[Message]:
    """Run a single prompt to completion, yielding each decoded message.

    The async iterator ends after the terminating ``ResultMessage``.
    """

    opts = options or AgentOptions()
    prompt_text = prompt if isinstance(prompt, str) else await _join_prompt(prompt)

    owns_transport = transport is None
    if transport is None:
        cwd = str(opts.cwd) if opts.cwd is not None else None
        transport = SubprocessTransport(
            agent=opts.selected_harness,
            model=opts.model,
            permission_mode=opts.permission_mode,
            cwd=cwd,
            env=opts.env or None,
            stderr=opts.stderr,
        )

    try:
        await transport.connect()
        await transport.send_control("initialize", hooks={}, sdk_mcp_servers=[])
        await transport.send_user_message(prompt_text)

        async for raw in transport.messages():
            message = decode_message(raw)
            yield message
            if is_result(message):
                break
    finally:
        if owns_transport:
            await transport.close()


async def _join_prompt(prompt: AsyncIterable[dict[str, Any]]) -> str:
    """Collapse a streamed-message prompt into text.

    Pulls ``content`` text out of each ``{"type": "user", ...}``-style dict.
    Best-effort: this SDK sends a single prompt string to the server.
    """

    parts: list[str] = []
    async for item in prompt:
        content = item.get("content") if isinstance(item, dict) else None
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and isinstance(block.get("text"), str):
                    parts.append(block["text"])
    return "".join(parts)
