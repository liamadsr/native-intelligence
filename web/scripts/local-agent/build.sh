#!/usr/bin/env bash
# Build the Mac body (the Native Intelligence agent, agents/chat-agent, with
# NI_AGENT_HOST=mac; scripts/local-agent/mac-body.sh) into
# agents/local-agent/.output, the self-hosted Nitro server the launcher starts
# from LOCAL_AGENT_DIR=agents/local-agent in dev (dev.json, smoke.ts,
# e2e-device.ts), plus the workers when there are any (the desktop's dev
# path): .output/workers/acp.mjs, .output/workers/registry.json and
# .output/acp/, the agents' protocol adapters (installed with npm: needs the
# network). Built in a throwaway copy, deleted before the output is used.
# Extra arguments go to `eve build`. See agents/local-agent/README.md.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=mac-body.sh
. "$repo/scripts/local-agent/mac-body.sh"

stage="$(mktemp -d "${TMPDIR:-/tmp}/ni-mac-body.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
stage_mac_body "$repo" "$stage"
build_mac_body "$repo" "$stage" "$@"

out="$repo/agents/local-agent/.output"
rm -rf "$out"
cp -R "$stage/agents/chat-agent/.output" "$out"
build_workers "$stage" "$out"
build_studio "$stage" "$out/studio"
rm -rf "$stage"
test -f "$out/server/index.mjs"
echo "Mac body built: $out/server/index.mjs"
