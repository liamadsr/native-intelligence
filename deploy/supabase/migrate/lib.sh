#!/usr/bin/env bash
# Shared by the numbered scripts in this folder. Sourced, never run.
#
# Where things come from:
#   ./.env            the hosted project's connection details (see .env.example)
#   ../stack/.env     the self-hosted stack's own settings: database password,
#                     pooler tenant id, the S3 protocol keys and region
# Both are root-only files, so the scripts are run with sudo. Nothing secret is
# written to a command line: psql and rclone run in containers and receive
# their settings as environment variables. The one exception is the Supabase
# CLI in 01-dump.sh, which only takes the database URL as an argument.
#
# Tools. psql and rclone are not installed on the server; they run from the
# same two images the backup container is built from, so the versions match.
MIGRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "$MIGRATE_DIR/../stack" && pwd)"
PSQL_IMAGE="${PSQL_IMAGE:-postgres:17-alpine}"
RCLONE_IMAGE="${RCLONE_IMAGE:-rclone/rclone:1.75.2}"

log() { echo "$(date -u +%H:%M:%SZ) $*"; }
warn() { echo "$(date -u +%H:%M:%SZ) WARNING: $*" >&2; }
die() {
	echo "$(date -u +%H:%M:%SZ) FAILED: $*" >&2
	exit 1
}

# env_get <file> <KEY>: the value of KEY in a compose-style env file, without
# surrounding quotes. Empty when the key is absent. The files are read, not
# sourced: a value may hold spaces or characters the shell would interpret.
env_get() {
	local file="$1" key="$2" value
	[ -f "$file" ] || return 0
	value="$(grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2-)" || true
	value="${value%$'\r'}"
	case "$value" in
		\"*\")
			value="${value#\"}" value="${value%\"}"
			# Inside double quotes a backslash, a double quote and a dollar sign
			# are written with a backslash in front. Undo that, one character at
			# a time on purpose: pattern replacement handles backslashes
			# differently from one version of bash to the next.
			local out="" c i=0 n=${#value}
			while [ "$i" -lt "$n" ]; do
				c="${value:$i:1}"
				if [ "$c" = "\\" ] && [ $((i + 1)) -lt "$n" ]; then
					case "${value:$((i + 1)):1}" in "\\" | '"' | '$') i=$((i + 1)) c="${value:$i:1}" ;; esac
				fi
				out="$out$c"
				i=$((i + 1))
			done
			value="$out"
			;;
		\'*\') value="${value#\'}" value="${value%\'}" ;;
	esac
	printf '%s' "$value"
}

# setting <KEY>: from the environment if set there, else from ./.env.
setting() {
	local key="$1"
	if [ -n "${!key:-}" ]; then
		printf '%s' "${!key}"
	else
		env_get "$MIGRATE_DIR/.env" "$key"
	fi
}

load_settings() {
	[ "$(id -u)" = 0 ] || die "run with sudo: Docker and the root-only .env files need it"
	command -v docker >/dev/null || die "docker not found"

	SOURCE_DB_URL="$(setting SOURCE_DB_URL)"
	SOURCE_S3_ENDPOINT="$(setting SOURCE_S3_ENDPOINT)"
	SOURCE_S3_REGION="$(setting SOURCE_S3_REGION)"
	SOURCE_S3_ACCESS_KEY_ID="$(setting SOURCE_S3_ACCESS_KEY_ID)"
	SOURCE_S3_SECRET_ACCESS_KEY="$(setting SOURCE_S3_SECRET_ACCESS_KEY)"

	# The self-hosted side. Every one of these has a default taken from the
	# stack, so normally none is set.
	local pw tenant db
	pw="$(env_get "$STACK_DIR/.env" POSTGRES_PASSWORD)"
	tenant="$(env_get "$STACK_DIR/.env" POOLER_TENANT_ID)"
	db="$(env_get "$STACK_DIR/.env" POSTGRES_DB)"
	TARGET_NETWORK="$(setting TARGET_NETWORK)"
	TARGET_NETWORK="${TARGET_NETWORK:-ni-supabase}"
	TARGET_DB_URL="$(setting TARGET_DB_URL)"
	if [ -z "$TARGET_DB_URL" ]; then
		[ -n "$pw" ] && [ -n "$tenant" ] || die "POSTGRES_PASSWORD or POOLER_TENANT_ID missing from $STACK_DIR/.env"
		# The connection the restore guide names: the pooler in session mode,
		# as postgres.<tenant id>. `supavisor` is its name on the stack's network.
		TARGET_DB_URL="postgres://postgres.${tenant}:${pw}@supavisor:5432/${db:-postgres}"
	fi
	# Storage accepts an S3 request only when it was signed for the host name
	# in SUPABASE_PUBLIC_URL. So inside Docker the gateway is called by that
	# name, over plain http on port 80 (its public listener), with the name
	# pointed at the gateway container's address on the stack's network.
	TARGET_PUBLIC_HOST="$(env_get "$STACK_DIR/.env" SUPABASE_PUBLIC_URL)"
	TARGET_PUBLIC_HOST="${TARGET_PUBLIC_HOST#*://}"
	TARGET_PUBLIC_HOST="${TARGET_PUBLIC_HOST%%/*}"
	TARGET_S3_ENDPOINT="$(setting TARGET_S3_ENDPOINT)"
	TARGET_S3_ENDPOINT="${TARGET_S3_ENDPOINT:-http://${TARGET_PUBLIC_HOST}/storage/v1/s3}"
	TARGET_S3_REGION="$(setting TARGET_S3_REGION)"
	TARGET_S3_REGION="${TARGET_S3_REGION:-$(env_get "$STACK_DIR/.env" REGION)}"
	TARGET_S3_ACCESS_KEY_ID="$(setting TARGET_S3_ACCESS_KEY_ID)"
	TARGET_S3_ACCESS_KEY_ID="${TARGET_S3_ACCESS_KEY_ID:-$(env_get "$STACK_DIR/.env" S3_PROTOCOL_ACCESS_KEY_ID)}"
	TARGET_S3_SECRET_ACCESS_KEY="$(setting TARGET_S3_SECRET_ACCESS_KEY)"
	TARGET_S3_SECRET_ACCESS_KEY="${TARGET_S3_SECRET_ACCESS_KEY:-$(env_get "$STACK_DIR/.env" S3_PROTOCOL_ACCESS_KEY_SECRET)}"

	# Only for a source that is not on the internet (a rehearsal against a
	# database in another Docker network). Normally both are empty.
	SOURCE_NETWORK="$(setting SOURCE_NETWORK)"
	MIGRATE_DOCKER_ARGS="$(setting MIGRATE_DOCKER_ARGS)"
}

need() { # need VAR...: fail if any is empty
	local name
	for name in "$@"; do
		[ -n "${!name:-}" ] || die "$name is not set (see $MIGRATE_DIR/.env.example)"
	done
}

# --- psql -------------------------------------------------------------------
# psql_source [psql args]   against the hosted project, over the internet
# psql_target [psql args]   against the self-hosted database, on the stack's network
# Stdin is passed through. Files are reached under /work, which is the folder
# named by WORK_DIR (read-only) when that is set.
_psql() { # _psql <network, or empty for Docker's default> <url> [psql args]
	local network="$1" url="$2"
	shift 2
	local opts=()
	[ -n "$network" ] && opts+=(--network "$network")
	[ -n "${WORK_DIR:-}" ] && opts+=(-v "$WORK_DIR:/work:ro" -w /work)
	PGURL="$url" docker run --rm -i -e PGURL -e PGCONNECT_TIMEOUT=20 -e PGAPPNAME=ni-migrate \
		"${opts[@]}" "$PSQL_IMAGE" sh -c 'exec psql "$PGURL" -X -v ON_ERROR_STOP=1 "$@"' psql "$@"
}
psql_source() { _psql "$SOURCE_NETWORK" "$SOURCE_DB_URL" "$@"; }
psql_target() { _psql "$TARGET_NETWORK" "$TARGET_DB_URL" "$@"; }

# One value or one column, unaligned, no header. Stdin is closed on purpose:
# `docker run -i` hands the caller's input to the container, so inside a
# `while read` loop a query would otherwise swallow the rest of the loop's
# lines and the loop would end after its first turn.
query_source() { psql_source -At -c "$1" </dev/null; }
query_target() { psql_target -At -c "$1" </dev/null; }

# --- rclone -----------------------------------------------------------------
# Two remotes, defined by environment variables only. (The config file is an
# empty one made on the spot, so that rclone does not remark on its absence.)
#   platform:     the hosted project's S3 endpoint
#   selfhosted:   this stack's S3 endpoint, through its gateway's public listener
rclone_run() {
	local gateway_ip host_args=()
	gateway_ip="$(docker inspect -f "{{with index .NetworkSettings.Networks \"$TARGET_NETWORK\"}}{{.IPAddress}}{{end}}" supabase-envoy 2>/dev/null || true)"
	if [ -n "$gateway_ip" ] && [ -n "$TARGET_PUBLIC_HOST" ]; then
		host_args=(--add-host "${TARGET_PUBLIC_HOST}:${gateway_ip}")
	elif [ -z "$(setting TARGET_S3_ENDPOINT)" ]; then
		# Without this the public name would be looked up in DNS, which
		# before the switch leads to the hosted project, not to this stack.
		die "the gateway container (supabase-envoy) is not running on the network ${TARGET_NETWORK}, or SUPABASE_PUBLIC_URL is empty in ${STACK_DIR}/.env: start the stack first (sudo sh run.sh start in ../stack)"
	fi
	# shellcheck disable=SC2086  # MIGRATE_DOCKER_ARGS is a list of arguments
	RCLONE_CONFIG_PLATFORM_TYPE=s3 RCLONE_CONFIG_PLATFORM_PROVIDER=Other \
		RCLONE_CONFIG_PLATFORM_ENDPOINT="$SOURCE_S3_ENDPOINT" \
		RCLONE_CONFIG_PLATFORM_REGION="$SOURCE_S3_REGION" \
		RCLONE_CONFIG_PLATFORM_ACCESS_KEY_ID="$SOURCE_S3_ACCESS_KEY_ID" \
		RCLONE_CONFIG_PLATFORM_SECRET_ACCESS_KEY="$SOURCE_S3_SECRET_ACCESS_KEY" \
		RCLONE_CONFIG_SELFHOSTED_TYPE=s3 RCLONE_CONFIG_SELFHOSTED_PROVIDER=Other \
		RCLONE_CONFIG_SELFHOSTED_ENDPOINT="$TARGET_S3_ENDPOINT" \
		RCLONE_CONFIG_SELFHOSTED_REGION="$TARGET_S3_REGION" \
		RCLONE_CONFIG_SELFHOSTED_ACCESS_KEY_ID="$TARGET_S3_ACCESS_KEY_ID" \
		RCLONE_CONFIG_SELFHOSTED_SECRET_ACCESS_KEY="$TARGET_S3_SECRET_ACCESS_KEY" \
		docker run --rm -i --network "$TARGET_NETWORK" "${host_args[@]}" \
		-e RCLONE_CONFIG_PLATFORM_TYPE -e RCLONE_CONFIG_PLATFORM_PROVIDER \
		-e RCLONE_CONFIG_PLATFORM_ENDPOINT -e RCLONE_CONFIG_PLATFORM_REGION \
		-e RCLONE_CONFIG_PLATFORM_ACCESS_KEY_ID -e RCLONE_CONFIG_PLATFORM_SECRET_ACCESS_KEY \
		-e RCLONE_CONFIG_SELFHOSTED_TYPE -e RCLONE_CONFIG_SELFHOSTED_PROVIDER \
		-e RCLONE_CONFIG_SELFHOSTED_ENDPOINT -e RCLONE_CONFIG_SELFHOSTED_REGION \
		-e RCLONE_CONFIG_SELFHOSTED_ACCESS_KEY_ID -e RCLONE_CONFIG_SELFHOSTED_SECRET_ACCESS_KEY \
		$MIGRATE_DOCKER_ARGS --entrypoint sh "$RCLONE_IMAGE" \
		-c ': >/tmp/rclone.conf && exec rclone --config /tmp/rclone.conf "$@"' rclone "$@"
}

# The schemas `supabase db dump` leaves out of schema.sql because the platform
# and the self-hosted services each create them themselves. Read from the CLI
# (3.1.0, `supabase db dump --dry-run`); only the ones that can hold something
# of the app's are listed. Used to carry over the app's own triggers and
# policies on those tables, which no other step moves.
# shellcheck disable=SC2034  # used by the scripts that source this file
MANAGED_SCHEMAS="'auth','storage','realtime'"
