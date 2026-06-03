"""lite-harness — a drop-in replacement for the Claude Agent SDK.

Swap ``from claude_agent_sdk import …`` for ``from lite_harness import …``
and existing code keeps working. The SDK is a thin client to a lite-harness
server, speaking the Claude Agent SDK stream-json control protocol over stdio;
the server owns the agent runtime.
"""

from transport import Transport
from blocks import (
    ContentBlock,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
)
from client import ClaudeSDKClient
from errors import (
    CLIConnectionError,
    CLIJSONDecodeError,
    CLINotFoundError,
    ClaudeSDKError,
    ProcessError,
)
from messages import (
    AssistantMessage,
    Message,
    ResultMessage,
    SystemMessage,
    UserMessage,
)
from options import AgentOptions, ClaudeAgentOptions, PermissionMode
from query import query

# Keep the public namespace to the names in __all__; drop the submodule
# objects that ``import`` binds at package level so ``dir(lite_harness)``
# reflects the intended surface.

__version__ = "0.1.0"

__all__ = [
    "__version__",
    # entrypoints
    "query",
    "ClaudeSDKClient",
    # transport
    "Transport",
    # options
    "AgentOptions",
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
