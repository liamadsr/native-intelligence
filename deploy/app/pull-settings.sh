#!/usr/bin/env bash
# Fills the app's settings file on the server (deploy/app/.env) without showing a
# single value: not to you, not in a terminal, not in a log. Run it on your own
# machine:
#
#   PULL_PROJECT=<project id> PULL_TEAM=<team id> \
#     deploy/app/pull-settings.sh <user>@<server> [NAME=value ...]
#
# In order:
#   1. The production settings of the app's earlier host (its API, through its
#      command-line tool, which must be logged in here): every one it will give out
#      is written into the file under the same name. Those it keeps write-only
#      ("sensitive") cannot be read back by anyone; they are listed at the end.
#   2. On the server: the Inngest keys are copied from ../inngest/.env, and the two
#      Supabase keys are compared with ../supabase/stack/.env (a mismatch is
#      reported, never fixed silently).
#   3. NAME=value arguments, last: plain settings you choose, such as the test
#      address of a rehearsal (NEXT_PUBLIC_APP_URL=https://test.example.com). Never
#      a secret here: it would be in your shell history. Secrets go in with
#      set-secret.sh (below).
#   4. With PULL_GENERATE=1: a new random value for each internal secret that may
#      be new on the server and is still empty (the list is below; README.md in this
#      folder says why each one may).
#   5. With PULL_REHEARSAL=1: a stand-in, starting with "rehearsal-", for each of the
#      two internal secrets the app cannot start without that must otherwise be the
#      earlier host's (RUN_SKILL_INTERNAL_SECRET, BROWSER_INTERNAL_SECRET), while they
#      are empty. Enough for a rehearsal. The containers refuse to start with
#      NI_LIVE=1 while any value starts with "rehearsal-" (entrypoint.sh).
#
# It ends with check_settings.py's report, by name only: each setting's group (must
# be the earlier host's value, needed, may stay empty), what is still empty, and
# whether Gate 1's settings are met by name (step 21 of ../README.md). Enter what is
# missing with
#
#   PULL_ENV_FILE=/opt/native-intelligence/deploy/app/.env \
#     deploy/supabase/set-secret.sh <user>@<server> NAME ...
#
# and check the values themselves with check-settings.sh.
#
# It only changes values of lines that exist: make the file first, on the server,
# with `sudo install -m 600 -o root -g root .env.example .env` in deploy/app.
#
# Needs here: python3, ssh, and the earlier host's command-line tool, logged in.
# On the server: python3, and sudo without a password (see
# deploy/supabase/pull-hosted-settings.sh for how to lift that for a while).
#
# Settings:
#   PULL_PROJECT, PULL_TEAM  the project and team the app runs under there
#   PULL_SSH_OPTS            extra options for ssh
#   PULL_ENV_FILE            the file on the server
#                            (default /opt/native-intelligence/deploy/app/.env)
#   PULL_GENERATE=1          step 4
#   PULL_REHEARSAL=1         step 5
#   PULL_DRY_RUN=1           read, and say what would be written; the server is
#                            not contacted
set -euo pipefail

die() { echo "pull: $*" >&2; exit 1; }

server="${1:-}"
[ $# -gt 0 ] && shift
if [ "${PULL_DRY_RUN:-}" != 1 ]; then
	case "$server" in *@*) ;; *) die "usage: pull-settings.sh <user>@<server> [NAME=value ...]" ;; esac
fi
: "${PULL_PROJECT:?set PULL_PROJECT to the project id}" "${PULL_TEAM:?set PULL_TEAM to the team id}"
: "${PULL_SSH_OPTS:=}" "${PULL_ENV_FILE:=/opt/native-intelligence/deploy/app/.env}"
command -v python3 >/dev/null || die "python3 is needed here."
command -v vercel >/dev/null || die "the earlier host's command-line tool (vercel) is needed here, logged in."
here="$(cd "$(dirname "$0")" && pwd)"
envfile_py="$here/../supabase/envfile.py"
[ -f "$envfile_py" ] || die "deploy/supabase/envfile.py is missing; run this from a full checkout."
[ -f "$here/.env.example" ] || die ".env.example is missing beside this script."
[ -f "$here/check_settings.py" ] || die "check_settings.py is missing beside this script."
for arg in "$@"; do
	case "${arg%%=*}" in "" | *[!A-Za-z0-9_]* | [0-9]*) die "'$arg' is not NAME=value." ;; esac
	case "$arg" in *=*) ;; *) die "'$arg' is not NAME=value." ;; esac
done

# Reads the earlier host and prints one JSON object of the values to write. The
# report goes to stderr, by name only.
build_values() {
	python3 -I - "$here/.env.example" "$PULL_PROJECT" "$PULL_TEAM" "$@" <<'PY'
import json, re, subprocess, sys

example, project, team = sys.argv[1:4]
overrides = sys.argv[4:]

def say(line=""):
    print(line, file=sys.stderr)

def api(path):
    sep = "&" if "?" in path else "?"
    r = subprocess.run(["vercel", "api", path + sep + "teamId=" + team], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("pull: the earlier host refused %s (exit %d). Is its tool logged in, and are PULL_PROJECT and PULL_TEAM right?" % (path.split("?")[0], r.returncode))
    try:
        return json.loads(r.stdout)
    except ValueError:
        sys.exit("pull: the earlier host's answer to %s was not JSON." % path.split("?")[0])

with open(example) as f:
    known = [l.split("=", 1)[0] for l in f.read().split("\n") if re.match(r"[A-Z_][A-Z0-9_]*=", l)]

# Names the earlier host sets that have no meaning here: its own build switches.
SKIP = re.compile(r"^VERCEL_")

envs = api("/v10/projects/%s/env" % project).get("envs", [])
production = [e for e in envs if "production" in (e.get("target") or []) and not e.get("gitBranch")]
out, sensitive, unknown, skipped = {}, [], [], []
for e in sorted(production, key=lambda e: e["key"]):
    name = e["key"]
    if SKIP.match(name):
        skipped.append(name)
        continue
    if name not in known:
        unknown.append(name)
        continue
    if e.get("type") == "sensitive":
        sensitive.append(name)
        continue
    full = api("/v1/projects/%s/env/%s" % (project, e["id"]))
    value = full.get("value")
    if e.get("type") == "encrypted" and full.get("decrypted") is not True:
        sys.exit("pull: %s came back still encrypted; nothing was written." % name)
    if not isinstance(value, str):
        sys.exit("pull: %s came back without a value; nothing was written." % name)
    out[name] = value

for arg in overrides:
    name, _, value = arg.partition("=")
    if name not in known:
        sys.exit("pull: %s is not a line of .env.example; nothing was written." % name)
    out[name] = value

say("From the earlier host's production settings: %d written." % (len(out) - len(overrides)))
for n in sorted(out):
    if n not in [a.split("=", 1)[0] for a in overrides]:
        say("   %s (%d characters)" % (n, len(out[n])))
if overrides:
    say("Set by you: %s" % ", ".join(a.split("=", 1)[0] for a in overrides))
if skipped:
    say("Left out, the earlier host's own: %s" % ", ".join(skipped))
if unknown:
    say("NOT brought, because .env.example has no line for them (add one, then run this again):")
    for n in unknown:
        say("   %s" % n)
say("Write-only there, so not brought: %s" % (", ".join(sensitive) or "none"))
json.dump(out, sys.stdout)
PY
}

# Runs on the server, as root: copies what the server already holds, compares, and
# reports what is still empty. Prints names and lengths, never values.
server_side() {
	cat <<'PY'
import json, os, re, secrets, subprocess, sys

target = sys.argv[1]
generate = sys.argv[2] == "1"
envfile_py = sys.argv[3]
rehearsal_stand_ins = sys.argv[4] == "1"
root = os.path.dirname(os.path.dirname(os.path.realpath(target)))  # .../deploy

def read_env(path):
    """The values of a Compose env file, as Compose reads them (the forms envfile.py writes)."""
    values = {}
    with open(path) as f:
        for line in f.read().split("\n"):
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

def apply(new):
    if not new:
        return
    r = subprocess.run([sys.executable, "-I", envfile_py, "apply", target], input=json.dumps(new), text=True)
    if r.returncode != 0:
        sys.exit(r.returncode)

app = read_env(target)

# The Inngest keys: the server's own, copied.
inngest_env = os.path.join(root, "inngest", ".env")
if os.path.exists(inngest_env):
    inn = read_env(inngest_env)
    copy = {k: inn[k] for k in ("INNGEST_SIGNING_KEY", "INNGEST_EVENT_KEY") if inn.get(k)}
    apply(copy)
    print("Copied from ../inngest/.env: %s" % (", ".join(sorted(copy)) or "nothing (it has no keys)"))
else:
    print("No ../inngest/.env here: the Inngest keys were not copied.")

# The Supabase keys: compared, never changed here.
stack_env = os.path.join(root, "supabase", "stack", ".env")
app = read_env(target)
if os.path.exists(stack_env):
    sb = read_env(stack_env)
    for mine, theirs in (("NEXT_PUBLIC_SUPABASE_ANON_KEY", "ANON_KEY"), ("SUPABASE_SERVICE_ROLE_KEY", "SERVICE_ROLE_KEY")):
        if not app.get(mine):
            print("   %s is empty" % mine)
        elif app.get(mine) == sb.get(theirs):
            print("   %s is the same as %s in the Supabase stack" % (mine, theirs))
        else:
            print("!! %s is NOT %s of the Supabase stack on this server. The app would be refused by its database." % (mine, theirs))

# Internal secrets that may be new here (README.md in this folder).
MAY_BE_NEW = ["AGENT_RUN_INTERNAL_SECRET", "CHAT_INTERNAL_SECRET", "LOCAL_AGENT_TOKEN_SECRET"]
if generate:
    fresh = {k: secrets.token_hex(32) for k in MAY_BE_NEW if k in app and not app[k]}
    apply(fresh)
    print("Generated here: %s" % (", ".join(sorted(fresh)) or "nothing (all set already)"))

# Stand-ins for a rehearsal: the two the app needs to start (README.md, step 5 above).
if rehearsal_stand_ins:
    app = read_env(target)
    stand = {k: "rehearsal-" + secrets.token_hex(32) for k in ("RUN_SKILL_INTERNAL_SECRET", "BROWSER_INTERNAL_SECRET") if k in app and not app[k]}
    apply(stand)
    print("Rehearsal stand-ins: %s" % (", ".join(sorted(stand)) or "nothing (both set already)"))

PY
}

ssh_server() { # ssh_server <remote command>
	# shellcheck disable=SC2086,SC2029
	ssh $PULL_SSH_OPTS -o BatchMode=yes -o ConnectTimeout=20 "$server" "$1"
}

if [ "${PULL_DRY_RUN:-}" = 1 ]; then
	build_values "$@" >/dev/null
	echo
	echo "Dry run: nothing was sent to a server."
	exit 0
fi

# The two programs travel as arguments (neither holds a secret) and the values
# through a pipe, as one JSON object: one that arrives cut short does not parse,
# and nothing is applied. Read first, send second: when the earlier host refuses,
# the server is not contacted.
values="$(build_values "$@")"
encoded="$(base64 <"$envfile_py" | tr -d '\n')"
# -I keeps python from loading a module out of the login user's home folder.
printf '%s' "$values" | ssh_server "sudo python3 -I -c 'import base64,sys; a=sys.argv; sys.argv=[a[0]]+a[2:]; exec(base64.b64decode(a[1]))' $encoded apply $(printf '%q' "$PULL_ENV_FILE")"
values=""

# The server-side step needs envfile.py as a file: it is put beside the target,
# root-only, for the length of the step.
side="$(server_side | base64 | tr -d '\n')"
ssh_server "set -e; t=\$(sudo mktemp /root/.ni-envfile.XXXXXX); trap 'sudo rm -f \"\$t\"' EXIT; echo $encoded | base64 -d | sudo tee \"\$t\" >/dev/null; echo $side | base64 -d | sudo python3 -I - $(printf '%q' "$PULL_ENV_FILE") ${PULL_GENERATE:-0} \"\$t\" ${PULL_REHEARSAL:-0}"

# What is still missing, by name: check_settings.py's groups, so that this list and
# check-settings.sh never disagree.
echo
check="$(base64 <"$here/check_settings.py" | tr -d '\n')"
ssh_server "set -e; t=\$(sudo mktemp /root/.ni-check.XXXXXX); trap 'sudo rm -f \"\$t\"' EXIT; echo $check | base64 -d | sudo tee \"\$t\" >/dev/null; sudo python3 -I \"\$t\" $(printf '%q' "$PULL_ENV_FILE") --names-only"
