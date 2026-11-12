#!/usr/bin/env bash
# Stops the LiveKit start-livekit.sh started.
here="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$here/run/livekit.pid" ]; then
	kill "$(cat "$here/run/livekit.pid")" 2>/dev/null || true
	rm -f "$here/run/livekit.pid"
fi
echo "livekit stopped"
