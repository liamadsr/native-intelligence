#!/usr/bin/env bash
# Bundle the worker adapters (Claude Code, Codex) for the desktop:
#
#   agents/local-agent/workers/build.sh <out-dir>
#
# writes <out-dir>/workers/claude-code.mjs and <out-dir>/workers/codex.mjs,
# each self-contained (eve's sandbox provider and the fence inlined), run by
# the desktop as `<node 24> <out-dir>/workers/<worker>.mjs`. Same esbuild
# settings as the launcher's bundle (scripts/local-agent/bundle.sh). Run from
# the repo the script sits in, so the module comments name `node_modules/…`.
#
# The bundle: bundle.sh calls this with its <out-dir>. Dev: after
# scripts/local-agent/build.sh, run it with agents/local-agent/.output (eve's
# build replaces .output), and the desktop's dev path is
# <agentDir>/.output/workers/<worker>.mjs.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <out-dir>" >&2
  exit 2
fi
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
mkdir -p "$1/workers"
out="$(cd "$1" && pwd)"
for worker in claude-code codex; do
  (cd "$repo" && node_modules/.bin/esbuild "agents/local-agent/workers/$worker.ts" \
    --bundle --platform=node --format=esm --target=node24 --log-level=warning \
    --banner:js="import { createRequire as __niRequire } from 'node:module'; const require = __niRequire(import.meta.url);" \
    --outfile="$out/workers/$worker.mjs")
done
echo "local-agent workers: $out/workers/{claude-code,codex}.mjs"
