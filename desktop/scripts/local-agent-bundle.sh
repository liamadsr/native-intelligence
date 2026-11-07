#!/bin/bash
# Vendor the local agent into src-tauri/resources/local-agent/, built from a
# dial8-website checkout by its scripts/local-agent/bundle.sh. Commit the
# result: a release ships exactly what is committed (release.sh checks the
# staged copy against BUNDLE.json). See scripts/local-agent.sh.
#
# Usage:
#   scripts/local-agent-bundle.sh [<dial8-website checkout>] [--allow-dirty]
#
# The checkout defaults to $DIAL8_WEB_DIR, else ../dial8-website next to this
# repo. It needs its node_modules installed. Build from a commit that is on
# the web repo's main: BUNDLE.json records it. --allow-dirty vendors a bundle
# from uncommitted web source for a local test; release.sh refuses it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$SCRIPT_DIR/src-tauri/resources/local-agent"

WEB_DIR="${DIAL8_WEB_DIR:-$SCRIPT_DIR/../dial8-website}"
ALLOW_DIRTY=false
for arg in "$@"; do
    case "$arg" in
        --allow-dirty) ALLOW_DIRTY=true ;;
        -*) echo "unknown flag: $arg" >&2; exit 2 ;;
        *) WEB_DIR="$arg" ;;
    esac
done
WEB_DIR="$(cd "$WEB_DIR" && pwd)"
if [ ! -x "$WEB_DIR/scripts/local-agent/bundle.sh" ]; then
    echo "not a dial8-website checkout with scripts/local-agent/bundle.sh: $WEB_DIR" >&2
    exit 1
fi

OUT="$(mktemp -d "${TMPDIR:-/tmp}/dial8-local-agent-vendor.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT
"$WEB_DIR/scripts/local-agent/bundle.sh" "$OUT/local-agent"

DIRTY="$(/usr/bin/python3 -c 'import json,sys; print(str(json.load(open(sys.argv[1]))["webDirty"]).lower())' "$OUT/local-agent/BUNDLE.json")"
if [ "$DIRTY" = "true" ] && [ "$ALLOW_DIRTY" != "true" ]; then
    echo "the web checkout has uncommitted changes under agents/local-agent or scripts/local-agent; commit them, or pass --allow-dirty for a local test (release.sh refuses such a bundle)" >&2
    exit 1
fi

rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -R "$OUT/local-agent" "$DEST"
/usr/bin/python3 - "$DEST/BUNDLE.json" <<'PY'
import json, sys
b = json.load(open(sys.argv[1]))
dirty = " (DIRTY)" if b["webDirty"] else ""
print("vendored the local agent: web %s%s, eve %s, %d files" % (b["webCommit"], dirty, b["eveVersion"], len(b["files"])))
PY
echo "commit src-tauri/resources/local-agent/ to ship it"
