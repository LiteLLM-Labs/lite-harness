"""Exception hierarchy mirroring the Claude Agent SDK.

``ClaudeSDKError`` is the base; everything else derives from it so callers can
catch the whole family with a single ``except ClaudeSDKError``.
"""

from __future__ import annotations


class ClaudeSDKError(Exception):
    """Base class for all SDK errors."""


class CLINotFoundError(ClaudeSDKError):
    """The lite-harness server binary/command could not be found."""


class CLIConnectionError(ClaudeSDKError):
    """Spawning or connecting to the server failed."""


class ProcessError(ClaudeSDKError):
    """The server process exited abnormally."""

    def __init__(
        self,
        message: str,
        *,
        exit_code: int | None = None,
        stderr: str | None = None,
    ) -> None:
        self.exit_code = exit_code
        self.stderr = stderr
        if exit_code is not None:
            message = f"{message} (exit code: {exit_code})"
        if stderr:
            message = f"{message}\n{stderr}"
        super().__init__(message)


class CLIJSONDecodeError(ClaudeSDKError):
    """A line received from the server was not valid JSON."""

    def __init__(self, line: str, original_error: Exception) -> None:
        self.line = line
        self.original_error = original_error
        super().__init__(f"Failed to decode JSON line: {line!r}\n{original_error}")
