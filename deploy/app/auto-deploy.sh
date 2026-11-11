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
#   sudo ./auto-deploy.sh clear-failure           forget a failure or a rollback, so that main is tried again
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
#     which take a change at their next restart or build, a reboot included);
#   - the new deploy/app/.env.example names a setting that .env has no line for
#     (names only: no value is read out or shown);
#   - the commit's build failed before (until main moves on, or `clear-failure`);
#     the commit was rolled back by hand (the same); or a roll-out was left half
#     done (everything, until `clear-failure`).
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
#   failed          "<commit> <kind> <reason>": kind build (that commit is skipped),
#                   rollback (the same) or halt (everything holds)
#   deployed        the last commit this tool rolled out, and when
#   acknowledged    the files acknowledged, each by its content (root only)
#   settings        the ping addresses (root only)
# The lock is /run/lock/ni-app-deploy.lock, shared with deploy.sh.
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
lock="${AUTO_DEPLOY_LOCK:-/run/lock/ni-app-deploy.lock}"
deploy_sh="${AUTO_DEPLOY_DEPLOY_SH:-$here/deploy.sh}"
docker="${AUTO_DEPLOY_DOCKER:-docker}"
curl="${AUTO_DEPLOY_CURL:-curl}"
systemd_dir="${AUTO_DEPLOY_SYSTEMD_DIR:-/etc/systemd/system}"
systemctl="${AUTO_DEPLOY_SYSTEMCTL:-systemctl}"
envfile="$repo/deploy/app/.env"
unit=ni-auto-deploy
# Files a person takes care of before the checkout may move past them (see above).
watched=(web/supabase/migrations web/supabase/functions web/supabase/templates deploy/edge deploy/supabase deploy/inngest deploy/backup)
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
after_halt="The roll-out may be half done, so nothing more is rolled out by itself. Look (sudo docker compose ps in deploy/app, the run's output), put it right by hand (sudo ./deploy.sh --no-build, or --rollback), then: sudo ./auto-deploy.sh clear-failure."

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

# The watched files <from>..<to> adds, changes or removes, each keyed by its
# content at <to> (removed: all zeros), against the acknowledged ones.
#   watched pending <raw diff> <short commit>  prints a hold's reason and action, or nothing
#   watched ack <raw diff>                     records them as acknowledged; prints what
watched_files() {
	python3 -I - "$@" "$state/acknowledged" <<'PY'
import json, os, sys
mode, raw, ackfile = sys.argv[1], sys.argv[2], sys.argv[-1]
commit = sys.argv[3] if mode == "pending" else ""
data = open(raw, "rb").read().split(b"\0")
entries = []
i = 0
while i + 1 < len(data) and data[i]:
    meta = data[i].decode()
    fields = meta[1:].split(" ")
    if not meta.startswith(":") or len(fields) != 5:
        sys.exit("unexpected git diff --raw output")
    path = data[i + 1].decode("utf-8", "surrogateescape")
    entries.append(("%s %s" % (fields[3], json.dumps(path)), path))
    i += 2
acked = set(open(ackfile).read().splitlines()) if os.path.exists(ackfile) else set()
todo = [(k, p) for k, p in entries if k not in acked]
if not todo:
    sys.exit(0)
def show(p):
    s = p.encode("utf-8", "surrogateescape").decode("utf-8", "backslashreplace")
    return s if s.isprintable() else repr(s)
def listed(ps):
    return ", ".join(show(p) for p in ps[:8]) + (" and %d more" % (len(ps) - 8) if len(ps) > 8 else "")
if mode == "ack":
    with os.fdopen(os.open(ackfile, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600), "a") as f:
        for k, _ in todo:
            f.write(k + "\n")
    print(listed([p for _, p in todo]))
    sys.exit(0)
kinds = [
    ("migration", ("web/supabase/migrations/",),
     "migrations not yet applied to the database"),
    ("live", ("web/supabase/functions/", "web/supabase/templates/"),
     "files the Supabase stack uses from the checkout, which change the moment it moves"),
    ("stack", ("deploy/edge/", "deploy/supabase/", "deploy/inngest/", "deploy/backup/"),
     "files of other stacks, which take effect at their next restart (a reboot included) or build"),
]
parts, actions = [], []
for kind, prefixes, what in kinds:
    ps = [p for _, p in todo if p.startswith(prefixes)]
    if ps:
        parts.append("%s: %s" % (what, listed(ps)))
        actions.append(kind)
steps = []
if "migration" in actions:
    steps.append("apply the migrations to the database (deploy/app/README.md, Automatic deploys, says how without pulling)")
if "live" in actions or "stack" in actions:
    steps.append("read the other files' changes: a person rolls those out, and restarts the stacks concerned once the checkout has moved")
print("a person deploys this one: " + "; ".join(parts) + " (up to %s)" % commit)
print("First " + ", then ".join(steps) + "; then: sudo ./auto-deploy.sh acknowledge %s" % commit)
PY
}

# The setting names in <example file> that the server's .env has no line for,
# comma-separated. Both are read the way check_settings.py reads them; only names
# leave this function.
missing_settings() { # missing_settings <example file>
	python3 -I - "$here" "$1" "$envfile" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
from check_settings import parse_env
with open(sys.argv[2]) as f:
    wanted = parse_env(f.read())
with open(sys.argv[3]) as f:
    have = parse_env(f.read())
print(", ".join(name for name in wanted if name not in have))
PY
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

	local out head target failed_commit="" failed_kind="" failed_reason="" deployed_commit="" deployed_at=""
	local branch missing reason action
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
	# A record that cannot be read is not "no record".
	if [ -f "$state/failed" ] && ! { is_commit "$failed_commit" && case "$failed_kind" in build | rollback | halt) true ;; *) false ;; esac; }; then
		hold "$state/failed cannot be read" "Look at it; sudo ./auto-deploy.sh clear-failure removes it."
	fi
	if [ -f "$state/deployed" ] && ! is_commit "$deployed_commit"; then
		hold "$state/deployed cannot be read" "Look at it; deleting it is safe once you know what serves."
	fi

	# A roll-out left half done holds everything.
	if [ "$failed_kind" = halt ]; then
		if $dry; then echo "Would do nothing: $(short "$failed_commit") failed and may be half rolled out ($failed_reason)."; exit 0; fi
		set_state "failed: $(short "$failed_commit"): $failed_reason" "$after_halt" "$serving"
		send_ping fail
		exit 0
	fi
	# What serves is no longer what this tool last rolled out, and not a later commit
	# either: someone went back (deploy.sh --rollback). That commit is not rolled out
	# again by itself.
	if [ -n "$deployed_commit" ] && [ "$deployed_commit" != "$serving" ] && ! $dry; then
		if ! git_ merge-base --is-ancestor "$deployed_commit" "$serving" 2>/dev/null; then
			write_failed "$deployed_commit" rollback "it was rolled back by hand ($(short "$serving") serves)"
			failed_commit="$deployed_commit" failed_kind=rollback failed_reason="it was rolled back by hand ($(short "$serving") serves)"
		fi
		rm -f "$state/deployed"
		deployed_commit=""
	fi

	if [ "$serving" = "$target" ]; then
		if $dry; then echo "Nothing new: $(short "$target"), origin/main, serves."; exit 0; fi
		# A failure or rollback of this commit is over: it serves (deployed by hand).
		[ "$failed_commit" != "$target" ] || rm -f "$state/failed"
		if [ "$deployed_commit" = "$serving" ]; then
			set_state "deployed $(short "$serving") at $deployed_at" "" "$serving"
		else
			set_state "idle: $(short "$serving") serves, the latest on main" "" "$serving"
		fi
		send_ping ok
		exit 0
	fi
	if [ "$failed_commit" = "$target" ]; then
		if $dry; then echo "Would do nothing: $(short "$target") is held ($failed_kind: $failed_reason)."; exit 0; fi
		if [ "$failed_kind" = rollback ]; then
			hold "$(short "$target") is not rolled out again: $failed_reason" "A newer commit on main is rolled out by itself. To roll this one out again: sudo ./auto-deploy.sh clear-failure."
		fi
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
	watched_files pending "$tmp/watched" "$(short "$target")" >"$tmp/pending" ||
		hold "could not compare the changed files with the acknowledged ones" "Look at $state/acknowledged."
	if [ -s "$tmp/pending" ]; then
		reason="$(sed -n 1p "$tmp/pending")"
		action="$(sed -n 2p "$tmp/pending")"
		hold "$reason" "$action"
	fi
	git_ ls-tree -z "$target" -- deploy/app/.env.example >"$tmp/example-entry" || hold "could not read the new deploy/app/.env.example" "Look at the checkout ($repo) as its owner."
	: >"$tmp/example"
	if [ -s "$tmp/example-entry" ]; then
		git_ show "$target:deploy/app/.env.example" >"$tmp/example" || hold "could not read the new deploy/app/.env.example" "Look at the checkout ($repo) as its owner."
	fi
	missing="$(missing_settings "$tmp/example")" || hold "could not compare deploy/app/.env.example with .env" "Check that $envfile exists and can be read; the next run tries again."
	[ -z "$missing" ] ||
		hold "the new deploy/app/.env.example has settings that .env has no line for: $missing" \
			"Copy their lines from deploy/app/.env.example into deploy/app/.env (sudo nano .env) and fill them in where needed; the next run sees them."

	if $dry; then
		echo "Would deploy $(short "$target") (serving $(short "$serving")): move the checkout from $(short "$head") (git merge --ff-only, as $owner), then $deploy_sh --build-only and --no-build."
		exit 0
	fi

	init_state
	local runlog problem
	runlog="$state/runs/$(date -u +%Y%m%dT%H%M%SZ)-$(short "$target").log"
	(umask 077 && : >"$runlog")
	# Each phase is recorded before it starts, so a run that is killed (a reboot, the
	# service's time limit) leaves the right failure behind.
	write_failed "$target" halt "the run stopped while moving the checkout, see $runlog"
	set_state "deploying $(short "$target") since $(now)" "Its output: $runlog" "$serving"
	git_ merge --ff-only --quiet "$target" >>"$runlog" 2>&1 || fail "$target" halt "git merge --ff-only failed in the checkout, see $runlog"
	write_failed "$target" build "the run stopped during the build (a reboot, a time-out or a kill), see $runlog"
	"$deploy_sh" --build-only </dev/null >>"$runlog" 2>&1 || fail "$target" build "the build failed, see $runlog"
	write_failed "$target" halt "the run stopped during the roll-out (a reboot, a time-out or a kill), see $runlog"
	"$deploy_sh" --no-build </dev/null >>"$runlog" 2>&1 || fail "$target" halt "the roll-out failed, see $runlog"
	if ! problem="$(serving_commit)" || [ "$problem" != "$target" ]; then
		fail "$target" halt "deploy.sh finished, but ni-app:running is not $(short "$target") (${problem:-unreadable})"
	fi
	problem="$(version_serves "$target")" || fail "$target" halt "deploy.sh finished, but $problem"
	serving="$target"
	printf '%s %s\n' "$target" "$(now)" >"$state/deployed"
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
	serving="$(serving_commit)" || die "cannot tell which commit serves: $serving."
	git_ merge-base --is-ancestor "$serving" "$commit" || die "$1 is not ahead of what serves ($(short "$serving"))."
	git_ diff --raw -z --no-abbrev --no-renames "$serving" "$commit" -- "${watched[@]}" >"$tmp/watched" || die "git diff failed."
	listed="$(watched_files ack "$tmp/watched")" || die "could not record them."
	[ -n "$listed" ] || die "nothing waits between what serves ($(short "$serving")) and $(short "$commit"): nothing to acknowledge."
	log "acknowledged, up to $(short "$commit"): $listed; a later change to them, or another file, is held again"
}

cmd_clear_failure() {
	require_root
	[ -f "$state/failed" ] || { echo "No failure or rollback is recorded: nothing to clear."; exit 0; }
	exec 9>>"$lock" || die "cannot open the lock $lock."
	flock -n 9 || die "a deploy is running; try again when it has ended (sudo ./auto-deploy.sh status)."
	local commit kind reason
	read -r commit kind reason <"$state/failed" || true
	rm -f "$state/failed"
	set_state "idle: the $kind of $(short "$commit") was cleared; the next run rolls out origin/main unless something holds it"
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
