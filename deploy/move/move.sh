#!/usr/bin/env bash
# Moves everything deploy/ runs from one server to another.
# Run it on your own machine, from a checkout of this repository.
# The whole procedure, and what it costs in downtime, is in README.md beside it.
#
# Written for the bash that ships with macOS (3.2) as well as current ones.
set -euo pipefail

usage() {
	cat <<'EOF'
Usage: OLD=user@old-host NEW=user@new-host deploy/move/move.sh <step>

Steps, in order:
  check      look at both servers; changes nothing
  prepare    set the new server up, copy the settings files, fetch the images
  sync       copy the data while the old server keeps running (repeat at will)
  cutover    stop the old server's containers, copy what changed, start the new one's
  finish     remove the temporary access that the copy used

Other:
  rollback   stop the new server's containers and start the old one's again
  status     what is running on each server

Settings, as environment variables:
  OLD, NEW        SSH logins, as user@host. The host part of OLD must be an
                  address the new server can reach as well: an IP address or a
                  DNS name, not an alias from your own SSH config.
  MOVE_SSH_OPTS   extra options for every ssh call from this machine, e.g.
                  "-i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes"
  MOVE_ROOT       where the checkout lives on both servers
                  (default /opt/native-intelligence)
  MOVE_PREFIX     what the Compose projects and volumes start with (default ni-)
  MOVE_YES=1      do not ask before cutover (rollback always asks)
  MOVE_ALLOW_DIRTY=1  prepare even though the old checkout has files that are
                  not in git (they do not move; see README.md)
EOF
}

die() { echo "move: $*" >&2; exit 1; }
say() { printf '\n== %s\n' "$*"; }

step="${1:-}"
case "$step" in
check | prepare | sync | cutover | finish | rollback | status) ;;
"" | -h | --help | help) usage; exit 0 ;;
*) usage >&2; exit 2 ;;
esac

: "${OLD:?set OLD=user@old-host}" "${NEW:?set NEW=user@new-host}"
: "${MOVE_ROOT:=/opt/native-intelligence}" "${MOVE_PREFIX:=ni-}" "${MOVE_SSH_OPTS:=}"
case "$OLD" in *@*) ;; *) die "OLD must be user@host." ;; esac
case "$NEW" in *@*) ;; *) die "NEW must be user@host." ;; esac
old_user="${OLD%@*}" old_host="${OLD#*@}"
new_user="${NEW%@*}" new_host="${NEW#*@}"
[ "$old_host" != "$new_host" ] || die "OLD and NEW are the same server."
# setup.sh turns root logins off, so a move driven as root would lock itself out.
[ "$new_user" != root ] || die "NEW must be an ordinary user who can sudo, not root: make one on the new server first."

here="$(cd "$(dirname "$0")" && pwd)"
setup_script="$here/../server/setup.sh"
[ -f "$setup_script" ] || die "deploy/server/setup.sh is missing; run this from a full checkout."

# One connection per server, reused by every call: the servers rate-limit new
# SSH connections. The socket lives in /tmp because its path has a length limit.
ctl="$(mktemp -d /tmp/ni-move.XXXXXX)"
hint=""
cleanup() {
	local d rc=$?
	if [ "$rc" != 0 ] && [ -n "$hint" ]; then printf '\nmove: %s\n' "$hint" >&2; fi
	for d in "$OLD" "$NEW"; do
		# shellcheck disable=SC2086
		ssh $MOVE_SSH_OPTS -o ControlPath="$ctl/%C" -O exit "$d" >/dev/null 2>&1 || true
	done
	rm -rf "$ctl"
}
trap cleanup EXIT
# A closed terminal or a kill would otherwise end the script without the EXIT
# trap, so without the hint about what state things are in.
trap 'exit 129' HUP
trap 'exit 143' TERM

# Every call from this machine goes through here.
ssh_to() {
	# shellcheck disable=SC2086
	ssh $MOVE_SSH_OPTS -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 \
		-o ControlMaster=auto -o ControlPath="$ctl/%C" -o ControlPersist=120 "$@"
}

# remote <login> [NAME=value ...]: runs the script on stdin as root over there,
# with the given variables set. Values are quoted for the far shell and must
# not contain a newline (a login shell other than bash would not read it back).
# The far side reads the whole script first and then runs it with nothing on
# its stdin, so a command in it that reads stdin cannot swallow the rest.
remote() {
	local dest="$1" envs="" kv
	shift
	for kv in "$@"; do envs="$envs $(printf '%q' "$kv")"; done
	# shellcheck disable=SC2029
	ssh_to "$dest" "sudo env$envs bash -c 's=\$(cat); exec bash -c \"\$s\" </dev/null'"
}

# stream <login> <command>: runs one command as root over there. Its stdin and
# stdout are this machine's, so data can be piped from one server to the other.
stream() {
	local dest="$1"
	shift
	# shellcheck disable=SC2029
	ssh_to "$dest" "sudo $*"
}

# What the old server runs. Prints lines of key=value.
inventory() {
	remote "$OLD" MOVE_ROOT="$MOVE_ROOT" MOVE_PREFIX="$MOVE_PREFIX" <<'EOS'
set -euo pipefail
owner="$(stat -c %U "$MOVE_ROOT")"
echo "commit=$(sudo -u "$owner" git -C "$MOVE_ROOT" rev-parse HEAD)"
echo "repo=$(sudo -u "$owner" git -C "$MOVE_ROOT" remote get-url origin)"
echo "sparse=$(sudo -u "$owner" git -C "$MOVE_ROOT" sparse-checkout list 2>/dev/null | tr '\n' ' ')"
echo "dockerroot=$(docker info -f '{{.DockerRootDir}}')"
echo "hostkey=$(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
for c in $(docker ps -a --format '{{.Names}}'); do
	p="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$c")"
	d="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$c")"
	case "$p" in "$MOVE_PREFIX"*) echo "project=$p|$d" ;; esac
done | sort -u
docker volume ls --format '{{.Name}}' | { grep "^$MOVE_PREFIX" || true; } | sed 's/^/volume=/'
find "$MOVE_ROOT/deploy" -name .env -type f | sed 's/^/envfile=/'
find /etc/cron.d -maxdepth 1 -type f -name "${MOVE_PREFIX}*" | sed 's/^/hostfile=/'
# Files changed or added by hand in the checkout. The .env files are ignored by
# git, so they do not show up here; they are moved on their own.
sudo -u "$owner" git -C "$MOVE_ROOT" status --porcelain --untracked-files=all -- deploy | sed 's/^/dirty=/'
docker ps --format '{{.Names}} {{.Label "com.docker.compose.project"}}' |
	awk -v p="$MOVE_PREFIX" 'index($2, p) == 1 { print "running=" $1 }'
EOS
}

inv=""
load_inventory() {
	inv="$(inventory)" || die "could not read the old server."
	[ -n "$(inv_get commit)" ] || die "the old server has no checkout at $MOVE_ROOT."
	[ -n "$(inv_get project)" ] || die "the old server has no ${MOVE_PREFIX} Compose projects; there is nothing to move or to go back to."
}
inv_get() { printf '%s\n' "$inv" | sed -n "s/^$1=//p"; }

# Start order: databases and queues first, the public door after them, backups
# last. Stopping goes the other way round.
rank() {
	case "$1" in
	*supabase*) echo 1 ;;
	*inngest*) echo 2 ;;
	*edge*) echo 4 ;;
	*backup*) echo 5 ;;
	*) echo 3 ;;
	esac
}
# Prints "name|dir" items on one line, in start order, or reversed.
projects_in_order() {
	local line name
	inv_get project | while IFS= read -r line; do
		[ -n "$line" ] || continue
		name="${line%%|*}"
		echo "$(rank "$name") $line"
	done | sort $1 | cut -d' ' -f2- | tr '\n' ' '
}

ask() {
	printf '%s [type yes] ' "$1"
	local answer=""
	read -r answer || true
	[ "$answer" = yes ] || die "stopped; nothing was changed."
}
confirm() {
	[ "${MOVE_YES:-}" = 1 ] && return 0
	ask "$1"
}

running_on() { # running_on <login>: names of this platform's running containers
	remote "$1" MOVE_PREFIX="$MOVE_PREFIX" <<'EOS'
set -euo pipefail
# No Docker yet means nothing of ours can be running. A Docker that fails to
# answer is an error, never "nothing running".
command -v docker >/dev/null 2>&1 || exit 0
docker ps --format '{{.Names}} {{.Label "com.docker.compose.project"}}' |
	awk -v p="$MOVE_PREFIX" 'index($2, p) == 1 { print $1 }' | tr '\n' ' '
EOS
}

# A finished cutover leaves a marker on the new server. While it is there,
# nothing here will copy onto that server again: that would replace what it
# has written since with the old server's data.
new_is_live() {
	local answer
	answer="$(remote "$NEW" <<'EOS'
[ -e /root/.ni-move-live ] && echo live || echo clear
EOS
)" || die "could not ask the new server whether it is live."
	# No answer is not "no": a dropped connection must not read as "not live".
	case "$answer" in
	live) return 0 ;;
	clear) return 1 ;;
	*) die "could not ask the new server whether it is live." ;;
	esac
}
refuse_if_live() {
	if new_is_live; then
		die "the new server is already live: a cutover to it has finished. Copying onto it again would wipe what it has written since. (The marker is /root/.ni-move-live on that server; 'rollback' removes it.)"
	fi
}

show_status() {
	local d
	for d in "$OLD" "$NEW"; do
		echo "-- $d"
		remote "$d" <<'EOS' || echo "   (not reachable, or no Docker yet)"
if command -v docker >/dev/null 2>&1; then
	docker ps -a --format '   {{.Names}}\t{{.Status}}' | sort
else
	echo "   Docker is not installed"
fi
echo "   memory free: $(free -m | awk 'NR==2{print $7}') MB, disk free: $(df -h / | awk 'NR==2{print $4}')"
EOS
	done
}

cmd_check() {
	say "The old server"
	load_inventory
	echo "checkout: $(inv_get commit | cut -c1-8) of $(inv_get repo | sed 's#.*/##')"
	echo "projects: $(projects_in_order -n)"
	echo "volumes:  $(inv_get volume | tr '\n' ' ')"
	echo "settings files: $(inv_get envfile | wc -l | tr -d ' ')   host files: $(inv_get hostfile | wc -l | tr -d ' ')"
	echo "running:  $(inv_get running | tr '\n' ' ')"
	if [ -n "$(inv_get dirty)" ]; then
		echo "!! changed by hand in the checkout, and NOT moved by this script:"
		inv_get dirty | sed 's/^/     /'
	fi
	remote "$OLD" MOVE_PREFIX="$MOVE_PREFIX" ROOTDIR="$(inv_get dockerroot)" <<'EOS'
command -v rsync >/dev/null || echo "!! rsync is not installed here"
echo "data to copy: $(du -shc "$ROOTDIR"/volumes/"$MOVE_PREFIX"*/_data 2>/dev/null | tail -1 | cut -f1)"
EOS
	say "The new server"
	remote "$NEW" <<'EOS'
. /etc/os-release; echo "system: $PRETTY_NAME, $(nproc) cores, $(free -g | awk 'NR==2{print $2}') GB memory, $(df -h / | awk 'NR==2{print $4}') disk free"
command -v docker >/dev/null 2>&1 && echo "Docker: $(docker version -f '{{.Server.Version}}')" || echo "Docker: not installed yet (prepare installs it)"
EOS
	if new_is_live; then echo "!! the new server is marked live: prepare, sync and cutover will refuse"; fi
	echo
	echo "Both servers answer and sudo works without a password on each."
}

cmd_prepare() {
	load_inventory
	refuse_if_live
	local running
	running="$(running_on "$NEW")"
	[ -z "${running// /}" ] || die "containers are running on the new server ($running). prepare is for a server that is not in use: it replaces the settings files and re-creates the containers."
	if [ -n "$(inv_get dirty)" ] && [ "${MOVE_ALLOW_DIRTY:-}" != 1 ]; then
		echo "The old server's checkout has files that are not in git:" >&2
		inv_get dirty | sed 's/^/   /' >&2
		die "they would not move. Commit them, or copy them by hand and run this again with MOVE_ALLOW_DIRTY=1."
	fi
	say "Setting the new server up (deploy/server/setup.sh)"
	# shellcheck disable=SC2029
	ssh_to "$NEW" "sudo bash -s -- --login-user $(printf '%q' "$new_user") --repo $(printf '%q' "$(inv_get repo)") --ref $(printf '%q' "$(inv_get commit)") --root $(printf '%q' "$MOVE_ROOT") --paths $(printf '%q' "$(inv_get sparse)")" <"$setup_script"

	say "Copying the settings files (their contents are never shown)"
	local files
	files="$(printf '%s\n%s\n' "$(inv_get envfile)" "$(inv_get hostfile)" | sed '/^$/d' | tr '\n' ' ')"
	[ -n "${files// /}" ] || die "the old server has no settings files; is MOVE_ROOT right?"
	remote "$OLD" FILES="$files" <<'EOS' | stream "$NEW" tar -C / -xpf - --same-owner
set -euo pipefail
# shellcheck disable=SC2086
printf '%s\n' $FILES | sed 's#^/##' | tar -C / -cpf - --files-from=-
EOS
	echo "$(printf '%s\n' $files | wc -l | tr -d ' ') files copied"

	say "Fetching the images and creating the containers, stopped"
	remote "$NEW" PROJECTS="$(projects_in_order -n)" <<'EOS'
set -euo pipefail
for item in $PROJECTS; do
	name="${item%%|*}" dir="${item#*|}"
	echo "-- $name"
	cd "$dir"
	docker compose pull --ignore-buildable --quiet
	docker compose build --quiet
	docker compose up --no-start --quiet-pull
done
EOS
	echo
	if [ "$(remote "$NEW" <<'EOS'
[ -f /var/run/reboot-required ] && echo yes || echo no
EOS
)" = yes ]; then
		echo "The new server wants a reboot (a kernel update is waiting). Reboot it now, before sync:"
		echo "  ssh $NEW sudo reboot"
		echo "Otherwise it reboots itself at its nightly time, possibly in the middle of the move."
	fi
	echo "The new server is ready and nothing is running on it. Next: sync."
}

# do_sync live|final. 'live' copies while the old server runs: files may change
# under it, so it only has to get most of the data across. 'final' runs with
# everything stopped and compares file contents, not just size and time: a file
# rewritten in place within the same second as the earlier copy looks unchanged
# otherwise, and a database started on it would be corrupt.
do_sync() {
	local mode="$1" volumes running from="" addr pub
	volumes="$(inv_get volume | tr '\n' ' ')"
	[ -n "${volumes// /}" ] || die "the old server has no volumes starting with $MOVE_PREFIX."
	running="$(running_on "$NEW")"
	[ -z "${running// /}" ] || die "containers are running on the new server ($running); copying over live data would corrupt it."

	# A key that exists only for this copy: made on the new server, allowed on the
	# old one for the old login, and removed again by 'finish'.
	pub="$(remote "$NEW" <<'EOS'
set -euo pipefail
install -d -m 700 /root/.ssh
[ -f /root/.ssh/ni-move ] || ssh-keygen -q -t ed25519 -N "" -C ni-move-temp -f /root/.ssh/ni-move
cat /root/.ssh/ni-move.pub
EOS
)"
	# Only the new server's address may use it, when that address is known.
	addr="$new_host"
	case "$addr" in
	*[!0-9.]*) addr="$(dig +short A "$new_host" 2>/dev/null | grep -E '^[0-9.]+$' | head -1 || true)" ;;
	esac
	local family=any
	if [ -n "$addr" ]; then
		from="from=\"$addr\","
		family=inet # the limit is an IPv4 address, so the copy must come from it
	fi
	remote "$OLD" LINE="${from}restrict $pub" LOGIN="$old_user" <<'EOS'
set -euo pipefail
f="$(getent passwd "$LOGIN" | cut -d: -f6)/.ssh/authorized_keys"
# A last line without a newline would be glued to ours, and both would break.
[ -z "$(tail -c1 "$f")" ] || echo >>"$f"
# Drop a key left by an earlier, unfinished move before adding this one.
sed -i '/ ni-move-temp$/d' "$f"
printf '%s\n' "$LINE" >>"$f"
EOS

	# The new server trusts exactly the host key the old one showed us over the
	# connection this machine already trusts.
	remote "$NEW" KNOWN="$old_host $(inv_get hostkey)" OLD_USER="$old_user" OLD_HOST="$old_host" \
		VOLUMES="$volumes" OLD_ROOT="$(inv_get dockerroot)" MODE="$mode" FAMILY="$family" <<'EOS'
set -euo pipefail
# One copy at a time. A copy whose connection to your machine dropped keeps
# running here; a second one beside it, or containers started under it, would
# corrupt the data. The lock is held by rsync too, for as long as it lives.
exec 9>/root/.ni-move.lock
flock -n 9 || { echo "An earlier copy is still running on the new server. Wait for it to end (pgrep -a rsync), then run this again." >&2; exit 1; }
printf '%s\n' "$KNOWN" >/root/.ssh/ni-move-known-hosts
new_root="$(docker info -f '{{.DockerRootDir}}')"
srcs=""
for v in $VOLUMES; do
	docker volume inspect "$v" >/dev/null 2>&1 || docker volume create "$v" >/dev/null
	if [ -z "$srcs" ]; then srcs="$OLD_USER@$OLD_HOST:$OLD_ROOT/volumes/./$v/_data"; else srcs="$srcs :$OLD_ROOT/volumes/./$v/_data"; fi
done
extra=""
[ "$MODE" = final ] && extra="--checksum"
log=/root/.ni-move-rsync.log
rc=0
# shellcheck disable=SC2086
rsync -aHAX --numeric-ids --delete --relative --stats $extra \
	-e "ssh -i /root/.ssh/ni-move -o BatchMode=yes -o IdentitiesOnly=yes -o AddressFamily=$FAMILY -o UserKnownHostsFile=/root/.ssh/ni-move-known-hosts -o StrictHostKeyChecking=yes" \
	--rsync-path="sudo rsync" $srcs "$new_root/volumes/" >"$log" 2>&1 || rc=$?
sed -n '/^Number of regular files transferred\|^Total transferred file size\|^Total file size/p' "$log"
if [ "$rc" != 0 ]; then
	# 24: files vanished while they were read. 23: some files were not copied,
	# which under a running database usually means they changed mid-read, but
	# is also what a permission or attribute error looks like. The live copy
	# goes on either way; its messages are shown so a real error is seen now
	# and not at the cutover, where the same error stops everything.
	if [ "$MODE" = live ] && { [ "$rc" = 23 ] || [ "$rc" = 24 ]; }; then
		echo "rsync ended with code $rc while the old server was running. Its messages:"
		{ grep -E '^(rsync|WARNING|ERROR|IO error|file has vanished)' "$log" || true; } | tail -8 | sed 's/^/   /'
		echo "Files that vanish or change under a live copy are normal; cutover copies them again."
		echo "Anything else in that list will stop the cutover too. Fix it first."
	else
		grep -v '^$' "$log" | tail -15 >&2
		exit "$rc"
	fi
fi
date -u +%Y-%m-%dT%H:%M:%SZ >/root/.ni-move-synced
EOS
}

cmd_sync() {
	load_inventory
	refuse_if_live
	[ -n "$(inv_get running)" ] || die "nothing is running on the old server. If a cutover was interrupted, run cutover again; it carries on from where it stopped."
	say "Copying the data, old server still running"
	do_sync live
	echo
	echo "Copied. Run sync again whenever you like; cutover copies only what changed since."
}

cmd_cutover() {
	load_inventory
	refuse_if_live
	[ "$(remote "$NEW" <<'EOS'
[ -f /root/.ni-move-synced ] && echo yes || echo no
EOS
)" = yes ] || die "run prepare and sync first."
	# Checked before anything is stopped: finding this out afterwards would mean
	# an outage with nothing to replace it.
	local running t0
	running="$(running_on "$NEW")"
	[ -z "${running// /}" ] || die "containers are already running on the new server ($running). Stop them there first."

	echo "This stops every $MOVE_PREFIX container on $old_host, copies what changed, and starts them on $new_host."
	echo "Until the DNS names point at the new server, the platform is down."
	confirm "Go ahead?"
	t0="$(date +%s)"
	hint="The old server's containers are stopped and nothing was started on the new server. Fix the cause and run 'cutover' again (it carries on from here), or run 'rollback' to start the old server again."

	say "Stopping the old server's containers"
	remote "$OLD" PROJECTS="$(projects_in_order -rn)" <<'EOS'
set -euo pipefail
for item in $PROJECTS; do
	cd "${item#*|}"
	docker compose stop
done
EOS
	running="$(running_on "$OLD")"
	[ -z "${running// /}" ] || die "still running on the old server after the stop: $running. Stop them by hand (docker stop), then run cutover again."

	say "Copying what changed, comparing file contents"
	do_sync final

	say "Starting on the new server"
	hint="The data is copied, but starting on the new server did not finish, and the old server is stopped. Look at the new server (docker ps -a, docker compose logs in the stack's folder). Then either stop what did start there and run 'cutover' again, or run 'rollback' to start the old server again."
	remote "$NEW" PROJECTS="$(projects_in_order -n)" OLD_HOST="$old_host" <<'EOS'
set -euo pipefail
flock -n /root/.ni-move.lock true || { echo "A copy is still running on this server; nothing was started." >&2; exit 1; }
for item in $PROJECTS; do
	cd "${item#*|}"
	docker compose up -d --wait --wait-timeout 300
done
printf 'live since %s, moved from %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$OLD_HOST" >/root/.ni-move-live
docker ps --format '   {{.Names}}\t{{.Status}}' | sort
EOS
	hint=""

	say "Started after $(($(date +%s) - t0)) seconds"
	echo "Now change every DNS record that points at the old server so it points at the new one."
	echo "The old server's containers are stopped, not removed: 'rollback' starts them again."
}

cmd_rollback() {
	load_inventory
	echo "This stops every $MOVE_PREFIX container on $new_host and starts them on $old_host again,"
	echo "with the data as it was at the cutover. Anything written on the new server since is left behind."
	remote "$NEW" <<'EOS'
if [ -e /root/.ni-move-live ]; then echo "The new server says: $(cat /root/.ni-move-live)."; else echo "The new server is not marked live."; fi
EOS
	# Always asked, whatever MOVE_YES says: this throws data away, more of it
	# the later it is run.
	ask "Go back to the old server?"
	hint="The rollback did not finish. Run 'status' to see what is running where; containers must end up running on exactly one of the two servers."
	say "Stopping the new server's containers"
	remote "$NEW" PROJECTS="$(projects_in_order -rn)" <<'EOS'
set -euo pipefail
for item in $PROJECTS; do
	cd "${item#*|}"
	docker compose stop
done
rm -f /root/.ni-move-live
EOS
	say "Starting the old server's containers"
	remote "$OLD" PROJECTS="$(projects_in_order -n)" <<'EOS'
set -euo pipefail
for item in $PROJECTS; do
	cd "${item#*|}"
	docker compose up -d --wait --wait-timeout 300
done
docker ps --format '   {{.Names}}\t{{.Status}}' | sort
EOS
	hint=""
	echo
	echo "Point the DNS records back at the old server."
	echo "If you are giving up on this move rather than trying again, run 'finish' too: it removes the temporary key."
}

cmd_finish() {
	say "Removing the temporary access"
	remote "$OLD" LOGIN="$old_user" <<'EOS'
set -euo pipefail
f="$(getent passwd "$LOGIN" | cut -d: -f6)/.ssh/authorized_keys"
if grep -q ' ni-move-temp$' "$f" 2>/dev/null; then
	sed -i '/ ni-move-temp$/d' "$f"
	echo "key removed from the old server"
else
	echo "no temporary key on the old server"
fi
EOS
	remote "$NEW" <<'EOS'
flock -n /root/.ni-move.lock true 2>/dev/null || { echo "A copy is still running on the new server; finish later." >&2; exit 1; }
rm -f /root/.ssh/ni-move /root/.ssh/ni-move.pub /root/.ssh/ni-move-known-hosts /root/.ni-move-synced /root/.ni-move-rsync.log /root/.ni-move.lock
echo "key deleted on the new server"
EOS
	echo
	echo "The old server still holds its stopped containers and its copy of the data."
	echo "Keep it for a few days as the way back, then cancel it with the provider."
}

case "$step" in
check) cmd_check ;;
prepare) cmd_prepare ;;
sync) cmd_sync ;;
cutover) cmd_cutover ;;
rollback) cmd_rollback ;;
finish) cmd_finish ;;
status) show_status ;;
esac
