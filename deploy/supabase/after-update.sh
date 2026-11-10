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
#   4. Reads their compose file with ours on top, and fails if the result
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
