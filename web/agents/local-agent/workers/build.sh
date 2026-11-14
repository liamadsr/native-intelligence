#!/usr/bin/env bash
# Bundle the worker for the desktop:
#
#   agents/local-agent/workers/build.sh <out-dir>
#
# writes <out-dir>/workers/worker.mjs, self-contained (the registry, eve's
# sandbox checks and the fence inlined), run by the desktop as
# `<node 24> <out-dir>/workers/worker.mjs` for every worker. It starts the
# person's own CLI directly: no package of either vendor is in it or beside
# it. Same esbuild settings as the launcher's bundle
# (scripts/local-agent/bundle.sh). Run from the repo the script sits in, so
# the module comments name `node_modules/…`.
#
# The bundle: bundle.sh calls this with its <out-dir>. Dev: after
# scripts/local-agent/build.sh, run it with agents/local-agent/.output (eve's
# build replaces .output), and the desktop's dev path is
# <agentDir>/.output/workers/worker.mjs.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <out-dir>" >&2
  exit 2
fi
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
mkdir -p "$1/workers"
out="$(cd "$1" && pwd)"
(cd "$repo" && node_modules/.bin/esbuild agents/local-agent/workers/worker.ts \
  --bundle --platform=node --format=esm --target=node24 --log-level=warning \
  --banner:js="import { createRequire as __niRequire } from 'node:module'; const require = __niRequire(import.meta.url);" \
  --outfile="$out/workers/worker.mjs")
# What earlier builds left: the ACP-era entry and the per-agent bundles before it.
rm -f "$out/workers/acp.mjs" "$out/workers/claude-code.mjs" "$out/workers/codex.mjs"
echo "local-agent workers: $out/workers/worker.mjs"
