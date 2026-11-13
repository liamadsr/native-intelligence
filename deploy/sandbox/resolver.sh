#!/bin/sh
# The sandboxes' resolver: closes the gap a narrowed sandbox had at its
# resolver (deploy/sandbox/README.md, "The resolver").
#
# The runtime gives every sandbox one resolver, 8.8.8.8, and opens that
# address to a sandbox whose network is narrowed to a list of names, on every
# port. A program in such a sandbox could look up any name, and so pass data
# out through lookups. With this set up, the guard sends a sandbox's lookups
# for that address to a resolver on this machine that answers only for the
# names the narrowed levels allow, and refuses everything else a sandbox sends
# to that address (guard.sh).
#
# A sandbox with the open internet never asks that address: the coding agent's
# image lists two ordinary public resolvers (image.py, RESOLVERS), and the app
# points only a narrowed sandbox at the runtime's one
# (web/agents/coding-agent/lib/runtime-sandbox.ts, NARROWED_RESOLVER). So the
# image is built with its list first, and "install" looks before it switches
# anything: a sandbox from an older image would ask that address for every name.
#
#   resolver.sh conf <the app's host> [port]   print the resolver's settings (the tests read this)
#   sudo resolver.sh install <the app's host>  install it, start it, and have the guard use it
#   sudo resolver.sh check                     it runs, answers for an allowed name and refuses another
#   sudo resolver.sh remove                    take it away again: the guard's rules first, then the service
set -eu

port_default=5335
# The names the coding agent's narrowed levels allow, as zones: a zone answers
# for its name and for every name under it. The list itself is
# RESTRICTED_ALLOW_HOSTS in web/agents/coding-agent/sandbox.ts;
# deploy/sandbox/tests pins the two together. Every name under these is the
# service's own, so no lookup under them reaches a name server someone else runs.
zones="github.com githubusercontent.com registry.npmjs.org"

here="$(cd "$(dirname "$0")" && pwd)"
settings=/etc/ni-sandbox/resolver.env
conf_file=/etc/unbound/ni-sandbox-resolver.conf
unit=ni-sandbox-resolver.service
guard=/usr/local/sbin/ni-sandbox-guard
runtime_dir=/opt/e2b

host_ok() {
	printf '%s\n' "$1" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$'
}

conf() {
	cat <<EOF
# Written by deploy/sandbox/resolver.sh. Not edited by hand: run it again instead.
server:
	username: "unbound"
	chroot: ""
	directory: "/etc/unbound"
	pidfile: ""
	use-syslog: no
	logfile: ""
	verbosity: 1
	do-daemonize: no
	# Every address of this machine: a sandbox's lookup arrives at the address
	# of its own link, and each sandbox has a link of its own. The guard lets
	# only redirected lookups and this machine itself reach the port.
	interface: 0.0.0.0
	interface-automatic: yes
	port: $2
	do-ip6: no
	access-control: 0.0.0.0/0 allow
	hide-identity: yes
	hide-version: yes
	# It asks the internet's name servers itself: no other resolver to depend
	# on, and none whose address could be the one the guard redirects.
	module-config: "iterator"
	# Refused, at once: a narrowed sandbox has no other resolver to ask, so a
	# name outside its list fails without a wait.
	local-zone: "." refuse
EOF
	for zone in $zones "$1"; do
		printf '\tlocal-zone: "%s." transparent\n' "$zone"
	done
}

# One question to the resolver on loopback, over UDP or TCP: prints the
# answer's code and how many records it carries ("0 2": answered, two records;
# "5 0": refused).
ask() {
	python3 - "$1" "$2" "$3" <<'PY'
import socket, struct, sys
port, name, how = int(sys.argv[1]), sys.argv[2], sys.argv[3]
question = b"".join(bytes([len(p)]) + p.encode() for p in name.split(".")) + b"\0" + struct.pack(">HH", 1, 1)
query = struct.pack(">HHHHHH", 0x4E49, 0x0100, 1, 0, 0, 0) + question
try:
    if how == "tcp":
        with socket.create_connection(("127.0.0.1", port), timeout=4) as s:
            s.sendall(struct.pack(">H", len(query)) + query)
            head = s.recv(2)
            reply = s.recv(struct.unpack(">H", head)[0]) if len(head) == 2 else b""
    else:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(4)
            s.sendto(query, ("127.0.0.1", port))
            reply = s.recv(4096)
    flags, _, answers = struct.unpack(">HHH", reply[2:8])
    print(flags & 15, answers)
except Exception as error:
    print("none", type(error).__name__)
PY
}

answers() {
	port="$1"
	case "$(ask "$port" github.com udp)" in "0 "[1-9]*) ;; *) return 1 ;; esac
	case "$(ask "$port" github.com tcp)" in "0 "[1-9]*) ;; *) return 1 ;; esac
	[ "$(ask "$port" example.org udp)" = "5 0" ] || return 1
	[ "$(ask "$port" example.org tcp)" = "5 0" ] || return 1
}

need_root() {
	[ "$(id -u)" = 0 ] || { echo "resolver: run it with sudo." >&2; exit 2; }
}

install() {
	host="$1"
	[ -x "$guard" ] && grep -q 'resolver\.env' "$guard" || {
		echo "resolver: the guard on this server does not know the resolver yet: run setup.sh from this checkout first." >&2
		exit 1
	}
	# A sandbox from an image without its own list of resolvers asks the
	# runtime's one for every name, and would lose all but the allowed names:
	# the image first, and no sandbox from before it.
	if ! (set -a && . "$runtime_dir/sdk.env" && set +a && "$runtime_dir/.venv/bin/python" "$here/image.py" resolvers); then
		echo "resolver: the coding agent's image is not built with its list of resolvers, or a sandbox is running: nothing was changed (run setup.sh, wait until no sandbox runs)." >&2
		exit 1
	fi
	# The package's own unit would start a resolver of its own on port 53:
	# masked before the package arrives. Nothing else on this server is restarted.
	systemctl mask unbound.service >/dev/null 2>&1 || true
	NEEDRESTART_MODE=l DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y -qq unbound >/dev/null
	mkdir -p /etc/ni-sandbox /etc/unbound
	conf "$host" "$port_default" >"$conf_file.new"
	unbound-checkconf "$conf_file.new" >/dev/null
	mv -f "$conf_file.new" "$conf_file"
	cat >"/etc/systemd/system/$unit" <<EOF
[Unit]
Description=The sandboxes' resolver: answers only for the names a narrowed sandbox may reach
After=network-online.target
Wants=network-online.target

[Service]
ExecStartPre=/usr/sbin/unbound-checkconf $conf_file
ExecStart=/usr/sbin/unbound -d -p -c $conf_file
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
	systemctl daemon-reload
	systemctl enable "$unit" >/dev/null 2>&1
	systemctl restart "$unit"
	tries=0
	until answers "$port_default"; do
		tries=$((tries + 1))
		if [ "$tries" -ge 15 ]; then
			echo "resolver: it does not answer as it should on port $port_default: the guard was not told about it (journalctl -u $unit)." >&2
			exit 1
		fi
		sleep 1
	done
	ufw allow from 10.11.0.0/16 to any port "$port_default" proto udp comment 'Sandboxes to their resolver' >/dev/null
	# Only now: the guard sends the sandboxes' lookups here once this file is there.
	(umask 022 && printf 'RESOLVER_PORT=%s\nGATE_HOST=%s\n' "$port_default" "$host" >"$settings.new") && mv -f "$settings.new" "$settings"
	"$guard" apply
	check
}

check() {
	[ -r "$settings" ] || { echo "resolver: not set up on this server"; return 1; }
	port="$(sed -n 's/^RESOLVER_PORT=\([0-9]\{4,5\}\)$/\1/p' "$settings")"
	[ -n "$port" ] || { echo "resolver: $settings names no port" >&2; return 1; }
	systemctl is-active --quiet "$unit" || { echo "resolver: $unit is not running" >&2; return 1; }
	answers "$port" || { echo "resolver: it does not answer for an allowed name, or answers for another" >&2; return 1; }
	nft list chain inet ni_sandbox_guard resolver_lookups >/dev/null 2>&1 || { echo "resolver: the guard does not send the sandboxes' lookups to it (sudo ni-sandbox-guard apply)" >&2; return 1; }
	echo "resolver: runs, answers for the allowed names over UDP and TCP, refuses another name, and the guard sends the sandboxes' lookups to it"
}

remove() {
	# The guard's rules first: without them the sandboxes' lookups go to the
	# runtime's resolver again, as before.
	rm -f "$settings"
	"$guard" apply
	systemctl disable --now "$unit" >/dev/null 2>&1 || true
	rm -f "/etc/systemd/system/$unit" "$conf_file"
	systemctl daemon-reload
	ufw delete allow from 10.11.0.0/16 to any port "$port_default" proto udp >/dev/null 2>&1 || true
	echo "resolver: removed (the package stays, its own unit masked)"
}

case "${1:-}" in
conf)
	host_ok "${2:-}" || { echo "resolver: conf needs the app's host, as a plain name (app.example.com)" >&2; exit 2; }
	conf "$2" "${3:-$port_default}"
	;;
install)
	need_root
	host_ok "${2:-}" || { echo "resolver: install needs the app's host, as a plain name (app.example.com): the host of the app's git gate" >&2; exit 2; }
	install "$2"
	;;
check)
	need_root
	check
	;;
remove)
	need_root
	remove
	;;
*)
	echo "usage: resolver.sh conf <the app's host> [port] | install <the app's host> | check | remove" >&2
	exit 2
	;;
esac
