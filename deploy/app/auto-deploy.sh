#!/usr/bin/env bash
# Automatic deploys, on the server: rolls out what is merged to main by itself, and
# is OFF until someone switches it on there. Nothing outside the server can reach
# it: a systemd timer (ni-auto-deploy.timer) calls `auto-deploy.sh run` every two
# minutes, as root, and the run asks GitHub whether main moved, as the checkout's
# owner (git never runs as root in the checkout).
#
#   sudo ./auto-deploy.sh status                  what it last did, and why
#   sudo ./auto-deploy.sh install                 put the service and timer in place; enables nothing
#   sudo ./auto-deploy.sh on | off                switch it on (enables the timer) or off
#   sudo ./auto-deploy.sh run [--dry-run]         one run (what the timer calls); --dry-run changes nothing
#   sudo ./auto-deploy.sh migrations-applied <commit>
#                                                 the migrations up to <commit> are applied: release the hold
#   sudo ./auto-deploy.sh clear-failure           forget the failed commit, so that it is tried again
#
# One run, when it is on: take the lock (another run, or a deploy.sh started by
# hand, makes it exit quietly); `git fetch origin main`; if the checkout is already
# there, stop. Otherwise it holds, and changes nothing, while any of these is true:
#   - the checkout is not on main, origin/main is not a plain step forward from it
#     (history rewritten), it has changes of its own, or files in it are not its
#     owner's;
#   - the new commits add, change or remove a file in web/supabase/migrations/ that
#     no one has acknowledged as applied (`migrations-applied`). This tool never
#     touches the database;
#   - the new deploy/app/.env.example names a setting that .env has no line for
#     (names only: no value is read out or shown);
#   - that same commit failed before (until main moves on, or `clear-failure`).
# Else it moves the checkout to exactly the commit it checked (git merge --ff-only,
# as the owner), runs deploy.sh, and checks that what serves is that commit:
# ni-app:running's label, which deploy.sh sets only after a finished roll-out, and
# /api/version asked through the stack's own proxy. A failure is recorded, never
# rolled back by itself: a failed build leaves the old version serving, and a
# roll-out that stopped half way needs a person.
#
# Exit codes of `run`: 0 nothing to do, or deployed; 2 holding; 1 failed. Both
# non-zero ones leave the service "failed" in systemd until resolved.
#
# State, in /var/lib/ni-auto-deploy (none of it in the repository):
#   on                        present while it is switched on
#   status                    last_run, state (idle / deployed / holding / failed) and
#                             what a person does about it; readable by anyone
#   log                       one line per change of state, appended
#   runs/                     each deploy's own output (root only; the newest 30 kept)
#   failed                    the commit that failed, and why
#   migrations-acknowledged   the migration files acknowledged as applied, each by its
#                             content (root only)
#   settings                  AUTO_DEPLOY_PING_URL (root only)
#
# For the tests (deploy/app/tests/test_auto_deploy.py), the outside world can be
# replaced: AUTO_DEPLOY_REPO, AUTO_DEPLOY_STATE, AUTO_DEPLOY_OWNER,
# AUTO_DEPLOY_DEPLOY_SH, AUTO_DEPLOY_DOCKER, AUTO_DEPLOY_CURL,
# AUTO_DEPLOY_SYSTEMD_DIR, AUTO_DEPLOY_SYSTEMCTL.
set -euo pipefail
umask 022

here="$(cd "$(dirname "$0")" && pwd)"
repo="${AUTO_DEPLOY_REPO:-$(cd "$here/../.." && pwd)}"
state="${AUTO_DEPLOY_STATE:-/var/lib/ni-auto-deploy}"
deploy_sh="${AUTO_DEPLOY_DEPLOY_SH:-$here/deploy.sh}"
docker="${AUTO_DEPLOY_DOCKER:-docker}"
curl="${AUTO_DEPLOY_CURL:-curl}"
systemd_dir="${AUTO_DEPLOY_SYSTEMD_DIR:-/etc/systemd/system}"
systemctl="${AUTO_DEPLOY_SYSTEMCTL:-systemctl}"
envfile="$repo/deploy/app/.env"
migrations=web/supabase/migrations
unit=ni-auto-deploy
dry=false

die() { echo "auto-deploy: $*" >&2; exit 1; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
short() { printf '%s' "${1:0:12}"; }

require_root() {
	[ "$(id -u)" = 0 ] || [ -n "${AUTO_DEPLOY_STATE:-}" ] || die "run it with sudo."
}

owner() { printf '%s' "${AUTO_DEPLOY_OWNER:-$(stat -c %U "$repo")}"; }

# git in the checkout, as its owner: as root it would leave root-owned files in .git.
git_() {
	local o
	o="$(owner)"
	if [ "$(id -un)" = "$o" ]; then
		git -C "$repo" "$@"
	else
		sudo -H -u "$o" -- git -C "$repo" "$@"
	fi
}

init_state() {
	mkdir -p "$state/runs"
	chmod 755 "$state"
	chmod 700 "$state/runs"
	if [ ! -f "$state/settings" ]; then
		(
			umask 077
			cat >"$state/settings" <<'EOF'
# Settings of deploy/app/auto-deploy.sh (root only).

# Requested after every successful automatic deploy, never on a hold or a
# failure. Point it at a check that alerts when no request arrives for longer
# than deploys usually take to come. Leave empty to run without one.
AUTO_DEPLOY_PING_URL=
EOF
		)
	fi
}

take_lock() { # take_lock: false when another run holds it
	exec 9>>"$state/lock"
	flock -n 9
}

# A deploy.sh someone started by hand (`sudo ./deploy.sh`, `bash deploy.sh` …).
deploy_running() {
	ps -Ao args= | awk '{ for (i = 1; i <= 3 && i <= NF; i++) { n = $i; sub(/.*\//, "", n); if (n == "deploy.sh") found = 1 } } END { exit !found }'
}

log() { # log <line>: says it, and appends it to the log
	local line
	line="$(now) $*"
	echo "$line"
	echo "$line" >>"$state/log"
}

set_state() { # set_state <state> [<what a person does>]: the status file; logs a change of state
	local previous=""
	[ -f "$state/status" ] && previous="$(sed -n 's/^state=//p' "$state/status")"
	printf 'last_run=%s\nstate=%s\naction=%s\n' "$(now)" "$1" "${2:-}" >"$state/status.new"
	mv -f "$state/status.new" "$state/status"
	[ "$1" = "$previous" ] || log "$1${2:+ -- $2}"
}

hold() { # hold <reason> <what a person does>
	if $dry; then
		echo "Would hold: $1"
		echo "What to do: $2"
	else
		set_state "holding: $1" "$2"
	fi
	exit 2
}

fail() { # fail <commit> <reason> <what a person does>
	printf '%s %s\n' "$1" "$2" >"$state/failed"
	set_state "failed: $(short "$1"): $2" "$3"
	exit 1
}

after_failure="A failed build leaves the old version serving; a roll-out that stopped half way needs a person (sudo docker compose ps in deploy/app, then sudo ./deploy.sh --no-build, or --rollback). When it is fixed, or to try the same commit again: sudo ./auto-deploy.sh clear-failure. A newer commit on main is tried by itself."

# "<blob> <path>" for each migration file that <from>..<to> adds, changes or removes.
# The blob is the file's content at <to>, so an acknowledgement covers that content
# only: a later change to the same file, or a new file, is held again.
pending_migrations() { # pending_migrations <from> <to>
	local path blob
	git_ diff --name-only --no-renames "$1" "$2" -- "$migrations" | while IFS= read -r path; do
		blob="$(git_ rev-parse -q --verify "$2:$path" 2>/dev/null || echo removed)"
		echo "$blob $path"
	done
}

unacknowledged_migrations() { # unacknowledged_migrations <from> <to>
	local ack=/dev/null
	[ -f "$state/migrations-acknowledged" ] && ack="$state/migrations-acknowledged"
	pending_migrations "$1" "$2" | grep -Fxv -f "$ack" || true
}

# The setting names in <commit>'s .env.example that the server's .env has no line
# for, comma-separated. Both files are read the way check_settings.py reads them;
# only names leave this function.
missing_settings() { # missing_settings <commit>
	local example status=0
	example="$(mktemp "${TMPDIR:-/tmp}/auto-deploy-example.XXXXXX")"
	git_ show "$1:deploy/app/.env.example" >"$example" 2>/dev/null || : >"$example"
	python3 -I - "$here" "$example" "$envfile" <<'PY' || status=$?
import sys
sys.path.insert(0, sys.argv[1])
from check_settings import parse_env
with open(sys.argv[2]) as f:
    wanted = parse_env(f.read())
with open(sys.argv[3]) as f:
    have = parse_env(f.read())
print(", ".join(name for name in wanted if name not in have))
PY
	rm -f "$example"
	return "$status"
}

# Tracked files, the folders they are in, and everything in .git that are not the
# owner's: git, running as the owner, could not update them. Ignored files such as
# the root-only .env are left out.
not_owned() {
	git_ ls-files -z | python3 -I -c '
import os, sys
root, uid = sys.argv[1], int(sys.argv[2])
paths = {".", ".git"}
for p in sys.stdin.buffer.read().split(b"\0"):
    p = p.decode("utf-8", "surrogateescape")
    while p:
        paths.add(p)
        p = os.path.dirname(p)
for top, dirs, files in os.walk(os.path.join(root, ".git")):
    for name in dirs + files:
        paths.add(os.path.relpath(os.path.join(top, name), root))
bad = []
for p in sorted(paths):
    try:
        if os.lstat(os.path.join(root, p)).st_uid != uid:
            bad.append(p)
    except FileNotFoundError:
        pass
print(", ".join(bad[:5]) + (" and %d more" % (len(bad) - 5) if len(bad) > 5 else ""))
' "$repo" "$(id -u "$(owner)")"
}

# What serves is <commit>: deploy.sh tags the image ni-app:running only once a
# roll-out has finished, and web answers /api/version with the first 8 characters
# of the commit it was built from. Sets $problem when it is not.
serving() { # serving <commit>
	local label build i
	label="$("$docker" image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' ni-app:running 2>/dev/null || true)"
	case "$label" in
	"" | unknown) problem="ni-app:running carries no commit"; return 1 ;;
	esac
	case "$1" in
	"$label"*) ;;
	*) problem="ni-app:running was built from $label, not $(short "$1")"; return 1 ;;
	esac
	for i in 1 2 3; do
		build="$("$docker" exec ni-app-proxy wget -q -T 10 -O - http://127.0.0.1:8080/api/version 2>/dev/null |
			sed -n 's/.*"buildId" *: *"\([0-9a-f]*\)".*/\1/p' || true)"
		if [ "${#build}" -ge 7 ]; then
			case "$1" in "$build"*) return 0 ;; esac
		fi
		[ "$i" = 3 ] || sleep 2
	done
	problem="/api/version through the stack's proxy says ${build:-nothing}, not ${1:0:8}"
	return 1
}

send_ping() {
	local url
	url="$(sed -n 's/^AUTO_DEPLOY_PING_URL=//p' "$state/settings" 2>/dev/null | tail -n 1 | sed "s/^[\"']//; s/[\"']\$//")"
	[ -n "$url" ] || return 0
	"$curl" -fsS -m 15 --retry 2 -o /dev/null "$url" >/dev/null 2>&1 ||
		log "the ping after the deploy did not go through (AUTO_DEPLOY_PING_URL in $state/settings)"
}

deployed() { # deployed <commit>: what a successful deploy leaves behind
	printf '%s %s\n' "$1" "$(now)" >"$state/deployed"
	rm -f "$state/failed" "$state/retry" "$state/migrations-acknowledged"
	set_state "deployed $(short "$1") at $(now)"
	send_ping
	ls -1 "$state/runs" | sort -r | tail -n +31 | while IFS= read -r old; do rm -f "$state/runs/$old"; done
}

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
	if ! $dry; then
		take_lock || exit 0
	fi
	if deploy_running; then
		$dry && echo "Do nothing: deploy.sh is running."
		exit 0
	fi

	local out head target failed_commit="" failed_reason="" retry="" branch dirty owned pending missing
	if ! out="$(git_ fetch --quiet origin main 2>&1)"; then
		hold "git fetch origin main failed: $(printf '%s' "$out" | tail -n 1)" "Usually the network, and the next run tries again. If it stays: git fetch origin main as the checkout's owner, in $repo."
	fi
	head="$(git_ rev-parse HEAD)"
	target="$(git_ rev-parse refs/remotes/origin/main)"
	if [ -f "$state/failed" ]; then
		read -r failed_commit failed_reason <"$state/failed" || true
	fi
	[ -f "$state/retry" ] && retry="$(cat "$state/retry")"

	if [ "$failed_commit" = "$target" ]; then
		if $dry; then
			echo "Would do nothing: $(short "$target") failed before ($failed_reason)."
		else
			set_state "failed: $(short "$target"): $failed_reason" "$after_failure"
		fi
		exit 1
	fi
	if [ "$head" = "$target" ] && [ "$retry" != "$target" ]; then
		if $dry; then
			echo "Nothing new: the checkout is at origin/main ($(short "$target"))."
			exit 0
		fi
		# A failure of an older commit no longer matters: main has moved past it.
		rm -f "$state/failed"
		local last=""
		[ -f "$state/deployed" ] && last="$(cat "$state/deployed")"
		if [ "${last%% *}" = "$head" ]; then
			set_state "deployed $(short "$head") at ${last#* }"
		else
			set_state "idle: nothing new on main; the checkout is at $(short "$head")"
		fi
		exit 0
	fi

	branch="$(git_ symbolic-ref --short -q HEAD || true)"
	[ "$branch" = main ] ||
		hold "the checkout is on ${branch:-a detached HEAD}, not main" "As the checkout's owner, in $repo: git switch main."
	if [ "$head" != "$target" ] && ! git_ merge-base --is-ancestor "$head" "$target"; then
		hold "origin/main ($(short "$target")) is not a plain step forward from the checkout ($(short "$head")): its history was rewritten, or the checkout has commits of its own" \
			"Look at git log --oneline HEAD...origin/main as the checkout's owner, in $repo. Once sure, move the checkout by hand (git reset --hard origin/main, as its owner) and roll out by hand (sudo ./deploy.sh)."
	fi
	dirty="$(git_ status --porcelain | cut -c4- | head -n 5 | paste -sd, - | sed 's/,/, /g')"
	[ -z "$dirty" ] ||
		hold "the checkout has changes of its own: $dirty" "As the checkout's owner, in $repo: git status, then commit, move away or undo them (git checkout -- <file>, or delete an untracked file)."
	owned="$(not_owned)"
	[ -z "$owned" ] ||
		hold "files in the checkout are not owned by $(owner): $owned" "Give them back: sudo chown $(owner):$(owner) <file> in $repo for each, and never run git there as root."
	pending="$(unacknowledged_migrations "$head" "$target" | cut -d' ' -f2- | sed 's#.*/##' | paste -sd, - | sed 's/,/, /g')"
	[ -z "$pending" ] ||
		hold "the new commits bring migrations not yet applied: $pending (in $migrations/, up to $(short "$target"))" \
			"Apply them to the database first (deploy/README.md, Day to day, \"Apply a database migration\"), then: sudo ./auto-deploy.sh migrations-applied $(short "$target")"
	if ! missing="$(missing_settings "$target")"; then
		hold "could not compare deploy/app/.env.example with .env" "Check that $envfile exists and can be read; the next run tries again."
	fi
	[ -z "$missing" ] ||
		hold "the new deploy/app/.env.example has settings that .env has no line for: $missing" \
			"Copy their lines from deploy/app/.env.example into deploy/app/.env (sudo nano .env) and fill them in where needed; the next run sees them."

	if $dry; then
		echo "Would deploy $(short "$target"): move the checkout from $(short "$head") (git merge --ff-only, as $(owner)), then run $deploy_sh."
		exit 0
	fi

	init_state
	# Asked to try a failed commit again, which someone may have put into service by hand meanwhile.
	if [ "$retry" = "$target" ] && serving "$target"; then
		log "$(short "$target") already serves (deployed by hand): recorded as deployed, nothing built"
		deployed "$target"
		exit 0
	fi
	local runlog
	runlog="$state/runs/$(date -u +%Y%m%dT%H%M%SZ)-$(short "$target").log"
	(umask 077 && : >"$runlog")
	# Recorded first: a run that is killed (a reboot, the service's time limit) stays a failure.
	printf '%s %s\n' "$target" "the run deploying it stopped before it finished (a reboot, a time-out or a kill); what runs may be half rolled out, see $runlog" >"$state/failed"
	rm -f "$state/retry"
	set_state "deploying $(short "$target") since $(now)" "Its output: $runlog"
	if ! git_ merge --ff-only --quiet "$target" >>"$runlog" 2>&1; then
		fail "$target" "git merge --ff-only $(short "$target") failed in the checkout, see $runlog" "Look at git status as the checkout's owner, in $repo. Then: sudo ./auto-deploy.sh clear-failure."
	fi
	if ! "$deploy_sh" </dev/null >>"$runlog" 2>&1; then
		fail "$target" "deploy.sh failed, see $runlog" "$after_failure"
	fi
	local problem=""
	if ! serving "$target"; then
		fail "$target" "deploy.sh finished, but $problem" "$after_failure"
	fi
	deployed "$target"
}

cmd_status() {
	if [ -e "$state/on" ]; then echo "Automatic deploys: on"; else echo "Automatic deploys: off"; fi
	local timer
	timer="$("$systemctl" is-enabled "$unit.timer" 2>/dev/null || true) $("$systemctl" is-active "$unit.timer" 2>/dev/null || true)"
	[ "$timer" = " " ] || echo "Timer $unit.timer: $timer"
	if [ -f "$state/lock" ] && ! flock -n "$state/lock" true 2>/dev/null; then
		echo "A run is in progress."
	fi
	if [ -f "$state/status" ]; then
		cat "$state/status"
	else
		echo "No run has recorded anything yet."
	fi
	[ ! -f "$state/deployed" ] || echo "last deployed: $(cat "$state/deployed")"
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
	if [ -f "$state/lock" ] && ! flock -n "$state/lock" true 2>/dev/null; then
		busy=" A run in progress finishes what it started (sudo ./auto-deploy.sh status)."
	fi
	[ ! -d "$state" ] || echo "$(now) switched off" >>"$state/log"
	echo "Switched off: no run starts any more, and a merge to main is rolled out only by hand.$busy"
}

cmd_migrations_applied() {
	require_root
	[ -n "${1:-}" ] || die "usage: auto-deploy.sh migrations-applied <commit> (the commit the hold names)"
	init_state
	take_lock || die "a run is in progress; try again when it has ended (sudo ./auto-deploy.sh status)."
	local commit head pending
	commit="$(git_ rev-parse -q --verify "$1^{commit}")" || die "no commit $1 in the checkout; the hold names it."
	head="$(git_ rev-parse HEAD)"
	git_ merge-base --is-ancestor "$head" "$commit" || die "$1 is not ahead of the checkout ($(short "$head"))."
	pending="$(unacknowledged_migrations "$head" "$commit")"
	[ -n "$pending" ] || die "no migration file waits between the checkout and $(short "$commit"): nothing to acknowledge."
	(umask 077 && printf '%s\n' "$pending" >>"$state/migrations-acknowledged")
	chmod 600 "$state/migrations-acknowledged"
	log "acknowledged as applied, up to $(short "$commit"): $(printf '%s\n' "$pending" | cut -d' ' -f2- | sed 's#.*/##' | paste -sd, - | sed 's/,/, /g'); a later change to them, or another file, is held again"
}

cmd_clear_failure() {
	require_root
	[ -f "$state/failed" ] || { echo "No failure is recorded: nothing to clear."; exit 0; }
	take_lock || die "a run is in progress; try again when it has ended (sudo ./auto-deploy.sh status)."
	local commit reason
	read -r commit reason <"$state/failed" || true
	rm -f "$state/failed"
	# The checkout is usually at the failed commit already, which by itself would be "nothing new".
	echo "$commit" >"$state/retry"
	set_state "idle: the failure of $(short "$commit") was cleared; the next run tries it again"
}

case "${1:-}" in
run) shift; cmd_run "$@" ;;
status) cmd_status ;;
install) cmd_install ;;
on) cmd_on ;;
off) cmd_off ;;
migrations-applied) shift; cmd_migrations_applied "$@" ;;
clear-failure) cmd_clear_failure ;;
-h | --help | help) awk 'NR > 1 && /^set -euo/ { exit } NR > 1' "$0" ;;
*) die "usage: auto-deploy.sh run [--dry-run] | status | on | off | migrations-applied <commit> | clear-failure | install (see --help)" ;;
esac
