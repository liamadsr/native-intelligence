#!/usr/bin/env bash
# Install the ACP adapters registry.json pins into one folder the desktop
# passes as LOCAL_AGENT_ACP_DIR:
#
#   agents/local-agent/workers/install-agents.sh <out-dir>
#
# writes <out-dir>/node_modules/… exactly as acp-adapters/package-lock.json
# says (`npm ci`: every package, nested ones too, at its locked version and
# integrity). `--ignore-scripts`: no install script of any package runs.
# `--omit=optional`: the adapters' optional platform builds of the CLIs
# themselves (~340 MB each) are left out, because a worker runs the person's
# own CLI ($CLI in the registry). Needs node and npm on PATH and the network;
# nothing in web/ changes.
#
# To change a version: edit registry.json and acp-adapters/package.json
# together, then in acp-adapters run
#   npm install --package-lock-only --ignore-scripts --omit=optional
# and commit the new lockfile.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <out-dir>" >&2
  exit 2
fi
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$1"
out="$(cd "$1" && pwd)"
# The lockfile's top-level packages must be exactly the registry's.
node -e '
  const reg = require(process.argv[1])
  const pkg = require(process.argv[2])
  const want = Object.assign({}, ...Object.values(reg).map((e) => e.packages))
  const have = pkg.dependencies || {}
  const same = Object.keys(want).length === Object.keys(have).length && Object.entries(want).every(([n, v]) => have[n] === v)
  if (!same) { console.error("acp-adapters/package.json does not match registry.json packages"); process.exit(1) }
' "$here/registry.json" "$here/acp-adapters/package.json"
cp "$here/acp-adapters/package.json" "$here/acp-adapters/package-lock.json" "$out/"
(cd "$out" && npm ci --no-audit --no-fund --ignore-scripts --omit=optional)
echo "ACP adapters in $out/node_modules"
