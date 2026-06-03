"""The stateful :class:`ClaudeSDKClient`.

Keeps the server process open across prompts until disconnect. Mirrors the
upstream Claude Agent SDK client surface. Speaks the stream-json control
protocol: ``initialize`` once on connect, a ``user`` line per :meth:`query`,
and ``control_request`` lines for the runtime controls.
"""

from __future__ import annotations

from typing import Any, AsyncIterable, AsyncIterator

from decode import decode_message, is_result
from transport import Transport
from transport import SubprocessTransport
from errors import CLIConnectionError
from messages import Message
from options import AgentOptions, PermissionMode


class ClaudeSDKClient:
    """Long-lived client over a single server process.

    Use as an async context manager::

        async with ClaudeSDKClient(options=opts) as client:
            await client.query("hello")
            async for message in client.receive_response():
                ...
    """

    def __init__(
        self,
        options: AgentOptions | None = None,
        transport: Transport | None = None,
    ) -> None:
        self._options = options or AgentOptions()
        self._transport = transport
        self._owns_transport = transport is None
        self._connected = False

    # -- lifecycle ---------------------------------------------------------

    async def connect(
        self, prompt: str | AsyncIterable[dict[str, Any]] | None = None
    ) -> None:
        """Connect to the server and send the ``initialize`` control request.

        If ``prompt`` is a string, it is sent immediately as the first turn.
        (Async-iterable prompts are accepted for signature parity but only the
        eager string form streams a prompt here.)
        """

        if self._transport is None:
            opts = self._options
            cwd = str(opts.cwd) if opts.cwd is not None else None
            self._transport = SubprocessTransport(
                agent=opts.selected_harness,
                model=opts.model,
                permission_mode=opts.permission_mode,
                cwd=cwd,
                env=opts.env or None,
                stderr=opts.stderr,
            )

        await self._transport.connect()
        await self._transport.send_control(
            "initialize", hooks={}, sdk_mcp_servers=[]
        )
        self._connected = True

        if isinstance(prompt, str):
            await self.query(prompt)

    async def disconnect(self) -> None:
        """Close stdin and tear down the transport."""

        if self._transport is None:
            return
        try:
            if self._owns_transport:
                await self._transport.close()
        finally:
            self._connected = False

    async def __aenter__(self) -> "ClaudeSDKClient":
        await self.connect()
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.disconnect()

    # -- runtime controls --------------------------------------------------

    def _require_transport(self) -> Transport:
        if not self._connected or self._transport is None:
            raise CLIConnectionError("Client is not connected")
        return self._transport

    async def query(self, prompt: str, session_id: str = "default") -> None:
        """Send a prompt by writing a ``user`` line. Streams back via
        :meth:`receive_messages`.

        ``session_id`` matches the upstream signature; the live server process
        is the one opened at :meth:`connect`.
        """

        transport = self._require_transport()
        await transport.send_user_message(prompt)

    async def interrupt(self) -> None:
        """Cancel the in-flight turn."""

        transport = self._require_transport()
        await transport.send_control("interrupt")

    async def set_permission_mode(self, mode: PermissionMode) -> None:
        """Change the permission mode for subsequent turns."""

        transport = self._require_transport()
        await transport.send_control("set_permission_mode", permission_mode=mode)

    async def set_model(self, model: str | None = None) -> None:
        """Change the model for subsequent turns."""

        transport = self._require_transport()
        await transport.send_control("set_model", model=model)

    # -- receiving ---------------------------------------------------------

    async def receive_messages(self) -> AsyncIterator[Message]:
        """Yield decoded messages continuously as they arrive."""

        transport = self._require_transport()
        async for raw in transport.messages():
            yield decode_message(raw)

    async def receive_response(self) -> AsyncIterator[Message]:
        """Yield messages until and including a ``ResultMessage``, then stop."""

        async for message in self.receive_messages():
            yield message
            if is_result(message):
                return
