#!/usr/bin/env bash
# Copy the plugin into an OpenCode config directory.
#
# Copies rather than symlinks, because this is also run on GWDG after an `scp`
# of the checkout. Editing the repo therefore means re-running this script.
#
# TWO discovery constraints, both read off the OpenCode source
# (packages/opencode/src/config/plugin.ts), not guessed:
#
#   1. The scan glob is `{plugin,plugins}/*.{ts,js}` — every immediate MATCHING
#      file is loaded as a plugin, so a helper module dropped there dies with
#      "Plugin export is not a function".
#   2. `.tsx` is NOT in that glob. A widget installed as `plugins/foo.tsx` is
#      never discovered, and fails completely silently — no error, no log line.
#      This is why the server half worked (it writes session metadata) while
#      the widget rendered nothing at all.
#
# JSX cannot simply be renamed into a `.ts` file (`<box height={1}>` parses as a
# type assertion and Bun rejects it). So the widget lives in `lib/` beside its
# logic helper, and `plugins/` gets a one-line `.ts` re-export shim, which the
# glob does match. The server half is plain `.js` and stays in `plugins/`.
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
SERVER="kiconnect-status-server.js"
WIDGET="kiconnect-status-tui"

mkdir -p "$DEST/lib" "$DEST/plugins"

cp "$SCRIPT_DIR/src/logic.mjs" "$DEST/lib/$LIB_NAME"

# Server half: stays in plugins/, so it reaches the helper via ../lib/.
sed "s#from \"\./logic\.mjs\"#from \"../lib/$LIB_NAME\"#" \
  "$SCRIPT_DIR/src/$SERVER" > "$DEST/plugins/$SERVER"

if ! grep -q "from \"../lib/$LIB_NAME\"" "$DEST/plugins/$SERVER"; then
  printf 'install.sh: import rewrite failed for %s\n' "$SERVER" >&2
  exit 1
fi

# Widget half: lands beside the helper, so `./logic.mjs` becomes `./<lib name>`.
sed "s#from \"\./logic\.mjs\"#from \"./$LIB_NAME\"#" \
  "$SCRIPT_DIR/src/$WIDGET.tsx" > "$DEST/lib/$WIDGET.tsx"

if ! grep -q "from \"./$LIB_NAME\"" "$DEST/lib/$WIDGET.tsx"; then
  printf 'install.sh: import rewrite failed for %s.tsx\n' "$WIDGET" >&2
  exit 1
fi

# Discoverable entrypoint. Bun resolves the explicit .tsx extension.
printf 'export { default } from "../lib/%s.tsx"\n' "$WIDGET" > "$DEST/plugins/$WIDGET.ts"

# A stale .tsx left in plugins/ from an earlier install is inert, but remove it
# so the directory cannot mislead the next reader.
rm -f "$DEST/plugins/$WIDGET.tsx"

printf '✓ %s\n' \
  "$DEST/lib/$LIB_NAME" \
  "$DEST/lib/$WIDGET.tsx" \
  "$DEST/plugins/$SERVER" \
  "$DEST/plugins/$WIDGET.ts"
printf 'Restart OpenCode to pick up the change.\n'
