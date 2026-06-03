"""Message dataclasses and the :data:`Message` union.

These mirror the Claude Agent SDK message shapes and the wire messages
described in ``PROTOCOL.md`` § Message.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Union

from blocks import ContentBlock


@dataclass
class AssistantMessage:
    """A message produced by the assistant."""

    content: list[ContentBlock]
    model: str
    parent_tool_use_id: str | None = None


@dataclass
class UserMessage:
    """A message from the user (or a tool result fed back as the user)."""

    content: str | list[ContentBlock]
    parent_tool_use_id: str | None = None


@dataclass
class SystemMessage:
    """A system event (e.g. ``init``). ``data`` carries the raw payload."""

    subtype: str
    data: dict[str, Any]


@dataclass
class ResultMessage:
    """The terminal message of a run."""

    subtype: str
    duration_ms: int
    duration_api_ms: int
    is_error: bool
    num_turns: int
    session_id: str
    total_cost_usd: float | None = None
    usage: dict[str, Any] | None = None
    result: str | None = None


Message = Union[AssistantMessage, UserMessage, SystemMessage, ResultMessage]
