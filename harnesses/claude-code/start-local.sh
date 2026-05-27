#!/usr/bin/env bash
# Run the claude-code inline harness locally, pointed at your local LAP instance.
# Prerequisites: @anthropic-ai/claude-code installed (npm install), claude CLI on PATH.
#
# Usage:
#   cd harnesses/claude-code
#   ./start-local.sh
set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"

# Source LAP .env for LiteLLM creds — skip if key already set (avoids cert-line errors)
LAP_ROOT="$(cd "$HARNESS_DIR/../.." && pwd)"
if [ -z "${LITELLM_API_KEY:-}" ]; then
  if [ ! -f "$LAP_ROOT/.env" ] && [ -f "$(dirname "$0")/../../../litellm-agent-platform/.env" ]; then
    LAP_ROOT="$(cd "$(dirname "$0")/../../../litellm-agent-platform" && pwd)"
  fi
  if [ -f "$LAP_ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$LAP_ROOT/.env"
    set +a
  fi
fi

: "${LITELLM_API_BASE:?set LITELLM_API_BASE}"
: "${LITELLM_API_KEY:?set LITELLM_API_KEY}"
: "${LITELLM_DEFAULT_MODEL:=anthropic/claude-sonnet-4-5}"

# Normalize base URL
BASE="${LITELLM_API_BASE%/}"
case "$BASE" in
  */v1) ;;
  *) BASE="${BASE}/v1" ;;
esac

export LITELLM_API_BASE="$BASE"
export LITELLM_API_KEY
export LITELLM_DEFAULT_MODEL
export REPO_DIR="${REPO_DIR:-$HARNESS_DIR}"
export PORT="${CLAUDE_CODE_INLINE_PORT:-4098}"
export LAP_BASE_URL="${LAP_BASE_URL:-http://localhost:3000}"

# Resolve claude binary for CLAUDE_CODE_EXECUTABLE hint
if command -v claude >/dev/null 2>&1; then
  export CLAUDE_CODE_EXECUTABLE="$(command -v claude)"
fi

echo "[start-local] base=$LITELLM_API_BASE model=$LITELLM_DEFAULT_MODEL port=$PORT"
echo "[start-local] claude=$(command -v claude 2>/dev/null || echo 'not found')"

exec node "$HARNESS_DIR/inline-adapter.mjs"
