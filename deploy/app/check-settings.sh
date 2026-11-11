#!/usr/bin/env bash
# Checks the app's settings on the server (deploy/app/.env) before the switch of the
# real names (../README.md step 21, Gate 1), without showing a single value. Run it
# on your own machine, from a full checkout:
#
#   deploy/app/check-settings.sh <user>@<server> [--fill]
#
# It runs check_settings.py on the server, as root, and prints each setting's group,
# whether it is set, and where it can be checked, whether it is the right value:
# against production's own data for those that must be the earlier host's (a stored
# ciphertext must open with CREDENTIAL_ENCRYPTION_KEY, a stored phone code's hash
# must come out of RUN_SKILL_INTERNAL_SECRET, CLOUD_BROWSER_SIGNING_KEY's public half
# must be the one pinned in the desktop app), and with a read-only call to the
# provider for keys any working value of which does. It ends with whether Gate 1's
# settings are met, and what is still in the way.
#
# --fill also brings GPT_LIVE_TRUNK_SECRET from the Twilio trunk's origination
# address, with the Twilio settings already in the file, when it is still empty.
#
# Changes nothing else. Needs ssh here; on the server python3 with its cryptography
# package, sudo without a password, and the Supabase stack running.
#
# Settings:
#   PULL_SSH_OPTS   extra options for ssh
#   PULL_ENV_FILE   the file on the server (default /opt/native-intelligence/deploy/app/.env)
set -euo pipefail

die() { echo "check: $*" >&2; exit 1; }

server="${1:-}"
case "$server" in *@*) ;; *) die "usage: check-settings.sh <user>@<server> [--fill]" ;; esac
shift
fill=0
for arg in "$@"; do
	case "$arg" in --fill) fill=1 ;; *) die "unknown argument $arg" ;; esac
done
: "${PULL_SSH_OPTS:=}" "${PULL_ENV_FILE:=/opt/native-intelligence/deploy/app/.env}"
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
[ -f "$here/check_settings.py" ] || die "check_settings.py is missing beside this script."
[ -f "$here/../supabase/envfile.py" ] || die "deploy/supabase/envfile.py is missing; run this from a full checkout."

# The public keys the released desktop app accepts (desktop/src-tauri/src/browser_exit.rs).
pinned_file="$root/desktop/src-tauri/src/browser_exit.rs"
args=()
if [ -f "$pinned_file" ]; then
	while IFS= read -r key; do args+=(--pinned "$key"); done < <(
		sed -n 's/^pub const PINNED_KEYS: &\[&str\] = &\[\(.*\)\];$/\1/p' "$pinned_file" | tr ',' '\n' | sed -n 's/^ *"\([A-Za-z0-9+\/=]*\)" *$/\1/p')
fi
# (${args[*]+x}: an empty array is "unset" to the bash 3.2 that macOS ships, under set -u.)
[ -n "${args[*]+x}" ] || echo "check: no pinned desktop key found in $pinned_file; CLOUD_BROWSER_SIGNING_KEY is only checked for its shape." >&2
# The embedding model the app asks Google for (web/src/lib/ai/gemini-embeddings.ts).
model="$(sed -n "s/^const GEMINI_EMBEDDING_MODEL = '\([A-Za-z0-9._-]*\)'$/\1/p" "$root/web/src/lib/ai/gemini-embeddings.ts" 2>/dev/null | head -1)"
[ -n "$model" ] && args+=(--embedding-model "$model")

program="$(base64 <"$here/check_settings.py" | tr -d '\n')"
envfile="$(base64 <"$here/../supabase/envfile.py" | tr -d '\n')"
quoted=""
for a in ${args[@]+"${args[@]}"}; do quoted="$quoted $(printf '%q' "$a")"; done

# The program travels as an argument (it holds no secret). With --fill, envfile.py is
# put beside it, root-only, for the length of the run, to write the one value.
# shellcheck disable=SC2086,SC2029
ssh $PULL_SSH_OPTS -o BatchMode=yes -o ConnectTimeout=20 "$server" "set -e
p=\$(sudo mktemp /root/.ni-check.XXXXXX); e=\$(sudo mktemp /root/.ni-envfile.XXXXXX)
trap 'sudo rm -f \"\$p\" \"\$e\"' EXIT
echo $program | base64 -d | sudo tee \"\$p\" >/dev/null
echo $envfile | base64 -d | sudo tee \"\$e\" >/dev/null
fill=''; [ $fill = 1 ] && fill=\"--fill \$e\"
sudo python3 -I \"\$p\" $(printf '%q' "$PULL_ENV_FILE") \$fill$quoted </dev/null"
