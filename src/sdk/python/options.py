"""Configuration options for a run.

:class:`AgentOptions` is the lite-harness public options type. It accepts the
Claude Agent SDK option field set for migration compatibility, plus
``harness`` for choosing the agent harness (for example ``"claude"`` or
``"openai"``).

Many advanced upstream fields (hooks, MCP SDK servers, sandbox, plugins, ...)
are accepted for compatibility but are not yet honored by every harness.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Literal

PermissionMode = Literal["default", "acceptEdits", "bypassPermissions", "plan"]

# Permissive aliases for complex upstream-typed fields we don't own. We accept
# these values for drop-in compatibility and either forward them opaquely or do
# not yet honor them. Using ``Any`` keeps mypy --strict happy without pulling in
# (or re-implementing) the upstream type definitions.
JSONValue = Any
# Callback fields (sync or async, varied signatures upstream).
Callback = Callable[..., Any]


@dataclass
class AgentOptions:
    """Options passed through to the runtime as opaque ``options`` config.

    See ``PROTOCOL.md`` § Requests: the server receives this as a snake_case
    dict via :meth:`to_wire`.

    This dataclass is a strict superset of the upstream
    ``claude_agent_sdk.ClaudeAgentOptions`` field set. Fields not understood by
    the lite-harness server are accepted (so the constructor never rejects an
    upstream kwarg) but are not serialized onto the wire.
    """

    # -- tools / permissions ----------------------------------------------
    tools: JSONValue = None  # accepted for drop-in compat; not yet honored
    allowed_tools: list[str] = field(default_factory=list)
    disallowed_tools: list[str] = field(default_factory=list)
    permission_mode: PermissionMode | None = None
    permission_prompt_tool_name: str | None = None
    can_use_tool: Callback | None = None  # callback; not yet honored

    # -- prompt / model ----------------------------------------------------
    system_prompt: str | None = None
    model: str | None = None
    fallback_model: str | None = None
    betas: JSONValue = None  # accepted for drop-in compat; not yet honored
    output_format: JSONValue = None  # accepted for drop-in compat; not honored
    thinking: JSONValue = None  # accepted for drop-in compat; not yet honored
    max_thinking_tokens: int | None = None  # accepted; not yet honored
    effort: Literal["low", "medium", "high", "xhigh", "max"] | None = None

    # -- MCP ---------------------------------------------------------------
    mcp_servers: JSONValue = field(default_factory=dict)  # opaque to lite
    strict_mcp_config: bool = False
    plugins: JSONValue = field(default_factory=list)  # accepted; not honored

    # -- conversation lifecycle -------------------------------------------
    continue_conversation: bool = False
    resume: str | None = None
    session_id: str | None = None  # accepted for drop-in compat; not yet honored
    fork_session: bool = False
    max_turns: int | None = None
    max_budget_usd: float | None = None
    task_budget: JSONValue = None  # accepted for drop-in compat; not yet honored

    # -- process / environment --------------------------------------------
    cwd: str | Path | None = None
    cli_path: str | Path | None = None
    settings: str | None = None
    setting_sources: list[str] | None = None
    add_dirs: list[str | Path] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    extra_args: dict[str, str | None] = field(default_factory=dict)
    max_buffer_size: int | None = None
    load_timeout_ms: int = 60000  # accepted for drop-in compat; not yet honored
    stderr: Callback | None = None  # callback; transport-only, never on wire
    # Upstream defaults this to ``sys.stderr``; we accept any file-like/None for
    # drop-in compat (transport-only, never on wire) and default to ``None``.
    debug_stderr: JSONValue = None  # accepted for drop-in compat; not honored
    user: str | None = None

    # -- hooks / agents / sandbox -----------------------------------------
    hooks: JSONValue = None  # accepted for drop-in compat; not yet honored
    include_partial_messages: bool = False
    include_hook_events: bool = False
    agents: JSONValue = None  # accepted for drop-in compat; not yet honored
    skills: JSONValue = None  # accepted for drop-in compat; not yet honored
    sandbox: JSONValue = None  # accepted for drop-in compat; not yet honored

    # -- checkpointing / session store ------------------------------------
    enable_file_checkpointing: bool = False
    session_store: JSONValue = None  # accepted for drop-in compat; not honored
    session_store_flush: Literal["batched", "eager"] = "batched"

    # -- lite-harness extension -------------------------------------------
    # Selects which agent harness should handle the run
    # (e.g. "claude", "openai").
    harness: str | None = None
    # Backward-compatible alias accepted by older docs/builds and upstream
    # Claude Agent SDK callers. ``harness`` wins when both are provided.
    agent: str | None = None

    def to_wire(self) -> dict[str, Any]:
        """Serialize to the snake_case ``options`` dict the server receives.

        Only the fields the stream-json server currently understands are
        serialized. Fields not in the wire payload are accepted for drop-in
        compatibility but not yet honored by every harness. Non-serializable /
        transport-only fields (``stderr``) are dropped, ``Path`` values are
        stringified, and ``harness`` / ``agent`` are excluded because they are
        passed as launch flags, not inside ``options``.
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

    @property
    def selected_harness(self) -> str | None:
        """Return the public harness selector, falling back to ``agent``."""

        return self.harness if self.harness is not None else self.agent


# Compatibility alias for code migrating from the Claude Agent SDK or older
# lite-harness SDK examples. New lite-harness code should use ``AgentOptions``.
ClaudeAgentOptions = AgentOptions
