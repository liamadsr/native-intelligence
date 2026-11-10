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
# What it needs:
#   - A Supabase access token: SUPABASE_ACCESS_TOKEN, or on a Mac the login
#     that the Supabase CLI keeps in the keychain ("supabase login").
#   - python3 and ssh here; python3 and sudo without a password on the server.
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

token="${SUPABASE_ACCESS_TOKEN:-}"
if [ -z "$token" ] && command -v security >/dev/null 2>&1; then
	token="$(security find-generic-password -s "Supabase CLI" -a supabase -w 2>/dev/null || true)"
	case "$token" in go-keyring-base64:*) token="$(printf '%s' "${token#go-keyring-base64:}" | base64 -d)" ;; esac
fi
[ -n "$token" ] || die "no Supabase access token: set SUPABASE_ACCESS_TOKEN, or run 'supabase login' first."

# Reads the three settings documents and prints the lines for stack/.env on
# stdout. What it tells the person goes to stderr and never contains a secret.
# The token reaches it through its environment, not its arguments.
build_lines() {
	NI_TOKEN="$token" NI_REF="$ref" python3 - <<'PY'
import json, os, re, sys, urllib.request, urllib.error

ref, token = os.environ["NI_REF"], os.environ["NI_TOKEN"]

def get(path):
    req = urllib.request.Request(
        "https://api.supabase.com/v1/projects/%s/%s" % (ref, path),
        headers={"Authorization": "Bearer " + token, "User-Agent": "pull-hosted-settings"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit("pull: the hosted project refused %s (HTTP %s). Does the token belong to an owner of the project?" % (path, e.code))
    except Exception as e:
        sys.exit("pull: could not read %s: %s" % (path, e))

pg, keys, auth = get("postgrest"), get("api-keys?reveal=true"), get("config/auth")

say = lambda *a: print(*a, file=sys.stderr)
out, notes = [], []

def fmt(v):
    """One value as a line of an env file that Docker Compose, a shell and
    check-env.sh all read the same way."""
    v = "" if v is None else str(v)
    if "\n" in v or "\r" in v:
        sys.exit("pull: a value contains a line break; that cannot go into an env file.")
    if re.fullmatch(r"[A-Za-z0-9_./:@,+=-]*", v):
        return v
    if "'" not in v:
        return "'" + v + "'"
    return '"' + v.replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$").replace("`", "\\`") + '"'

def put(name, value, secret=False):
    out.append("%s=%s" % (name, fmt(value)))
    v = "" if value is None else str(value)
    if secret:
        say("   %-34s %s" % (name, "set (%d characters)" % len(v) if v else "EMPTY on the hosted project"))
    else:
        say("   %-34s %s" % (name, v if len(v) <= 60 else v[:57] + "..."))

flag = lambda v: "true" if v else "false"
join = lambda *parts: ",".join(p for p in parts if p)

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

for name, key in (("GOOGLE", "google"), ("APPLE", "apple")):
    on = auth.get("external_%s_enabled" % key)
    put(name + "_ENABLED", flag(on))
    put(name + "_CLIENT_ID", join(auth.get("external_%s_client_id" % key), auth.get("external_%s_additional_client_ids" % key)))
    put(name + "_SECRET", auth.get("external_%s_secret" % key), secret=True)
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
    put("SMTP_PASS", auth.get("smtp_pass"), secret=True)
else:
    notes.append("The hosted project has NO SMTP settings: it sends its sign-in emails through Supabase's own mail service, which a self-hosted stack does not have. The six SMTP_ lines were left as they are. Fill them with a mail provider's SMTP details, or confirmation and password-reset emails will not be sent.")

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

if notes:
    say("")
    say("To know:")
    for n in notes:
        say("   - " + n)

print("\n".join(out))
PY
}

# On the server: replace the value of each named line in the settings file,
# keeping everything else, and put the new file in place in one move. Refuses
# a name the file does not have, so a typo cannot add a setting nothing reads.
apply_py='
import os, sys, tempfile
path = sys.argv[2]  # argv[1] is this program itself, encoded
new = {}
for line in sys.stdin.read().splitlines():
    if line.strip():
        k, _, v = line.partition("=")
        new[k] = v
if not new:
    sys.exit("apply: nothing arrived; the file was not changed.")
try:
    lines = open(path).read().split("\n")
except OSError as e:
    sys.exit("apply: cannot read %s (%s). Create it first: step 14 of deploy/README.md." % (path, e.strerror))
last = {}
for i, line in enumerate(lines):
    k = line.split("=", 1)[0]
    if "=" in line and k in new:
        last[k] = i
missing = sorted(set(new) - set(last))
if missing:
    sys.exit("apply: %s has no line for %s; nothing was changed." % (path, ", ".join(missing)))
for k, i in last.items():
    lines[i] = k + "=" + new[k]
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".env.")
with os.fdopen(fd, "w") as f:
    f.write("\n".join(lines))
os.chmod(tmp, 0o600)
os.chown(tmp, 0, 0)
os.replace(tmp, path)
print("%d settings written to %s" % (len(new), path))
'

if [ "${PULL_DRY_RUN:-}" = 1 ]; then
	build_lines >/dev/null
	echo
	echo "Dry run: nothing was sent to a server."
	exit 0
fi

# The lines travel from the reader to the server through a pipe. The small
# program that applies them holds no secret, so it can travel as an argument.
encoded="$(printf '%s' "$apply_py" | base64 | tr -d '\n')"
# shellcheck disable=SC2086,SC2029
build_lines | ssh $PULL_SSH_OPTS -o BatchMode=yes -o ConnectTimeout=20 "$server" \
	"sudo python3 -c 'import base64,sys; exec(base64.b64decode(sys.argv[1]))' $encoded $(printf '%q' "$PULL_ENV_FILE")"

echo
echo "Next, on the server: fill in what is still empty, then  cd $(dirname "$(dirname "$PULL_ENV_FILE")") && sudo ./check-env.sh"
