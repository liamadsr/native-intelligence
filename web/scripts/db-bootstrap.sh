#!/usr/bin/env bash
#
# Build the web app's database on an EMPTY Supabase database:
#   1. supabase/baseline/schema.sql  the schema as of the baseline cut (supabase/baseline/CUT)
#   2. supabase/baseline/seed.sql    the configuration rows the app needs (plans, model costs,
#                                    the built-in library)
#   3. every supabase/migrations/*.sql numbered after the cut, in file-name order
#
# Usage:
#   DATABASE_URL=postgresql://postgres:<password>@<host>:5432/postgres scripts/db-bootstrap.sh
#
# Connect as `postgres` (Supabase: Connect → direct connection or session pooler). Needs
# psql. It refuses a database that already has the app's tables or functions: an existing
# database only takes the migrations it hasn't applied yet.

set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "set DATABASE_URL to the connection string of an empty database" >&2
  exit 1
fi
command -v psql >/dev/null || { echo "psql not found" >&2; exit 1; }

ROOT=$(cd "$(dirname "$0")/.." && pwd)
BASE="$ROOT/supabase/baseline"
CUT=$(grep -vE '^[[:space:]]*(#|$)' "$BASE/CUT" | tr -d '[:space:]')
[[ "$CUT" =~ ^[0-9]+$ ]] || { echo "no cut number in $BASE/CUT" >&2; exit 1; }

psql_() { psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }

# Empty means: no private schema, and nothing in public but what extensions own.
existing=$(psql_ -At -c "
  select (select count(*) from pg_namespace where nspname = 'private')
       + (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r','p','v','m','S','f')
            and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass
                            and d.objid = c.oid and d.deptype = 'e'))
       + (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass
                            and d.objid = p.oid and d.deptype = 'e'))")
if [ "$existing" != 0 ]; then
  echo "refusing: this database isn't empty ($existing objects in public/private)." >&2
  echo "Apply only the migrations it hasn't run yet instead." >&2
  exit 1
fi

echo "schema (baseline at migration $CUT)"
psql_ -1 -f "$BASE/schema.sql" >/dev/null
echo "seed"
psql_ -1 -f "$BASE/seed.sql" >/dev/null

applied=0
for f in "$ROOT"/supabase/migrations/*.sql; do
  name=$(basename "$f")
  num=${name%%_*}
  [[ "$num" =~ ^[0-9]+$ ]] || continue
  if (( 10#$num > CUT )); then
    echo "migration $name"
    psql_ -f "$f"
    applied=$((applied + 1))
  fi
done
echo "done: baseline $CUT + $applied migration(s) after it"
