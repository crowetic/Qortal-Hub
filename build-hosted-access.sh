#!/usr/bin/env bash
set -euo pipefail

task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "Install Node.js >=22.12 and npm before running this builder." >&2
  exit 1
fi
cd "$task_root"
exec node -- scripts/configure-hosted.mjs "$@"
