#!/usr/bin/env bash
# after-update.sh
#
# Run in a checkout, right after Supabase's stack/update.sh has brought in a
# new release, before anything is committed. README.md, "Updating to a new
# Supabase release", is the whole procedure; this is its second step.
#
#   1. Compares the settings of their new example file with ours and says
#      which ones the release added (check-env.sh does the comparing).
#   2. Removes what update.sh leaves behind and what is never committed:
#      the throwaway stack/.env, stack/backups, and the two things of theirs
#      this repository does not keep, stack/.env.example and stack/tests.
#      Those hold Supabase's public demo keys, which the repository's leak
#      check (.github/guard.sh) rightly refuses; update.sh puts them back on
#      every run because it finds them missing.
#   3. Puts a new update.sh in place if the release brought one.
#   4. Checks that the one change gateway/entrypoint.sh makes to the
#      gateway's routes at start-up still finds its place in this release.
#   5. Reads their compose file with ours on top, and fails if the result
#      publishes a port or runs a service that is meant to be off. This is
#      where an override that stopped applying shows up.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"
failed=0

# The throwaway settings file update.sh was given goes first: with it gone,
# check-env.sh compares the two example files and nothing else.
#
# On the server stack/.env is the real one, and deleting it there would take
# the database password and the JWT secret with it. So it is only deleted
# when it is what the procedure leaves behind: empty, or holding nothing but
# what update.sh appended to an empty file (which it marks with a comment).
if [ -s stack/.env ]; then
	first="$(grep -m 1 -v '^[[:space:]]*$' stack/.env || true)"
	case "$first" in
		'# Added by update.sh'*) ;;
		*)
			echo "stack/.env holds settings that update.sh did not put there: this looks like the server, or a stack in use." >&2
			echo "This script is for a checkout that is about to become a pull request. Nothing was changed." >&2
			exit 1
			;;
	esac
fi
rm -rf stack/.env stack/.env.old stack/backups

echo "== their settings against ours"
if [ -f stack/.env.example ]; then
	./check-env.sh || failed=1
else
	echo "  stack/.env.example is not there: run stack/update.sh first (it brings it back each time)"
	failed=1
fi

echo "== removing what is not committed"
rm -rf stack/tests stack/.env.example
if [ -f stack/update.sh.dist ]; then
	mv stack/update.sh.dist stack/update.sh
	echo "  the release changed update.sh itself: the new one is in place"
fi

echo "== the gateway's start-up change (gateway/entrypoint.sh)"
# The same two things the entrypoint checks when the container starts, so
# that a release which moves them is noticed here and not in production.
their_entrypoint=stack/volumes/api/envoy/docker-entrypoint.sh
their_routes=stack/volumes/api/envoy/lds.template.yaml
if ! grep -q '^exec envoy ' "$their_entrypoint" 2>/dev/null; then
	echo "  PROBLEM: $their_entrypoint no longer starts Envoy with 'exec envoy': the gateway would refuse to start"
	failed=1
fi
before="$(grep -c '^ *timeout: 0s$' "$their_routes" 2>/dev/null || true)"
# (The expression is the one in gateway/entrypoint.sh.)
after="$(sed '/^ *prefix: \/storage\/v1\/$/,/^ *timeout:/ s/^\( *\)timeout: .*/\1timeout: 0s/' "$their_routes" 2>/dev/null | grep -c '^ *timeout: 0s$' || true)"
if [ "${after:-0}" -eq $((${before:-0} + 1)) ]; then
	echo "  the Storage route's time limit is where it is expected"
else
	echo "  PROBLEM: the Storage route's timeout is not found exactly once in $their_routes: the gateway would refuse to start. Read gateway/entrypoint.sh against the new file."
	failed=1
fi

echo "== their compose file with ours on top"
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
	env_file="$(mktemp)"
	trap 'rm -f "$env_file"' EXIT
	# Our example, with the three switches Compose insists on filled in.
	sed -E 's/^(GOOGLE_ENABLED|APPLE_ENABLED|HOOK_BEFORE_USER_CREATED_ENABLED)=$/\1=false/' .env.example >"$env_file"
	if merged="$(docker compose --project-directory stack --env-file "$env_file" \
		-f stack/docker-compose.yml -f compose.override.yaml config 2>&1)"; then
		ports="$(grep -c 'published:' <<<"$merged" || true)"
		services="$(docker compose --project-directory stack --env-file "$env_file" \
			-f stack/docker-compose.yml -f compose.override.yaml config --services 2>/dev/null | sort | tr '\n' ' ')"
		echo "  services: $services"
		if [ "$ports" != 0 ]; then
			echo "  PROBLEM: $ports port(s) would be published on the host. An override no longer applies:"
			grep -B 6 'published:' <<<"$merged" | grep -E '^  [a-z-]+:$|published:' | sed 's/^/    /' || true
			failed=1
		fi
		for off in imgproxy analytics vector; do
			case " $services " in *" $off "*) echo "  PROBLEM: the service $off would run"; failed=1 ;; esac
		done
		for needed in api-gw auth db functions mail-templates meta realtime rest storage studio supavisor; do
			case " $services " in *" $needed "*) ;; *) echo "  PROBLEM: the service $needed is gone (renamed by the release?)"; failed=1 ;; esac
		done
		grep -q 'port_value: 80$' <<<"$merged" || { echo "  PROBLEM: the public listener is no longer in the gateway's command"; failed=1; }
		grep -q '/ni/gateway-entrypoint.sh' <<<"$merged" || { echo "  PROBLEM: the gateway no longer starts through gateway/entrypoint.sh"; failed=1; }
		grep -q 'name: ni-supabase-edge$' <<<"$merged" || { echo "  PROBLEM: the gateway is no longer on the network it shares with Caddy (ni-supabase-edge)"; failed=1; }
		if grep -q 'name: ni-edge$' <<<"$merged"; then
			echo "  PROBLEM: something in this stack is on ni-edge, the network every other stack is on"
			failed=1
		fi
		grep -q 'GOTRUE_RATE_LIMIT_HEADER: X-Real-IP$' <<<"$merged" || { echo "  PROBLEM: Auth is no longer told which header carries the client's address (GOTRUE_RATE_LIMIT_HEADER)"; failed=1; }
	else
		echo "$merged" | tail -n 5 | sed 's/^/  /'
		echo "  PROBLEM: the two files no longer merge"
		failed=1
	fi
else
	echo "  skipped: docker compose is not installed here. Run it where it is before merging."
fi

echo
if [ "$failed" = 0 ]; then
	echo "Good. Now: git add -A . && git add -f stack/.supabase-version"
else
	echo "Not ready to commit: see PROBLEM above."
	exit 1
fi
