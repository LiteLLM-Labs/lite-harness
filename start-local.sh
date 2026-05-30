#!/usr/bin/env bash
# Run the lite-harness locally.
# Usage: ./start-local.sh [--harness opencode|claude-code|github-copilot]
# Set SKIP_UI_BUILD=1 to skip the UI rebuild step.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HARNESS="${1:-opencode}"

# --- Build UI ---
if [ "${SKIP_UI_BUILD:-0}" != "1" ]; then
  echo "[start-local] building UI..."
  (cd "$ROOT/ui" && npm run build)
fi

exec bash "$ROOT/harnesses/opencode/start-local.sh"
