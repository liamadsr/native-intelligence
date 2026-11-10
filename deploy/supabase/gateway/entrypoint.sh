#!/bin/sh
# The gateway's entrypoint, run in front of Supabase's own.
#
# Supabase's entrypoint (stack/volumes/api/envoy/docker-entrypoint.sh) writes
# the gateway's routes to /etc/envoy/lds.yaml and then starts Envoy. One line
# of what it writes is wrong for this server: the Storage route carries
# `timeout: 30s`, and in Envoy that limits the whole response, so a download
# that takes longer than 30 seconds is cut off in the middle. Measured on
# release 0.8.4: a 40 MB file read at 500 KB/s stopped after 25 MB. The hosted
# platform has no such limit.
#
# None of their files is edited. Their entrypoint runs as it is, and this
# script changes that one line in what it wrote, just before Envoy starts.
# How: their entrypoint ends in `exec envoy …`. Stage 1 below puts a two-line
# `envoy` of its own first on the PATH and runs their entrypoint; that
# stand-in calls back into this script (stage 2), which makes the change and
# starts the real Envoy with the arguments it was given.
#
# With the limit gone, a transfer may take as long as it needs. One that goes
# silent is still dropped by Envoy after 5 minutes without a byte (its
# default stream idle timeout).
#
# It fails closed. If their entrypoint no longer ends in `exec envoy`, or the
# Storage route is not where it is expected, the gateway does not start, Caddy
# answers 502 for the Supabase host, and this container's log says why.
# ../after-update.sh checks the same two things when a release is taken.
set -eu

me=/ni/gateway-entrypoint.sh
theirs=/docker-entrypoint.sh
routes=/etc/envoy/lds.yaml

fail() {
	echo "ni gateway: FAILED: $*" >&2
	echo "ni gateway: see deploy/supabase/gateway/entrypoint.sh" >&2
	exit 1
}

if [ "${1:-}" != --ni-stage-2 ]; then
	# Stage 1.
	grep -q '^exec envoy ' "$theirs" || fail "$theirs no longer starts Envoy with 'exec envoy'"
	real="$(command -v envoy)" || fail "no envoy in this image"
	bin="$(mktemp -d)"
	printf '#!/bin/sh\nexec /bin/sh %s --ni-stage-2 %s "$@"\n' "$me" "$real" >"$bin/envoy"
	chmod +x "$bin/envoy"
	PATH="$bin:$PATH" exec /bin/sh "$theirs" "$@"
fi

# Stage 2: their entrypoint has written the routes and is starting Envoy.
shift
real="$1"
shift
[ -s "$routes" ] || fail "$routes is missing or empty"
# The first `timeout:` line after the Storage route's prefix, and only that
# line (anchored, so an `idle_timeout:` is never taken for it).
before="$(grep -c '^ *timeout: 0s$' "$routes" || true)"
sed '/^ *prefix: \/storage\/v1\/$/,/^ *timeout:/ s/^\( *\)timeout: .*/\1timeout: 0s/' "$routes" >"$routes.ni"
after="$(grep -c '^ *timeout: 0s$' "$routes.ni" || true)"
[ "$after" -eq $((before + 1)) ] || fail "the Storage route's timeout was not found exactly once in $routes (a release changed its shape)"
cat "$routes.ni" >"$routes"
rm -f "$routes.ni"
echo "ni gateway: the Storage route has no overall time limit"
exec "$real" "$@"
