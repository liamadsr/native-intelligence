#!/usr/bin/env bash
# The sealed copy: the app's write-only production settings, from its earlier host
# into the server's deploy/app/.env, without anyone seeing them (README.md in this
# folder, "Sealed copy"). Run it on your own machine, from a full checkout.
#
#   deploy/app/sealed-copy.sh new-key <user>@<server>
#       Makes the server's key pair (sealed_settings.py new-key): the private half
#       stays on the server, root only; the public half is written to
#       web/scripts/seal-settings.pub here, to be committed and merged.
#
#   deploy/app/sealed-copy.sh open <user>@<server> <deployment id or address>
#       Reads that production deployment's build log from the earlier host (its
#       command-line tool, logged in; PULL_TEAM is the team id), cuts out the
#       sealed block web/scripts/seal-settings.mjs printed, and sends it to the
#       server, which opens it, writes the values into .env through envfile.py,
#       and deletes its private key. Then runs check-settings.sh, which proves the
#       values that can be proven. Nothing on the way shows a value: the block is
#       sealed, and the server prints names, what happened to each, and lengths.
#
# Settings:
#   PULL_SSH_OPTS   extra options for ssh
#   PULL_ENV_FILE   the file on the server (default /opt/native-intelligence/deploy/app/.env)
#   PULL_TEAM       (open) the team id the app's project is in on the earlier host
#   PULL_PROJECT    (open) the app's project id there: a deployment of any other
#                   project is refused
#   SEAL_KEY_FILE   the private key on the server (default /root/ni-seal/settings.key)
set -euo pipefail

die() { echo "sealed: $*" >&2; exit 1; }

command="${1:-}"
server="${2:-}"
case "$command" in new-key | open) ;; *) die "usage: sealed-copy.sh new-key <user>@<server> | open <user>@<server> <deployment>" ;; esac
case "$server" in *@*) ;; *) die "name the server as <user>@<server>." ;; esac
: "${PULL_SSH_OPTS:=}" "${PULL_ENV_FILE:=/opt/native-intelligence/deploy/app/.env}" "${SEAL_KEY_FILE:=/root/ni-seal/settings.key}"
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
[ -f "$here/sealed_settings.py" ] || die "sealed_settings.py is missing beside this script."
program="$(base64 <"$here/sealed_settings.py" | tr -d '\n')"

ssh_server() { # ssh_server <remote command>, stdin passed through
	# shellcheck disable=SC2086,SC2029
	ssh $PULL_SSH_OPTS -o BatchMode=yes -o ConnectTimeout=20 "$server" "$1"
}

if [ "$command" = new-key ]; then
	# Into a file, not $( ): the bash 3.2 macOS ships misreads the quotes below inside one.
	out="$(mktemp)"
	trap 'rm -f "$out"' EXIT
	ssh_server "set -e; p=\$(sudo mktemp /root/.ni-sealed.XXXXXX); trap 'sudo rm -f \"\$p\"' EXIT
echo $program | base64 -d | sudo tee \"\$p\" >/dev/null
sudo python3 -I \"\$p\" new-key $(printf '%q' "$SEAL_KEY_FILE") </dev/null" >"$out"
	head -1 "$out"
	public="$(tail -1 "$out")"
	case "$public" in MC[A-Za-z0-9+/]*=) ;; *) die "the server did not print a public key." ;; esac
	printf '%s\n' "$public" >"$root/web/scripts/seal-settings.pub"
	echo "Written to web/scripts/seal-settings.pub: commit it, and have it merged before the sealing build."
	exit 0
fi

deployment="${3:-}"
[ -n "$deployment" ] || die "name the production deployment whose build sealed the settings (its id, dpl_…, or its address)."
: "${PULL_TEAM:?set PULL_TEAM to the team id the project is in}" "${PULL_PROJECT:?set PULL_PROJECT to the project id}"
command -v vercel >/dev/null || die "the earlier host's command-line tool (vercel) is needed here, logged in."
[ -f "$here/../supabase/envfile.py" ] || die "deploy/supabase/envfile.py is missing; run this from a full checkout."
envfile="$(base64 <"$here/../supabase/envfile.py" | tr -d '\n')"

# The build log, in order, cut down to the block (sealed_settings.py cut, here). The
# block is sealed: what passes through this machine is ciphertext only.
ref="${deployment#https://}"
ref="${ref%%/*}"
found="$(vercel api "/v13/deployments/$ref?teamId=$PULL_TEAM" 2>/dev/null | python3 -I "$here/sealed_settings.py" production-id "$PULL_PROJECT")" ||
	die "the earlier host does not know $ref as a production deployment of the app's project."
id="${found% *}"
created="${found#* }"
block="$(vercel api "/v3/deployments/$id/events?builds=1&limit=-1&direction=forward&teamId=$PULL_TEAM" 2>/dev/null |
	python3 -I "$here/sealed_settings.py" cut)" || die "no complete sealed block in that build's log (was NI_SEAL_SETTINGS=1 set for it?)."

printf '%s\n' "$block" | ssh_server "set -e
p=\$(sudo mktemp /root/.ni-sealed.XXXXXX); e=\$(sudo mktemp /root/.ni-envfile.XXXXXX)
trap 'sudo rm -f \"\$p\" \"\$e\"' EXIT
echo $program | base64 -d | sudo tee \"\$p\" >/dev/null
echo $envfile | base64 -d | sudo tee \"\$e\" >/dev/null
sudo python3 -I \"\$p\" open $(printf '%q' "$SEAL_KEY_FILE") $(printf '%q' "$PULL_ENV_FILE") \"\$e\" $(printf '%q' "$id") $(printf '%q' "$created")"
block=""

# The switch that made the build seal must not stay on: every later production
# build would print a block again.
if vercel api "/v10/projects/$PULL_PROJECT/env?teamId=$PULL_TEAM" 2>/dev/null | grep -q '"key": *"NI_SEAL_SETTINGS"'; then
	echo
	echo "!! NI_SEAL_SETTINGS is still set on the earlier host: remove it now (README.md in this folder, \"Sealed copy\", step 3)."
fi

echo
echo "Proving what can be proven:"
"$here/check-settings.sh" "$server" --fill
