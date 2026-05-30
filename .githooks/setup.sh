#!/usr/bin/env bash
# Run once after cloning: git config core.hooksPath .githooks
set -e
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"
chmod +x .githooks/pre-commit .githooks/pre-push
git config core.hooksPath .githooks
echo "Git hooks installed from .githooks/"
