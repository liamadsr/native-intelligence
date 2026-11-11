#!/usr/bin/env bash
# Automatic deploys, on the server: rolls out what is merged to main by itself, and
# is OFF until someone switches it on there. Nothing outside the server can start or
# reach it: a systemd timer (ni-auto-deploy.timer) calls `auto-deploy.sh run` every
# two minutes, as root, and the run asks GitHub whether main moved, as the
# checkout's owner (git never runs as root in the checkout).
#
#   sudo ./auto-deploy.sh status                  what serves, what it last did, and why
#   sudo ./auto-deploy.sh install                 put the service and timer in place; enables nothing
#   sudo ./auto-deploy.sh on | off                switch it on (enables the timer) or off
#   sudo ./auto-deploy.sh run [--dry-run]         one run (what the timer calls); --dry-run changes nothing
#   sudo ./auto-deploy.sh acknowledge <commit>    the files the hold names, up to <commit>, are taken
#                                                 care of (migrations applied, other stacks checked)
#   sudo ./auto-deploy.sh clear-failure           forget a failure or a rollback; says what the next run rolls out
#
# What is "new" is measured from what SERVES, never from the checkout: the commit
# on the image ni-app:running, which deploy.sh tags only after a finished roll-out.
# When that cannot be read, nothing is deployed (a person rolls out by hand once).
#
# One run, when it is on: take the deploy lock that deploy.sh takes too (when a
# deploy runs, by hand or not, the run does nothing and says so); `git fetch origin
# main`; if what serves is origin/main, stop. Otherwise it holds, changing nothing,
# while any of these is true:
#   - the checkout is not on main, origin/main is not a plain step forward from what
#     serves or from the checkout, it has changes of its own, files in it are not
#     its owner's, or the new commits add a path that exists there untracked or
#     ignored (git would overwrite it: deploy/app/.env is one);
#   - between what serves and origin/main a file changes (added, changed, renamed or
#     removed) that a person must take care of and has not acknowledged:
#     web/supabase/migrations (this tool never touches the database);
#     web/supabase/functions and web/supabase/templates (the Supabase stack uses
#     them from the checkout: they change the moment the checkout moves); and
#     deploy/edge, deploy/supabase, deploy/inngest, deploy/backup (other stacks,
#     which take a change at their next restart or build, a reboot included); and
#     this server's own deploy tooling, which runs as root or sets what the
#     containers may do: EVERYTHING in deploy/app (the scripts, compose.yaml and
#     any other file Compose would read beside it, the Dockerfile, whose first
#     line names the program that drives the build, and Dockerfile.dockerignore:
#     the two decide what a build may take from the checkout, where the other
#     stacks' settings lie; the systemd units, proxy/, and any file or folder
#     that is new there), except what only ever runs inside the containers, with
#     the rights compose.yaml gives them (cron/, smoke/, healthcheck.mjs,
#     eve-origin.mjs), tests/, README.md, and .env.example, which has its own
#     check (next);
#   - the new deploy/app/.env.example is gone or is not a plain file, has a line
#     that is neither NAME=value nor a comment, or names a setting that .env has
#     no line for (names only: no value is read out or shown);
#   - the commit's build failed before (that commit only, until main moves on or
#     `clear-failure`); or, holding everything until `clear-failure`: a roll-out
#     was left half done, the checkout moved under the run, or what serves went
#     anywhere but forward. That last one needs no run to have seen it happen,
#     and holds for what was done while this was off: deploy.sh --rollback leaves
#     a mark (rolled-back, below); ni-app:previous (what served before the last
#     roll-out, which --rollback swaps with what serves) must be what serves or
#     an earlier commit; and what serves must be what the last run saw or a later
#     commit.
# Any error while checking is a hold, never a pass.
#
# Else it moves the checkout to exactly the commit it checked (git merge
# --ff-only, as the owner), runs `deploy.sh --build-only` (the old version keeps
# serving; a failure there replaced nothing) and then `deploy.sh --no-build` (the
# roll-out; a failure there may leave it half done), and checks that what serves is
# that commit: ni-app:running's label and /api/version asked through the stack's
# own proxy. Nothing is ever rolled back by itself.
#
# Exit codes of `run`: 1 only when this run's deploy failed, or the tool itself
# could not work; 0 otherwise, holds included (the status file and the pings carry
# the state, so systemd does not report a failure every two minutes).
#
# State, in /var/lib/ni-auto-deploy (none of it in the repository):
#   on              present while it is switched on
#   status          last_run, state (idle / deployed / waiting / holding / failed),
#                   action (what a person does), serving; readable by anyone
#   log             one line per change of state, appended
#   runs/           each deploy's own output (root only; the newest 30 kept)
#   failed          "<commit> <kind> <reason>": kind build (that commit is skipped)
#                   or halt (everything holds)
#   seen            the commit that served at the last run, and the one ni-app:previous
#                   carried then (or "none", "unreadable")
#   rolled-back     left by deploy.sh --rollback (when it was run); the next run
#                   takes it, and holds everything
#   deployed        the last commit this tool rolled out, and when
#   acknowledged    the files acknowledged, each by its mode and content (root only)
#   held            every file the current hold names
#   settings        the ping addresses (root only)
# The lock is /run/ni-app-deploy.lock (only root can create it), shared with deploy.sh.
#
# For the tests (deploy/app/tests/test_auto_deploy.py), the outside world can be
# replaced: AUTO_DEPLOY_REPO, AUTO_DEPLOY_STATE, AUTO_DEPLOY_LOCK,
# AUTO_DEPLOY_OWNER, AUTO_DEPLOY_OWNER_UID, AUTO_DEPLOY_DEPLOY_SH,
# AUTO_DEPLOY_DOCKER, AUTO_DEPLOY_CURL, AUTO_DEPLOY_SYSTEMD_DIR,
# AUTO_DEPLOY_SYSTEMCTL.
set -euo pipefail
umask 022

here="$(cd "$(dirname "$0")" && pwd)"
repo="${AUTO_DEPLOY_REPO:-$(cd "$here/../.." && pwd)}"
state="${AUTO_DEPLOY_STATE:-/var/lib/ni-auto-deploy}"
lock="${AUTO_DEPLOY_LOCK:-/run/ni-app-deploy.lock}"
deploy_sh="${AUTO_DEPLOY_DEPLOY_SH:-$here/deploy.sh}"
docker="${AUTO_DEPLOY_DOCKER:-docker}"
curl="${AUTO_DEPLOY_CURL:-curl}"
systemd_dir="${AUTO_DEPLOY_SYSTEMD_DIR:-/etc/systemd/system}"
systemctl="${AUTO_DEPLOY_SYSTEMCTL:-systemctl}"
envfile="$repo/deploy/app/.env"
unit=ni-auto-deploy
# Files a person takes care of before the checkout may move past them (see above).
# In deploy/app everything is held but the paths named here, so that a file nobody
# thought of (compose.override.yaml, a folder Python would import from) is held too.
watched=(web/supabase/migrations web/supabase/functions web/supabase/templates deploy/edge deploy/supabase deploy/inngest deploy/backup
	deploy/app ':(exclude)deploy/app/cron' ':(exclude)deploy/app/smoke' ':(exclude)deploy/app/healthcheck.mjs'
	':(exclude)deploy/app/eve-origin.mjs' ':(exclude)deploy/app/tests' ':(exclude)deploy/app/README.md'
	':(exclude)deploy/app/.env.example')
dry=false
owner=""
tmp=""
trap '[ -z "$tmp" ] || rm -rf "$tmp"' EXIT

die() { echo "auto-deploy: $*" >&2; exit 1; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
short() { printf '%s' "${1:0:12}"; }
is_commit() { case "$1" in *[!0-9a-f]*) return 1 ;; esac; [ "${#1}" = 40 ]; }

require_root() {
	[ "$(id -u)" = 0 ] || [ -n "${AUTO_DEPLOY_STATE:-}" ] || die "run it with sudo."
}

resolve_owner() {
	owner="${AUTO_DEPLOY_OWNER:-}"
	[ -n "$owner" ] || owner="$(stat -c %U "$repo")" || die "cannot tell who owns $repo."
	tmp="$(mktemp -d "${TMPDIR:-/tmp}/auto-deploy.XXXXXX")"
}

# git in the checkout, as its owner: as root it would leave root-owned files in .git.
# File names are printed as they are, never quoted.
git_() {
	if [ "$(id -un)" = "$owner" ]; then
		git -c core.quotePath=false -C "$repo" "$@"
	else
		sudo -H -u "$owner" -- git -c core.quotePath=false -C "$repo" "$@"
	fi
}

lock_busy() { [ -e "$lock" ] && ! flock -n "$lock" true 2>/dev/null; }

init_state() {
	mkdir -p "$state/runs"
	chmod 755 "$state"
	chmod 700 "$state/runs"
	if [ ! -f "$state/settings" ]; then
		(
			umask 077
			cat >"$state/settings" <<'EOF'
# Settings of deploy/app/auto-deploy.sh (root only). Each address is optional and
# is requested at the end of every run while it is switched on, so that a check
# elsewhere can tell the states apart: only the first arriving = running and well;
# the second = holding, a person is needed; the third = failed; none = not running.
#
# After a run that ended well: nothing new, waiting for a deploy by hand, or deployed.
AUTO_DEPLOY_PING_URL=
# After a run that holds (a migration, a new setting, a rollback …).
AUTO_DEPLOY_HOLD_PING_URL=
# After a run whose deploy failed, and every run while that failure stands.
AUTO_DEPLOY_FAIL_PING_URL=
EOF
		)
	fi
}

log() { # log <line>: says it, and appends it to the log
	local line
	line="$(now) $*"
	echo "$line"
	echo "$line" >>"$state/log"
}

set_state() { # set_state <state> [<what a person does>] [<serving commit>]: the status file; logs a change of state
	local previous=""
	[ ! -f "$state/status" ] || previous="$(sed -n 's/^state=//p' "$state/status")"
	printf 'last_run=%s\nstate=%s\naction=%s\nserving=%s\n' "$(now)" "$1" "${2:-}" "${3:-}" >"$state/status.new"
	mv -f "$state/status.new" "$state/status"
	[ "$1" = "$previous" ] || log "$1${2:+ -- $2}"
}

send_ping() { # send_ping ok|hold|fail
	local name url
	case "$1" in ok) name=AUTO_DEPLOY_PING_URL ;; hold) name=AUTO_DEPLOY_HOLD_PING_URL ;; *) name=AUTO_DEPLOY_FAIL_PING_URL ;; esac
	url="$(sed -n "s/^$name=//p" "$state/settings" 2>/dev/null | tail -n 1 | sed "s/^[\"']//; s/[\"']\$//")" || return 0
	[ -n "$url" ] || return 0
	"$curl" -fsS -m 15 --retry 2 -o /dev/null "$url" >/dev/null 2>&1 || echo "auto-deploy: the request to $name did not go through" >&2
}

serving="" # what serves, once known: for the status file

hold() { # hold <reason> <what a person does>
	if $dry; then
		echo "Would hold: $1"
		echo "What to do: $2"
		exit 0
	fi
	set_state "holding: $1" "$2" "$serving"
	send_ping hold
	exit 0
}

write_failed() { printf '%s %s %s\n' "$1" "$2" "$3" >"$state/failed"; } # write_failed <commit> <kind> <reason>

after_build="The old version still serves: nothing was replaced. A newer commit on main is tried by itself; to try this one again: sudo ./auto-deploy.sh clear-failure."
after_halt="Nothing more is rolled out by itself. Look (sudo docker compose ps in deploy/app, the run's output in runs/), put it right by hand (sudo ./deploy.sh --no-build, or --rollback), then: sudo ./auto-deploy.sh clear-failure, which says what the next run would roll out."

fail() { # fail <commit> <kind> <reason>: this run's deploy failed
	local action="$after_build"
	[ "$2" = build ] || action="$after_halt"
	write_failed "$1" "$2" "$3"
	set_state "failed: $(short "$1"): $3" "$action" "$serving"
	send_ping fail
	exit 1
}

# --- reading the checkout ------------------------------------------------------------

# Names from a file of NUL-separated names (--status: `git status -z` entries): the
# first five, readable, and how many more.
names() { # names [--status] <file>
	python3 -I -c '
import sys
strip = sys.argv[1] == "--status"
data = open(sys.argv[-1], "rb").read().split(b"\0")
items = [p[3:] if strip else p for p in data if p]
def show(b):
    s = b.decode("utf-8", "backslashreplace")
    return s if s.isprintable() else repr(s)
out = ", ".join(show(p) for p in items[:5])
print(out + (" and %d more" % (len(items) - 5) if len(items) > 5 else ""))' "$@"
}

# The commit ni-app:running was built from, in full; or, failing, why not (and false).
serving_commit() {
	local label
	if ! label="$("$docker" image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' ni-app:running 2>/dev/null)"; then
		echo "there is no image ni-app:running"
		return 1
	fi
	case "$label" in "" | *[!0-9a-f]*)
		echo "ni-app:running carries no commit ('$label')"
		return 1
		;;
	esac
	if [ "${#label}" -lt 7 ] || ! git_ rev-parse -q --verify "$label^{commit}" 2>/dev/null; then
		echo "ni-app:running was built from $label, which the checkout does not have"
		return 1
	fi
}

# The commit ni-app:previous was built from: what served before the last roll-out
# (deploy.sh keeps it for --rollback, which swaps it with what serves). Prints
# "none" when there is no such image. Otherwise prints why not, and returns 2 when
# docker did not answer (the next run may fare better) or 1 when the image is
# there and carries no commit this checkout knows (that will not change by itself).
previous_commit() {
	local id label
	if ! id="$("$docker" image ls -q ni-app:previous 2>/dev/null)"; then
		echo "docker could not say whether there is an image ni-app:previous"
		return 2
	fi
	if [ -z "$id" ]; then
		echo none
		return 0
	fi
	if ! label="$("$docker" image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' ni-app:previous 2>/dev/null)"; then
		echo "docker could not inspect ni-app:previous"
		return 2
	fi
	case "$label" in "" | *[!0-9a-f]*)
		echo "ni-app:previous carries no commit ('$label')"
		return 1
		;;
	esac
	if [ "${#label}" -lt 7 ] || ! git_ rev-parse -q --verify "$label^{commit}" 2>/dev/null; then
		echo "ni-app:previous was built from $label, which the checkout does not have"
		return 1
	fi
}

# web answers /api/version with the first 8 characters of its commit.
version_serves() { # version_serves <commit>
	local build i
	for i in 1 2 3; do
		build="$("$docker" exec ni-app-proxy wget -q -T 10 -O - http://127.0.0.1:8080/api/version 2>/dev/null |
			sed -n 's/.*"buildId" *: *"\([0-9a-f]*\)".*/\1/p')" || build=""
		if [ "${#build}" -ge 7 ]; then
			case "$1" in "$build"*) return 0 ;; esac
		fi
		[ "$i" = 3 ] || sleep 2
	done
	echo "/api/version through the stack's proxy says ${build:-nothing}, not ${1:0:8}"
	return 1
}

# Tracked files, the folders they are in, and everything in .git that are not the
# owner's, NUL-separated: git, running as the owner, could not update them.
# Ignored files such as the root-only .env are left out.
not_owned() { # not_owned <out file>
	local uid
	uid="${AUTO_DEPLOY_OWNER_UID:-$(id -u "$owner")}" || return 1
	git_ ls-files -z >"$tmp/tracked" || return 1
	python3 -I -c '
import os, sys
root, uid, tracked, out = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
paths = {b".", b".git"}
for p in open(tracked, "rb").read().split(b"\0"):
    while p:
        paths.add(p)
        p = os.path.dirname(p)
for top, dirs, files in os.walk(os.path.join(root.encode(), b".git")):
    for name in dirs + files:
        paths.add(os.path.relpath(os.path.join(top, name), root.encode()))
bad = []
for p in sorted(paths):
    try:
        if os.lstat(os.path.join(root.encode(), p)).st_uid != uid:
            bad.append(p)
    except FileNotFoundError:
        pass
open(out, "wb").write(b"".join(p + b"\0" for p in bad))' "$repo" "$uid" "$tmp/tracked" "$1"
}

# The paths <from>..<to> adds that exist in the checkout already (untracked or
# ignored), NUL-separated: the fast-forward would overwrite them.
in_the_way() { # in_the_way <from> <to> <out file>
	git_ diff -z --name-only --no-renames --diff-filter=A "$1" "$2" >"$tmp/added" || return 1
	python3 -I -c '
import os, sys
root, added, out = sys.argv[1].encode(), sys.argv[2], sys.argv[3]
found = [p for p in open(added, "rb").read().split(b"\0") if p and os.path.lexists(os.path.join(root, p))]
open(out, "wb").write(b"".join(p + b"\0" for p in found))' "$repo" "$tmp/added" "$3"
}

# The watched files <from>..<to> adds, changes or removes, each keyed by its mode
# and content at <to> (removed: all zeros), against the acknowledged ones.
#   watched_files pending <raw diff> <short commit> <list file>
#       prints a hold's reason and action, or nothing; writes every held file to <list file>
#   watched_files ack <raw diff>
#       records them as acknowledged; prints every one
watched_files() {
	python3 -I - "$@" "$state/acknowledged" <<'PY'
import json, os, sys
mode, raw, ackfile = sys.argv[1], sys.argv[2], sys.argv[-1]
data = open(raw, "rb").read().split(b"\0")
entries = []
i = 0
while i + 1 < len(data) and data[i]:
    meta = data[i].decode()
    fields = meta[1:].split(" ")
    if not meta.startswith(":") or len(fields) != 5:
        sys.exit("unexpected git diff --raw output")
    path = data[i + 1].decode("utf-8", "surrogateescape")
    entries.append(("%s %s %s" % (fields[1], fields[3], json.dumps(path)), path))
    i += 2
if i + 1 < len(data):
    sys.exit("unexpected git diff --raw output")
acked = set(open(ackfile).read().splitlines()) if os.path.exists(ackfile) else set()
todo = [(k, p) for k, p in entries if k not in acked]
if not todo:
    sys.exit(0)
def show(p):
    s = p.encode("utf-8", "surrogateescape").decode("utf-8", "backslashreplace")
    return s if s.isprintable() else repr(s)
if mode == "ack":
    with os.fdopen(os.open(ackfile, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600), "a") as f:
        for k, _ in todo:
            f.write(k + "\n")
    print("%d file%s: %s" % (len(todo), "" if len(todo) == 1 else "s", ", ".join(show(p) for _, p in todo)))
    sys.exit(0)
commit, listfile = sys.argv[3], sys.argv[4]
# git has already left out what is not watched (the pathspecs in `watched`), so
# whatever is listed is held: the last kind takes what the others do not name.
kinds = [
    ("migration", lambda p: p.startswith("web/supabase/migrations/"),
     "migrations not yet applied to the database"),
    ("live", lambda p: p.startswith(("web/supabase/functions/", "web/supabase/templates/")),
     "files the Supabase stack uses from the checkout, which change the moment it moves"),
    ("stack", lambda p: p.startswith(("deploy/edge/", "deploy/supabase/", "deploy/inngest/", "deploy/backup/")),
     "files of other stacks, which take effect at their next restart (a reboot included) or build"),
    ("tooling", lambda p: p.startswith("deploy/app/"),
     "the server's own deploy tooling, which runs as root on the server or sets what the containers may do"),
    ("other", lambda p: True, "other files this tool holds"),
]
parts, found, lines = [], [], []
rest = [p for _, p in todo]
for kind, match, what in kinds:
    ps = [p for p in rest if match(p)]
    rest = [p for p in rest if not match(p)]
    if ps:
        shown = ", ".join(show(p) for p in ps[:8]) + (" and %d more" % (len(ps) - 8) if len(ps) > 8 else "")
        parts.append("%s (%d): %s" % (what, len(ps), shown))
        found.append(kind)
        lines += ["%s: %s" % (kind, show(p)) for p in ps]
with open(listfile, "w") as f:
    f.write("\n".join(lines) + "\n")
steps = []
if "migration" in found:
    steps.append("apply the migrations to the database (deploy/app/README.md, Automatic deploys, says how without pulling)")
if set(found) - {"migration"}:
    steps.append("read the other files' changes (a person rolls them out, and restarts the stacks concerned once the checkout has moved)")
print("a person deploys this one, %d file%s: " % (len(lines), "" if len(lines) == 1 else "s") + "; ".join(parts) + " (up to %s; every file: sudo ./auto-deploy.sh status)" % commit)
print("First " + ", then ".join(steps) + "; then: sudo ./auto-deploy.sh acknowledge %s" % commit)
PY
}

# The setting names in <example file> that the server's .env has no line for,
# comma-separated. Both are read the way check_settings.py reads them; only names
# leave this function. Exit 3, printing which line, when the example has a line
# that is neither NAME=value, a comment nor blank: a form the reader skips (export
# NAME=, an indented line, a value over several lines) could name a setting unseen.
# check_settings.py is loaded by its path, never through Python's search path: a
# file or folder beside it named like a standard module must not run as root here.
missing_settings() { # missing_settings <example file>
	python3 -I - "$here/check_settings.py" "$1" "$envfile" <<'PY'
import importlib.util, re, sys
spec = importlib.util.spec_from_file_location("check_settings", sys.argv[1])
check_settings = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check_settings)
with open(sys.argv[2]) as f:
    example = f.read()
for n, line in enumerate(example.split("\n"), 1):
    if line.strip() and not line.startswith("#") and not re.match(r"[A-Za-z_][A-Za-z0-9_]*=", line):
        print("line %d" % n)
        sys.exit(3)
wanted = check_settings.parse_env(example)
with open(sys.argv[3]) as f:
    have = check_settings.parse_env(f.read())
print(", ".join(name for name in wanted if name not in have))
PY
}

# The checkout is at the commit the run checked ($head is set to where it is).
at_target() { head="$(git_ rev-parse --verify HEAD)" && [ "$head" = "$target" ]; }

# The image just built carries that commit ($built is set to its label).
built_from_target() {
	built="$("$docker" image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' ni-app:live 2>/dev/null)" || built=""
	[ "${#built}" -ge 7 ] && case "$built" in *[!0-9a-f]*) false ;; esac && case "$target" in "$built"*) true ;; *) false ;; esac
}

# --- the commands --------------------------------------------------------------------

cmd_run() {
	case "${1:-}" in
	"") ;;
	--dry-run) dry=true ;;
	*) die "unknown option $1 (run [--dry-run])" ;;
	esac
	require_root
	if [ ! -e "$state/on" ]; then
		$dry || exit 0
		echo "Automatic deploys are off: a run does nothing. Were they on, this run would:"
	fi
	# The lock deploy.sh takes too, held for the whole run; deploy.sh, started from
	# here, inherits it and is told so.
	exec 9>>"$lock" || die "cannot open the lock $lock."
	if ! flock -n 9; then
		if $dry; then
			echo "Do nothing: a deploy is running (by hand, or another run)."
		else
			case "$(sed -n 's/^state=//p' "$state/status" 2>/dev/null || true)" in
			"deploying "*) ;; # another run of this tool: its own state stands
			*)
				set_state "waiting: a deploy is running (deploy.sh by hand, or another run); this run did nothing"
				send_ping ok
				;;
			esac
		fi
		exit 0
	fi
	export NI_DEPLOY_LOCK_HELD=1
	resolve_owner

	local out head target failed_commit="" failed_kind="" failed_reason="" deployed_commit="" deployed_at="" seen="" seen_previous=""
	local branch missing reason action previous previous_problem="" halted=""
	if ! out="$(git_ fetch --quiet origin main 2>&1)"; then
		hold "git fetch origin main failed: $(printf '%s\n' "$out" | sed -n '$p')" "Usually the network, and the next run tries again. If it stays: git fetch origin main as the checkout's owner, in $repo."
	fi
	head="$(git_ rev-parse --verify HEAD)" || hold "cannot read the checkout's HEAD" "Look at the checkout ($repo) as its owner."
	target="$(git_ rev-parse --verify refs/remotes/origin/main)" || hold "cannot read origin/main" "Look at the checkout ($repo) as its owner."
	if ! serving="$(serving_commit)"; then
		reason="$serving"
		serving=""
		hold "cannot tell which commit serves: $reason" "Roll out by hand once (git pull as the checkout's owner, then sudo ./deploy.sh): it labels what it puts into service."
	fi
	[ ! -f "$state/failed" ] || read -r failed_commit failed_kind failed_reason <"$state/failed" || true
	[ ! -f "$state/deployed" ] || read -r deployed_commit deployed_at <"$state/deployed" || true
	[ ! -f "$state/seen" ] || read -r seen seen_previous <"$state/seen" || true
	# A record that cannot be read is not "no record".
	if [ -f "$state/failed" ] && ! { is_commit "$failed_commit" && case "$failed_kind" in build | halt) true ;; *) false ;; esac; }; then
		hold "$state/failed cannot be read" "Look at it; sudo ./auto-deploy.sh clear-failure removes it."
	fi
	if [ -f "$state/deployed" ] && ! is_commit "$deployed_commit"; then
		hold "$state/deployed cannot be read" "Look at it; deleting it is safe once you know what serves."
	fi
	if [ -f "$state/seen" ] && ! { is_commit "$seen" && case "$seen_previous" in "" | none | unreadable) true ;; *) is_commit "$seen_previous" ;; esac; }; then
		hold "$state/seen cannot be read" "Look at it; deleting it is safe once you know what serves."
	fi

	# Did what serves go anywhere but forward? Someone went back (deploy.sh
	# --rollback) or did something by hand this tool does not understand: everything
	# holds until a person clears it, and no acknowledgement made before it counts any
	# more. Three things say so, and each is judged once (the record of the failure,
	# not this, is what keeps holding until clear-failure):
	#   - the mark deploy.sh --rollback leaves, whatever was rolled out after it;
	#   - the images: ni-app:previous is what served before the last roll-out, so it
	#     is what serves or an earlier commit, unless the last roll-out went back.
	#     Like the mark, this needs no run to have seen it happen, and holds for what
	#     was done while this was off;
	#   - what the last run saw serving, which what serves now must be or come after.
	if previous="$(previous_commit)"; then :; else
		case $? in
		2)
			reason="$previous"
			hold "cannot tell what served before the last roll-out: $reason" \
				"Usually docker being busy, and the next run tries again. If it stays: sudo docker image inspect ni-app:previous."
			;;
		esac
		previous_problem="$previous"
		previous=unreadable
	fi
	reason=""
	if [ -e "$state/rolled-back" ]; then
		halted="$serving"
		reason="deploy.sh --rollback was run by hand ($(head -c 40 "$state/rolled-back" | tr -cd '0-9TZ:-'))"
	elif [ "$serving $previous" != "$seen $seen_previous" ]; then
		if [ -n "$seen" ] && [ "$seen" != "$serving" ] && ! git_ merge-base --is-ancestor "$seen" "$serving" 2>/dev/null; then
			halted="$seen"
			reason="what serves went from $(short "$seen") to $(short "$serving"), which is not a later commit: a rollback, or something done by hand"
		elif [ "$previous" = unreadable ]; then
			halted="$serving"
			reason="what served before $(short "$serving") cannot be told ($previous_problem), so a rollback cannot be ruled out"
		elif [ "$previous" != none ] && [ "$previous" != "$serving" ] && ! git_ merge-base --is-ancestor "$previous" "$serving" 2>/dev/null; then
			halted="$previous"
			reason="what serves, $(short "$serving"), is not a later commit than what served before it, $(short "$previous"): a rollback (deploy.sh --rollback), or an older commit rolled out by hand"
		fi
	fi
	if [ -n "$reason" ]; then
		if $dry; then echo "Would hold everything: $reason."; exit 0; fi
		write_failed "$halted" halt "$reason"
		rm -f "$state/acknowledged" "$state/rolled-back"
		failed_commit="$halted" failed_kind=halt failed_reason="$reason"
	fi
	if ! $dry; then
		printf '%s %s\n' "$serving" "$previous" >"$state/seen.new"
		mv -f "$state/seen.new" "$state/seen"
		rm -f "$state/held"
	fi

	# After a rollback, or a roll-out that may be half done, nothing is rolled out
	# until a person runs clear-failure.
	if [ "$failed_kind" = halt ]; then
		if $dry; then echo "Would do nothing: $(short "$failed_commit"): $failed_reason."; exit 0; fi
		set_state "failed: $(short "$failed_commit"): $failed_reason" "$after_halt" "$serving"
		send_ping fail
		exit 0
	fi

	if [ "$serving" = "$target" ]; then
		if $dry; then echo "Nothing new: $(short "$target"), origin/main, serves."; exit 0; fi
		# A failed build of this commit is over: it serves (deployed by hand).
		[ "$failed_commit" != "$target" ] || rm -f "$state/failed"
		if [ "$deployed_commit" = "$serving" ]; then
			set_state "deployed $(short "$serving") at $deployed_at" "" "$serving"
		else
			set_state "idle: $(short "$serving") serves, the latest on main" "" "$serving"
		fi
		send_ping ok
		exit 0
	fi
	# A failed build skips that commit; a newer one is tried.
	if [ "$failed_commit" = "$target" ]; then
		if $dry; then echo "Would do nothing: the build of $(short "$target") failed ($failed_reason)."; exit 0; fi
		set_state "failed: $(short "$target"): $failed_reason" "$after_build" "$serving"
		send_ping fail
		exit 0
	fi

	branch="$(git_ symbolic-ref --short -q HEAD)" || branch=""
	[ "$branch" = main ] ||
		hold "the checkout is on ${branch:-a detached HEAD}, not main" "As the checkout's owner, in $repo: git switch main."
	git_ merge-base --is-ancestor "$serving" "$target" ||
		hold "origin/main ($(short "$target")) is not a plain step forward from what serves ($(short "$serving")): its history was rewritten" \
			"Look at git log --oneline $(short "$serving")...origin/main as the checkout's owner, in $repo, and roll out by hand once sure."
	git_ merge-base --is-ancestor "$head" "$target" ||
		hold "origin/main ($(short "$target")) is not a plain step forward from the checkout ($(short "$head")): history was rewritten, or the checkout has commits of its own" \
			"Look at git log --oneline HEAD...origin/main as the checkout's owner, in $repo. Once sure, move it by hand (git reset --hard origin/main, as its owner); the next run goes on from there."
	git_ status --porcelain=v1 -z --no-renames >"$tmp/status" || hold "git status failed in the checkout" "Look at the checkout ($repo) as its owner."
	[ ! -s "$tmp/status" ] ||
		hold "the checkout has changes of its own: $(names --status "$tmp/status")" "As the checkout's owner, in $repo: git status, then commit, move away or undo them."
	not_owned "$tmp/owned" || hold "could not check who owns the checkout's files" "Look at the checkout ($repo)."
	[ ! -s "$tmp/owned" ] ||
		hold "files in the checkout are not owned by $owner: $(names "$tmp/owned")" "Give them back: sudo chown $owner:$owner <file> in $repo for each, and never run git there as root."
	in_the_way "$head" "$target" "$tmp/in-the-way" || hold "could not list what the new commits add" "Look at the checkout ($repo) as its owner."
	[ ! -s "$tmp/in-the-way" ] ||
		hold "the new commits add files that exist untracked or ignored in the checkout, which moving it would overwrite: $(names "$tmp/in-the-way")" \
			"Look at them (deploy/app/.env holds the settings); move them away or roll out by hand. The next run sees it."
	git_ diff --raw -z --no-abbrev --no-renames "$serving" "$target" -- "${watched[@]}" >"$tmp/watched" ||
		hold "could not list the files the new commits change" "Look at the checkout ($repo) as its owner."
	local held="$state/held"
	! $dry || held="$tmp/held"
	watched_files pending "$tmp/watched" "$(short "$target")" "$held" >"$tmp/pending" ||
		hold "could not compare the changed files with the acknowledged ones" "Look at $state/acknowledged."
	if [ -s "$tmp/pending" ]; then
		reason="$(sed -n 1p "$tmp/pending")"
		action="$(sed -n 2p "$tmp/pending")"
		! $dry || { echo "Every held file:"; cat "$held"; }
		hold "$reason" "$action"
	fi
	# The settings the new commits need are read from their .env.example, so it must
	# be there and be a plain file: gone, a link or a folder says nothing, and
	# nothing is not "no new setting".
	git_ ls-tree -z "$target" -- deploy/app/.env.example >"$tmp/example-entry" || hold "could not read the new deploy/app/.env.example" "Look at the checkout ($repo) as its owner."
	case "$(head -c 7 "$tmp/example-entry")" in
	"100644 " | "100755 ") ;;
	"")
		hold "the new commits remove deploy/app/.env.example, so the settings they need cannot be checked" \
			"Put the file back on main, or roll out by hand once sure (git pull as the checkout's owner, then sudo ./deploy.sh)."
		;;
	*)
		hold "the new deploy/app/.env.example is not a plain file (a link or a folder), so the settings the new commits need cannot be checked" \
			"Make it a plain file again on main, or roll out by hand once sure (git pull as the checkout's owner, then sudo ./deploy.sh)."
		;;
	esac
	git_ show "$target:deploy/app/.env.example" >"$tmp/example" || hold "could not read the new deploy/app/.env.example" "Look at the checkout ($repo) as its owner."
	if missing="$(missing_settings "$tmp/example")"; then :; else
		case $? in
		3)
			hold "the new deploy/app/.env.example has a line that is neither NAME=value nor a comment ($missing), so the settings the new commits need cannot be checked" \
				"Put the line right on main (one NAME=value a line, comments starting with #), or roll out by hand once sure."
			;;
		*) hold "could not compare deploy/app/.env.example with .env" "Check that $envfile exists and can be read; the next run tries again." ;;
		esac
	fi
	[ -z "$missing" ] ||
		hold "the new deploy/app/.env.example has settings that .env has no line for: $missing" \
			"Copy their lines from deploy/app/.env.example into deploy/app/.env (sudo nano .env) and fill them in where needed; the next run sees them."

	if $dry; then
		echo "Would deploy $(short "$target") (serving $(short "$serving")): move the checkout from $(short "$head") (git merge --ff-only, as $owner), then $deploy_sh --build-only and --no-build."
		exit 0
	fi

	init_state
	local runlog problem built=""
	runlog="$state/runs/$(date -u +%Y%m%dT%H%M%SZ)-$(short "$target").log"
	(umask 077 && : >"$runlog")
	# Each phase is recorded before it starts, so a run that is killed (a reboot, the
	# service's time limit) leaves the right failure behind.
	write_failed "$target" halt "the run stopped while moving the checkout, see $runlog"
	set_state "deploying $(short "$target") since $(now)" "Its output: $runlog" "$serving"
	git_ merge --ff-only --quiet "$target" >>"$runlog" 2>&1 || fail "$target" halt "git merge --ff-only failed in the checkout, see $runlog"
	# The lock does not stop a person's git pull: build only what was checked.
	at_target || fail "$target" halt "after the merge the checkout is at $(short "$head"), not $(short "$target"): it was moved meanwhile, so nothing was built"
	write_failed "$target" build "the run stopped during the build (a reboot, a time-out or a kill), see $runlog"
	"$deploy_sh" --build-only </dev/null >>"$runlog" 2>&1 || fail "$target" build "the build failed, see $runlog"
	at_target && built_from_target ||
		fail "$target" halt "after the build the checkout is at $(short "$head") and ni-app:live says ${built:-nothing}, not $(short "$target"): the checkout was moved during the build, so nothing was rolled out"
	write_failed "$target" halt "the run stopped during the roll-out (a reboot, a time-out or a kill), see $runlog"
	"$deploy_sh" --no-build </dev/null >>"$runlog" 2>&1 || fail "$target" halt "the roll-out failed, see $runlog"
	if ! problem="$(serving_commit)" || [ "$problem" != "$target" ]; then
		fail "$target" halt "deploy.sh finished, but ni-app:running is not $(short "$target") (${problem:-unreadable})"
	fi
	problem="$(version_serves "$target")" || fail "$target" halt "deploy.sh finished, but $problem"
	serving="$target"
	printf '%s %s\n' "$target" "$(now)" >"$state/deployed"
	printf '%s\n' "$target" >"$state/seen"
	rm -f "$state/failed" "$state/acknowledged"
	set_state "deployed $(short "$target") at $(now)" "" "$serving"
	send_ping ok
	ls -1 "$state/runs" | sort -r | sed -n '31,$p' | while IFS= read -r old; do rm -f "$state/runs/$old"; done
}

cmd_status() {
	local timer
	if [ -e "$state/on" ]; then echo "Automatic deploys: on"; else echo "Automatic deploys: off"; fi
	timer="$("$systemctl" is-enabled "$unit.timer" 2>/dev/null || true) $("$systemctl" is-active "$unit.timer" 2>/dev/null || true)"
	[ "$timer" = " " ] || echo "Timer $unit.timer: $timer"
	! lock_busy || echo "A deploy is running now (by hand, or a run of this tool)."
	if [ -f "$state/status" ]; then
		cat "$state/status"
	else
		echo "No run has recorded anything yet."
	fi
	[ ! -f "$state/failed" ] || echo "failed: $(cat "$state/failed")"
	[ ! -f "$state/deployed" ] || echo "last deployed by this tool: $(cat "$state/deployed")"
	if [ -s "$state/held" ]; then
		echo
		echo "Every held file:"
		cat "$state/held"
	fi
	if [ -f "$state/log" ]; then
		echo
		echo "Last lines of $state/log:"
		tail -n 10 "$state/log"
	fi
}

cmd_install() {
	require_root
	local f
	[ -d "$systemd_dir" ] || die "$systemd_dir does not exist."
	for f in service timer; do
		[ -f "$here/$unit.$f" ] || die "$here/$unit.$f is missing."
		sed "s#/opt/native-intelligence#$repo#g" "$here/$unit.$f" >"$systemd_dir/$unit.$f.new"
		chmod 644 "$systemd_dir/$unit.$f.new"
		mv -f "$systemd_dir/$unit.$f.new" "$systemd_dir/$unit.$f"
	done
	"$systemctl" daemon-reload
	init_state
	echo "Installed $unit.service and $unit.timer in $systemd_dir and reloaded systemd; nothing is enabled or started (sudo ./auto-deploy.sh on switches it on)."
}

cmd_on() {
	require_root
	local out
	[ -f "$systemd_dir/$unit.timer" ] || die "$unit.timer is not installed: sudo ./auto-deploy.sh install first."
	out="$("$systemctl" enable --now "$unit.timer" 2>&1)" || die "systemctl enable --now $unit.timer failed: $out"
	init_state
	: >"$state/on"
	echo "$(now) switched on" >>"$state/log"
	echo "Switched on: a run every two minutes rolls out what is merged to main, unless something holds it (sudo ./auto-deploy.sh status says what). sudo ./auto-deploy.sh off switches it off."
}

cmd_off() {
	require_root
	local busy=""
	rm -f "$state/on"
	"$systemctl" disable --now "$unit.timer" >/dev/null 2>&1 || true
	! lock_busy || busy=" A deploy running now finishes what it started (sudo ./auto-deploy.sh status)."
	[ ! -d "$state" ] || echo "$(now) switched off" >>"$state/log"
	echo "Switched off: no run starts any more, and a merge to main is rolled out only by hand.$busy"
}

cmd_acknowledge() {
	require_root
	case "${1:-}" in "" | *[!0-9a-f]*) die "usage: auto-deploy.sh acknowledge <commit> (the commit the hold names)" ;; esac
	init_state
	exec 9>>"$lock" || die "cannot open the lock $lock."
	flock -n 9 || die "a deploy is running; try again when it has ended (sudo ./auto-deploy.sh status)."
	resolve_owner
	local commit listed
	commit="$(git_ rev-parse -q --verify "$1^{commit}")" || die "no commit $1 in the checkout; the hold names it."
	# Only a commit of main as the last run fetched it: what a hold can have shown.
	git_ merge-base --is-ancestor "$commit" refs/remotes/origin/main ||
		die "$1 is not on origin/main as last fetched; acknowledge the commit the hold names."
	serving="$(serving_commit)" || die "cannot tell which commit serves: $serving."
	git_ merge-base --is-ancestor "$serving" "$commit" || die "$1 is not ahead of what serves ($(short "$serving"))."
	git_ diff --raw -z --no-abbrev --no-renames "$serving" "$commit" -- "${watched[@]}" >"$tmp/watched" || die "git diff failed."
	listed="$(watched_files ack "$tmp/watched")" || die "could not record them."
	[ -n "$listed" ] || die "nothing waits between what serves ($(short "$serving")) and $(short "$commit"): nothing to acknowledge."
	log "acknowledged, up to $(short "$commit"), $listed; a later change to them, or another file, is held again"
}

cmd_clear_failure() {
	require_root
	[ -f "$state/failed" ] || { echo "No failure or rollback is recorded: nothing to clear."; exit 0; }
	exec 9>>"$lock" || die "cannot open the lock $lock."
	flock -n 9 || die "a deploy is running; try again when it has ended (sudo ./auto-deploy.sh status)."
	resolve_owner
	local commit kind reason next="" now_serving="" contains=""
	read -r commit kind reason <"$state/failed" || true
	rm -f "$state/failed"
	[ "$kind" = build ] || rm -f "$state/acknowledged"
	# What the next run would roll out, so that the person sees it before it happens.
	next="$(git_ rev-parse -q --verify refs/remotes/origin/main)" || next=""
	now_serving="$(serving_commit)" || now_serving=""
	if is_commit "$commit" && [ -n "$next" ] && git_ merge-base --is-ancestor "$commit" "$next" 2>/dev/null; then
		contains=", which is or contains $(short "$commit")"
	fi
	if [ -z "$next" ] || [ -z "$now_serving" ]; then
		set_state "idle: cleared ($kind of $(short "$commit")); what the next run rolls out cannot be told now: sudo ./auto-deploy.sh run --dry-run"
	elif [ "$next" = "$now_serving" ]; then
		set_state "idle: cleared ($kind of $(short "$commit")); origin/main ($(short "$next")) serves, so the next run rolls out nothing" "" "$now_serving"
	else
		set_state "idle: cleared ($kind of $(short "$commit")); the next run rolls out origin/main as last fetched, $(short "$next")$contains, over $(short "$now_serving"), unless something holds it (newer commits on main come with it)" "" "$now_serving"
	fi
}

case "${1:-}" in
run) shift; cmd_run "$@" ;;
status) cmd_status ;;
install) cmd_install ;;
on) cmd_on ;;
off) cmd_off ;;
acknowledge) shift; cmd_acknowledge "$@" ;;
clear-failure) cmd_clear_failure ;;
-h | --help | help) awk 'NR > 1 && /^set -euo/ { exit } NR > 1' "$0" ;;
*) die "usage: auto-deploy.sh run [--dry-run] | status | on | off | acknowledge <commit> | clear-failure | install (see --help)" ;;
esac
