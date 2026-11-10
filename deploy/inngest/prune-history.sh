#!/usr/bin/env bash
# Prunes the history of finished Inngest runs from the Inngest Postgres.
#
# Inngest never deletes run history, so these tables grow for ever. This
# removes what belongs to runs that ENDED more than N days ago and leaves
# every run that is still going, however old. prune-history.sql has the rules.
#
#   sudo ./prune-history.sh                  # dry run: counts only, deletes nothing
#   sudo ./prune-history.sh --apply          # delete, keeping 30 days
#   sudo ./prune-history.sh --days 60 --apply
#
# Runs on the server, against the running ni-inngest-postgres container.
# ../README.md has the monthly cron line.
set -euo pipefail

days=30
batch=1000
apply=false
container=ni-inngest-postgres

usage() {
	sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
	case "$1" in
		--days)
			days="${2:?--days needs a number}"
			shift 2
			;;
		--batch)
			batch="${2:?--batch needs a number}"
			shift 2
			;;
		--apply)
			apply=true
			shift
			;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			echo "unknown option: $1" >&2
			usage >&2
			exit 2
			;;
	esac
done

case "$days" in '' | *[!0-9]*) echo "--days must be a whole number of days" >&2; exit 2 ;; esac
case "$batch" in '' | *[!0-9]* | 0) echo "--batch must be a whole number above zero" >&2; exit 2 ;; esac
if [ "$days" -lt 7 ]; then
	# Any window is safe for runs in flight, because only ended runs are
	# touched. But a short one empties the dashboard of the failures you may
	# still want to look at, and below a week is almost surely a typo.
	echo "refusing to keep fewer than 7 days of history (got --days $days)" >&2
	exit 2
fi

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" != "true" ]; then
	echo "container $container is not running" >&2
	exit 1
fi

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) inngest history prune: keep ${days} days, apply=${apply}"

docker exec -i "$container" \
	psql --username inngest --dbname inngest --no-psqlrc \
	--set "days=${days}" --set "batch=${batch}" --set "apply=${apply}" \
	--file - <"$here/prune-history.sql"
