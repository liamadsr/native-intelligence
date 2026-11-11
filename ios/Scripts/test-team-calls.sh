#!/bin/bash
# Team calls' rules on the phone (Core/Models/TeamCalls), built and run on the Mac: the VoIP push's
# payload, the ring's state machine against CallKit, the call's session, tiles and message.
set -euo pipefail
cd "$(dirname "$0")/.."
TASK_TMP=$(mktemp -d /tmp/ni-team-calls.XXXXXX)
trap 'rm -rf "$TASK_TMP"' EXIT
swiftc -module-cache-path "$TASK_TMP/modules" Core/Models/TeamChat/*.swift Core/Models/TeamCalls/*.swift Tests/TeamCalls/TeamCallTests.swift -o "$TASK_TMP/tests"
"$TASK_TMP/tests"
