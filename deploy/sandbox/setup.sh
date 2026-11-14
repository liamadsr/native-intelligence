#!/usr/bin/env bash
# The sandbox server's own stack: E2B's open-source sandbox runtime (its
# single-machine package) and the firewall rules this server needs around it.
# Run it on a server that deploy/server/setup.sh --role sandbox has prepared,
# from the repository's checkout there. It is safe to run again: every step
# looks first and only changes what is missing.
#
#   cd /opt/native-intelligence/deploy/sandbox
#   sudo ./setup.sh [--pool-gib <n>] [--upgrade] [--with-browser]
#
# --pool-gib  how much memory sandboxes may use between them, in GiB. The
#             runtime reserves it when it starts and nothing else on the
#             machine can use it then. Default: what was set before, and half
#             the machine's memory the first time.
# --upgrade   replace an installed runtime by the one pinned below. This ends
#             every running sandbox.
# --with-browser  build the cloud browser's image too, now and on every later
#             run (the choice is kept in /etc/ni-sandbox/browser.enabled). Without
#             it, and until it is given once, nothing of the browser's image is
#             built or checked: the coding agent's is all, as before.
#
# What it sets up, in this order (deploy/sandbox/README.md explains each):
#   1. the guard, before anything that runs a sandbox;
#   2. the firewall rule that lets sandboxes reach the runtime's way out;
#   3. the runtime's two files, at the commit pinned here, checksums verified;
#   4. a unit that starts the runtime after every boot;
#   5. the client (requirements.txt, every file pinned by its hash) and the
#      key the checks use (check.sh);
#   6. the unit that pauses the running cloud browsers before the runtime stops
#      (pause_browsers.py);
#   7. the runtime's limits: how much disk a sandbox gets and how long it may live;
#   8. the images: the coding agent's, and the cloud browser's once asked for
#      (--with-browser; image.py). A failure of the browser's never stops the
#      coding agent's: it is built first, and the browser's after it.
#
# It handles one secret, the runtime's own API key, which the runtime makes on
# its first start: it is copied to a file only root can read and never shown.
set -eEuo pipefail

# The runtime's two files, as one pin: the commit they are fetched at and what
# they must hash to. To move to a newer runtime, change all three together.
RUNTIME_REF=a958dfe4be8e05d44f31f795479ec4ae16958a86
COMPOSE_SHA256=51b01f6ecc03035ea2d1f592a9a7c6f9090f61142c0fe64b993876440c19fac7
ENV_SHA256=4ecbbdcf42d0ae2abac6f8a530c990834fdea252e6efeed87af137282060ecf1
# The client the checks use.
SDK_VERSION=2.46.0
# The runtime's own limits, which it ships at 512 MiB and one hour. A coding
# run needs room for a repository and what it installs, and may outlast an
# hour: the app's own token for a run lives six.
LIMIT_DISK_MIB=16384
LIMIT_HOURS=6

runtime_dir=/opt/e2b
settings=/etc/ni-sandbox/runtime.env
limits=/etc/ni-sandbox/limits.env

main() {
trap 'echo "setup: stopped by a failing command at line $LINENO." >&2' ERR
pool_gib=""
upgrade=0
with_browser=0
while [ $# -gt 0 ]; do
	case "$1" in
	--pool-gib) pool_gib="${2:?}"; shift 2 ;;
	--upgrade) upgrade=1; shift ;;
	--with-browser) with_browser=1; shift ;;
	*) echo "Unknown option: $1" >&2; exit 2 ;;
	esac
done

die() { echo "setup: $*" >&2; exit 1; }
say() { printf '\n== %s\n' "$*"; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ "$(id -u)" = 0 ] || die "run it with sudo."
[ -f "$here/guard.sh" ] && [ -f "$here/requirements.txt" ] && [ -f "$here/image.py" ] && [ -f "$here/pause_browsers.py" ] || die "run it from the repository's checkout (guard.sh, requirements.txt, image.py and pause_browsers.py must be beside it)."
[ -c /dev/kvm ] || die "no /dev/kvm here. Prepare the server first: deploy/server/setup.sh --role sandbox."
command -v docker >/dev/null 2>&1 || die "Docker is missing. Prepare the server first: deploy/server/setup.sh --role sandbox."
# Read whole before it is looked at: a reader that leaves early closes the
# pipe on the writer, and with pipefail that counts as a failure.
firewall="$(ufw status)"
case "$firewall" in "Status: active"*) ;; *) die "the firewall is off. Prepare the server first: deploy/server/setup.sh --role sandbox." ;; esac
# Ports the app's stack publishes mean this is the app's server: sandboxes do not belong beside it.
if docker network inspect ni-edge >/dev/null 2>&1; then
	die "this looks like the app's server (it has the ni-edge network). The sandbox runtime goes on a server of its own."
fi

mem_gib=$(awk '/^MemTotal:/ { printf "%d", $2 / 1048576 }' /proc/meminfo)
# No size asked for: keep the one set before. Working it out afresh would
# quietly undo a size someone chose, on a run that was about something else.
if [ -z "$pool_gib" ] && [ -f "$settings" ]; then
	pages="$(sed -n 's/^HUGEPAGES=\([0-9][0-9]*\)$/\1/p' "$settings")"
	[ -z "$pages" ] || pool_gib=$((pages / 512))
fi
[ -n "$pool_gib" ] || pool_gib=$((mem_gib / 2))
case "$pool_gib" in '' | *[!0-9]*) die "--pool-gib takes a whole number of GiB." ;; esac
[ "$pool_gib" -ge 1 ] || die "--pool-gib must be at least 1."
[ "$pool_gib" -le $((mem_gib - 6)) ] || die "--pool-gib $pool_gib leaves under 6 GiB of this machine's $mem_gib for everything else."

export DEBIAN_FRONTEND=noninteractive

write_if_changed() {
	local path="$1" mode="${2:-644}" tmp
	tmp="$(mktemp)" || die "could not make a temporary file."
	cat >"$tmp" || die "could not write a temporary file for $path."
	if [ -f "$path" ] && cmp -s "$tmp" "$path"; then
		rm -f "$tmp"
		return 1
	fi
	install -m "$mode" -o root -g root "$tmp" "$path" || die "could not write $path."
	rm -f "$tmp"
	return 0
}

say "Packages the runtime expects"
apt-get -o DPkg::Lock::Timeout=600 update -qq
apt-get -o DPkg::Lock::Timeout=600 install -y -qq iptables nftables rsync e2fsprogs iproute2 python3-venv >/dev/null
echo "installed"

say "The guard"
install -m 755 -o root -g root "$here/guard.sh" /usr/local/sbin/ni-sandbox-guard
# Loaded early at boot, before Docker.
if write_if_changed /etc/systemd/system/ni-sandbox-guard.service <<'EOF'
[Unit]
Description=Sandbox server guard: load its firewall table
After=ufw.service
Before=docker.service ni-sandbox-runtime.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/ni-sandbox-guard apply

[Install]
WantedBy=multi-user.target
EOF
then
	# Drop whatever an older copy of this unit was linked to.
	systemctl daemon-reload
	systemctl reenable ni-sandbox-guard.service >/dev/null 2>&1
fi
# And loaded again by Docker itself every time it starts: when that fails,
# Docker does not start, so no container and no sandbox runs without the
# guard. A step of Docker's own start, not a unit Docker depends on:
# restarting a unit Docker depended on would restart Docker with it.
install -d -m 755 -o root -g root /etc/systemd/system/docker.service.d
write_if_changed /etc/systemd/system/docker.service.d/10-ni-sandbox-guard.conf <<'EOF' || true
[Unit]
After=ni-sandbox-guard.service

[Service]
ExecStartPre=/usr/local/sbin/ni-sandbox-guard apply
EOF
# Looked at every minute, and loaded again if something took it out.
write_if_changed /etc/systemd/system/ni-sandbox-guard-keep.service <<'EOF' || true
[Unit]
Description=Sandbox server guard: load it again if it is gone

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/ni-sandbox-guard ensure
EOF
write_if_changed /etc/systemd/system/ni-sandbox-guard-keep.timer <<'EOF' || true
[Unit]
Description=Sandbox server guard: looked at every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=5s

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable ni-sandbox-guard.service ni-sandbox-guard-keep.timer >/dev/null 2>&1
/usr/local/sbin/ni-sandbox-guard apply
systemctl start ni-sandbox-guard.service ni-sandbox-guard-keep.timer
/usr/local/sbin/ni-sandbox-guard check

say "Firewall: sandboxes to the runtime's way out"
# A sandbox's connections are turned to these ports on this machine, where the
# runtime's proxy decides what may leave. They arrive from the sandboxes' own
# address range and from nowhere else; the firewall refuses the same ports from outside.
ufw allow from 10.11.0.0/16 to any port 5010,5011,5012,5016,5017,5018 proto tcp comment 'Sandboxes to the runtime way out' >/dev/null
ufw status | grep -E '5010|Status' || true

say "The runtime's files, at ${RUNTIME_REF:0:12}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
base="https://raw.githubusercontent.com/e2b-dev/runtime/$RUNTIME_REF/embed/compose"
curl -fsSL --retry 3 -o "$tmp/compose.yaml" "$base/compose.yaml"
curl -fsSL --retry 3 -o "$tmp/.env" "$base/.env"
echo "$COMPOSE_SHA256  $tmp/compose.yaml" | sha256sum -c --quiet - || die "compose.yaml is not the pinned file."
echo "$ENV_SHA256  $tmp/.env" | sha256sum -c --quiet - || die ".env is not the pinned file."
install -d -m 755 -o root -g root "$runtime_dir"
changed=0
for f in compose.yaml .env; do
	if [ -f "$runtime_dir/$f" ] && ! cmp -s "$tmp/$f" "$runtime_dir/$f"; then
		[ "$upgrade" = 1 ] || die "$runtime_dir/$f is another version than the one pinned here. Run again with --upgrade to replace it: that ends every running sandbox."
		changed=1
	fi
	install -m 644 -o root -g root "$tmp/$f" "$runtime_dir/$f"
done
rm -rf "$tmp"
echo "in $runtime_dir, checksums verified"

say "Memory for sandboxes: $pool_gib of this machine's $mem_gib GiB"
install -d -m 755 -o root -g root "$(dirname "$settings")"
# The runtime counts in pages of 2 MiB.
settings_changed=0
write_if_changed "$settings" <<EOF && settings_changed=1
HUGEPAGES=$((pool_gib * 512))
EOF
cat "$settings"

say "Start, and start after every boot"
# The runtime's own guide asks for "up" once after each reboot: two of the
# changes it makes to the machine do not outlast one.
write_if_changed /etc/systemd/system/ni-sandbox-runtime.service <<EOF || true
[Unit]
Description=Sandbox runtime
Requires=docker.service
After=docker.service ni-sandbox-guard.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$runtime_dir
EnvironmentFile=$settings
ExecStartPre=/usr/local/sbin/ni-sandbox-guard check
ExecStartPre=/bin/sh -c 'ufw status | grep -q "^Status: active"'
ExecStart=/usr/bin/docker compose up -d --wait
TimeoutStartSec=1800

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable ni-sandbox-runtime.service >/dev/null 2>&1
if [ "$changed" = 1 ]; then
	(cd "$runtime_dir" && set -a && . "$settings" && set +a && docker compose pull --quiet)
fi
# Another version or another memory size replaces the runtime's containers, which
# ends every running sandbox: the cloud browsers are paused first, each after its
# own stop script (pause_browsers.py), so that their people stay signed in. Coding
# runs are not: they end, as before. Nothing to pause on the first run.
# --hold closes the runtime to the app first (pause_browsers.py, Hold), so that the
# live app cannot resume a browser between the last listing and the restart right
# below; nothing slow comes in between. The restart is followed by --release,
# whether it worked or not.
if { [ "$changed" = 1 ] || [ "$settings_changed" = 1 ]; } && [ -r "$runtime_dir/sdk.env" ] && [ -x "$runtime_dir/.venv/bin/python" ]; then
	"$runtime_dir/.venv/bin/python" -I "$here/pause_browsers.py" --hold ||
		echo "setup: not every cloud browser could be paused (above): those end with the runtime's restart." >&2
fi
# Runs "up": the first time it prepares the machine, fetches what it needs and
# builds the base image (a few minutes); later it only puts right what is not.
release_hold() { nft delete table inet ni_sandbox_hold >/dev/null 2>&1 || true; }
systemctl restart ni-sandbox-runtime.service || { release_hold; die "the runtime did not start again (above); it is open to the app again."; }
release_hold
(cd "$runtime_dir" && docker compose ps --format '  {{.Service}}: {{.Status}}')

say "The client and the key the checks use"
[ -x "$runtime_dir/.venv/bin/python" ] || python3 -m venv "$runtime_dir/.venv"
"$runtime_dir/.venv/bin/pip" install --quiet --disable-pip-version-check --require-hashes -r "$here/requirements.txt"
have="$("$runtime_dir/.venv/bin/python" -c 'import importlib.metadata as m; print(m.version("e2b"))')"
[ "$have" = "$SDK_VERSION" ] || die "requirements.txt holds client $have, not the $SDK_VERSION pinned here."
# The runtime's key, as it hands it out itself. Never on the screen.
(
	umask 077
	cd "$runtime_dir"
	docker compose exec -T ready cat /run/e2b/sdk.env >"$runtime_dir/sdk.env.new"
)
grep -q '^export E2B_API_KEY=' "$runtime_dir/sdk.env.new" || die "the runtime did not hand out its key."
mv -f "$runtime_dir/sdk.env.new" "$runtime_dir/sdk.env"
chown root:root "$runtime_dir/sdk.env"
chmod 600 "$runtime_dir/sdk.env"
echo "client $SDK_VERSION; the key is in $runtime_dir/sdk.env (root only)"

say "Running cloud browsers are paused before the runtime stops"
# Installed whether or not the browser's image is: with no browser running it
# lists the runtime's sandboxes once at a shutdown, finds none and is done.
# A restart of the runtime, or of the machine, ends every running sandbox and
# keeps the paused ones. This unit pauses each running cloud browser first,
# after its own stop script, when it is stopped: before Docker at every
# shutdown and reboot (it is ordered after Docker, so it stops before it), and
# whenever Docker is stopped or restarted (PartOf). Coding sandboxes are left
# alone. Its own time limit, and the unit's, keep a shutdown from waiting long.
install -d -m 755 -o root -g root /usr/local/lib/ni-sandbox
install -m 644 -o root -g root "$here/pause_browsers.py" /usr/local/lib/ni-sandbox/pause_browsers.py
write_if_changed /usr/local/sbin/ni-sandbox-pause-browsers 755 <<EOF || true
#!/bin/sh
# Installed by deploy/sandbox/setup.sh: pause every running cloud browser on
# this server, each after its own stop script (--list: only say how many run).
exec $runtime_dir/.venv/bin/python -I /usr/local/lib/ni-sandbox/pause_browsers.py "\$@"
EOF
if write_if_changed /etc/systemd/system/ni-sandbox-pause-browsers.service <<'EOF'
[Unit]
Description=Sandbox server: pause the running cloud browsers before the runtime stops
After=docker.service ni-sandbox-runtime.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
# Started after the runtime (at boot, and when Docker and the runtime come back
# from a restart): the runtime is opened to the app again, should a stop have
# left it closed (pause_browsers.py, Hold). "-": nothing to open is no failure.
ExecStart=-/usr/sbin/nft delete table inet ni_sandbox_hold
# Closes the runtime to the app, then pauses until a listing shows none running.
ExecStop=/usr/local/sbin/ni-sandbox-pause-browsers --hold
# pause_browsers.py gives itself 90 s in all.
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
EOF
then
	systemctl daemon-reload
fi
systemctl enable ni-sandbox-pause-browsers.service >/dev/null 2>&1
# Started, never restarted here: its stop is what pauses the browsers.
systemctl start ni-sandbox-pause-browsers.service
/usr/local/sbin/ni-sandbox-pause-browsers --list ||
	echo "setup: the unit is in place, but the runtime could not be asked for its browsers just now: check.sh tries again." >&2

say "The runtime's limits: $((LIMIT_DISK_MIB / 1024)) GiB of disk for a sandbox, $LIMIT_HOURS hours at most"
# The runtime keeps them in one row of its own database, not in a settings
# file, and its API reads them when it starts. So: change the row, restart
# the API. That restart ends no sandbox; the part that runs them is another.
sql() { (cd "$runtime_dir" && docker compose exec -T postgres sh -c 'psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" -At -v ON_ERROR_STOP=1 -c "$1"' sh "$1"); }
# The disk is two values there: how much free disk an image is built with,
# and the most it may have. Raising one without the other changes nothing.
had="$(sql "select disk_mb || '|' || default_free_disk_size_mb || '|' || max_length_hours from public.default_limits")" ||
	die "the runtime's limits are not where this script knows them (public.default_limits). Did the pinned runtime change how it keeps them?"
if [ "$had" != "$LIMIT_DISK_MIB|$LIMIT_DISK_MIB|$LIMIT_HOURS" ]; then
	[ "$(printf '%s\n' "$had" | wc -l)" = 1 ] || die "the runtime's limits table has more than one row: not changed."
	sql "update public.default_limits set disk_mb = $LIMIT_DISK_MIB, default_free_disk_size_mb = $LIMIT_DISK_MIB, max_length_hours = $LIMIT_HOURS" >/dev/null
	(cd "$runtime_dir" && docker compose restart api >/dev/null 2>&1)
	tries=0
	until [ "$(cd "$runtime_dir" && docker compose ps api --format '{{.Health}}')" = healthy ]; do
		tries=$((tries + 1))
		[ "$tries" -le 60 ] || die "the runtime's API did not come back healthy after its restart."
		sleep 2
	done
	echo "set (they were $had: disk, free disk, hours), and the API restarted"
	# An image keeps the disk it was built with: one built under the old limit is built again.
	rm -f /etc/ni-sandbox/image.*
else
	echo "already set"
fi
write_if_changed "$limits" <<EOF || true
LIMIT_DISK_MIB=$LIMIT_DISK_MIB
LIMIT_HOURS=$LIMIT_HOURS
EOF

say "The coding agent's image"
# Built on this server, by the runtime itself, from the agent framework's own
# base image. The first build fetches that image (about 600 MB) and takes a
# few minutes; afterwards it is only built again when its definition changes.
(set -a && . "$runtime_dir/sdk.env" && set +a && "$runtime_dir/.venv/bin/python" "$here/image.py" build "$LIMIT_DISK_MIB" ni-coding-agent) ||
	die "the coding agent's image was not built."

# The cloud browser's image: opt-in (--with-browser), and kept current once
# asked for. The same way, from a Node image and the cloud browser's own
# scripts (web/scripts/cloud-browser/base). The first build fetches that image
# and Chrome and takes a few minutes, and its check holds a 4 GiB sandbox from
# the pool the coding agent shares for up to three minutes. Nothing uses it
# until the app's CLOUD_BROWSER_BACKEND is runtime (../README.md, "The cloud
# browser"). Its failure is said, and the run ends in an error, with
# everything above, the coding agent's image included, in place.
browser_enabled=/etc/ni-sandbox/browser.enabled
browser_failed=0
if [ "$with_browser" = 1 ] && [ ! -e "$browser_enabled" ]; then
	install -m 644 -o root -g root /dev/null "$browser_enabled"
fi
if [ -e "$browser_enabled" ]; then
	say "The cloud browser's image"
	(set -a && . "$runtime_dir/sdk.env" && set +a && "$runtime_dir/.venv/bin/python" "$here/image.py" build "$LIMIT_DISK_MIB" ni-cloud-browser) || browser_failed=1
else
	say "The cloud browser's image: not asked for (setup.sh --with-browser builds it)"
fi

say "Done"
if [ "$browser_failed" = 1 ]; then
	echo "setup: the cloud browser's image was not built (above). Everything else, the coding agent's image included, is in place." >&2
	exit 1
fi
echo "Now run: sudo ./check.sh"
}

main "$@" </dev/null
