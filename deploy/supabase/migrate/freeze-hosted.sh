#!/usr/bin/env bash
# freeze-hosted.sh status | on | off   [--yes]
#
# Makes the HOSTED project refuse every change (on), or accept them again
# (off). It is the one script here that changes anything on the hosted side,
# and what it changes is four switches of its own, never a row of data:
# sql/freeze.sql says what they are and which of them Supabase documents.
#
#   on      at the real switch, after the door is closed and before the final
#           dump (../../README.md, step 18.2). From then on, whatever still
#           talks to the hosted project directly is refused where the person
#           can see it, instead of writing data that would be left behind.
#           The project then STAYS frozen until it is retired.
#   off     the first step of going back (step 19).
#   status  which parts are on. Read-only.
#
# REHEARSE ON THE DEV PROJECT FIRST: on, look at the app, off, look again.
# Point this script at it for that one run:
#   sudo SOURCE_DB_URL='<the dev project's session pooler URL>' ./freeze-hosted.sh on
# (with a space in front of `sudo` if the shell is set to keep such lines out
# of its history: the URL holds a password).
#
# It uses SOURCE_DB_URL from ./.env and nothing else. Without this script, or
# once ./.env has been deleted: paste sql/freeze.sql or sql/thaw.sql into the
# project's SQL editor. They are plain SQL.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
load_settings
need SOURCE_DB_URL

action=""
yes=false
for arg in "$@"; do
	case "$arg" in
		status | on | off) action="$arg" ;;
		--yes) yes=true ;;
		*) die "unknown argument: $arg" ;;
	esac
done
[ -n "$action" ] || die "usage: freeze-hosted.sh status | on | off   [--yes]"

# Which project this is, in words a person can check: the host in the URL
# (never the password) and what the database says about itself.
host="${SOURCE_DB_URL#*@}"
host="${host%%[:/?]*}"
facts="$(query_source "select current_database() || ', ' || (select count(*) from auth.users) || ' users, ' || (select count(*) from pg_tables where schemaname = 'public') || ' tables in public'")" \
	|| die "cannot reach the project at ${host}"

tab="$(printf '\t')"
status() { psql_source -q -At -F "$tab" -f - <"$MIGRATE_DIR/sql/freeze-status.sql"; }
show() { # show <status lines>
	awk -F '\t' '{ printf "  %-40s %s\n", $1, $2 }' <<<"$1"
}

log "the project at ${host} (${facts})"
case "$action" in
	status)
		now="$(status)" || die "could not read the state"
		show "$now"
		;;
	on)
		if ! $yes; then
			[ -t 0 ] || die "this makes the project refuse every change; pass --yes to confirm when not typing at a terminal"
			printf 'This makes the project at %s REFUSE EVERY CHANGE until "off" is run. Type freeze to go on: ' "$host"
			read -r answer
			[ "$answer" = freeze ] || die "not confirmed"
		fi
		out="$(psql_source -q -f - <"$MIGRATE_DIR/sql/freeze.sql" 2>&1)" || { echo "$out" >&2; die "freezing failed (the lines above); run 'status' to see what is on"; }
		[ -z "$out" ] || awk '{ print "  " $0 }' <<<"$out" >&2
		now="$(status)" || die "frozen, but the state could not be read back"
		show "$now"
		grep -q "^Data API.*${tab}on$" <<<"$now" || die "the Data API part is not on: the project still accepts changes"
		if grep -qv "${tab}on$" <<<"$now"; then
			warn "a part above is not on (the reason is in the WARNING lines). What it would have refused is still accepted:"
			warn "  Storage trigger off  = uploads made with the service-role key"
			warn "  Accounts off         = sign-ups and sign-ins. Switch sign-ups off in the dashboard instead (Authentication, Sign In / Providers, \"Allow new users to sign up\")."
		fi
		log "frozen. Check it from outside before going on (../../README.md, step 18.2 has the two requests)."
		;;
	off)
		out="$(psql_source -q -f - <"$MIGRATE_DIR/sql/thaw.sql" 2>&1)" || { echo "$out" >&2; die "thawing failed (the lines above); run 'status' to see what is still on"; }
		[ -z "$out" ] || awk '{ print "  " $0 }' <<<"$out" >&2
		now="$(status)" || die "thawed, but the state could not be read back"
		show "$now"
		if grep -qv "${tab}off$" <<<"$now"; then
			die "a part is still on (above). The project is still refusing those changes: this needs Supabase support if 'off' cannot remove it."
		fi
		log "the project accepts changes again."
		;;
esac
