#!/usr/bin/env bash
# 02-restore.sh <dump folder> [--final] [--skip-table <schema.table>]...
#
# Restores a dump made by 01-dump.sh into the EMPTY self-hosted database, the
# way Supabase's restore guide says to (steps 3 and 4 of
# https://supabase.com/docs/guides/self-hosting/restore-from-platform):
# one psql run, one transaction, roles then schema then data, with triggers
# off while the data loads. If anything fails, nothing is left behind.
#
# Around the guide's command it does what the guide leaves to you, or does
# not cover. Each of these was needed in the rehearsal:
#
#   before  refuses a database that is not empty; checks that every extension
#           the source uses exists here; checks that every table and column
#           in data.sql exists here and can be written (the platform's Auth
#           and Storage can be newer than this release's), and stops with the
#           list if not
#   in it   first clears the new database's default grants, so that tables
#           and functions get the hosted project's permissions and no more
#           (sql/clear-default-privileges.sql says why)
#   in it   applies extras.sql after the data: the app's policies and
#           triggers on auth, storage and realtime tables, and its cron jobs
#   after   ANALYZE, because a restore carries no planner statistics
#   after   pauses every pg_cron job, unless --final is given
#
# --final          this is the real switch: leave the cron jobs as they were
#                  on the source. Without it this is a rehearsal, and a copy
#                  of production must not run production's jobs a second time.
# --skip-table     leave one table's rows out of the data. For a table that
#                  exists on the platform and not here; named in the error
#                  this script prints. Repeat for more than one.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
load_settings

dump=""
final=false
skip_tables=()
while [ $# -gt 0 ]; do
	case "$1" in
		--final) final=true; shift ;;
		--skip-table) skip_tables+=("${2:?--skip-table needs schema.table}"); shift 2 ;;
		-*) die "unknown argument: $1" ;;
		*) [ -z "$dump" ] || die "more than one dump folder given"; dump="$1"; shift ;;
	esac
done
[ -n "$dump" ] || die "usage: 02-restore.sh <dump folder> [--final] [--skip-table schema.table]..."
dump="$(cd "$dump" 2>/dev/null && pwd)" || die "no such folder: $1"
for f in roles.sql schema.sql data.sql extras.sql extensions.txt; do
	[ -s "$dump/$f" ] || die "$dump/$f is missing or empty: is this a folder made by 01-dump.sh?"
done

umask 077
work="$(mktemp -d "$dump/.restore.XXXXXX")"
trap 'rm -rf "$work"' EXIT
export WORK_DIR="$dump"
rel="${work#"$dump"/}" # the scratch folder as psql sees it, under /work

# --- 1. the target must be empty -------------------------------------------
log "checking that the target is empty"
existing="$(query_target "
  select (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
             and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass
                             and d.objid = c.oid and d.deptype = 'e'))
       + (select count(*) from auth.users)
       + (select count(*) from storage.buckets)
       + (select count(*) from storage.objects)")" || die "cannot reach the target database"
[ "$existing" = 0 ] || die "the target is not empty ($existing tables, users, buckets or files). Reset it first: README.md, \"Starting again\"."

# --- 2. extensions (the guide's step 3) ------------------------------------
# schema.sql creates the extensions itself (CREATE EXTENSION IF NOT EXISTS);
# what can go wrong is that one is not part of this Postgres image.
log "checking extensions"
missing_ext=""
while read -r name version; do
	[ -n "$name" ] || continue
	have="$(query_target "select default_version from pg_available_extensions where name = '$name'")"
	if [ -z "$have" ]; then
		missing_ext+=" $name"
	elif [ "$have" != "$version" ]; then
		log "  $name: source $version, here $have"
	fi
done <"$dump/extensions.txt"
[ -z "$missing_ext" ] || die "not available in this Postgres image:$missing_ext"

# --- 3. does the data fit this release's tables? -----------------------------
# Tables that schema.sql creates are fine by construction. The rest already
# exist on the target (auth, storage, ...) in the shape THIS release gives
# them, owned by the services' own roles, and the data was dumped in the shape
# the platform has. Three things can be wrong with a table in data.sql, and
# each one aborts the whole transaction if it is only found during the load:
#   it does not exist here; a column does not exist here; or the role the
#   restore runs as (postgres) may not write to it here.
log "checking that the data fits this release's tables"
awk '
	in_copy {
		if ($0 == "\\.") { in_copy = 0; print "T\t" s "\t" t "\t" rows } else rows++
		next
	}
	/^COPY "[^"]+"\."[^"]+" \(/ {
		in_copy = 1; rows = 0
		line = $0
		sub(/^COPY "/, "", line); s = line; sub(/"\..*/, "", s)
		sub(/^[^"]+"\."/, "", line); t = line; sub(/".*/, "", t)
		sub(/^[^(]*\(/, "", line); sub(/\) FROM stdin;$/, "", line)
		n = split(line, cols, ", ")
		for (i = 1; i <= n; i++) { c = cols[i]; gsub(/^"|"$/, "", c); print "C\t" s "\t" t "\t" c }
	}' "$dump/data.sql" >"$work/copy.tsv"
{
	echo "create temp table dump_col (s text, t text, c text);"
	echo "create temp table dump_tab (s text, t text, n bigint);"
	echo "create temp table dump_seq (s text, q text);"
	echo "create temp table made (kind text, s text, n text);"
	echo "copy dump_col from stdin;"
	sed -n 's/^C\t//p' "$work/copy.tsv"
	echo '\.'
	echo "copy dump_tab from stdin;"
	sed -n 's/^T\t//p' "$work/copy.tsv"
	echo '\.'
	echo "copy dump_seq from stdin;"
	# SELECT pg_catalog.setval('"auth"."refresh_tokens_id_seq"', 9, true);
	sed -n -E "s/^SELECT pg_catalog\.setval\('\"([^\"]+)\"\.\"([^\"]+)\"'.*/\1\t\2/p" "$dump/data.sql"
	echo '\.'
	echo "copy made from stdin;"
	sed -n -E 's/^CREATE TABLE IF NOT EXISTS "([^"]+)"\."([^"]+)".*/table\t\1\t\2/p' "$dump/schema.sql"
	sed -n -E 's/^(CREATE SEQUENCE IF NOT EXISTS|[[:space:]]*SEQUENCE NAME) "([^"]+)"\."([^"]+)".*/seq\t\2\t\3/p' "$dump/schema.sql"
	echo '\.'
	cat <<'SQL'
with here as (
  select d.s, d.t, d.n,
         exists (select 1 from made m where m.kind = 'table' and m.s = d.s and m.n = d.t) as made,
         exists (select 1 from information_schema.tables i where i.table_schema = d.s and i.table_name = d.t) as present
  from dump_tab d
)
select 'table', s || '.' || t, n::text from here where not made and not present
union all
select 'noaccess', s || '.' || t, n::text from here
-- (a CASE, so the privilege is only asked about a table that exists)
where case when not made and present
           then not has_table_privilege(format('%I.%I', s, t), 'INSERT') else false end
union all
select 'column', d.s || '.' || d.t || '.' || d.c, h.n::text
from dump_col d join here h using (s, t)
where not h.made and h.present
  and not exists (select 1 from information_schema.columns i
                  where i.table_schema = d.s and i.table_name = d.t and i.column_name = d.c)
union all
select 'sequence', d.s || '.' || d.q, '0'
from dump_seq d
where not exists (select 1 from made m where m.kind = 'seq' and m.s = d.s and m.n = d.q)
  and not exists (select 1 from pg_sequences i where i.schemaname = d.s and i.sequencename = d.q)
union all
select 'seqnoaccess', d.s || '.' || d.q, '0'
from dump_seq d
where case when not exists (select 1 from made m where m.kind = 'seq' and m.s = d.s and m.n = d.q)
            and exists (select 1 from pg_sequences i where i.schemaname = d.s and i.sequencename = d.q)
           then not has_sequence_privilege(format('%I.%I', d.s, d.q), 'UPDATE') else false end
order by 1, 2;
SQL
} >"$work/fit.sql"
misfits="$(psql_target -q -At -F ' ' -f "$rel/fit.sql")" || die "the check itself failed"

asked=" ${skip_tables[*]:-} "
skip=" " # tables whose rows are left out of the data
drop_seqs=" " # sequences whose setval line is left out
problems=""
while read -r kind name rows; do
	[ -n "$kind" ] || continue
	case "$kind" in
		table | noaccess)
			reason="does not exist here"
			[ "$kind" = noaccess ] && reason="cannot be written by the postgres role here"
			if [ "$rows" = 0 ]; then
				# Nothing to load, and the COPY line alone would fail.
				log "  $name: empty on the source and $reason; left out"
				skip+="$name "
			elif [[ "$asked" == *" $name "* ]]; then
				log "  $name: $rows row(s) left out (--skip-table); it $reason"
				skip+="$name "
			else
				problems+="  $name ($rows rows) $reason"$'\n'
			fi
			;;
		column)
			table="${name%.*}"
			[[ "$skip" == *" $table "* ]] || [[ "$asked" == *" $table "* ]] \
				|| problems+="  column $name ($rows rows in the table) does not exist here"$'\n'
			;;
		sequence)
			log "  counter $name: no such sequence here; left out"
			drop_seqs+="$name "
			;;
		seqnoaccess)
			problems+="  counter $name cannot be set by the postgres role here"$'\n'
			;;
	esac
done <<<"$misfits"
if [ -n "$problems" ]; then
	echo "$problems" >&2
	die "the platform's data does not fit this release (list above). A table can be left behind with --skip-table <schema.table> when its rows belong to a feature this release's Auth or Storage does not have. For a missing column, see \"Version mismatches\" in Supabase's restore guide. README.md, \"When the data does not fit\", walks through both."
fi

data_file="data.sql"
if [ "$skip" != " " ] || [ "$drop_seqs" != " " ]; then
	log "writing a copy of the data without what is left out"
	SKIP_TABLES="$skip" DROP_SEQS="$drop_seqs" awk '
		BEGIN { skip = ENVIRON["SKIP_TABLES"]; seqs = ENVIRON["DROP_SEQS"] }
		in_copy {
			if ($0 == "\\.") { in_copy = 0; if (dropping) { dropping = 0; next } }
			if (!dropping) print
			next
		}
		/^COPY "[^"]+"\."[^"]+" \(/ {
			in_copy = 1
			line = $0
			sub(/^COPY "/, "", line); s = line; sub(/"\..*/, "", s)
			sub(/^[^"]+"\."/, "", line); t = line; sub(/".*/, "", t)
			if (index(skip, " " s "." t " ")) { dropping = 1; next }
			print; next
		}
		/^SELECT pg_catalog\.setval\(\x27"[^"]+"\."[^"]+"\x27/ {
			line = $0
			sub(/^SELECT pg_catalog\.setval\(\x27"/, "", line); s = line; sub(/"\..*/, "", s)
			sub(/^[^"]+"\."/, "", line); q = line; sub(/".*/, "", q)
			if (index(seqs, " " s "." q " ")) next
		}
		{ print }' "$dump/data.sql" >"$work/data.sql"
	data_file="$rel/data.sql"
fi

# --- 4. the restore (the guide's step 4, as written there) ------------------
if $final; then
	log "restoring: THE REAL SWITCH (--final)"
else
	log "restoring: a rehearsal (cron jobs will be paused)"
fi
started=$SECONDS
cp "$MIGRATE_DIR/sql/clear-default-privileges.sql" "$work/"
psql_target \
	--single-transaction \
	--variable "managed=$MANAGED_SCHEMAS" \
	--file "$rel/clear-default-privileges.sql" \
	--file roles.sql \
	--file schema.sql \
	--command 'SET session_replication_role = replica' \
	--file "$data_file" \
	--file extras.sql \
	>"$work/restore.log" 2>&1 || {
	grep -E 'ERROR|FATAL|error:' "$work/restore.log" | head -n 20 >&2
	die "the restore failed and was rolled back: the database is still empty. The lines above are the errors."
}
log "restored in $((SECONDS - started))s"

# --- 5. afterwards ----------------------------------------------------------
log "collecting planner statistics (ANALYZE)"
psql_target -q -c "set client_min_messages = error" -c "analyze" >/dev/null

if ! $final; then
	paused="$(query_target "select count(*) from (select cron.alter_job(jobid, active := false) from cron.job where active) x" 2>/dev/null || echo 0)"
	log "paused $paused cron job(s): this is a rehearsal"
fi

log "now in the database:"
psql_target -q -At -F ' ' <<'SQL' | sed 's/^/  /'
select 'tables in public:', count(*) from pg_tables where schemaname = 'public';
select 'users:', count(*) from auth.users;
select 'buckets:', count(*) from storage.buckets;
select 'file records (the files themselves come next):', count(*) from storage.objects;
select 'policies:', count(*) from pg_policies;
select 'tables in the realtime publication:', count(*) from pg_publication_tables where pubname = 'supabase_realtime';
select 'cron jobs:', count(*) || ' (' || count(*) filter (where active) || ' active)' from cron.job;
SQL
log "next: restart the stack so every service re-reads the database (cd ../stack && sudo sh run.sh restart),"
log "      then sudo $MIGRATE_DIR/03-copy-storage.sh"
