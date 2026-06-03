"""Transport contract.

A :class:`Transport` owns the connection to the lite-harness server: process
spawn (or, for a fake, in-memory wiring), the single multiplexed NDJSON stream
described in ``PROTOCOL.md``, control-request/response correlation by
``request_id``, and delivery of the decoded non-control messages.

The wire language is the Claude Agent SDK stream-json control protocol:

* outgoing ``control_request`` lines (correlated by ``request_id``) for
  ``initialize`` / ``interrupt`` / ``set_permission_mode`` / ``set_model``,
* outgoing ``user`` lines to start a turn (no reply expected), and
* incoming lines demultiplexed on top-level ``type``: ``control_response`` lines
  resolve the matching pending request; everything else is a turn message.

Both :class:`~lite_agent_sdk._transport.subprocess.SubprocessTransport` and the
test fake implement this interface, so a fake server can be injected wherever a
real one would go.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, AsyncIterator


class Transport(ABC):
    """Abstract stream-json control-protocol transport."""

    @abstractmethod
    async def connect(self) -> None:
        """Start the connection (spawn the process, begin reading)."""

    @abstractmethod
    async def send_control(self, subtype: str, **fields: Any) -> dict[str, Any]:
        """Send a ``control_request`` and await its matching ``control_response``.

        ``subtype`` is the request subtype (``initialize``, ``interrupt``,
        ``set_permission_mode``, ``set_model``); ``fields`` are merged into the
        ``request`` object. Returns the ``response`` dict on a ``success``
        subtype and raises a :class:`~lite_agent_sdk.errors.ClaudeSDKError`
        subclass on an ``error`` subtype or a transport failure.
        """

    @abstractmethod
    async def send_user_message(self, content: Any) -> None:
        """Write a ``user`` line to start a turn. No reply is expected."""

    @abstractmethod
    def messages(self) -> AsyncIterator[dict[str, Any]]:
        """Async iterator over incoming non-control message lines (raw dicts)."""

    @abstractmethod
    async def close(self) -> None:
        """Tear down the connection. Safe to call more than once."""


__all__ = ["Transport"]
