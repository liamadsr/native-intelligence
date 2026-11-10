#!/usr/bin/env bash
# Reads the hosted Supabase project's settings and writes them into the
# stack's settings file on the server (stack/.env), sections 2 and 4 of
# .env.example, without showing a single secret: not to you, not in a
# terminal, not in a log. It is the alternative to reading some twenty values
# off the hosted dashboard and typing them in (step 14 of ../README.md).
#
# Run it on your own machine:
#
#   deploy/supabase/pull-hosted-settings.sh <project ref> <user>@<server>
#
# It only reads from the hosted project. On the server it changes the values
# of lines that already exist in stack/.env and nothing else, so create that
# file first, as step 14 describes.
#
# What it cannot bring: the Google and Apple client secrets and the SMTP
# password. The hosted project hands those out as a fingerprint only, never
# the value itself. It tells you which of them you need, and set-secret.sh
# beside this file takes them with hidden typing.
#
# What it needs:
#   - A Supabase access token of an owner of the project: SUPABASE_ACCESS_TOKEN,
#     or on a Mac the login that the Supabase CLI keeps ("supabase login").
#   - python3 and ssh here; python3 and sudo WITHOUT a password on the server:
#     this runs without a terminal, so sudo has nobody to ask. A user made as
#     step 2 of ../README.md describes is asked for one; lift that for the
#     length of the job with
#       echo '<user> ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/90-ni-pull
#     and remove that file afterwards.
#
# Settings:
#   PULL_SSH_OPTS   extra options for ssh, for example
#                   "-i $HOME/.ssh/id_ed25519 -o IdentitiesOnly=yes"
#   PULL_ENV_FILE   the file on the server
#                   (default /opt/native-intelligence/deploy/supabase/stack/.env)
#   PULL_DRY_RUN=1  read the hosted project and say what would be written;
#                   the server is not contacted
set -euo pipefail

die() { echo "pull: $*" >&2; exit 1; }

ref="${1:-}"
server="${2:-}"
[ -n "$ref" ] || die "usage: pull-hosted-settings.sh <project ref> <user>@<server>"
case "$ref" in *[!a-z0-9]*) die "that does not look like a project ref (lower-case letters and digits)." ;; esac
if [ "${PULL_DRY_RUN:-}" != 1 ]; then
	case "$server" in *@*) ;; *) die "the second argument is the server login, as user@host." ;; esac
fi
: "${PULL_SSH_OPTS:=}" "${PULL_ENV_FILE:=/opt/native-intelligence/deploy/supabase/stack/.env}"
command -v python3 >/dev/null || die "python3 is needed here."
here="$(cd "$(dirname "$0")" && pwd)"
[ -f "$here/envfile.py" ] || die "envfile.py is missing beside this script."

# The CLI has kept its login in different places over time.
token="${SUPABASE_ACCESS_TOKEN:-}"
if [ -z "$token" ] && command -v security >/dev/null 2>&1; then
	for account in supabase access-token; do
		token="$(security find-generic-password -s "Supabase CLI" -a "$account" -w 2>/dev/null || true)"
		[ -z "$token" ] || break
	done
	case "$token" in go-keyring-base64:*) token="$(printf '%s' "${token#go-keyring-base64:}" | base64 -d)" ;; esac
fi
if [ -z "$token" ] && [ -r "$HOME/.supabase/access-token" ]; then token="$(cat "$HOME/.supabase/access-token")"; fi
[ -n "$token" ] || die "no Supabase access token: set SUPABASE_ACCESS_TOKEN, or run 'supabase login' first."
# Anything else (a stray line ending from a file, say) would end up inside an
# error message further down, and that message would show the token.
case "$token" in *[!A-Za-z0-9_.-]*) die "the access token has characters a token never has (a line ending copied along with it?). Nothing was read." ;; esac

# Reads the three settings documents and prints one JSON object of
# name -> value on stdout. What it tells the person goes to stderr and never
# contains a secret. The token reaches it through its environment.
build_values() {
	NI_TOKEN="$token" NI_REF="$ref" python3 - <<'PY'
import json, os, re, sys, urllib.request, urllib.error

ref, token = os.environ["NI_REF"], os.environ["NI_TOKEN"]

class NoRedirect(urllib.request.HTTPRedirectHandler):
    # A redirect would carry the token along to wherever it points.
    def redirect_request(self, *args, **kwargs):
        return None

opener = urllib.request.build_opener(NoRedirect)

def get(path):
    req = urllib.request.Request(
        "https://api.supabase.com/v1/projects/%s/%s" % (ref, path),
        headers={"Authorization": "Bearer " + token, "User-Agent": "pull-hosted-settings"})
    try:
        with opener.open(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit("pull: the hosted project refused %s (HTTP %s). Does the token belong to an owner of the project?" % (path, e.code))
    except urllib.error.URLError as e:
        sys.exit("pull: could not reach the hosted project for %s (%s)." % (path, type(e.reason).__name__))
    except Exception as e:
        # Only the kind of error: its text can contain the request, token included.
        sys.exit("pull: could not read %s (%s)." % (path, type(e).__name__))

pg, keys, auth = get("postgrest"), get("api-keys?reveal=true"), get("config/auth")

say = lambda *a: print(*a, file=sys.stderr)
out, notes = {}, []
fingerprint = re.compile(r"[0-9a-f]{64}")

# Checked by check-env.sh against each other, so a wrong one cannot pass. A
# project may well have chosen a 64-character hex secret of its own.
verified_later = {"JWT_SECRET", "ANON_KEY", "SERVICE_ROLE_KEY"}

def put(name, value, secret=False):
    v = "" if value is None else str(value)
    # The hosted project answers with a fingerprint in place of some secrets.
    # Writing one would look like success and fail at the first sign-in.
    if name not in verified_later and fingerprint.fullmatch(v):
        sys.exit("pull: %s came back as a fingerprint, not a value; nothing was written." % name)
    out[name] = v
    if secret:
        say("   %-34s %s" % (name, "set (%d characters)" % len(v) if v else "EMPTY on the hosted project"))
    else:
        say("   %-34s %s" % (name, v if len(v) <= 60 else v[:57] + "..."))

flag = lambda v: "true" if v else "false"
join = lambda *parts: ",".join(p for p in parts if p)
by_hand = []

say("From project %s:" % ref)

# --- section 2: what everything already issued was signed with
legacy = {k.get("name"): k.get("api_key") for k in keys if k.get("type") == "legacy"}
if not pg.get("jwt_secret") or not legacy.get("anon") or not legacy.get("service_role"):
    sys.exit("pull: the hosted project did not hand over its JWT secret and both legacy keys; nothing was written.")
put("JWT_SECRET", pg["jwt_secret"], secret=True)
put("ANON_KEY", legacy["anon"], secret=True)
put("SERVICE_ROLE_KEY", legacy["service_role"], secret=True)
put("JWT_EXPIRY", auth.get("jwt_exp"))

# --- section 4: auth settings that exist only in the hosted dashboard
put("SITE_URL", auth.get("site_url"))
put("ADDITIONAL_REDIRECT_URLS", auth.get("uri_allow_list"))
put("DISABLE_SIGNUP", flag(auth.get("disable_signup")))
put("ENABLE_EMAIL_SIGNUP", flag(auth.get("external_email_enabled")))
put("ENABLE_EMAIL_AUTOCONFIRM", flag(auth.get("mailer_autoconfirm")))
put("ENABLE_ANONYMOUS_USERS", flag(auth.get("external_anonymous_users_enabled")))
put("ENABLE_PHONE_SIGNUP", flag(auth.get("external_phone_enabled")))
put("ENABLE_PHONE_AUTOCONFIRM", flag(auth.get("sms_autoconfirm")))
if auth.get("external_phone_enabled"):
    notes.append("Phone sign-in is ON there. This stack has no settings for an SMS provider, so codes would not be sent.")

# Client ids are public and come across. The client SECRETS do not: the
# hosted project only ever returns their fingerprint.
for name, key in (("GOOGLE", "google"), ("APPLE", "apple")):
    on = auth.get("external_%s_enabled" % key)
    put(name + "_ENABLED", flag(on))
    put(name + "_CLIENT_ID", join(auth.get("external_%s_client_id" % key), auth.get("external_%s_additional_client_ids" % key)))
    if on:
        by_hand.append(name + "_SECRET")
if auth.get("external_google_skip_nonce_check"):
    notes.append("Google's 'Skip nonce checks' is ON there. Uncomment GOOGLE_SKIP_NONCE_CHECK=true in stack/.env by hand.")

# The switch stays off until the database, and with it the function the hook
# calls, has been restored. With it on and the function missing nobody can sign up.
put("HOOK_BEFORE_USER_CREATED_ENABLED", "false")
if auth.get("hook_before_user_created_enabled"):
    notes.append("The sign-up check (Before User Created hook) is ON there. It is written as false here on purpose: turn it on after the database has been restored (step 16).")

if auth.get("smtp_host"):
    put("SMTP_ADMIN_EMAIL", auth.get("smtp_admin_email"))
    put("SMTP_SENDER_NAME", auth.get("smtp_sender_name"))
    put("SMTP_HOST", auth.get("smtp_host"))
    put("SMTP_PORT", auth.get("smtp_port"))
    put("SMTP_USER", auth.get("smtp_user"), secret=True)
    by_hand.append("SMTP_PASS")
else:
    notes.append("The hosted project has NO SMTP settings: it sends its sign-in emails through Supabase's own mail service, which a self-hosted stack does not have. The six SMTP_ lines were left as they are. Fill them with a mail provider's SMTP details: without them the sign-in service does not even start.")

for name in ("confirmation", "invite", "magic_link", "recovery", "email_change"):
    put("MAILER_SUBJECTS_" + name.upper(), auth.get("mailer_subjects_" + name))

# --- things the hosted project has switched on that stack/.env has no line for
known = {"email", "google", "apple", "phone", "anonymous_users"}
for k, v in sorted(auth.items()):
    m = re.fullmatch(r"external_(.+)_enabled", k)
    if m and v is True and m.group(1) not in known:
        notes.append("Sign-in with %s is ON there and this stack has no setting for it." % m.group(1))
    m = re.fullmatch(r"hook_(.+)_enabled", k)
    if m and v is True and m.group(1) != "before_user_created":
        notes.append("The %s hook is ON there and this stack has no setting for it." % m.group(1))
if auth.get("security_captcha_enabled"):
    notes.append("CAPTCHA is ON there and this stack has no setting for it.")
if auth.get("sessions_timebox") or auth.get("sessions_inactivity_timeout") or auth.get("sessions_single_per_user"):
    notes.append("Session limits are set there and this stack has no setting for them.")
notes.append("Not compared at all: rate limits, password rules, one-time-code length and expiry, and MFA switches. Where the hosted project differs from Auth's defaults there, this stack runs on the defaults (see 'Settings this list does not cover' in README.md).")

say("")
if by_hand:
    say("NOT brought, because the hosted project only gives out their fingerprint:")
    for n in by_hand:
        say("   %s" % n)
    say("   Enter them with:  deploy/supabase/set-secret.sh <user>@<server> %s" % " ".join(by_hand))
    say("")
say("To know:")
for n in notes:
    say("   - " + n)

json.dump(out, sys.stdout)
PY
}

if [ "${PULL_DRY_RUN:-}" = 1 ]; then
	build_values >/dev/null
	echo
	echo "Dry run: nothing was sent to a server."
	exit 0
fi

# The values travel from the reader to the server through a pipe, as one JSON
# object: one that arrives cut short does not parse, and nothing is applied.
# The program that applies them holds no secret, so it travels as an argument.
encoded="$(base64 <"$here/envfile.py" | tr -d '\n')"
# Read first, send second: when the hosted project refuses, the server is not
# contacted at all. printf is part of the shell, so the values never appear
# in a process list.
values="$(build_values)"
# -I keeps python from loading a module out of the login user's home folder,
# which is where this command starts, in place of its own.
# shellcheck disable=SC2086,SC2029
printf '%s' "$values" | ssh $PULL_SSH_OPTS -o BatchMode=yes -o ConnectTimeout=20 "$server" \
	"sudo python3 -I -c 'import base64,sys; a=sys.argv; sys.argv=[a[0]]+a[2:]; exec(base64.b64decode(a[1]))' $encoded apply $(printf '%q' "$PULL_ENV_FILE")"
values=""

echo
echo "Next, on the server: fill in what is still empty, then  cd $(dirname "$(dirname "$PULL_ENV_FILE")") && sudo ./check-env.sh"
