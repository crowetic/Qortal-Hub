#!/usr/bin/env bash
# Linux-controlled test builds: Windows locally in Wine, macOS on native CI.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$REPO_ROOT/electron/scripts/run-cross-docker.mjs" "$@"
