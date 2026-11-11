#!/bin/sh
# The sandbox server's guard: nothing on this machine may connect to one of
# this machine's own outward addresses.
#
# Why. The sandbox runtime sends every sandbox's outgoing connections through
# a proxy that runs on this machine, as this machine. The proxy refuses
# private and loopback addresses by itself, but not this machine's public
# address: asked for that one, it connects to itself. That reaches the
# runtime's own ports, among them a control port that asks for no password
# (it creates and kills any sandbox), and SSH. The firewall's inbound rules do
# not stop it, because the connection never comes in from outside.
#
# One rule stops it: a connection made on this machine to one of this
# machine's own addresses is refused, unless that address is loopback. The
# runtime's parts talk to each other over loopback only, so nothing of theirs
# is in its way (deploy/sandbox/README.md, "The guard").
#
#   guard.sh apply   put the rule first in line, for IPv4 and IPv6 (safe to repeat)
#   guard.sh check   exit 0 only when the rule is in force and first in line
set -eu

mark=ni-sandbox-guard

# $1 is iptables or ip6tables, $2 that family's loopback range.
first_is_ours() {
	"$1" -w -S OUTPUT | sed -n 2p | grep -q -- "--comment $mark" || return 1
	"$1" -w -S OUTPUT | sed -n 2p | grep -q -- "! -d $2 .*--dst-type LOCAL.* -j REJECT"
}

apply() {
	if ! first_is_ours "$1" "$2"; then
		"$1" -w -I OUTPUT 1 -m addrtype --dst-type LOCAL ! -d "$2" -m comment --comment "$mark" -j REJECT
		echo "guard: rule put first in $1's OUTPUT chain"
	fi
	# Copies further down, last first so the line numbers stay true.
	for n in $("$1" -w -L OUTPUT -n --line-numbers | awk -v mark="$mark" 'index($0, mark) && $1 > 1 { print $1 }' | sort -rn); do
		"$1" -w -D OUTPUT "$n"
	done
}

case "${1:-}" in
apply)
	apply iptables 127.0.0.0/8
	apply ip6tables ::1/128
	;;
check)
	ok=0
	first_is_ours iptables 127.0.0.0/8 || { echo "guard: NOT in force for IPv4" >&2; ok=1; }
	first_is_ours ip6tables ::1/128 || { echo "guard: NOT in force for IPv6" >&2; ok=1; }
	[ "$ok" = 0 ] && echo "guard: in force, first in line, for IPv4 and IPv6"
	exit "$ok"
	;;
*)
	echo "usage: guard.sh apply | check" >&2
	exit 2
	;;
esac
