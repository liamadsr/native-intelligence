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
#   sudo ./tunnel.sh check
#       On the app's server: that nothing can come in through the tunnel, and
#       that the runtime answers through it. Changes nothing. (On the sandbox
#       server, check.sh covers the tunnel.)
#
# So: "key" on both, then "sandbox" there and "app" here, each with the other's
# public key. Every step is safe to run again, and a role run again with
# another key or address replaces the earlier one.
#
# Which end does what (deploy/sandbox/README.md, "The tunnel"):
# - The app's end dials out. No port is opened on the app's server, and
#   whatever arrives through the tunnel that is not an answer to the app's own
#   call is dropped, before anything else on the server looks at it: before
#   the firewall, and before Docker, which would otherwise hand a connection
#   for a published port (the web's two, the calls' two) straight to its
#   container without the firewall seeing it.
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
# The app's end only: its own small firewall table for what comes out of the tunnel.
app_table=ni_sandbox_tunnel
app_rules=/etc/wireguard/$iface.nft
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

# A WireGuard key: 44 characters of base64 for exactly 32 bytes, written the
# one way those bytes are written (WireGuard refuses any other spelling, and
# would do so only after the settings were in place).
is_key() {
	[[ "$1" =~ ^[A-Za-z0-9+/]{43}=$ ]] || return 1
	local again
	again="$(printf '%s' "$1" | base64 -d 2>/dev/null | base64 -w 0 2>/dev/null || true)"
	[ "$again" = "$1" ]
}
is_ipv4() {
	[[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
	local part
	for part in "${BASH_REMATCH[@]:1}"; do [ "$part" -le 255 ] || return 1; done
}

tools() {
	command -v wg >/dev/null 2>&1 && command -v wg-quick >/dev/null 2>&1 && command -v nft >/dev/null 2>&1 && return 0
	export DEBIAN_FRONTEND=noninteractive
	# After an install the system may restart services that wait for one. Not
	# here: this runs on the app's server too, and a small package must not
	# turn into restarts there.
	export NEEDRESTART_SUSPEND=1
	# With time limits: a package server that is down must end in an error
	# here, not in a wait of many minutes (that happened on the app's server).
	local get=(apt-get -o DPkg::Lock::Timeout=600 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o Acquire::Retries=1)
	# The package list is fetched only when this machine does not know the
	# two packages yet: fetching it asks every package server the machine has.
	apt-cache show wireguard-tools nftables >/dev/null 2>&1 || "${get[@]}" update -qq
	"${get[@]}" install -y -qq wireguard-tools nftables >/dev/null ||
		die "could not install wireguard-tools. If a package server is down, see \"When a package server is down\" in deploy/sandbox/README.md."
}

# Removes every firewall rule whose line in the numbered list matches, by its
# number: a rule named by its words is not found again once its comment differs.
ufw_remove() {
	local n
	# "#" between the parts: the pattern holds a slash (51820/udp) and a bar.
	while n="$(ufw status numbered | sed -n -E "s#^\\[ *([0-9]+)\\] +$1.*#\\1#p" | sed -n 1p)" && [ -n "$n" ]; do
		ufw --force delete "$n" >/dev/null
	done
}

# The app's end: is everything that arrives through the tunnel dropped, unless it answers the app's own call?
app_closed() {
	local rules
	rules="$(nft list table inet "$app_table" 2>/dev/null)" || return 1
	case "$rules" in *"hook prerouting"*"iifname \"$iface\" ct state established,related accept"*"iifname \"$iface\" counter"*"drop"*) return 0 ;; esac
	return 1
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

	say "The guard, told about the tunnel"
	# Before the tunnel comes up, so that there is no moment in which this
	# machine could open a connection into it. And the guard beside this
	# script, not whichever one was installed before: an older one knows
	# nothing of tunnels and would leave the two ports closed.
	[ -f "$here/guard.sh" ] || die "run it from the repository's checkout (guard.sh must be beside it)."
	old=""
	[ ! -f "$tunnel_settings" ] || old="$(sed -n 's/^TUNNEL_PEER_PUBLIC=//p' "$tunnel_settings")"
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

	say "Firewall: the tunnel's port, for the app server's address alone"
	# An earlier run for another address leaves its rule behind: take it out first.
	if [ -n "$old" ] && [ "$old" != "$peer_address" ] && is_ipv4 "$old"; then
		ufw_remove "$port/udp +ALLOW IN +${old//./\\.}( |\$)"
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

	say "Nothing comes in through the tunnel"
	# A table of this tunnel's own, loaded before the tunnel exists and again
	# each time it comes up. It runs ahead of the firewall and ahead of Docker's
	# address rewriting: Docker hands a connection for a published port straight
	# to its container, and the firewall's rules for what comes in never see it.
	(umask 077 && cat >"$app_rules.new" <<EOF
table inet $app_table
delete table inet $app_table
table inet $app_table {
	chain from_tunnel {
		type filter hook prerouting priority -150; policy accept;
		iifname "$iface" ct state established,related accept
		iifname "$iface" counter drop
	}
}
EOF
	)
	mv -f "$app_rules.new" "$app_rules"
	nft -f "$app_rules"
	app_closed || die "the table that closes the tunnel's way in did not load: the tunnel is not brought up."
	# And the firewall's own rule, first in line, for whoever reads its list.
	first="$(ufw status numbered | sed -n -E 's/^\[ *1\] +//p')"
	case "$first" in
	"Anywhere on $iface"*"DENY IN"*) ;;
	*)
		ufw_remove "Anywhere( \\(v6\\))? on $iface +"
		ufw insert 1 deny in on "$iface" comment 'Nothing in from the sandbox server' >/dev/null
		;;
	esac
	echo "set"

	say "The tunnel's settings"
	bring_up <<EOF
# Managed by deploy/sandbox/tunnel.sh in the native-intelligence repository.
[Interface]
Address = $app_address/30
PreUp = nft -f $app_rules
PostUp = wg set %i private-key $key_file

[Peer]
PublicKey = $peer_key
Endpoint = $endpoint:$port
AllowedIPs = $sandbox_address/32
PersistentKeepalive = 25
EOF
	app_closed || die "the table that closes the tunnel's way in is gone after the tunnel came up."

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

check)
	[ ! -x "$guard" ] || die "this is the sandbox server: its check is check.sh."
	command -v wg >/dev/null 2>&1 || die "no tunnel here."
	failed=0
	if app_closed; then echo "ok    whatever arrives through the tunnel is dropped, unless it answers the app's own call"; else echo "FAIL  the table that closes the tunnel's way in is not loaded (sudo systemctl restart wg-quick@$iface)"; failed=1; fi
	first="$(ufw status numbered | sed -n -E 's/^\[ *1\] +//p')"
	case "$first" in "Anywhere on $iface"*"DENY IN"*) echo "ok    the firewall's first rule refuses what comes in through the tunnel" ;; *) echo "FAIL  the firewall's first rule is not the tunnel's"; failed=1 ;; esac
	if [ "$(wg show "$iface" allowed-ips 2>/dev/null | awk '{ print $2 }')" = "$sandbox_address/32" ]; then echo "ok    the tunnel carries the sandbox server's one address and no other"; else echo "FAIL  the tunnel is not set to the sandbox server's one address"; failed=1; fi
	if curl -fsS -m 6 -o /dev/null "http://$sandbox_address:3000/health"; then echo "ok    the sandbox runtime answers through the tunnel"; else echo "FAIL  the sandbox runtime does not answer through the tunnel"; failed=1; fi
	exit "$failed"
	;;

status)
	command -v wg >/dev/null 2>&1 || die "no tunnel here."
	# "wg show" never prints a private key: it writes "(hidden)".
	wg show "$iface"
	;;

*)
	die "usage: tunnel.sh key | sandbox --peer-key <key> --peer-address <address> | app --peer-key <key> --endpoint <address> | status | check"
	;;
esac
}

main "$@" </dev/null
