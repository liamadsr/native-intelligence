#!/bin/bash
# Move a sidecar's upstream submodule to a new commit, rebuild, and bench it.
#
#   scripts/modules/bump.sh <sidecar> <git ref>     e.g. bump.sh local-stt origin/main
#
# Leaves the submodule moved and the build in .out/; commit the submodule
# change plus the bench numbers in the sidecar's UPSTREAM.md if the gates hold.
set -euo pipefail

SIDECAR="${1:?usage: bump.sh <sidecar> <git ref>}"
REF="${2:?usage: bump.sh <sidecar> <git ref>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$ROOT/src-tauri/sidecars/$SIDECAR"
UP="$DIR/upstream"
[ -d "$UP" ] || { echo "no upstream submodule in $DIR" >&2; exit 1; }

# Upstreams may keep assets in Git LFS we never build — skip LFS entirely.
export GIT_LFS_SKIP_SMUDGE=1
export GIT_CONFIG_COUNT=4
export GIT_CONFIG_KEY_0=filter.lfs.process GIT_CONFIG_VALUE_0=
export GIT_CONFIG_KEY_1=filter.lfs.smudge  GIT_CONFIG_VALUE_1=cat
export GIT_CONFIG_KEY_2=filter.lfs.clean   GIT_CONFIG_VALUE_2=cat
export GIT_CONFIG_KEY_3=filter.lfs.required GIT_CONFIG_VALUE_3=false

OLD="$(git -C "$UP" rev-parse --short HEAD)"
# Our patches and upstream's own build-time patching dirty the tree; reset it
# (and its nested submodules) before moving.
git -C "$UP" reset -q --hard
git -C "$UP" submodule foreach -q --recursive 'git reset -q --hard; git clean -qfd'
git -C "$UP" fetch -q origin
git -C "$UP" checkout -q "$REF"
git -C "$UP" submodule update -q --init --depth 1 ggml llama.cpp 2>/dev/null || true
NEW="$(git -C "$UP" rev-parse --short HEAD)"
echo "[bump] $SIDECAR upstream $OLD → $NEW"
# -n, not `| head`: head closing the pipe SIGPIPEs git, and pipefail ends the script.
git -C "$UP" log --oneline -n 40 "$OLD..$NEW"

# The submodule has moved but the new pin is not committed yet: build it anyway.
SIDECAR_ALLOW_UNPINNED=1 "$DIR/build.sh" release
if [ -x "$DIR/bench/bench.sh" ]; then
    echo "[bump] bench:"
    "$DIR/bench/bench.sh"
fi
echo "[bump] if the gates hold: record the numbers in $DIR/UPSTREAM.md and commit the submodule move."
