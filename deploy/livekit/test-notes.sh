#!/usr/bin/env bash
# Checks everything a call's notes depend on, without a call and at no cost: the
# recorder is up and has reached the app lately, the app accepts its secret and has
# the recorder on, the live agent answers, LiveKit answers, and Deepgram accepts the
# key and opens a streaming socket (closed before any audio is sent). One ok/FAIL
# line per check; exits 0 only when all pass. Reads and writes nothing in the app.
# Run it before a call that matters.
#
#   sudo ./test-notes.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
[ "$(id -u)" = 0 ] || { echo "Run it with sudo: .env is root's alone." >&2; exit 1; }
exec docker compose -f "$here/compose.yaml" exec -T recorder node src/main.ts --check
