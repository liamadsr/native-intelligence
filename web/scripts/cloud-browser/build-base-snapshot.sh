#!/bin/bash
# Build the cloud browser's base snapshot (docs/plans/cloud-browser.md, C0) and
# print its id. Run from the repo root, signed in to the Vercel CLI:
#   bash scripts/cloud-browser/build-base-snapshot.sh
# Then set CLOUD_BROWSER_BASE_SNAPSHOT_ID to the printed id (per environment).
# Rebuild to update Chrome; existing browsers keep their own snapshot until
# they are recreated. The snapshot never expires (every browser is created from it).
set -euo pipefail
PROJECT=${PROJECT:-dial8-website}
HERE="$(cd "$(dirname "$0")" && pwd)"
# The Vercel team: SCOPE, or the one the main checkout is linked to, as in
# scripts/main-checkout.ts (a worktree has no .vercel of its own).
MAIN="$(git rev-parse --path-format=absolute --git-common-dir)/../$(git rev-parse --show-prefix)"
SCOPE=${SCOPE:-$(node -e '
  const fs = require("fs"), dir = process.argv[1] + "/.vercel/"
  const read = (f) => { try { return JSON.parse(fs.readFileSync(dir + f, "utf8")) } catch { return {} } }
  const linked = read("repo.json").projects ?? []
  process.stdout.write(read("project.json").orgId ?? (linked.find((p) => p.name === process.argv[2]) ?? linked[0])?.orgId ?? "")
' "$MAIN" "$PROJECT")}
NAME="cloud-browser-base-$(date +%Y%m%d%H%M%S)"
SB=(--project="$PROJECT" ${SCOPE:+--scope="$SCOPE"})

trap 'vercel sandbox remove "${SB[@]}" "$NAME" >/dev/null 2>&1 || true' EXIT
vercel sandbox create "${SB[@]}" --name "$NAME" --image vercel/sandbox/universal --vcpus 2 --timeout 30m --non-persistent >/dev/null
vercel sandbox exec "${SB[@]}" "$NAME" -- mkdir -p /tmp/cloud-browser-base >/dev/null
for f in install.sh start.sh stop.sh close-chrome.mjs; do
  vercel sandbox copy "${SB[@]}" "$HERE/base/$f" "$NAME:/tmp/cloud-browser-base/$f" >/dev/null
done
vercel sandbox exec "${SB[@]}" "$NAME" -- bash /tmp/cloud-browser-base/install.sh
# Prove the image boots a browser before snapshotting it, then close everything
# (Chrome and Xvfb) cleanly. start.sh runs in the background, as the host runs it:
# a command that leaves Chrome running never counts as finished.
vercel sandbox exec "${SB[@]}" "$NAME" -- bash -c 'setsid bash /opt/cloud-browser/start.sh </dev/null >/tmp/boot.out 2>&1 &
  for _ in $(seq 100); do curl -s -m 1 -o /dev/null http://127.0.0.1:9222/json/version && break; sleep 0.3; done
  curl -s -m 1 http://127.0.0.1:9222/json/version | grep -q Browser || { cat /tmp/boot.out; exit 1; }
  bash /opt/cloud-browser/stop.sh'
# Every person starts from an empty profile, not the one the boot check made.
vercel sandbox exec "${SB[@]}" "$NAME" -- bash -c 'rm -rf /home/ubuntu/profile /tmp/cloud-browser-base /tmp/*.log /tmp/boot.out /tmp/cloud-browser-start.* &&
  mkdir -p /home/ubuntu/profile/Default &&
  echo "{\"session\":{\"restore_on_startup\":1}}" > /home/ubuntu/profile/Default/Preferences'
vercel sandbox snapshot "${SB[@]}" "$NAME" --stop --expiration 0 | tail -1
