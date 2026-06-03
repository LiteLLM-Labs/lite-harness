"""Configuration options for a run.

:class:`ClaudeAgentOptions` mirrors the upstream Claude Agent SDK options so
existing code keeps working after a drop-in import swap. The one addition is
:attr:`ClaudeAgentOptions.harness`, which selects the lite-harness agent
runtime and defaults to ``"claude"`` to preserve compatibility.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Literal

PermissionMode = Literal["default", "acceptEdits", "bypassPermissions", "plan"]


@dataclass
class ClaudeAgentOptions:
    """Options passed through to the server as opaque ``options`` config.

    See ``PROTOCOL.md`` § Requests: the server receives this as a snake_case
    dict via :meth:`to_wire`.
    """

    allowed_tools: list[str] = field(default_factory=list)
    disallowed_tools: list[str] = field(default_factory=list)
    system_prompt: str | None = None
    mcp_servers: dict[str, Any] = field(default_factory=dict)
    permission_mode: PermissionMode | None = None
    continue_conversation: bool = False
    resume: str | None = None
    max_turns: int | None = None
    model: str | None = None
    cwd: str | Path | None = None
    add_dirs: list[str | Path] = field(default_factory=list)
    settings: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    extra_args: dict[str, str | None] = field(default_factory=dict)
    max_buffer_size: int | None = None
    stderr: Callable[[str], None] | None = None
    include_partial_messages: bool = False
    # Selects which agent runtime the lite-harness server should use
    # (e.g. "codex", "pi-ai"). Optional — when ``None`` the server's default
    # runtime is used. Mirrors the Claude Agent SDK ``agent`` option.
    agent: str | None = None

    def to_wire(self) -> dict[str, Any]:
        """Serialize to the snake_case ``options`` dict the server receives.

        Non-serializable / transport-only fields (``stderr``) are dropped, and
        ``Path`` values are stringified. ``agent`` is excluded because it is
        passed as a launch flag, not inside ``options``.
        """

        wire: dict[str, Any] = {
            "allowed_tools": list(self.allowed_tools),
            "disallowed_tools": list(self.disallowed_tools),
            "system_prompt": self.system_prompt,
            "mcp_servers": dict(self.mcp_servers),
            "permission_mode": self.permission_mode,
            "continue_conversation": self.continue_conversation,
            "resume": self.resume,
            "max_turns": self.max_turns,
            "model": self.model,
            "cwd": str(self.cwd) if self.cwd is not None else None,
            "add_dirs": [str(d) for d in self.add_dirs],
            "settings": self.settings,
            "env": dict(self.env),
            "extra_args": dict(self.extra_args),
            "max_buffer_size": self.max_buffer_size,
            "include_partial_messages": self.include_partial_messages,
        }
        return wire
