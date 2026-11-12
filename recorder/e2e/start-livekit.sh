#!/usr/bin/env bash
# A throwaway local LiveKit for the end-to-end run (run.mjs), configured as deploy/livekit/compose.yaml
# renders it (room.auto_create off; webhooks off), with fresh keys kept in e2e/run/ and never printed.
# Two settings are the test's own: remote unmute (the scenario mutes a person from the server, as their
# own mute reaches LiveKit), and no load limit (a busy laptop would otherwise refuse joins).
#
#   LIVEKIT_SERVER_BIN=/path/to/livekit-server ./start-livekit.sh
#
# The binary is LiveKit's own release (the version deploy/livekit/compose.yaml pins).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
bin="${LIVEKIT_SERVER_BIN:?set LIVEKIT_SERVER_BIN to a livekit-server binary}"
mkdir -p "$here/run"
raw="$(head -c 600 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')"
key="API${raw:0:12}"
secret="${raw:12:48}"
printf '{"key":"%s","secret":"%s"}\n' "$key" "$secret" >"$here/run/keys.json"
cat >"$here/run/livekit.yaml" <<EOF
port: 7880
logging:
  level: info
rtc:
  udp_port: 7882
  tcp_port: 7881
  node_ip: 127.0.0.1
keys:
  $key: $secret
webhook:
  api_key: $key
  urls: []
turn:
  enabled: false
node_selector:
  kind: any
  sysload_limit: 1000
room:
  auto_create: false
  enable_remote_unmute: true
EOF
LIVEKIT_CONFIG="$(cat "$here/run/livekit.yaml")" nohup "$bin" --bind 127.0.0.1 >"$here/run/livekit.log" 2>&1 &
echo $! >"$here/run/livekit.pid"
for _ in $(seq 1 40); do
	if curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7880/ | grep -q 200; then echo "livekit up"; exit 0; fi
	sleep 0.5
done
echo "livekit did not come up"; tail -30 "$here/run/livekit.log"; exit 1
