#!/usr/bin/env bash
# The private link between the app's server and the sandbox server: a
# WireGuard tunnel with one address at each end. Through it the app reaches
# the sandbox runtime (its API on port 3000, the sandboxes' traffic on 3002).
# Nothing else passes, and nothing is opened the other way.
#
# One script for both ends. On each server, from the repository's checkout:
#
#   sudo ./tunnel.sh key
#       Makes this end's key pair if it has none, and prints its PUBLIC key
#       and nothing else. The private key stays in a file only root can read
#       and is never shown, here or by any other part of this script.
#
#   sudo ./tunnel.sh sandbox --peer-key <the app server's public key> --peer-address <the app server's public IPv4 address>
#       On the sandbox server.
#
#   sudo ./tunnel.sh app --peer-key <the sandbox server's public key> --endpoint <the sandbox server's public IPv4 address>
#       On the app's server.
#
#   sudo ./tunnel.sh status
#       What this end sees: the other end's public key, when they last spoke,
#       how much has passed. No private key.
#
# So: "key" on both, then "sandbox" there and "app" here, each with the other's
# public key. Every step is safe to run again, and a role run again with
# another key or address replaces the earlier one.
#
# Which end does what (deploy/sandbox/README.md, "The tunnel"):
# - The app's end dials out and listens on nothing. No port is opened on the
#   app's server, and its firewall is told to refuse whatever arrives through
#   the tunnel.
# - The sandbox end listens on one UDP port, opened to the app server's
#   address alone, and takes connections from the tunnel on ports 3000 and
#   3002 alone. Its guard refuses every connection the machine itself would
#   open into the tunnel, so a sandbox cannot use the machine to get at the
#   app's server.
set -eEuo pipefail

iface=ni-sandbox
app_address=10.200.77.1
sandbox_address=10.200.77.2
port=51820
key_file=/etc/wireguard/$iface.key
conf=/etc/wireguard/$iface.conf
guard=/usr/local/sbin/ni-sandbox-guard
# Read by the guard and by check.sh on the sandbox server.
tunnel_settings=/etc/ni-sandbox/tunnel.env

main() {
trap 'echo "tunnel: stopped by a failing command at line $LINENO." >&2' ERR
die() { echo "tunnel: $*" >&2; exit 1; }
say() { printf '\n== %s\n' "$*"; }

[ "$(id -u)" = 0 ] || die "run it with sudo."
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
action="${1:-}"
[ $# -gt 0 ] && shift
peer_key=""
peer_address=""
endpoint=""
while [ $# -gt 0 ]; do
	case "$1" in
	--peer-key) peer_key="${2:?}"; shift 2 ;;
	--peer-address) peer_address="${2:?}"; shift 2 ;;
	--endpoint) endpoint="${2:?}"; shift 2 ;;
	*) die "unknown option: $1" ;;
	esac
done

is_key() { [[ "$1" =~ ^[A-Za-z0-9+/]{43}=$ ]]; }
is_ipv4() {
	[[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
	local part
	for part in "${BASH_REMATCH[@]:1}"; do [ "$part" -le 255 ] || return 1; done
}

tools() {
	command -v wg >/dev/null 2>&1 && command -v wg-quick >/dev/null 2>&1 && return 0
	export DEBIAN_FRONTEND=noninteractive
	apt-get -o DPkg::Lock::Timeout=600 update -qq
	apt-get -o DPkg::Lock::Timeout=600 install -y -qq wireguard-tools >/dev/null
}

# This end's private key, made once. Never on the screen, in an argument or in the settings file.
own_key() {
	install -d -m 700 -o root -g root /etc/wireguard
	if [ ! -s "$key_file" ]; then
		(umask 077 && wg genkey >"$key_file")
	fi
	chown root:root "$key_file"
	chmod 600 "$key_file"
}

# Writes the settings and (re)starts the tunnel when they changed. stdin: the settings.
bring_up() {
	local tmp
	tmp="$(mktemp)"
	cat >"$tmp"
	if [ -f "$conf" ] && cmp -s "$tmp" "$conf"; then
		rm -f "$tmp"
		systemctl enable wg-quick@$iface >/dev/null 2>&1
		systemctl is-active --quiet wg-quick@$iface || systemctl start wg-quick@$iface
		echo "unchanged"
	else
		install -m 600 -o root -g root "$tmp" "$conf"
		rm -f "$tmp"
		systemctl enable wg-quick@$iface >/dev/null 2>&1
		systemctl restart wg-quick@$iface
		echo "written, and the tunnel (re)started"
	fi
}

case "$action" in
key)
	tools
	own_key
	wg pubkey <"$key_file"
	;;

sandbox)
	[ -x "$guard" ] || die "this is not the sandbox server (no guard here). On the app's server the role is: app."
	is_key "$peer_key" || die "--peer-key takes the app server's public key (44 characters, as 'tunnel.sh key' prints it there)."
	is_ipv4 "$peer_address" || die "--peer-address takes the app server's public IPv4 address."
	firewall="$(ufw status)"
	case "$firewall" in "Status: active"*) ;; *) die "the firewall is off. Prepare the server first: deploy/server/setup.sh --role sandbox." ;; esac
	tools
	own_key

	say "Firewall: the tunnel's port, for the app server's address alone"
	# An earlier run for another address leaves its rule behind: take it out first.
	old=""
	[ ! -f "$tunnel_settings" ] || old="$(sed -n 's/^TUNNEL_PEER_PUBLIC=//p' "$tunnel_settings")"
	if [ -n "$old" ] && [ "$old" != "$peer_address" ] && is_ipv4 "$old"; then
		ufw delete allow from "$old" to any port "$port" proto udp >/dev/null 2>&1 || true
	fi
	ufw allow from "$peer_address" to any port "$port" proto udp comment 'Tunnel from the app server' >/dev/null
	# What may come out of the tunnel: the app's server, to the runtime's two ports.
	ufw allow in on "$iface" from "$app_address" to any port 3000,3002 proto tcp comment 'App server to the runtime' >/dev/null
	echo "set"

	say "The tunnel's settings"
	bring_up <<EOF
# Managed by deploy/sandbox/tunnel.sh in the native-intelligence repository.
[Interface]
Address = $sandbox_address/30
ListenPort = $port
PostUp = wg set %i private-key $key_file

[Peer]
PublicKey = $peer_key
AllowedIPs = $app_address/32
EOF

	say "The guard, told about the tunnel"
	# The guard beside this script, not whichever one was installed before: an
	# older one knows nothing of tunnels and would leave the two ports closed.
	[ -f "$here/guard.sh" ] || die "run it from the repository's checkout (guard.sh must be beside it)."
	install -m 755 -o root -g root "$here/guard.sh" "$guard"
	install -d -m 755 -o root -g root "$(dirname "$tunnel_settings")"
	cat >"$tunnel_settings.new" <<EOF
TUNNEL_IF=$iface
TUNNEL_PEER=$app_address
TUNNEL_PORT=$port
TUNNEL_PEER_PUBLIC=$peer_address
EOF
	chmod 644 "$tunnel_settings.new"
	mv -f "$tunnel_settings.new" "$tunnel_settings"
	"$guard" apply
	"$guard" check

	say "Done"
	echo "This end's public key, for the app's server:"
	wg pubkey <"$key_file"
	echo "Now run: sudo ./check.sh"
	;;

app)
	[ ! -x "$guard" ] || die "this is the sandbox server. Here the role is: sandbox."
	docker network inspect ni-edge >/dev/null 2>&1 || die "this does not look like the app's server (no ni-edge network)."
	is_key "$peer_key" || die "--peer-key takes the sandbox server's public key (44 characters, as 'tunnel.sh key' prints it there)."
	is_ipv4 "$endpoint" || die "--endpoint takes the sandbox server's public IPv4 address."
	firewall="$(ufw status verbose)"
	case "$firewall" in "Status: active"*) ;; *) die "the firewall is off here: not adding a tunnel to a server without one." ;; esac
	case "$firewall" in *"deny (incoming)"*) ;; *) die "the firewall does not refuse what comes in by default: not adding a tunnel to it." ;; esac
	tools
	own_key

	say "Firewall: nothing comes in through the tunnel"
	# First in line, so that a rule which opens a port to everyone does not open it to the tunnel.
	rules="$(ufw status)"
	case "$rules" in
	*"on $iface"*) ;;
	*) ufw insert 1 deny in on "$iface" comment 'Nothing in from the sandbox server' >/dev/null ;;
	esac
	echo "set"

	say "The tunnel's settings"
	bring_up <<EOF
# Managed by deploy/sandbox/tunnel.sh in the native-intelligence repository.
[Interface]
Address = $app_address/30
PostUp = wg set %i private-key $key_file

[Peer]
PublicKey = $peer_key
Endpoint = $endpoint:$port
AllowedIPs = $sandbox_address/32
PersistentKeepalive = 25
EOF

	say "Does the other end answer?"
	# The runtime's own health answer, through the tunnel. A few tries: the first handshake takes a moment.
	answered=no
	for _ in 1 2 3 4 5 6; do
		if curl -fsS -m 4 -o /dev/null "http://$sandbox_address:3000/health"; then answered=yes; break; fi
		sleep 2
	done
	if [ "$answered" = yes ]; then
		echo "yes: the sandbox runtime answers at http://$sandbox_address:3000"
	else
		echo "NOT yet. The tunnel is set up on this end; on the sandbox server, check that its 'sandbox' step was run with this end's public key and address:"
		wg pubkey <"$key_file"
		exit 1
	fi
	;;

status)
	command -v wg >/dev/null 2>&1 || die "no tunnel here."
	# "wg show" never prints a private key: it writes "(hidden)".
	wg show "$iface"
	;;

*)
	die "usage: tunnel.sh key | sandbox --peer-key <key> --peer-address <address> | app --peer-key <key> --endpoint <address> | status"
	;;
esac
}

main "$@" </dev/null
