#!/bin/sh
# Asks the app to register its functions with the Inngest server, forever.
# Runs as the `sync` service in compose.yaml, which explains why it exists.
#
# The request is the one the server's own poll sends: PUT <serve URL>. The app
# answers by POSTing its function list to the server (/fn/register), signed
# with the signing key. Nothing secret is sent from here.
set -u

: "${INNGEST_SDK_URL:?INNGEST_SDK_URL is not set}"
interval="${SYNC_INTERVAL_SECONDS:-60}"

# PID 1 ignores signals it has no handler for. Stop at once when asked to.
trap 'exit 0' TERM INT

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

echo "$(now) asking ${INNGEST_SDK_URL} to sync every ${interval}s"

while true; do
	if out=$(curl -sS -m 60 -X PUT -w ' HTTP %{http_code}' "$INNGEST_SDK_URL" 2>&1); then
		case "$out" in
			*'"modified":true'*) echo "$(now) functions changed: ${out}" ;;
			*'HTTP 200') ;;
			*) echo "$(now) sync refused: ${out}" ;;
		esac
	else
		echo "$(now) sync request failed: ${out}"
	fi
	# In the background so the trap can interrupt the wait.
	sleep "$interval" &
	wait $!
done
