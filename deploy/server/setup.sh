#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 server for everything in deploy/: steps 3 to 7
# of deploy/README.md as one script. It is safe to run again: every step looks
# first and only changes what is missing.
#
#   sudo ./setup.sh --login-user <user> --repo <https address of this repository> [--ref <commit>] [--paths "<folders>"]
#
# --paths names further folders of the repository the server needs beside
# deploy/ (the Supabase stack reads two under web/supabase). Folders already
# checked out are kept: this only ever adds.
#
# From your own machine, before the repository is on the server:
#
#   ssh <user>@<server> "sudo bash -s -- --login-user <user> --repo <address>" < deploy/server/setup.sh
#
# What it does not do: create users, start a container, or handle a secret.
# The settings files (.env) and the data are brought by deploy/move/move.sh, or
# written by hand as deploy/README.md describes.
#
# The whole script is one function that is called on the last line with nothing
# on its stdin. When it is fed to "bash -s" over ssh, bash would otherwise read
# it piece by piece from stdin, and any command in it that also reads stdin
# (apt, for one) could swallow the rest.
set -eEuo pipefail

main() {
# Say where it stopped: a command that fails ends the script without a word otherwise.
trap 'echo "setup: stopped by a failing command at line $LINENO." >&2' ERR
login_user=""
repo=""
ref=""
root=/opt/native-intelligence
reboot_time="08:37"
paths=""

while [ $# -gt 0 ]; do
	case "$1" in
	--login-user) login_user="${2:?}"; shift 2 ;;
	--repo) repo="${2:?}"; shift 2 ;;
	--ref) ref="${2:?}"; shift 2 ;;
	--root) root="${2:?}"; shift 2 ;;
	--reboot-time) reboot_time="${2:?}"; shift 2 ;;
	--paths) paths="${2-}"; shift 2 ;;
	*) echo "Unknown option: $1" >&2; exit 2 ;;
	esac
done

die() { echo "setup: $*" >&2; exit 1; }
say() { printf '\n== %s\n' "$*"; }

[ "$(id -u)" = 0 ] || die "run it with sudo."
[ -n "$login_user" ] || die "--login-user is required: the user you log in as."
id "$login_user" >/dev/null 2>&1 || die "there is no user called $login_user."
# Step 1 turns root logins off. Doing that while logged in as root locks the
# server: the session in progress survives, the next one is refused.
[ "$login_user" != root ] || die "--login-user must be an ordinary user who can sudo, not root. Make one first."
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "this is written for Ubuntu, and this is ${PRETTY_NAME:-something else}."

home="$(getent passwd "$login_user" | cut -d: -f6)"
# Step 1 turns passwords off. Refuse to do that to a user who has no key yet.
[ -s "$home/.ssh/authorized_keys" ] || die "$login_user has no SSH key in $home/.ssh/authorized_keys; add one first, or this would lock you out."

export DEBIAN_FRONTEND=noninteractive

# Writes stdin to a file only when the content differs. Returns 0 when it wrote.
write_if_changed() {
	local path="$1" tmp
	# This function is used as an "if" condition, where a failing command does
	# not stop the script by itself, so each step is checked by hand. A file
	# cut short by a full disk must never be put in place.
	tmp="$(mktemp)" || die "could not make a temporary file."
	cat >"$tmp" || die "could not write a temporary file for $path."
	if [ -f "$path" ] && cmp -s "$tmp" "$path"; then
		rm -f "$tmp"
		return 1
	fi
	install -m 644 -o root -g root "$tmp" "$path" || die "could not write $path."
	rm -f "$tmp"
	return 0
}

say "SSH: keys only, no root login"
if write_if_changed /etc/ssh/sshd_config.d/00-ni-hardening.conf <<EOF
# Managed by deploy/server/setup.sh in the native-intelligence repository.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowUsers $login_user
EOF
then
	sshd -t
	systemctl restart ssh
	echo "applied"
else
	echo "already set"
fi
sshd -T | grep -E '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|allowusers) '

say "Packages"
# A fresh server is often in the middle of its own first update: wait for it.
apt_get() { apt-get -o DPkg::Lock::Timeout=600 "$@"; }
apt_get update -qq
apt_get install -y -qq unattended-upgrades ca-certificates curl git rsync ufw >/dev/null
echo "installed"

say "Automatic security updates, with a reboot at $reboot_time UTC when one is needed"
write_if_changed /etc/apt/apt.conf.d/20auto-upgrades <<'EOF' || true
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
# Not on the hour or the half hour: that is when scheduled jobs fire, and a
# reboot at that second makes the ones that start a few seconds later skip a turn.
write_if_changed /etc/apt/apt.conf.d/52ni-unattended-upgrades <<EOF || true
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "$reboot_time";
EOF
echo "set"

say "Firewall: SSH, 80 and 443, and LiveKit's two media ports"
# Whatever port sshd really listens on, so enabling the firewall cannot cut
# the connection this is running over.
# awk reads to the end on purpose: leaving early would close the pipe on sshd,
# and with pipefail that counts as a failure.
ssh_ports="$(sshd -T | awk '$1 == "port" { print $2 }' | tr '\n' ' ')"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
for ssh_port in ${ssh_ports:-22}; do
	ufw limit "$ssh_port/tcp" comment 'SSH' >/dev/null
done
ufw allow 80/tcp comment 'HTTP (redirects, certificates)' >/dev/null
ufw allow 443/tcp comment 'HTTPS' >/dev/null
# The media of calls (deploy/livekit): WebRTC over one UDP port, and ICE over TCP
# for networks that block UDP. Not HTTP, so not through Caddy. Docker opens the two
# ports it publishes whatever ufw says (deploy/README.md, step 5); these lines make
# ufw's own list say what is open. Nothing listens on them until LiveKit runs.
ufw allow 7882/udp comment 'LiveKit media (WebRTC over UDP)' >/dev/null
ufw allow 7881/tcp comment 'LiveKit media (ICE over TCP)' >/dev/null
ufw --force enable >/dev/null
ufw status | sed -n '1,16p'

say "Docker"
if ! command -v docker >/dev/null 2>&1; then
	install -m 0755 -d /etc/apt/keyrings
	curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
	chmod a+r /etc/apt/keyrings/docker.asc
	echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" >/etc/apt/sources.list.d/docker.list
	apt_get update -qq
	apt_get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
install -d -m 755 /etc/docker
# Cap the logs before any container exists. Restarting Docker restarts every
# container, so it is only done when this file really changed.
if write_if_changed /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "20m",
    "max-file": "5"
  }
}
EOF
then
	systemctl restart docker
fi
systemctl enable docker >/dev/null 2>&1
echo "Docker $(docker version -f '{{.Server.Version}}'), Compose $(docker compose version --short)"

say "Kernel setting for Redis"
write_if_changed /etc/sysctl.d/90-ni-redis.conf <<'EOF' || true
vm.overcommit_memory = 1
EOF
sysctl --system >/dev/null
sysctl vm.overcommit_memory

say "The files"
install -d -o "$login_user" -g "$login_user" "$root"
as_user() { sudo -u "$login_user" -H "$@"; }
if [ ! -d "$root/.git" ]; then
	[ -n "$repo" ] || die "--repo is required the first time: the repository's HTTPS address."
	as_user git clone --quiet --depth 1 --filter=blob:none --sparse "$repo" "$root"
fi
# Every run, not only the first: a clone that was cut off leaves .git behind
# without this having happened. "add", never "set": set would take away the
# folders a later step added, and the containers that read them would find
# them empty.
# shellcheck disable=SC2086
as_user git -C "$root" sparse-checkout add deploy $paths
if [ -n "$ref" ] && [ "$(as_user git -C "$root" rev-parse HEAD)" != "$ref" ]; then
	as_user git -C "$root" fetch --quiet --depth 1 origin "$ref"
	as_user git -C "$root" checkout --quiet --detach "$ref"
fi
echo "$root is at $(as_user git -C "$root" rev-parse --short HEAD)"

say "Docker networks"
docker network inspect ni-edge >/dev/null 2>&1 ||
	docker network create --subnet 172.30.0.0/24 --ip-range 172.30.0.128/25 ni-edge >/dev/null
docker network inspect ni-supabase-edge >/dev/null 2>&1 ||
	docker network create ni-supabase-edge >/dev/null
# Caddy and LiveKit only (deploy/livekit). An ordinary bridge, not internal:
# LiveKit's way out (STUN, its webhooks) is through it.
docker network inspect ni-livekit-edge >/dev/null 2>&1 ||
	docker network create ni-livekit-edge >/dev/null
docker network ls --format '{{.Name}}' | grep '^ni-' | sed 's/^/  /'

say "Done"
echo "No container was started and no settings file was written."
echo "Reboot needed: $([ -f /var/run/reboot-required ] && echo yes || echo no)"
}

main "$@" </dev/null
