#!/usr/bin/env bash
# 04-verify.sh [--fast] [--no-files] [--keep]
#
# Compares the hosted project with this stack and prints every difference.
# Read-only on both sides. Exit status 0 means no difference at all.
#
# What is compared (sql/verify.sql has the queries):
#   the row count of every table, and a checksum of each table's content
#   auth.users and auth.identities, spelled out, with checksums
#   buckets, the number and total size of files per bucket, every file record
#   the files themselves, downloaded from both sides and compared byte for byte
#   extensions and their versions
#   publications and every table in them (supabase_realtime's list)
#   the number of row-level-security policies, and every policy
#   which tables have row-level security on
#   triggers, table columns, constraints, indexes, views, functions and who
#   may call them, enum types, sequences (the id counters), table grants
#   settings stored on roles (statement_timeout and the like), custom roles
#   pg_cron jobs
#   and what no step moves: vault secrets and the app's event triggers
#
# --fast       row counts only, no content checksums
# --no-files   skip downloading the files (03-copy-storage.sh already did it)
# --keep       keep the two descriptions that were compared, and say where
#
# Some differences are expected and are not errors: README.md, "Reading the
# verification", lists them. At the real switch, with writes paused, the row
# counts, checksums, accounts and files must all match.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
load_settings
need SOURCE_DB_URL

deep=true
files=true
keep=false
while [ $# -gt 0 ]; do
	case "$1" in
		--fast) deep=false; shift ;;
		--no-files) files=false; shift ;;
		--keep) keep=true; shift ;;
		*) die "unknown argument: $1" ;;
	esac
done

umask 077
work="$(mktemp -d "$MIGRATE_DIR/.verify.XXXXXX")"
cleanup() { $keep || rm -rf "$work"; }
trap cleanup EXIT

describe() { # describe <psql function> <output file>
	local side="$1" out="$2" has_cron has_vault
	has_cron="$("$side" -At -c "select exists (select 1 from pg_extension where extname = 'pg_cron')")"
	has_vault="$("$side" -At -c "select has_schema_privilege('vault', 'USAGE') and has_table_privilege('vault.secrets', 'SELECT') from pg_namespace where nspname = 'vault' union all select false order by 1 desc limit 1")"
	"$side" -v "deep=$deep" -v "managed=$MANAGED_SCHEMAS" -v "has_cron=$has_cron" -v "has_vault=$has_vault" -f - \
		<"$MIGRATE_DIR/sql/verify.sql" >"$out"
}

log "describing the hosted project ($($deep && echo "with content checksums" || echo "row counts only"))"
describe psql_source "$work/hosted.tsv" || die "could not read the hosted project"
log "describing this stack"
describe psql_target "$work/here.tsv" || die "could not read this stack"
log "hosted: $(query_source "show server_version")   here: $(query_target "show server_version")"

# Compare, section by section. Each line is  section <TAB> item <TAB> value.
differences="$(awk -F '\t' '
	FNR == 1 { side++ }
	{
		key = $1 "\t" $2
		if (side == 1) { hosted[key] = $3; if (!(key in seen)) { seen[key] = 1; order[++n] = key } }
		else           { here[key] = $3;   if (!(key in seen)) { seen[key] = 1; order[++n] = key } }
		if (!($1 in sections)) { sections[$1] = 1; sorder[++m] = $1 }
		items[$1]++
	}
	END {
		for (i = 1; i <= m; i++) {
			s = sorder[i]; bad = 0; out = ""
			for (j = 1; j <= n; j++) {
				split(order[j], k, "\t")
				if (k[1] != s) continue
				key = order[j]
				if (!(key in here))        { bad++; out = out "    only on hosted: " k[2] "  (" hosted[key] ")\n" }
				else if (!(key in hosted)) { bad++; out = out "    only here:      " k[2] "  (" here[key] ")\n" }
				else if (hosted[key] != here[key]) {
					bad++; out = out "    differs:        " k[2] "\n        hosted: " hosted[key] "\n        here:   " here[key] "\n"
				}
			}
			if (bad) { total += bad; printf "  %s: %d difference(s)\n%s", s, bad, out }
			else printf "  %s: the same\n", s
		}
		printf "TOTAL\t%d\n", total
	}' "$work/hosted.tsv" "$work/here.tsv")"
total="$(sed -n 's/^TOTAL\t//p' <<<"$differences")"
grep -v '^TOTAL' <<<"$differences"

file_differences=0
if $files; then
	need SOURCE_S3_ENDPOINT SOURCE_S3_REGION SOURCE_S3_ACCESS_KEY_ID SOURCE_S3_SECRET_ACCESS_KEY
	for bucket in $(query_source "select id from storage.buckets order by id"); do
		if out="$(rclone_run check "platform:$bucket" "selfhosted:$bucket" --download --checkers 8 --retries 1 --low-level-retries 2 2>&1)"; then
			echo "  files in $bucket, byte for byte: the same ($(grep -oE '[0-9]+ matching files' <<<"$out" | tail -n 1))"
		else
			file_differences=$((file_differences + 1))
			echo "  files in $bucket, byte for byte: DIFFERENT"
			grep -E 'ERROR' <<<"$out" | sed -E 's/^[0-9/]+ [0-9:]+ ERROR *: /    /' | head -n 50
		fi
	done
else
	echo "  files, byte for byte: not checked (--no-files)"
fi

$keep && log "the two descriptions are in $work (delete the folder when done)"
if [ "$total" = 0 ] && [ "$file_differences" = 0 ]; then
	log "no differences"
else
	log "$total difference(s) in the database, $file_differences bucket(s) whose files differ"
	exit 1
fi
