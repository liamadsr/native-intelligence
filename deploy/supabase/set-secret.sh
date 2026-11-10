#!/usr/bin/env bash
# Puts secrets into the stack's settings file on the server (stack/.env) with
# hidden typing: what you paste is not shown, is not kept in your shell's
# history, and is not written anywhere but that file.
#
# Run it on your own machine, in a terminal:
#
#   deploy/supabase/set-secret.sh <user>@<server> NAME [NAME ...]
#
# for example
#
#   deploy/supabase/set-secret.sh <user>@<server> GOOGLE_SECRET SMTP_PASS
#
# It asks for each one in turn. A name the file has no line for is refused.
#
# NAME=pattern asks for one part of a value. What you type is percent-encoded
# and put where the pattern has {}. That is how a database password goes into
# a connection string without you having to encode it by hand:
#
#   PULL_ENV_FILE=/opt/native-intelligence/deploy/supabase/migrate/.env \
#     deploy/supabase/set-secret.sh <user>@<server> \
#     'SOURCE_DB_URL=postgresql://postgres.<ref>:{}@<pooler host>:5432/postgres'
#
# It is for the values pull-hosted-settings.sh cannot bring (the hosted
# project never gives out provider secrets or the SMTP password), and for the
# ones that come from somewhere else altogether (Stripe).
#
# Needs python3 and sudo on the server. Unlike pull-hosted-settings.sh it runs
# in a terminal, so a sudo that asks for a password simply asks.
#
# One thing to know about the server: if its sudo is set up to record what is
# typed (the "log_input" option; Ubuntu does not turn it on), what you paste
# here is recorded too.
#
# Settings:
#   PULL_SSH_OPTS   extra options for ssh
#   PULL_ENV_FILE   the file on the server
#                   (default /opt/native-intelligence/deploy/supabase/stack/.env)
set -euo pipefail

die() { echo "set-secret: $*" >&2; exit 1; }

server="${1:-}"
case "$server" in *@*) ;; *) die "usage: set-secret.sh <user>@<server> NAME [NAME ...]" ;; esac
shift
[ $# -gt 0 ] || die "name at least one setting."
names=""
for arg in "$@"; do
	name="${arg%%=*}"
	case "$name" in "" | *[!A-Za-z0-9_]* | [0-9]*) die "'$name' is not a setting name." ;; esac
	# Quoted for the far shell: a pattern holds characters it would act on.
	names="$names $(printf '%q' "$arg")"
done
: "${PULL_SSH_OPTS:=}" "${PULL_ENV_FILE:=/opt/native-intelligence/deploy/supabase/stack/.env}"
[ -t 0 ] || die "this needs a terminal: it asks for each value with the typing hidden."
here="$(cd "$(dirname "$0")" && pwd)"
[ -f "$here/envfile.py" ] || die "envfile.py is missing beside this script."

# The program travels as an argument (it holds no secret); the secrets are
# typed straight into it on the server, over the terminal ssh -t provides.
encoded="$(base64 <"$here/envfile.py" | tr -d '\n')"
# shellcheck disable=SC2086,SC2029
ssh -t $PULL_SSH_OPTS -o ConnectTimeout=20 "$server" \
	"sudo python3 -I -c 'import base64,sys; a=sys.argv; sys.argv=[a[0]]+a[2:]; exec(base64.b64decode(a[1]))' $encoded prompt $(printf '%q' "$PULL_ENV_FILE")$names"
