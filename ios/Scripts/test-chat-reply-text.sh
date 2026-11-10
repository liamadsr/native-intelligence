#!/bin/bash
# The chat bubble's comment stripping (Core/Models/ChatReplyText.swift), built and run on the Mac.
set -euo pipefail
cd "$(dirname "$0")/.."
TASK_TMP=$(mktemp -d /tmp/ni-chat-reply-text.XXXXXX)
trap 'rm -rf "$TASK_TMP"' EXIT
swiftc -O -module-cache-path "$TASK_TMP/modules" Core/Models/ChatReplyText.swift Tests/ChatReplyText/ChatReplyTextTests.swift -o "$TASK_TMP/tests"
"$TASK_TMP/tests"
