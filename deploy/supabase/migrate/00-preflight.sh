#!/usr/bin/env bash
# 00-preflight.sh
#
# Looks at both sides before anything is moved. Read-only. Run it first, and
# again right before the real switch.
#
# It says what will move, what no step moves (so that it can be done by
# hand), and what would stop the restore: an extension this Postgres image
# lacks, a target that is not empty, an endpoint that does not answer.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
load_settings
need SOURCE_DB_URL SOURCE_S3_ENDPOINT SOURCE_S3_REGION SOURCE_S3_ACCESS_KEY_ID SOURCE_S3_SECRET_ACCESS_KEY

problems=0
problem() {
	echo "  PROBLEM: $*"
	problems=$((problems + 1))
}

cli="${SUPABASE_CLI:-supabase}"
echo "Tools"
if command -v "$cli" >/dev/null; then
	echo "  Supabase CLI: $("$cli" --version 2>/dev/null | head -n 1)"
else
	problem "the Supabase CLI ($cli) is not installed: 01-dump.sh needs it (README.md, \"Before you start\")"
fi
echo "  Docker: $(docker version --format '{{.Server.Version}}')"

echo "The hosted project"
src() { query_source "$1"; }
src "select 1" >/dev/null || die "cannot connect to the hosted database: check SOURCE_DB_URL"
echo "  Postgres $(src "show server_version"), database size $(src "select pg_size_pretty(pg_database_size(current_database()))")"
echo "  $(src "select count(*) from pg_tables where schemaname = 'public'") tables in public, $(src "select count(*) from auth.users") users, $(src "select count(*) from auth.identities") identities"
echo "  $(src "select count(*) from pg_policies") policies, $(src "select count(*) from pg_publication_tables where pubname = 'supabase_realtime'") tables in the supabase_realtime publication"
echo "  extensions: $(src "select string_agg(extname || ' ' || extversion, ', ' order by extname) from pg_extension where extname <> 'plpgsql'")"
echo "  buckets:"
src "select '    ' || b.id || ': ' || count(o.id) || ' files, ' || pg_size_pretty(coalesce(sum((o.metadata ->> 'size')::bigint), 0)) || case when b.public then ' (PUBLIC)' else ' (private)' end from storage.buckets b left join storage.objects o on o.bucket_id = b.id group by b.id, b.public order by b.id"
echo "  settings stored on roles:"
src "select '    ' || r.rolname || ': ' || array_to_string(s.setconfig, ', ') from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname in ('anon', 'authenticated', 'authenticator', 'service_role', 'postgres') or r.rolname !~ '^(supabase_|pg_)' order by 1"

echo "Carried over by a step of its own (extras.sql), because the dump leaves it out"
echo "  $(src "select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname in ($MANAGED_SCHEMAS)") policies on auth, storage and realtime tables"
echo "  $(src "select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace where not t.tgisinternal and n.nspname in ($MANAGED_SCHEMAS) and pn.nspname not in ($MANAGED_SCHEMAS)") triggers of the app on those tables"
if [ "$(src "select exists (select 1 from pg_extension where extname = 'pg_cron')")" = t ]; then
	echo "  pg_cron jobs:"
	src "select '    ' || coalesce(jobname, '(no name)') || ': ' || schedule || case when active then '' else ' (inactive)' end from cron.job order by jobid" | sed -e '$!b' -e 's/^$/    (none)/'
fi

echo "NOT moved by any step: do these by hand if the number is not 0"
vault="$(src "select count(*) from vault.secrets" 2>/dev/null || echo "?")"
echo "  secrets in the vault: $vault  (re-create each with vault.create_secret(); they are encrypted with a key that stays on the platform)"
echo "  roles made by hand that can log in: $(src "select coalesce(string_agg(rolname, ', '), '0') from pg_roles where rolcanlogin and rolname !~ '^(pg_|supabase_|pgsodium_|pgtle_|cli_login_)' and rolname not in ('postgres', 'authenticator', 'dashboard_user', 'pgbouncer')")  (they come over without a password: ALTER ROLE ... PASSWORD)"
echo "  event triggers of the app: $(src "select count(*) from pg_event_trigger e join pg_proc p on p.oid = e.evtfoid join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ('extensions', 'pgsodium', 'pg_catalog', 'graphql', 'realtime', 'storage', 'auth', 'vault', 'cron', 'net', 'supabase_functions')")"
echo "  database webhooks (they call an address that may be the hosted project's): $(src "select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'supabase_functions' and not t.tgisinternal")"

echo "This stack"
query_target "select 1" >/dev/null || die "cannot connect to the self-hosted database through the pooler: is the stack up (sudo sh run.sh status in ../stack)?"
echo "  Postgres $(query_target "show server_version"), reached as $(query_target "select current_user") through the pooler"
[ "$(query_target "show server_version" | cut -d. -f1)" = "$(src "show server_version" | cut -d. -f1)" ] \
	|| problem "the two sides run different major versions of Postgres"
while read -r name version; do
	[ -n "$name" ] || continue
	have="$(query_target "select default_version from pg_available_extensions where name = '$name'")"
	if [ -z "$have" ]; then
		problem "extension $name is not available in this Postgres image"
	elif [ "$have" != "$version" ]; then
		echo "  extension $name: hosted $version, here $have"
	fi
done < <(src "select extname || ' ' || extversion from pg_extension where extname <> 'plpgsql' order by 1")
empty="$(query_target "select (select count(*) from pg_tables where schemaname in ('public', 'private')) + (select count(*) from auth.users) + (select count(*) from storage.buckets) + (select count(*) from storage.objects)")"
if [ "$empty" = 0 ]; then
	echo "  empty, ready for a restore"
else
	echo "  NOT empty ($empty tables, users, buckets or files): 02-restore.sh will refuse it. README.md, \"Starting again\"."
fi
# The platform's Auth and Storage may be newer than this release's. Their
# migration tables say how far each side has got.
for pair in "auth.schema_migrations:version" "storage.migrations:name"; do
	table="${pair%%:*}" column="${pair##*:}"
	theirs="$(src "select max($column) from $table" 2>/dev/null || echo "?")"
	ours="$(query_target "select max($column) from $table" 2>/dev/null || echo "?")"
	if [ "$theirs" = "$ours" ]; then
		echo "  ${table%%.*} schema: the same version on both sides"
	else
		echo "  ${table%%.*} schema: hosted is at $theirs, this stack at $ours. If hosted is ahead, its data may have tables or columns this release lacks; 02-restore.sh checks and says which."
	fi
done

echo "Storage over the S3 protocol"
if out="$(rclone_run lsf platform: 2>&1)"; then
	echo "  hosted answers: $(echo "$out" | tr -d '/' | tr '\n' ' ')"
else
	problem "the hosted S3 endpoint does not answer: $(echo "$out" | grep -E 'ERROR|error' | tail -n 1 | cut -c1-200)"
fi
if out="$(rclone_run lsf selfhosted: 2>&1)"; then
	echo "  this stack answers (as $TARGET_PUBLIC_HOST)"
else
	problem "this stack's S3 endpoint does not answer: $(echo "$out" | grep -E 'ERROR|error' | tail -n 1 | cut -c1-200)"
fi

if [ "$problems" = 0 ]; then
	log "nothing in the way. next: sudo $MIGRATE_DIR/01-dump.sh"
else
	die "$problems problem(s) above"
fi
