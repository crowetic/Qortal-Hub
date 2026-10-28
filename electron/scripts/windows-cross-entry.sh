#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$HOME"
WORKSPACE="$(mktemp -d /tmp/qortal-win-cross-XXXXXX)"
cd /source
# Include tracked working-tree content, without .git, dependencies, credentials,
# ignored hosted leftovers or generated artifacts. New source files must be staged.
git ls-files -z | tar --null -T - -cf - | tar -C "$WORKSPACE" -xf -
cd "$WORKSPACE"
exec xvfb-run -a node electron/scripts/build-windows-cross.mjs
