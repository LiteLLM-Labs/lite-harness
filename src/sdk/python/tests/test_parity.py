"""Drop-in parity against the real upstream ``claude_agent_sdk``.

This suite is the enforcement contract for drop-in compatibility: swapping
``from claude_agent_sdk import …`` for ``from lite_harness import …`` must not
break callers. It checks the *runtime surface* we commit to — exported names,
the ``ClaudeAgentOptions`` field superset (lite ⊇ claude, so any upstream kwarg
constructs without ``TypeError``), the ``query()`` parameter names, and the core
``ClaudeSDKClient`` methods.

It deliberately does NOT assert parity for advanced upstream features that are
explicitly OUT of v0 scope:

  * in-process tools — ``tool()`` / ``create_sdk_mcp_server`` decorators
  * hook execution (hooks are accepted as opaque config but not run)
  * MCP SDK servers (in-process MCP server objects)
  * session-management helper functions

These are accepted for drop-in compatibility (no constructor errors) but are not
yet honored by the lite-harness server; the parity test scopes to the surface we
actually implement.

If ``claude-agent-sdk`` cannot be installed (e.g. CI without network), the whole
module skips via ``pytest.importorskip`` and the rest of the suite still runs.
"""

from __future__ import annotations

import dataclasses
import inspect

import pytest

claude = pytest.importorskip("claude_agent_sdk")

import lite_harness as lite

CORE_EXPORTS = [
    "query",
    "ClaudeSDKClient",
    "ClaudeAgentOptions",
    "AssistantMessage",
    "UserMessage",
    "SystemMessage",
    "ResultMessage",
    "TextBlock",
    "ThinkingBlock",
    "ToolUseBlock",
    "ToolResultBlock",
]

CLIENT_METHODS = [
    "connect",
    "query",
    "receive_messages",
    "receive_response",
    "interrupt",
    "set_permission_mode",
    "set_model",
    "disconnect",
]


@pytest.mark.parametrize("name", CORE_EXPORTS)
def test_export_parity(name: str) -> None:
    assert hasattr(lite, name), f"lite_harness is missing export {name!r}"
    assert hasattr(claude, name), f"claude_agent_sdk is missing export {name!r}"


def test_lite_exports_agent_options() -> None:
    assert lite.AgentOptions is lite.ClaudeAgentOptions


def test_options_field_superset() -> None:
    """Every upstream option field name must exist in lite (lite ⊇ claude)."""
    upstream = {f.name for f in dataclasses.fields(claude.ClaudeAgentOptions)}
    ours = {f.name for f in dataclasses.fields(lite.AgentOptions)}
    missing = upstream - ours
    assert not missing, (
        "lite_harness.AgentOptions is missing upstream fields: "
        f"{sorted(missing)}"
    )


def test_query_signature_superset() -> None:
    """lite.query parameter names ⊇ claude.query parameter names (names only)."""
    upstream = set(inspect.signature(claude.query).parameters)
    ours = set(inspect.signature(lite.query).parameters)
    missing = upstream - ours
    assert not missing, f"lite.query is missing parameters: {sorted(missing)}"


@pytest.mark.parametrize("method", CLIENT_METHODS)
def test_client_method_parity(method: str) -> None:
    assert callable(
        getattr(lite.ClaudeSDKClient, method, None)
    ), f"lite.ClaudeSDKClient is missing method {method!r}"
    assert callable(
        getattr(claude.ClaudeSDKClient, method, None)
    ), f"claude.ClaudeSDKClient is missing method {method!r}"
