"""Transport: spawn the server and speak the stream-json control protocol.

A :class:`Transport` owns the connection to the lite-harness server — process
spawn (or, for a fake, in-memory wiring), the single multiplexed NDJSON stream
described in ``PROTOCOL.md``, control-request/response correlation by
``request_id``, and delivery of the decoded non-control messages.

The wire language is the Claude Agent SDK stream-json control protocol:

* outgoing ``control_request`` lines (correlated by ``request_id``) for
  ``initialize`` / ``interrupt`` / ``set_permission_mode`` / ``set_model``,
* outgoing ``user`` lines to start a turn (no reply expected), and
* incoming lines demultiplexed on top-level ``type``: ``control_response`` lines
  resolve the matching pending request; everything else is a turn message.

:class:`SubprocessTransport` is the production implementation; the test fake
implements the same :class:`Transport` interface, so a fake server can be
injected wherever a real one would go.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import shlex
import shutil
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, AsyncIterator, Callable

from errors import (
    CLIConnectionError,
    CLIJSONDecodeError,
    CLINotFoundError,
    ClaudeSDKError,
    ProcessError,
)

# Sentinel pushed onto the message queue when the stream ends.
_CLOSED = object()


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
        subtype and raises a :class:`~lite_harness.errors.ClaudeSDKError`
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


def resolve_server_command(explicit: list[str] | None = None) -> list[str]:
    """Resolve the base server spawn command per PROTOCOL.md.

    Order: explicit argument, then ``LITE_HARNESS_SERVER`` env var (a command
    line), then the in-repo server (when running from a clone), then the
    installed ``lite-harness-server`` on PATH. The stream-json launch flags are
    appended separately by :class:`SubprocessTransport`.
    """

    if explicit:
        return list(explicit)

    env_cmd = os.environ.get("LITE_HARNESS_SERVER")
    if env_cmd:
        return shlex.split(env_cmd)

    node = shutil.which("node")
    if node is None:
        raise CLINotFoundError(
            "Could not resolve the lite-harness server command. Set "
            "LITE_HARNESS_SERVER or pass a transport explicitly."
        )

    # Running straight from a clone: src/sdk/python -> src/sdk/server/server.mjs
    repo_server = Path(__file__).resolve().parent.parent / "server" / "server.mjs"
    if repo_server.is_file():
        return [node, str(repo_server)]

    return [node, "lite-harness-server"]


class SubprocessTransport(Transport):
    """Spawns the server and frames the stream-json control protocol over stdio."""

    def __init__(
        self,
        command: list[str] | None = None,
        *,
        agent: str | None = None,
        model: str | None = None,
        permission_mode: str | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        stderr: Callable[[str], None] | None = None,
    ) -> None:
        self._command = self._build_command(
            resolve_server_command(command),
            agent=agent,
            model=model,
            permission_mode=permission_mode,
            cwd=cwd,
        )
        self._cwd = cwd
        self._env = env
        self._stderr_cb = stderr

        self._proc: asyncio.subprocess.Process | None = None
        self._next_id = 0
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._messages: asyncio.Queue[Any] = asyncio.Queue()
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._closed = False

    @staticmethod
    def _build_command(
        base: list[str],
        *,
        agent: str | None,
        model: str | None,
        permission_mode: str | None,
        cwd: str | None,
    ) -> list[str]:
        cmd = [
            *base,
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
        ]
        if agent is not None:
            cmd += ["--agent", agent]
        if model is not None:
            cmd += ["--model", model]
        if permission_mode is not None:
            cmd += ["--permission-mode", permission_mode]
        if cwd is not None:
            cmd += ["--cwd", cwd]
        return cmd

    async def connect(self) -> None:
        spawn_env = {**os.environ, **(self._env or {})}
        try:
            self._proc = await asyncio.create_subprocess_exec(
                *self._command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self._cwd,
                env=spawn_env,
            )
        except FileNotFoundError as exc:
            raise CLINotFoundError(
                f"Server command not found: {self._command[0]!r}"
            ) from exc
        except OSError as exc:
            raise CLIConnectionError(
                f"Failed to spawn server: {self._command!r}"
            ) from exc

        self._reader_task = asyncio.ensure_future(self._read_stdout())
        if self._proc.stderr is not None:
            self._stderr_task = asyncio.ensure_future(self._read_stderr())

    async def _read_stdout(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        stdout = self._proc.stdout
        try:
            while True:
                raw = await stdout.readline()
                if not raw:
                    break
                line = raw.decode("utf-8").strip()
                if not line:
                    continue
                self._dispatch_line(line)
        except asyncio.CancelledError:
            raise
        finally:
            await self._fail_pending_and_close()

    def _dispatch_line(self, line: str) -> None:
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as exc:
            error = CLIJSONDecodeError(line, exc)
            self._fail_all_pending(error)
            return

        if not isinstance(obj, dict):
            return

        if obj.get("type") == "control_response":
            response = obj.get("response") or {}
            request_id = response.get("request_id")
            if not isinstance(request_id, str):
                return
            future = self._pending.pop(request_id, None)
            if future is None or future.done():
                return
            if response.get("subtype") == "error":
                future.set_exception(
                    ClaudeSDKError(
                        f"Control request failed: {response.get('error')}"
                    )
                )
            else:
                future.set_result(response)
            return

        # Any non-control line is a turn message.
        self._messages.put_nowait(obj)

    async def _read_stderr(self) -> None:
        assert self._proc is not None and self._proc.stderr is not None
        stderr = self._proc.stderr
        try:
            while True:
                raw = await stderr.readline()
                if not raw:
                    break
                if self._stderr_cb is not None:
                    self._stderr_cb(raw.decode("utf-8").rstrip("\n"))
        except asyncio.CancelledError:
            raise

    def _fail_all_pending(self, error: Exception) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(error)
        self._pending.clear()

    async def _fail_pending_and_close(self) -> None:
        if self._pending:
            stderr_text = await self._collect_stderr()
            exit_code = self._proc.returncode if self._proc is not None else None
            self._fail_all_pending(
                ProcessError(
                    "Server closed the connection before replying",
                    exit_code=exit_code,
                    stderr=stderr_text,
                )
            )
        self._messages.put_nowait(_CLOSED)

    async def _collect_stderr(self) -> str | None:
        if self._proc is None or self._proc.stderr is None:
            return None
        try:
            data = await self._proc.stderr.read()
        except Exception:
            return None
        text = data.decode("utf-8", errors="replace").strip()
        return text or None

    async def send_control(self, subtype: str, **fields: Any) -> dict[str, Any]:
        if self._proc is None or self._proc.stdin is None:
            raise CLIConnectionError("Transport is not connected")

        self._next_id += 1
        request_id = f"req_{self._next_id}_{secrets.token_hex(4)}"
        future: asyncio.Future[dict[str, Any]] = (
            asyncio.get_event_loop().create_future()
        )
        self._pending[request_id] = future

        payload = {
            "type": "control_request",
            "request_id": request_id,
            "request": {"subtype": subtype, **fields},
        }
        try:
            self._write_line(payload)
        except Exception:
            self._pending.pop(request_id, None)
            raise
        return await future

    async def send_user_message(self, content: Any) -> None:
        if self._proc is None or self._proc.stdin is None:
            raise CLIConnectionError("Transport is not connected")
        self._write_line(
            {
                "type": "user",
                "message": {"role": "user", "content": content},
                "session_id": None,
                "parent_tool_use_id": None,
            }
        )

    def _write_line(self, payload: dict[str, Any]) -> None:
        assert self._proc is not None and self._proc.stdin is not None
        line = json.dumps(payload, separators=(",", ":")) + "\n"
        self._proc.stdin.write(line.encode("utf-8"))

    async def messages(self) -> AsyncIterator[dict[str, Any]]:
        while True:
            item = await self._messages.get()
            if item is _CLOSED:
                return
            yield item

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True

        proc = self._proc
        if proc is not None:
            if proc.stdin is not None and not proc.stdin.is_closing():
                try:
                    proc.stdin.close()
                except Exception:
                    pass
            if proc.returncode is None:
                try:
                    proc.terminate()
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(proc.wait(), timeout=5.0)
                except asyncio.TimeoutError:
                    try:
                        proc.kill()
                    except ProcessLookupError:
                        pass
                    await proc.wait()
            else:
                # Already exited: still await so the loop runs the
                # connection-lost callback now, instead of letting the
                # subprocess transport's __del__ try to close pipes after the
                # loop is gone ("Event loop is closed" warning at GC time).
                await proc.wait()

        for task in (self._reader_task, self._stderr_task):
            if task is not None and not task.done():
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass

        self._messages.put_nowait(_CLOSED)


__all__ = ["Transport", "SubprocessTransport", "resolve_server_command"]
