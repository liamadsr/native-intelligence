#!/bin/sh
# Asks the app to register its functions with the Inngest server, forever.
# Runs as the `sync` service in compose.yaml, which explains why it exists.
#
# The request is a plain PUT to the app's serve endpoint. The app answers by
# POSTing its function list to the server (/fn/register), signed with the
# signing key. Nothing secret is sent from here.
#
# It logs the first answer it gets, every change to the function list after
# that, and every failure. A sync that changes nothing is silent.
set -u

: "${INNGEST_SDK_URL:?INNGEST_SDK_URL is not set}"
interval="${SYNC_INTERVAL_SECONDS:-60}"

# PID 1 ignores signals it has no handler for. Stop at once when asked to.
trap 'exit 0' TERM INT

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

echo "$(now) asking ${INNGEST_SDK_URL} to sync every ${interval}s"

answered=no
while true; do
	if out=$(curl -sS -m 60 -X PUT -w ' HTTP %{http_code}' "$INNGEST_SDK_URL" 2>&1); then
		case "$out" in
			*'"modified":true'*) echo "$(now) functions changed: ${out}" ;;
			*'HTTP 200') [ "$answered" = yes ] || echo "$(now) first sync answered: ${out}" ;;
			*) echo "$(now) sync refused: ${out}" ;;
		esac
		case "$out" in *'HTTP 200') answered=yes ;; esac
	else
		echo "$(now) sync request failed: ${out}"
	fi
	# In the background so the trap can interrupt the wait.
	sleep "$interval" &
	wait $!
done
