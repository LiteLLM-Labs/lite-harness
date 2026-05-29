#!/usr/bin/env bash
# Run the lite-harness locally.
# Usage: ./start-local.sh [--harness opencode|claude-code|github-copilot]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HARNESS="${1:-opencode}"

exec bash "$ROOT/harnesses/opencode/start-local.sh"
