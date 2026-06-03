#!/usr/bin/env python3
"""Deterministic fake lite-harness server (pure stdlib).

Speaks the Claude Agent SDK stream-json control protocol from PROTOCOL.md over
one multiplexed NDJSON stream on stdin/stdout. Launch flags are ignored.

* On a ``control_request`` (``initialize`` / ``interrupt`` /
  ``set_permission_mode`` / ``set_model``) it replies with a ``control_response``
  of subtype ``success``, echoing the ``request_id``.
* On a ``user`` line it emits a ``system`` init line, one ``assistant`` line
  whose ``text`` block echoes the prompt content, then a terminating ``result``
  line (subtype ``success``).

Exits when stdin closes.
"""

from __future__ import annotations

import json
import sys
from typing import Any


def _write(obj: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _control_success(request_id: Any) -> None:
    _write(
        {
            "type": "control_response",
            "response": {"request_id": request_id, "subtype": "success"},
        }
    )


def _content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        ]
        return "".join(parts)
    return ""


def _run_turn(content: Any) -> None:
    prompt = _content_to_text(content)
    session_id = "sess-fake"
    _write(
        {
            "type": "system",
            "subtype": "init",
            "session_id": session_id,
            "model": "claude-fake",
        }
    )
    _write(
        {
            "type": "assistant",
            "message": {
                "model": "claude-fake",
                "content": [{"type": "text", "text": f"echo: {prompt}"}],
            },
            "parent_tool_use_id": None,
        }
    )
    _write(
        {
            "type": "result",
            "subtype": "success",
            "duration_ms": 1,
            "duration_api_ms": 1,
            "is_error": False,
            "num_turns": 1,
            "session_id": session_id,
            "total_cost_usd": 0.0,
            "usage": {},
            "result": f"echo: {prompt}",
        }
    )


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict):
            continue

        msg_type = obj.get("type")
        if msg_type == "control_request":
            _control_success(obj.get("request_id"))
        elif msg_type == "user":
            content = (obj.get("message") or {}).get("content")
            _run_turn(content)


if __name__ == "__main__":
    main()
