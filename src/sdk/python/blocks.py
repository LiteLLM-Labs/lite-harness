"""Content block dataclasses and the :data:`ContentBlock` union.

These mirror the Claude Agent SDK content block shapes and the wire blocks
described in ``PROTOCOL.md`` § Content blocks.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Union


@dataclass
class TextBlock:
    """A plain text block."""

    text: str


@dataclass
class ThinkingBlock:
    """An extended-thinking block with its cryptographic signature."""

    thinking: str
    signature: str


@dataclass
class ToolUseBlock:
    """A request from the model to invoke a tool."""

    id: str
    name: str
    input: dict[str, Any]


@dataclass
class ToolResultBlock:
    """The result of a tool invocation, fed back to the model."""

    tool_use_id: str
    content: str | list[dict[str, Any]] | None = None
    is_error: bool | None = None


ContentBlock = Union[TextBlock, ThinkingBlock, ToolUseBlock, ToolResultBlock]
