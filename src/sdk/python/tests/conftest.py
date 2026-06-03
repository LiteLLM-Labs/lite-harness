"""Shared test fixtures: point the SDK at the stdlib fake server."""

from __future__ import annotations

import shlex
import sys
from pathlib import Path

import pytest

FAKE_SERVER = Path(__file__).parent / "fixtures" / "fake_server.py"


@pytest.fixture()
def fake_server_command() -> list[str]:
    return [sys.executable, str(FAKE_SERVER)]


@pytest.fixture()
def fake_server_env(monkeypatch: pytest.MonkeyPatch) -> None:
    cmd = shlex.join([sys.executable, str(FAKE_SERVER)])
    monkeypatch.setenv("LITE_HARNESS_SERVER", cmd)
