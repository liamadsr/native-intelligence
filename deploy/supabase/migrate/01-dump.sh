#!/usr/bin/env bash
# 01-dump.sh [--out <folder>]
#
# Dumps the hosted project the way Supabase's restore guide says to
# (https://supabase.com/docs/guides/self-hosting/restore-from-platform, step 2):
# three plain-SQL files written by the Supabase CLI, never a raw pg_dump.
#
#   roles.sql    supabase db dump --role-only
#   schema.sql   supabase db dump
#   data.sql     supabase db dump --use-copy --data-only
#
# and one file the guide does not have, because the CLI leaves out what it
# covers (see sql/managed-schema-objects.sql):
#
#   extras.sql   the app's own policies and triggers on auth, storage and
#                realtime tables, and the pg_cron jobs
#
# Read-only on the hosted project. The files hold every user's email address,
# password hash and data: the folder is root-only, and is deleted by hand
# once the move is over (README.md).
#
# Needs: the Supabase CLI (SUPABASE_CLI, default `supabase`) and Docker, which
# the CLI uses to run pg_dump from Supabase's own Postgres image.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
load_settings
need SOURCE_DB_URL

out=""
while [ $# -gt 0 ]; do
	case "$1" in
		--out) out="${2:?--out needs a folder}"; shift 2 ;;
		*) die "unknown argument: $1" ;;
	esac
done
out="${out:-$MIGRATE_DIR/dumps/$(date -u +%Y%m%dT%H%M%SZ)}"

cli="${SUPABASE_CLI:-supabase}"
command -v "$cli" >/dev/null || die "the Supabase CLI ($cli) is not installed. See README.md, \"Before you start\"."

umask 077
mkdir -p "$out"
out="$(cd "$out" && pwd)"
[ -z "$(ls -A "$out")" ] || die "$out is not empty"
log "dumping into $out ($("$cli" --version 2>/dev/null | head -n 1))"

# The CLI treats the folder it runs in as a project folder; an empty one keeps
# it from picking up anything.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
dump() { # dump <file> [flags]
	local file="$1"
	shift
	log "  $file"
	(cd "$work" && "$cli" db dump --remote="$SOURCE_DB_URL" -f "$out/$file" "$@") \
		|| die "supabase db dump failed for $file"
	[ -s "$out/$file" ] || die "$file is empty"
}
dump roles.sql --role-only
dump schema.sql
dump data.sql --use-copy --data-only

log "  extras.sql"
has_cron="$(query_source "select exists (select 1 from pg_extension where extname = 'pg_cron')")"
psql_source -q -At -v "managed=$MANAGED_SCHEMAS" -v "has_cron=$has_cron" -f - \
	<"$MIGRATE_DIR/sql/managed-schema-objects.sql" >"$out/extras.sql" \
	|| die "could not read the app's policies and triggers from the source"

# What the source looked like, for the restore to check itself against.
query_source "select extname || ' ' || extversion from pg_extension order by 1" >"$out/extensions.txt"

log "done:"
(cd "$out" && wc -c roles.sql schema.sql data.sql extras.sql | sed 's/^/  /')
log "carried in extras.sql: $(grep -c '^create policy' "$out/extras.sql" || true) policies, $(grep -c '^create or replace trigger' "$out/extras.sql" || true) triggers, $(grep -c '^select cron.schedule' "$out/extras.sql" || true) cron jobs"
log "next: sudo $MIGRATE_DIR/02-restore.sh $out"
