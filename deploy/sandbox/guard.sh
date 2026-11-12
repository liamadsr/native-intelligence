#!/bin/sh
# The sandbox server's guard: three rules of this server's own, in a firewall
# table of their own that neither ufw, Docker nor a flush of the usual tables
# touches (deploy/sandbox/README.md, "The guard").
#
# 1. Nothing on this machine may connect to one of this machine's own
#    addresses, except IPv4 loopback.
#
#    Why. The sandbox runtime sends every sandbox's outgoing connections
#    through a proxy that runs on this machine, as this machine. The proxy
#    refuses private and loopback addresses by itself, but not this machine's
#    public address: asked for that one, it connects to itself. That reaches
#    the runtime's own ports, among them a control port that asks for no
#    password (it creates and kills any sandbox), and SSH. Rules about what
#    comes in do not stop it, because the connection never comes in from
#    outside. The runtime's parts talk to each other over IPv4 loopback only,
#    so this is not in their way; IPv6 loopback is refused too, since nothing
#    here needs it and the runtime's ports answer on it.
#
#    It runs before Docker's own address rewriting, so a port a container
#    publishes on this machine's address is covered as well.
#
# 2. The runtime's ports take connections from this machine itself and, on
#    the six ports of its proxy, from the sandboxes' own range. Everything
#    else is dropped, whatever ufw says: ufw does the same, and this holds
#    when ufw is off.
#
# 3. Nothing that comes from a sandbox is passed on to a private address.
#
#    Why. A sandbox's connection to a port that a container publishes on this
#    machine never reaches the proxy: Docker rewrites its address first and
#    the machine passes it straight on to the container. The same goes for
#    anything that is not TCP, which the runtime passes on without its proxy.
#    Containers, other sandboxes and, later, the tunnel to the app's server
#    all have private addresses; the internet does not.
#
#   guard.sh apply     load the table, replacing an older copy in one step
#   guard.sh check     exit 0 only when the table is loaded exactly as apply left it
#   guard.sh ensure    check, and apply when the check fails (the timer's job)
#   guard.sh forget    empty the note of refused connections (check.py, before its tries)
#   guard.sh refused   that note, as JSON: every address and port rule 1 refused since
set -eu

table=ni_sandbox_guard
# The rules "apply" loaded, without their counters: "check" compares the live rules with them.
expected=/run/ni-sandbox-guard.expected
private='{ 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 }'

# The three chains, rule by rule. Not the whole table: that would include the
# note's contents, which change with every refusal.
listing() {
	for chain in outbound inbound forward; do
		nft -s list chain inet "$table" "$chain" 2>/dev/null || return 1
	done
}

load() {
	# "table" first so that "delete" has something to delete the first time;
	# the whole file is one transaction, so there is no moment without the rules.
	nft -f - <<EOF
table inet $table
delete table inet $table
table inet $table {
	# Which of this machine's addresses and ports rule 1 refused, for check.py:
	# a count of packets cannot tell one try from another, this can.
	set refused4 {
		type ipv4_addr . inet_service
		size 65535
		flags dynamic,timeout
		timeout 15m
	}
	chain outbound {
		type filter hook output priority -150; policy accept;
		# A refusal answers with an error message, and on this machine that
		# message is itself addressed to one of this machine's addresses. Let it
		# through: refused again, it would never arrive, and the caller would
		# wait out its timeout instead of hearing "refused" at once.
		icmp type destination-unreachable accept
		icmpv6 type destination-unreachable accept
		# Noted, then refused. When the note is full this rule stops matching,
		# and the next one, which notes nothing, refuses all the same.
		meta l4proto tcp fib daddr type local ip daddr != 127.0.0.0/8 update @refused4 { ip daddr . tcp dport } counter reject comment "own-address-v4-noted"
		fib daddr type local ip daddr != 127.0.0.0/8 counter reject comment "own-address-v4"
		meta nfproto ipv6 fib daddr type local counter reject comment "own-address-v6"
	}
	chain inbound {
		type filter hook input priority -150; policy accept;
		iifname "lo" accept
		ct state established,related accept
		ip saddr 10.11.0.0/16 tcp dport { 5010-5012, 5016-5018 } accept
		tcp dport { 3000-3003, 5007-5012, 5016-5018, 5109 } counter drop comment "runtime-ports"
	}
	chain forward {
		type filter hook forward priority -150; policy accept;
		# By the link a sandbox's traffic comes in on, and by the address the
		# runtime gives it: either alone would miss a renamed link or a forged address.
		iifname "e2b-*" ip daddr $private counter drop comment "sandbox-link-to-private"
		ip saddr 10.11.0.0/16 ip daddr $private counter drop comment "sandbox-range-to-private"
		iifname "e2b-*" meta nfproto ipv6 counter drop comment "sandbox-ipv6"
	}
}
EOF
	(umask 077 && listing >"$expected.new") && mv -f "$expected.new" "$expected"
}

# Loaded, and the same as what apply loaded: a table that is there but was
# changed since (a rule put in front, a chain moved) does not count.
loaded() {
	[ -s "$expected" ] || return 1
	[ "$(listing)" = "$(cat "$expected")" ]
}

case "${1:-}" in
apply)
	load
	;;
check)
	if loaded; then
		echo "guard: loaded (this machine's own addresses refused, the runtime's ports closed to the outside, nothing passed on from a sandbox to a private address)"
	else
		echo "guard: NOT loaded, or not as it was loaded" >&2
		exit 1
	fi
	;;
ensure)
	if ! loaded; then
		load
		echo "guard: was missing or changed, loaded again"
	fi
	;;
forget)
	nft flush set inet "$table" refused4
	;;
refused)
	nft -j list set inet "$table" refused4
	;;
*)
	echo "usage: guard.sh apply | check | ensure | forget | refused" >&2
	exit 2
	;;
esac
