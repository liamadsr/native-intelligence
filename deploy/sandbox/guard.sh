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
#   guard.sh apply    load the table, replacing an older copy in one step
#   guard.sh check    exit 0 only when all three rules are loaded
#   guard.sh ensure   check, and apply when the check fails (the timer's job)
#   guard.sh count    how many connections rule 1 has refused (IPv4) since it was loaded
set -eu

table=ni_sandbox_guard

load() {
	# "table" first so that "delete" has something to delete the first time;
	# the whole file is one transaction, so there is no moment without the rules.
	nft -f - <<EOF
table inet $table
delete table inet $table
table inet $table {
	chain outbound {
		type filter hook output priority -150; policy accept;
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
		iifname "e2b-*" ip daddr { 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 } counter drop comment "sandbox-to-private"
		iifname "e2b-*" meta nfproto ipv6 counter drop comment "sandbox-ipv6"
	}
}
EOF
}

loaded() {
	rules="$(nft list table inet "$table" 2>/dev/null)" || return 1
	# The listing may name the priority instead of printing its number, so it is not matched.
	for want in 'hook output' 'own-address-v4' 'own-address-v6' 'hook input' 'runtime-ports' 'hook forward' 'sandbox-to-private' 'sandbox-ipv6'; do
		case "$rules" in *"$want"*) ;; *) return 1 ;; esac
	done
}

case "${1:-}" in
apply)
	load
	;;
check)
	if loaded; then
		echo "guard: loaded (this machine's own addresses refused, the runtime's ports closed to the outside, nothing passed on from a sandbox to a private address)"
	else
		echo "guard: NOT loaded" >&2
		exit 1
	fi
	;;
ensure)
	if ! loaded; then
		load
		echo "guard: was missing, loaded again"
	fi
	;;
count)
	nft list chain inet "$table" outbound | sed -n 's/.*counter packets \([0-9][0-9]*\) .*own-address-v4.*/\1/p'
	;;
*)
	echo "usage: guard.sh apply | check | ensure | count" >&2
	exit 2
	;;
esac
