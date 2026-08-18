#!/usr/bin/env bash
# Copy the plugin into an OpenCode config directory.
#
# Copies rather than symlinks, because this is also run on GWDG after an `scp`
# of the checkout. Editing the repo therefore means re-running this script.
#
# OpenCode auto-discovers *every immediate file* in `plugins/`, so a helper
# module dropped there is loaded as a plugin and dies with
# "Plugin export is not a function". Helpers go in the sibling `lib/` instead,
# and each entrypoint's import is rewritten to point at it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${HOME}/.config/opencode"

usage() {
  cat <<'USAGE'
usage: install.sh [--dest DIR]

  --dest DIR   OpenCode config directory (default: ~/.config/opencode)
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="${2:?--dest needs a directory}"; shift 2 ;;
    --dest=*) DEST="${1#--dest=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'install.sh: unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

LIB_NAME="kiconnect-status-logic.mjs"

mkdir -p "$DEST/lib" "$DEST/plugins"

cp "$SCRIPT_DIR/src/logic.mjs" "$DEST/lib/$LIB_NAME"

# Rewrite `./logic.mjs` to the installed `../lib/` path, then prove it took —
# a silently unrewritten import would fail only when the plugin is loaded.
for entrypoint in kiconnect-status-server.js kiconnect-status-tui.tsx; do
  sed "s#from \"\./logic\.mjs\"#from \"../lib/$LIB_NAME\"#" \
    "$SCRIPT_DIR/src/$entrypoint" > "$DEST/plugins/$entrypoint"

  if ! grep -q "from \"../lib/$LIB_NAME\"" "$DEST/plugins/$entrypoint"; then
    printf 'install.sh: import rewrite failed for %s\n' "$entrypoint" >&2
    exit 1
  fi
done

printf '✓ %s\n' \
  "$DEST/lib/$LIB_NAME" \
  "$DEST/plugins/kiconnect-status-server.js" \
  "$DEST/plugins/kiconnect-status-tui.tsx"
printf 'Restart OpenCode to pick up the change.\n'
