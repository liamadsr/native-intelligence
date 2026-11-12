#!/usr/bin/env bash
# Makes LiveKit's API key and secret on the server, writes them into this folder's
# .env, and the same pair into the app's (../app/.env), with the address browsers
# connect to. While LIVEKIT_WEBHOOK_URL in this folder's .env is empty, it also sets
# that to the app's public address (NEXT_PUBLIC_APP_URL in ../app/.env) and the
# webhook route, and while Egress's four storage lines are empty, copies them from the
# Supabase stack's own settings (../supabase/stack/.env). For the call recorder, while its lines here
# are empty: the app's address, the capture feed's secret (made once, the same value in both files)
# and Deepgram's key (the app's). Neither key is ever shown, typed, or put on a command line: they go
# from here to the files through a pipe, with ../supabase/envfile.py, which only
# changes lines the files already have.
#
#   sudo ./make-keys.sh          a pair, made only if .env has none yet; then the app's copy
#   sudo ./make-keys.sh --new    a new pair in place of the old one
#
# Safe to run again at any time: without --new it keeps the pair and only brings the
# app's copy up to date (for one, after the three LIVEKIT_ lines were added to
# ../app/.env). LiveKit reads its .env only when its container is made, so after a
# change here it says to run `sudo docker compose up -d`, which recreates it then
# and does nothing when nothing changed.
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
[ -f "$own_env" ] || die "$own_env is missing. Make it first: [ -e .env ] || sudo install -m 600 -o root -g root .env.example .env"
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

# The webhooks' address, once: the app's public name and the route the calls feature
# adds. Only while the line is there and empty; a commented-out line (no webhooks)
# and an address set by hand are left alone.
webhook_changed=0
if grep -q '^LIVEKIT_WEBHOOK_URL=$' "$own_env"; then
	app_url=""
	[ -f "$app_env" ] && app_url="$(value_of NEXT_PUBLIC_APP_URL "$app_env")"
	app_url="${app_url%/}"
	if [[ "$app_url" =~ ^https://[A-Za-z0-9.-]+$ ]]; then
		write "$own_env" "LIVEKIT_WEBHOOK_URL=$app_url/api/calls/livekit/webhook"
		echo "Webhooks will go to $app_url/api/calls/livekit/webhook (LIVEKIT_WEBHOOK_URL in $own_env)."
		webhook_changed=1
	else
		echo "LIVEKIT_WEBHOOK_URL stays empty (no webhooks): $app_env has no https:// NEXT_PUBLIC_APP_URL to take it from."
	fi
fi

# Egress's storage (../README.md step 23, "Egress"): Supabase Storage's S3 key pair,
# its region and its public S3 address, copied from the stack's own settings while
# the four lines here are empty. Through a pipe, never shown; lines already filled
# in are left alone.
storage_changed=0
stack_env="$deploy/supabase/stack/.env"
if grep -q '^LIVEKIT_EGRESS_S3_ACCESS_KEY=' "$own_env"; then
	if [ -f "$stack_env" ]; then
		copied="$(python3 -I - "$own_env" "$stack_env" "$envfile" <<'PY'
import json, re, subprocess, sys

own, stack, envfile = sys.argv[1:4]

def parse(path):
    # As Compose reads the forms envfile.py writes (deploy/app/check_settings.py, parse_env).
    values = {}
    for line in open(path).read().split("\n"):
        m = re.match(r"([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if not m:
            continue
        name, v = m.groups()
        if len(v) >= 2 and v[0] == v[-1] == "'":
            v = v[1:-1]
        elif len(v) >= 2 and v[0] == v[-1] == '"':
            v = re.sub(r'\\(["\\$n])', lambda m: "\n" if m.group(1) == "n" else m.group(1), v[1:-1])
        else:
            v = v.split(" #", 1)[0].strip()
        values[name] = v
    return values

mine, theirs = parse(own), parse(stack)
public = theirs.get("SUPABASE_PUBLIC_URL", "").rstrip("/")
wanted = {
    "LIVEKIT_EGRESS_S3_ACCESS_KEY": theirs.get("S3_PROTOCOL_ACCESS_KEY_ID", ""),
    "LIVEKIT_EGRESS_S3_SECRET": theirs.get("S3_PROTOCOL_ACCESS_KEY_SECRET", ""),
    "LIVEKIT_EGRESS_S3_REGION": theirs.get("REGION", ""),
    "LIVEKIT_EGRESS_S3_ENDPOINT": public + "/storage/v1/s3" if public.startswith("https://") else "",
}
new = {k: v for k, v in wanted.items() if k in mine and not mine[k] and v}
# compose.yaml puts them in single-quoted YAML: a value with a single quote or a line
# break would not arrive as it is. Supabase makes its key pair in hex, so this never
# happens.
for k in [k for k, v in new.items() if chr(39) in v or chr(10) in v]:
    print("make-keys: %s not copied: it holds a single quote or a line break, which compose.yaml cannot pass to Egress." % k, file=sys.stderr)
    del new[k]
if new:
    subprocess.run([sys.executable, "-I", envfile, "apply", own], input=json.dumps(new), text=True, check=True, stdout=subprocess.DEVNULL)
print(" ".join(sorted(new)))
PY
)"
		if [ -n "$copied" ]; then
			echo "Egress's storage settings copied from $stack_env: $copied."
			storage_changed=1
		fi
	else
		echo "No $stack_env: Egress's storage settings stay as they are."
	fi
fi

# The call recorder (../README.md step 23, "The call recorder"): the app's address, the
# capture feed's secret (one value, in this .env and the app's) and Deepgram's key, each
# while its line here is empty. Never shown; lines filled in by hand are left alone.
recorder_changed=0
if grep -q '^RECORDER_APP_URL=$' "$own_env"; then
	app_url=""
	[ -f "$app_env" ] && app_url="$(value_of NEXT_PUBLIC_APP_URL "$app_env")"
	app_url="${app_url%/}"
	if [[ "$app_url" =~ ^https://[A-Za-z0-9.-]+$ ]]; then
		write "$own_env" "RECORDER_APP_URL=$app_url"
		echo "The recorder will reach the app at $app_url (RECORDER_APP_URL in $own_env)."
		recorder_changed=1
	fi
fi
if grep -q '^CAPTURE_FEED_SECRET=' "$own_env"; then
	feed="$(value_of CAPTURE_FEED_SECRET "$own_env")"
	if [ ! -f "$app_env" ] || ! grep -q '^CAPTURE_FEED_SECRET=' "$app_env"; then
		[ -n "$feed" ] || echo "$app_env has no CAPTURE_FEED_SECRET line yet: copy it (and TEAM_CALL_RECORDER) from $deploy/app/.env.example, then run this again."
	else
		app_feed="$(value_of CAPTURE_FEED_SECRET "$app_env")"
		if [ -z "$feed" ] && [ -n "$app_feed" ]; then
			[[ "$app_feed" =~ ^[A-Za-z0-9]{32,}$ ]] || die "CAPTURE_FEED_SECRET in $app_env is not 32 or more letters and digits: empty it there, then run this again to make one."
			write "$own_env" "CAPTURE_FEED_SECRET=$app_feed"
			echo "The capture feed's secret is copied from $app_env into $own_env (${#app_feed} characters)."
			recorder_changed=1
		elif [ -z "$feed" ]; then
			feed="$(random_alnum 48)"
			write "$own_env" "CAPTURE_FEED_SECRET=$feed"
			write "$app_env" "CAPTURE_FEED_SECRET=$feed"
			echo "A new capture feed secret is in $own_env and $app_env (${#feed} characters)."
			recorder_changed=1
			made_feed=1
		elif [ -z "$app_feed" ]; then
			write "$app_env" "CAPTURE_FEED_SECRET=$feed"
			echo "The capture feed's secret is copied into $app_env."
			made_feed=1
		elif [ "$feed" != "$app_feed" ]; then
			echo "make-keys: CAPTURE_FEED_SECRET differs between $own_env and $app_env: the app will refuse the recorder. Empty one of them, then run this again." >&2
		fi
	fi
fi
if grep -q '^RECORDER_DEEPGRAM_API_KEY=$' "$own_env" && [ -f "$app_env" ]; then
	dg="$(value_of DEEPGRAM_API_KEY "$app_env")"
	if [[ "$dg" =~ ^[A-Za-z0-9]+$ ]]; then
		write "$own_env" "RECORDER_DEEPGRAM_API_KEY=$dg"
		echo "Deepgram's key is copied from $app_env into $own_env (RECORDER_DEEPGRAM_API_KEY)."
		recorder_changed=1
	elif [ -n "$dg" ]; then
		echo "DEEPGRAM_API_KEY in $app_env is not letters and digits: put the recorder's own in RECORDER_DEEPGRAM_API_KEY by hand (sudo nano $own_env)."
	fi
fi

if [ "$made" = 1 ] || [ "$webhook_changed" = 1 ] || [ "$storage_changed" = 1 ] || [ "$recorder_changed" = 1 ]; then
	echo
	echo "LiveKit reads this only when its container is made: sudo docker compose up -d in $here"
	echo "(if LiveKit is running, it is recreated, and every call in it ends)."
fi
if [ "$made" = 1 ] || [ "${made_feed:-0}" = 1 ]; then
	echo "The app reads its copy when its containers start: sudo ./deploy.sh --no-build in $deploy/app,"
	echo "once the app uses it."
fi
