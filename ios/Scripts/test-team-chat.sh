#!/bin/bash
# Team chat's rules on the phone (Core/Models/TeamChat), built and run on the Mac.
set -euo pipefail
cd "$(dirname "$0")/.."
TASK_TMP=$(mktemp -d /tmp/ni-team-chat.XXXXXX)
trap 'rm -rf "$TASK_TMP"' EXIT
swiftc -module-cache-path "$TASK_TMP/modules" Core/Models/TeamChat/*.swift Tests/TeamChat/TeamChatTests.swift -o "$TASK_TMP/tests"
"$TASK_TMP/tests"
