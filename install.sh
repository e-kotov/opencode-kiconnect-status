#!/usr/bin/env bash
# Copy the plugin into an OpenCode config directory.
#
# Copies rather than symlinks, because this is also run on GWDG after an `scp`
# of the checkout. Editing the repo therefore means re-running this script.
#
# TWO separate registration mechanisms, easy to confuse — and this plugin has
# one half of each:
#
#   1. SERVER plugins are auto-discovered from `plugins/` by the glob
#      `{plugin,plugins}/*.{ts,js}` (packages/opencode/src/config/plugin.ts).
#      Every match is loaded, so a helper module dropped there dies with
#      "Plugin export is not a function". Helpers go in the sibling `lib/`
#      instead, and each entrypoint's import is rewritten to point at it.
#      `kiconnect-status-server.js` is picked up this way.
#   2. TUI widgets are NOT auto-discovered. They must be listed in the
#      `plugin` array of `tui.json`. `.tsx` sits deliberately outside the
#      server glob, which is what stops a widget being loaded twice.
#
# Getting only (1) right is exactly how the server half came to work — writing
# `kiStatus` into session metadata — while the widget rendered nothing at all,
# with no error and no log line. So this script does both halves.
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
WIDGET="./plugins/kiconnect-status-tui.tsx"

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

# Register the widget in tui.json, extending the plugin array without
# disturbing any other TUI setting. The server half needs no entry.
python3 - "$DEST/tui.json" "$WIDGET" <<'PYEOF'
import json, pathlib, sys

path, entry = pathlib.Path(sys.argv[1]), sys.argv[2]
config = json.loads(path.read_text()) if path.exists() else {}
if not isinstance(config, dict):
    raise SystemExit("install.sh: %s is not a JSON object" % path)

plugins = config.get("plugin", [])
if not isinstance(plugins, list):
    raise SystemExit('install.sh: %s has a non-list "plugin"' % path)

if entry not in plugins:
    plugins.append(entry)
config.setdefault("$schema", "https://opencode.ai/tui.json")
config["plugin"] = plugins

path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(config, indent=2) + "\n")
PYEOF

printf '✓ %s\n' \
  "$DEST/lib/$LIB_NAME" \
  "$DEST/plugins/kiconnect-status-server.js" \
  "$DEST/plugins/kiconnect-status-tui.tsx" \
  "$DEST/tui.json → $WIDGET"
printf 'Restart every running OpenCode to pick up the change.\n'
