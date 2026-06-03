"""lite-agent-sdk — a drop-in replacement for the Claude Agent SDK.

Swap ``from claude_agent_sdk import …`` for ``from lite_agent_sdk import …``
and existing code keeps working. The SDK is a thin client to a lite-harness
server, speaking the Claude Agent SDK stream-json control protocol over stdio;
the server owns the agent runtime.
"""

from ._transport import Transport
from ._version import __version__
from .blocks import (
    ContentBlock,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
)
from .client import ClaudeSDKClient
from .errors import (
    CLIConnectionError,
    CLIJSONDecodeError,
    CLINotFoundError,
    ClaudeSDKError,
    ProcessError,
)
from .messages import (
    AssistantMessage,
    Message,
    ResultMessage,
    SystemMessage,
    UserMessage,
)
from .options import ClaudeAgentOptions, PermissionMode
from .query import query

# Keep the public namespace to the names in __all__; drop the submodule
# objects that ``import`` binds at package level so ``dir(lite_agent_sdk)``
# reflects the intended surface.
del blocks, client, errors, messages, options  # type: ignore[name-defined]  # noqa: F821

__all__ = [
    "__version__",
    # entrypoints
    "query",
    "ClaudeSDKClient",
    # transport
    "Transport",
    # options
    "ClaudeAgentOptions",
    "PermissionMode",
    # messages
    "AssistantMessage",
    "UserMessage",
    "SystemMessage",
    "ResultMessage",
    "Message",
    # blocks
    "TextBlock",
    "ThinkingBlock",
    "ToolUseBlock",
    "ToolResultBlock",
    "ContentBlock",
    # errors
    "ClaudeSDKError",
    "CLINotFoundError",
    "CLIConnectionError",
    "ProcessError",
    "CLIJSONDecodeError",
]
