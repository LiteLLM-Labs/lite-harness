#!/usr/bin/env bash
set -euo pipefail
# Run the unified inline-adapter pointing at this harness.
# Requires: GITHUB_TOKEN env var with GitHub Copilot access.
# Optional: GITHUB_COPILOT_MODEL (default: gpt-4o)
cd "$(dirname "$0")/../opencode"
exec node inline-adapter.mjs
