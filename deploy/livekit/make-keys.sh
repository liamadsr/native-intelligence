#!/usr/bin/env bash
# Makes LiveKit's API key and secret on the server, writes them into this folder's
# .env, and the same pair into the app's (../app/.env), with the address browsers
# connect to. Neither value is ever shown, typed, or put on a command line: they go
# from here to the files through a pipe, with ../supabase/envfile.py, which only
# changes lines the files already have.
#
#   sudo ./make-keys.sh          a pair, made only if .env has none yet; then the app's copy
#   sudo ./make-keys.sh --new    a new pair in place of the old one
#
# Run again at any time: without --new it keeps the pair and only brings the app's
# copy up to date (for one, after the three LIVEKIT_ lines were added to ../app/.env).
#
# --new ends every call in progress and every token made with the old pair; LiveKit
# and the app then have to be restarted with the new one (the script says how).
#
# Settings:
#   LIVEKIT_HOST   the public name (default: LIVEKIT_HOST in ../edge/.env, or
#                  livekit.nativeintelligence.dev when that has none)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
deploy="$(cd "$here/.." && pwd)"
own_env="$here/.env"
app_env="$deploy/app/.env"
edge_env="$deploy/edge/.env"
envfile="$deploy/supabase/envfile.py"

die() { echo "make-keys: $*" >&2; exit 1; }

new=0
for arg in "$@"; do
	case "$arg" in --new) new=1 ;; *) die "unknown argument $arg (only --new)" ;; esac
done
[ "$(id -u)" = 0 ] || die "run it with sudo: the .env files are root's alone."
[ -f "$own_env" ] || die "$own_env is missing. Make it first: sudo install -m 600 -o root -g root .env.example .env"
[ -f "$envfile" ] || die "$envfile is missing; the checkout needs deploy/ whole."
command -v python3 >/dev/null || die "python3 is missing."

# The value of NAME in an env file, as written there (make-keys.sh writes letters and
# digits only, which need no quotes). Empty when the line is missing or empty.
value_of() { sed -n "s/^$1=//p" "$2" | tail -n 1 | tr -d "'\""; }

# write <file> NAME=VALUE...: through a pipe, so no value is on a command line.
write() {
	local file="$1" json="{" sep="" pair
	shift
	for pair in "$@"; do
		json="$json$sep\"${pair%%=*}\":\"${pair#*=}\""
		sep=","
	done
	printf '%s}' "$json" | python3 -I "$envfile" apply "$file" >/dev/null
}

# Letters and digits only: they go into YAML (compose.yaml) and into JWTs as they
# are. LiveKit's own generator makes "API" and 12 characters for the key and a
# secret of 43; the secret here is 48 (LiveKit wants at least 32).
random_alnum() {
	local raw=""
	while [ "${#raw}" -lt "$1" ]; do
		raw="$raw$(head -c 512 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')"
	done
	printf '%s' "${raw:0:$1}"
}

key="$(value_of LIVEKIT_API_KEY "$own_env")"
secret="$(value_of LIVEKIT_API_SECRET "$own_env")"
if [ "$new" = 1 ] || [ -z "$key" ] || [ -z "$secret" ]; then
	key="API$(random_alnum 12)"
	secret="$(random_alnum 48)"
	write "$own_env" "LIVEKIT_API_KEY=$key" "LIVEKIT_API_SECRET=$secret"
	echo "A new key pair is in $own_env (key ${#key} characters, secret ${#secret})."
	made=1
else
	[[ "$key" =~ ^[A-Za-z0-9]+$ && "$secret" =~ ^[A-Za-z0-9]{32,}$ ]] ||
		die "the pair in $own_env is not letters and digits, or the secret is shorter than 32. Make a new one: sudo ./make-keys.sh --new"
	echo "Kept the key pair already in $own_env (key ${#key} characters, secret ${#secret})."
	made=0
fi

host="${LIVEKIT_HOST:-}"
if [ -z "$host" ] && [ -f "$edge_env" ]; then host="$(value_of LIVEKIT_HOST "$edge_env")"; fi
[ -n "$host" ] || host=livekit.nativeintelligence.dev
[[ "$host" =~ ^[A-Za-z0-9.-]+$ ]] || die "LIVEKIT_HOST is not a host name: $host"
url="wss://$host"

if [ ! -f "$app_env" ]; then
	echo "No $app_env on this server: nothing to give the app."
elif ! grep -q '^LIVEKIT_URL=' "$app_env" || ! grep -q '^LIVEKIT_API_KEY=' "$app_env" || ! grep -q '^LIVEKIT_API_SECRET=' "$app_env"; then
	echo "$app_env has no LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET lines yet. Copy the three from"
	echo "$deploy/app/.env.example (sudo nano $app_env), then run this again: it keeps the pair and fills them in."
else
	write "$app_env" "LIVEKIT_URL=$url" "LIVEKIT_API_KEY=$key" "LIVEKIT_API_SECRET=$secret"
	echo "The same pair is in $app_env, with LIVEKIT_URL=$url."
fi

if [ "$made" = 1 ]; then
	echo
	echo "To use it: sudo docker compose up -d in $here (LiveKit restarts and every call in it ends),"
	echo "then sudo ./deploy.sh --no-build in $deploy/app for the app."
fi
