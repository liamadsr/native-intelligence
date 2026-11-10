#!/usr/bin/env bash
# Package the Mac body for the desktop app: a relocatable folder the app ships
# inside its signed bundle (Contents/Resources/local-agent), run by a pinned
# Node 24 the app downloads on first use. docs/plans/local-agents.md,
# "Packaging"; the Mac body is contract C2 in docs/plans/teammate-agent.md.
#
#   scripts/local-agent/bundle.sh <out-dir>
#
# <out-dir> is replaced. It holds:
#   launcher/launcher.mjs      launcher.ts with eve/client and prompts.ts bundled in (esbuild)
#   launcher/server-guard.ts   the server's preload, as is (Node strips types)
#   .output/                   eve's build of the Mac body: agents/chat-agent with
#                              NI_AGENT_HOST=mac (mac-body.sh; Nitro, self-contained)
#   workers/<worker>.mjs       when agents/local-agent/workers/ exists: the worker
#                              adapters, bundled by its build.sh (L4, F-web's)
#   licenses/NOTICES.txt       the bundled packages and their license texts
#   BUNDLE.json                where it came from (the web commit, eve, Node), a
#                              SHA-256 per file, and `capabilities`: "local-model"
#                              when the host marker says lib/model.ts runs models
#                              on the Mac (every Mac body built from this tree),
#                              "workers" when the adapters are in. The desktop
#                              refuses a feature the bundle doesn't declare.
#
# The agent is built in a throwaway copy, so the build names no path on this
# Mac, and the copy is deleted before the folder is used: a bundle that still
# read its source tree would fail here, not on a person's Mac.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <out-dir>" >&2
  exit 2
fi
repo="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=mac-body.sh
. "$repo/scripts/local-agent/mac-body.sh"
mkdir -p "$1"
out="$(cd "$1" && pwd)"
case "$out" in
  "$repo"|"$repo"/agents*|/|"$HOME") echo "refusing to replace $out" >&2; exit 2 ;;
esac

# A fixed, neutral path: eve's manifest names where the agent was built
# (agentRoot, sourcePath: labels the server never needs to exist), so the
# bundle names this folder and nothing about this Mac. (Two builds of one
# commit still differ in eve's random build id and Nitro's build date.)
stage=/tmp/ni-local-agent-build
if ! mkdir "$stage" 2>/dev/null; then
  echo "$stage exists: another bundle build is running (or remove it)" >&2
  exit 1
fi
trap 'rm -rf "$stage"' EXIT

stage_mac_body "$repo" "$stage"
build_mac_body "$repo" "$stage"

rm -rf "$out"
mkdir -p "$out/launcher" "$out/licenses"
# ESM with a require for the CommonJS deps eve/client pulls in. Run from the
# copy so the module comments name `node_modules/…` (bundle-notices.mjs).
banner="import { createRequire as __niRequire } from 'node:module'; const require = __niRequire(import.meta.url);"
(cd "$stage" && "$repo/node_modules/.bin/esbuild" agents/local-agent/launcher/launcher.ts \
  --bundle --platform=node --format=esm --target=node24 --log-level=warning \
  --banner:js="$banner" --outfile="$out/launcher/launcher.mjs")
cp "$stage/agents/local-agent/launcher/server-guard.ts" "$out/launcher/server-guard.ts"
cp -R "$stage/agents/chat-agent/.output" "$out/.output"

# The worker adapters (F-web's, L4), when there are any.
build_workers "$stage" "$out"
capabilities=()
if ls "$out"/workers/*.mjs >/dev/null 2>&1; then
  capabilities+=(workers)
fi
# A model on the Mac (L4): the build's host marker says its lib/model.ts has a
# local route (mac-body.sh); the launcher passes LOCAL_AGENT_LOCAL_MODEL_* through.
if grep -q '"localModel":true' "$out/.output/dial8-host.json"; then
  capabilities+=(local-model)
fi

# The packages the agent's own code imports, read from the copy: eve inlines
# that code without the bundlers' module comments, so the notices' scan of the
# bundle alone would miss a package only the agent imports.
node "$repo/scripts/local-agent/bundle-notices.mjs" --agent-packages "$repo" "$stage/agents/chat-agent" "$stage/agent-packages.txt"

# The copy goes before anything reads the bundle.
rm -rf "$stage/agents"

# No path on this Mac in what ships (bundle-notices.mjs --scrub).
# node_modules can be a symlink into another checkout (Liam's worktrees share one).
node "$repo/scripts/local-agent/bundle-notices.mjs" --scrub "$out" \
  "$repo" "$(cd "$repo" && pwd -P)" "$(dirname "$(cd "$repo/node_modules" && pwd -P)")" \
  "$HOME" "${TMPDIR:-}" "$(cd "${TMPDIR:-/tmp}" && pwd -P)"
node "$repo/scripts/local-agent/bundle-notices.mjs" "$repo" "$out/licenses" "$stage/agent-packages.txt"

commit="$(git -C "$repo" rev-parse HEAD)"
# Dirty: any change to what the build reads, including gitignored files the
# copy would carry (dot entries, node_modules and tests never enter it).
dirty=false
changes="$(git -C "$repo" status --porcelain --ignored=matching -- \
  agents/chat-agent agents/local-agent scripts/local-agent package.json package-lock.json tsconfig.json |
  grep -Ev '^!! (.*/)?(\.[^/]*|node_modules|__tests__)(/|$)' || true)"
if [ -n "$changes" ]; then
  dirty=true
fi
caps="$(IFS=,; echo "${capabilities[*]:-}")"
node "$repo/scripts/local-agent/bundle-notices.mjs" --stamp "$repo" "$out" "$commit" "$dirty" "$caps"

echo "local-agent bundle: $out (web $commit$([ "$dirty" = true ] && echo ', DIRTY'); capabilities: ${caps:-none}; $(du -sh "$out" | cut -f1))"
