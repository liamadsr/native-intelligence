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
  MOVE_YES=1      do not ask before cutover or rollback
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

here="$(cd "$(dirname "$0")" && pwd)"
setup_script="$here/../server/setup.sh"
[ -f "$setup_script" ] || die "deploy/server/setup.sh is missing; run this from a full checkout."

# One connection per server, reused by every call: the servers rate-limit new
# SSH connections. The socket lives in /tmp because its path has a length limit.
ctl="$(mktemp -d /tmp/ni-move.XXXXXX)"
cleanup() {
	local d
	for d in "$OLD" "$NEW"; do
		# shellcheck disable=SC2086
		ssh $MOVE_SSH_OPTS -o ControlPath="$ctl/%C" -O exit "$d" >/dev/null 2>&1 || true
	done
	rm -rf "$ctl"
}
trap cleanup EXIT

# Every call from this machine goes through here.
ssh_to() {
	# shellcheck disable=SC2086
	ssh $MOVE_SSH_OPTS -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 \
		-o ControlMaster=auto -o ControlPath="$ctl/%C" -o ControlPersist=120 "$@"
}

# remote <login> [NAME=value ...]: runs the script on stdin as root over there,
# with the given variables set. Values are quoted for the far shell.
remote() {
	local dest="$1" envs="" kv
	shift
	for kv in "$@"; do envs="$envs $(printf '%q' "$kv")"; done
	# shellcheck disable=SC2029
	ssh_to "$dest" "sudo env$envs bash -s"
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
EOS
}

inv=""
load_inventory() {
	inv="$(inventory)" || die "could not read the old server."
	[ -n "$(inv_get commit)" ] || die "the old server has no checkout at $MOVE_ROOT."
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

confirm() {
	[ "${MOVE_YES:-}" = 1 ] && return 0
	printf '%s [type yes] ' "$1"
	local answer
	read -r answer
	[ "$answer" = yes ] || die "stopped; nothing was changed."
}

running_on() { # running_on <login>: names of this platform's running containers
	remote "$1" MOVE_PREFIX="$MOVE_PREFIX" <<'EOS'
docker ps --format '{{.Names}} {{ index .Labels "com.docker.compose.project" }}' 2>/dev/null |
	awk -v p="$MOVE_PREFIX" 'index($2, p) == 1 { print $1 }' | tr '\n' ' '
EOS
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
	remote "$OLD" MOVE_PREFIX="$MOVE_PREFIX" ROOTDIR="$(inv_get dockerroot)" <<'EOS'
command -v rsync >/dev/null || echo "!! rsync is not installed here"
echo "data to copy: $(du -shc "$ROOTDIR"/volumes/"$MOVE_PREFIX"*/_data 2>/dev/null | tail -1 | cut -f1)"
EOS
	say "The new server"
	remote "$NEW" <<'EOS'
. /etc/os-release; echo "system: $PRETTY_NAME, $(nproc) cores, $(free -g | awk 'NR==2{print $2}') GB memory, $(df -h / | awk 'NR==2{print $4}') disk free"
command -v docker >/dev/null 2>&1 && echo "Docker: $(docker version -f '{{.Server.Version}}')" || echo "Docker: not installed yet (prepare installs it)"
EOS
	echo
	echo "Both servers answer and sudo works without a password on each."
}

cmd_prepare() {
	load_inventory
	say "Setting the new server up (deploy/server/setup.sh)"
	# shellcheck disable=SC2029
	ssh_to "$NEW" "sudo bash -s -- --login-user $(printf '%q' "$new_user") --repo $(printf '%q' "$(inv_get repo)") --ref $(printf '%q' "$(inv_get commit)") --root $(printf '%q' "$MOVE_ROOT")" <"$setup_script"

	say "Copying the settings files (their contents are never shown)"
	local files
	files="$(printf '%s\n%s\n' "$(inv_get envfile)" "$(inv_get hostfile)" | sed '/^$/d')"
	[ -n "$files" ] || die "the old server has no settings files; is MOVE_ROOT right?"
	remote "$OLD" FILES="$files" <<'EOS' | stream "$NEW" tar -C / -xpf - --same-owner
set -euo pipefail
printf '%s\n' "$FILES" | sed 's#^/##' | tar -C / -cpf - --files-from=-
EOS
	echo "$(printf '%s\n' "$files" | wc -l | tr -d ' ') files copied"

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
	echo "The new server is ready and nothing is running on it. Next: sync."
}

do_sync() {
	local volumes running new_ip from=""
	volumes="$(inv_get volume | tr '\n' ' ')"
	[ -n "${volumes// /}" ] || die "the old server has no volumes starting with $MOVE_PREFIX."
	running="$(running_on "$NEW")"
	[ -z "${running// /}" ] || die "containers are running on the new server ($running); copying over live data would corrupt it."

	# A key that exists only for this copy: made on the new server, allowed on the
	# old one for the old login, and removed again by 'finish'.
	local pub
	pub="$(remote "$NEW" <<'EOS'
set -euo pipefail
install -d -m 700 /root/.ssh
[ -f /root/.ssh/ni-move ] || ssh-keygen -q -t ed25519 -N "" -C ni-move-temp -f /root/.ssh/ni-move
cat /root/.ssh/ni-move.pub
EOS
)"
	case "$new_host" in
	*[!0-9.]*) ;; # a name: no address restriction
	*) from="from=\"$new_host\"," ;;
	esac
	remote "$OLD" LINE="${from}no-agent-forwarding,no-port-forwarding,no-pty,no-X11-forwarding $pub" LOGIN="$old_user" <<'EOS'
set -euo pipefail
home="$(getent passwd "$LOGIN" | cut -d: -f6)"
grep -q ' ni-move-temp$' "$home/.ssh/authorized_keys" 2>/dev/null || printf '%s\n' "$LINE" >>"$home/.ssh/authorized_keys"
EOS

	# The new server trusts exactly the host key the old one showed us over the
	# connection this machine already trusts.
	remote "$NEW" KNOWN="$old_host $(inv_get hostkey)" OLD_USER="$old_user" OLD_HOST="$old_host" \
		VOLUMES="$volumes" OLD_ROOT="$(inv_get dockerroot)" <<'EOS'
set -euo pipefail
printf '%s\n' "$KNOWN" >/root/.ssh/ni-move-known-hosts
new_root="$(docker info -f '{{.DockerRootDir}}')"
srcs=""
for v in $VOLUMES; do
	docker volume inspect "$v" >/dev/null 2>&1 || docker volume create "$v" >/dev/null
	if [ -z "$srcs" ]; then srcs="$OLD_USER@$OLD_HOST:$OLD_ROOT/volumes/./$v/_data"; else srcs="$srcs :$OLD_ROOT/volumes/./$v/_data"; fi
done
# shellcheck disable=SC2086
rsync -aHAX --numeric-ids --delete --relative --info=stats1 \
	-e "ssh -i /root/.ssh/ni-move -o BatchMode=yes -o IdentitiesOnly=yes -o UserKnownHostsFile=/root/.ssh/ni-move-known-hosts -o StrictHostKeyChecking=yes" \
	--rsync-path="sudo rsync" $srcs "$new_root/volumes/" | sed -n '/Number of regular files transferred\|Total transferred file size\|Total file size/p'
date -u +%Y-%m-%dT%H:%M:%SZ >/root/.ni-move-synced
EOS
}

cmd_sync() {
	load_inventory
	say "Copying the data, old server still running"
	do_sync
	echo
	echo "Copied. Run sync again whenever you like; cutover copies only what changed since."
}

cmd_cutover() {
	load_inventory
	remote "$NEW" <<'EOS' || die "run prepare and sync first."
test -f /root/.ni-move-synced
EOS
	echo "This stops every $MOVE_PREFIX container on $old_host, copies what changed, and starts them on $new_host."
	echo "Until the DNS names point at the new server, the platform is down."
	confirm "Go ahead?"
	local t0
	t0="$(date +%s)"

	say "Stopping the old server's containers"
	remote "$OLD" PROJECTS="$(projects_in_order -rn)" <<'EOS'
set -euo pipefail
for item in $PROJECTS; do
	cd "${item#*|}"
	docker compose stop
done
EOS

	say "Copying what changed"
	do_sync

	say "Starting on the new server"
	remote "$NEW" PROJECTS="$(projects_in_order -n)" <<'EOS'
set -euo pipefail
for item in $PROJECTS; do
	cd "${item#*|}"
	docker compose up -d --wait --wait-timeout 300
done
docker ps --format '   {{.Names}}\t{{.Status}}' | sort
EOS

	say "Started after $(($(date +%s) - t0)) seconds"
	echo "Now change every DNS record that points at the old server so it points at the new one."
	echo "The old server's containers are stopped, not removed: 'rollback' starts them again."
}

cmd_rollback() {
	load_inventory
	echo "This stops every $MOVE_PREFIX container on $new_host and starts them on $old_host again,"
	echo "with the data as it was at the cutover. Anything written on the new server since is left behind."
	confirm "Go back to the old server?"
	say "Stopping the new server's containers"
	remote "$NEW" PROJECTS="$(projects_in_order -rn)" <<'EOS'
set -euo pipefail
for item in $PROJECTS; do
	cd "${item#*|}"
	docker compose stop
done
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
	echo
	echo "Point the DNS records back at the old server."
}

cmd_finish() {
	say "Removing the temporary access"
	remote "$OLD" LOGIN="$old_user" <<'EOS'
set -euo pipefail
home="$(getent passwd "$LOGIN" | cut -d: -f6)"
if grep -q ' ni-move-temp$' "$home/.ssh/authorized_keys" 2>/dev/null; then
	sed -i '/ ni-move-temp$/d' "$home/.ssh/authorized_keys"
	echo "key removed from the old server"
else
	echo "no temporary key on the old server"
fi
EOS
	remote "$NEW" <<'EOS'
rm -f /root/.ssh/ni-move /root/.ssh/ni-move.pub /root/.ssh/ni-move-known-hosts /root/.ni-move-synced
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
