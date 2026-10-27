#!/usr/bin/env bash
# Build the regular Linux x64 desktop AppImage through the Docker pipeline.
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "Usage: ./build-appimage.sh"
  echo "Builds the desktop AppImage with npm run electron:make-lin-docker-appimage."
  echo "Requires Git, npm and a running Docker or Podman engine."
  exit 0
fi
if (( $# > 0 )); then
  echo "Unknown argument: $1 (use --help)" >&2
  exit 64
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${REPO_ROOT}/electron"
exec npm run electron:make-lin-docker-appimage
