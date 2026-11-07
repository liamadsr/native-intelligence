#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
TASK_TMP=$(mktemp -d /tmp/dial8-eve-tests.XXXXXX)
python3 Tests/EveChat/fixture_server.py "$TASK_TMP/port" > "$TASK_TMP/server.log" 2>&1 &
TASK_SERVER_PID=$!
trap 'kill "$TASK_SERVER_PID" 2>/dev/null || true; cat "$TASK_TMP/server.log"; rm -rf "$TASK_TMP"' EXIT
swiftc -module-cache-path "$TASK_TMP/modules" Core/Services/AIChat/EveChatProtocol.swift Core/Services/AIChat/EveChatService.swift Tests/EveChat/Support.swift Tests/EveChat/ContractTests.swift -o "$TASK_TMP/tests"
for ((attempt=0; attempt<300; attempt++)); do
    if [ -s "$TASK_TMP/port" ]; then break; fi
    kill -0 "$TASK_SERVER_PID" 2>/dev/null || { cat "$TASK_TMP/server.log"; exit 1; }
    sleep 0.1
done
[ -s "$TASK_TMP/port" ] || { cat "$TASK_TMP/server.log"; exit 1; }
EVE_TEST_PORT=$(cat "$TASK_TMP/port") "$TASK_TMP/tests"
