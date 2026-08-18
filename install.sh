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
usage: install.sh [--dest DIR] [--narrow MODE]

  --dest DIR     OpenCode config directory (default: ~/.config/opencode)
  --narrow MODE  What the widget does when the prompt row is too narrow for
                 even its shortest form: "always" (print it anyway, the
                 default) or "hide".
  --placement M  Where it draws: "auto" (sidebar when the host shows one,
                 prompt row otherwise -- the default), "prompt" (always under
                 the chat box) or "sidebar" (only in the sidebar).

Both are written into tui.json as the plugin's options, and both can be changed
afterwards from the command palette without reinstalling.
USAGE
}

NARROW=""
PLACEMENT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="${2:?--dest needs a directory}"; shift 2 ;;
    --dest=*) DEST="${1#--dest=}"; shift ;;
    --narrow) NARROW="${2:?--narrow needs a mode}"; shift 2 ;;
    --narrow=*) NARROW="${1#--narrow=}"; shift ;;
    --placement) PLACEMENT="${2:?--placement needs a mode}"; shift 2 ;;
    --placement=*) PLACEMENT="${1#--placement=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'install.sh: unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$NARROW" in
  ""|always|hide) ;;
  *) printf 'install.sh: --narrow must be "always" or "hide", got: %s\n' "$NARROW" >&2; exit 2 ;;
esac

case "$PLACEMENT" in
  ""|auto|prompt|sidebar) ;;
  *) printf 'install.sh: --placement must be "auto", "prompt" or "sidebar", got: %s\n' "$PLACEMENT" >&2; exit 2 ;;
esac

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
python3 - "$DEST/tui.json" "$WIDGET" "$NARROW" "$PLACEMENT" <<'PYEOF'
import json, os, pathlib, sys

path, entry = pathlib.Path(sys.argv[1]), sys.argv[2]
flags = {"narrow": sys.argv[3], "placement": sys.argv[4]}
config = json.loads(path.read_text()) if path.exists() else {}
if not isinstance(config, dict):
    raise SystemExit("install.sh: %s is not a JSON object" % path)

plugins = config.get("plugin", [])
if not isinstance(plugins, list):
    raise SystemExit('install.sh: %s has a non-list "plugin"' % path)


def spec_of(item):
    """An entry is either "<spec>" or ["<spec>", {options}] (ConfigPluginV1.Spec)."""
    if isinstance(item, list) and item:
        return item[0]
    return item


def same_widget(item, entry):
    """Whether an existing entry registers the widget `entry` names.

    Compared on the file name, not the spec string. OpenCode rewrites a
    relative spec to an absolute path when it loads the config, so the entry
    this script wrote as `./plugins/x.tsx` comes back as
    `/home/you/.config/opencode/plugins/x.tsx`. Matching the raw strings then
    finds nothing, appends a second registration for the same file, and the
    widget renders twice — measured on GWDG, where all three had been
    rewritten. The file name is what actually identifies the widget.
    """
    spec = spec_of(item)
    if not isinstance(spec, str):
        return False
    return os.path.basename(spec) == os.path.basename(entry)


# Match on the spec, so re-running with a different --narrow rewrites our own
# entry instead of appending a second registration for the same widget.
index = next((i for i, item in enumerate(plugins) if same_widget(item, entry)), None)

# Start from whatever options are already configured, so `--narrow` does not
# silently drop a `--placement` set by an earlier run, and a flag left off
# leaves its option untouched.
current = plugins[index][1] if index is not None and isinstance(plugins[index], list) and len(plugins[index]) > 1 else {}
options = dict(current) if isinstance(current, dict) else {}
options.update({key: value for key, value in flags.items() if value})

replacement = [entry, options] if options else entry

if index is None:
    plugins.append(replacement)
else:
    plugins[index] = replacement

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
