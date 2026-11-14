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
# With the tunnel to the app's server set up (tunnel.sh writes the settings
# read below), three more lines: the app's server may reach the runtime's API
# and the sandboxes' traffic port through the tunnel; this machine opens no
# connection into the tunnel; and nothing is passed on into it. The app's
# server reaches in, and nothing here reaches out.
#
# With the sandboxes' resolver set up (resolver.sh writes the setting read
# below): a sandbox's lookups for the one resolver the runtime gives it go to
# the resolver on this machine, and nothing else from a sandbox reaches that
# address.
#
#   guard.sh apply     load the table, replacing an older copy in one step
#   guard.sh check     exit 0 only when the table is loaded exactly as apply left it
#   guard.sh ensure    check, and apply when the check fails (the timer's job)
#   guard.sh forget    empty the note of refused connections (check.py, before its tries)
#   guard.sh refused   that note, as JSON: every address and port rule 1 refused since
#   guard.sh render    print what apply would load, and load nothing (the tests, and
#                      "guard.sh render | nft -c -f -" to try a change before it is loaded)
set -eu

# Where the tunnel's and the resolver's settings are read. Only "render" takes
# another folder, for the tests: what is loaded always comes from this one.
settings_dir=/etc/ni-sandbox
if [ "${1:-}" = render ] && [ -n "${NI_SANDBOX_SETTINGS_DIR:-}" ]; then
	settings_dir="$NI_SANDBOX_SETTINGS_DIR"
fi

table=ni_sandbox_guard
# The rules "apply" loaded, without their counters: "check" compares the live rules with them.
expected=/run/ni-sandbox-guard.expected
private='{ 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 }'

# The tunnel, when there is one. The two values go into firewall rules, so
# they are taken only in the shape they must have.
tunnel_settings=$settings_dir/tunnel.env
tunnel_in=""
tunnel_out=""
tunnel_forward=""
if [ -r "$tunnel_settings" ]; then
	tunnel_if="$(sed -n 's/^TUNNEL_IF=\([a-z0-9-]\{1,15\}\)$/\1/p' "$tunnel_settings")"
	tunnel_peer="$(sed -n 's/^TUNNEL_PEER=\([0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}\)$/\1/p' "$tunnel_settings")"
	if [ -z "$tunnel_if" ] || [ -z "$tunnel_peer" ]; then
		echo "guard: $tunnel_settings is there but does not name a tunnel and its other end" >&2
		exit 1
	fi
	tunnel_in="iifname \"$tunnel_if\" ip saddr $tunnel_peer tcp dport { 3000, 3002 } accept comment \"from-the-tunnel\""
	# Everything that does not answer the app's own call, not only what counts
	# as a new connection. Noted first, like rule 1, so that check.sh can ask
	# whether one particular try was refused; the second line refuses what the
	# first cannot note.
	tunnel_out="oifname \"$tunnel_if\" meta l4proto tcp ct state != { established, related } update @refused4 { ip daddr . tcp dport } counter reject comment \"into-the-tunnel-noted\"
		oifname \"$tunnel_if\" ct state != { established, related } counter reject comment \"into-the-tunnel\""
	tunnel_forward="oifname \"$tunnel_if\" counter drop comment \"passed-on-into-the-tunnel\""
fi

# The resolver, when there is one (README, "The resolver").
#
# The runtime opens one resolver's address, on every port, to a sandbox whose
# network is narrowed to a list of names. Lookups (UDP) are passed on by this
# machine from the sandbox's link: those are sent to our resolver, and anything
# else passed on to that address is dropped. Everything over TCP leaves as this
# machine instead, through the runtime's proxy: that is refused. The proxy's
# connections cannot be told from this machine's own, so this machine too
# loses that address over TCP. Nothing here uses it, and our resolver asks the
# internet's name servers, never another resolver.
#
# Lookups over TCP are refused with the rest, not sent to our resolver: its
# answer to this machine would be addressed to this machine's own address,
# which rule 1 refuses. The allowed names' answers fit in a datagram.
sandbox_resolver=8.8.8.8
resolver_settings=$settings_dir/resolver.env
resolver_port=""
resolver_out=""
resolver_in=""
resolver_forward=""
resolver_chains=""
resolver_names=""
if [ -r "$resolver_settings" ]; then
	resolver_port="$(sed -n 's/^RESOLVER_PORT=\([0-9]\{4,5\}\)$/\1/p' "$resolver_settings")"
	if [ -z "$resolver_port" ]; then
		echo "guard: $resolver_settings is there but names no port" >&2
		exit 1
	fi
	resolver_out="ip daddr $sandbox_resolver meta l4proto tcp counter reject comment \"resolver-address-over-tcp\""
	# Only a lookup the guard itself redirected: a sandbox that addresses this
	# machine's port directly is dropped like anyone else.
	resolver_in="iifname \"e2b-*\" ip saddr 10.11.0.0/16 udp dport $resolver_port ct status dnat accept comment \"sandbox-lookups\"
		meta l4proto { tcp, udp } th dport $resolver_port counter drop comment \"resolver-port\""
	resolver_forward="iifname \"e2b-*\" ip daddr $sandbox_resolver counter drop comment \"sandbox-link-to-resolver-address\"
		ip saddr 10.11.0.0/16 ip daddr $sandbox_resolver counter drop comment \"sandbox-range-to-resolver-address\""
	resolver_chains="chain resolver_lookups {
		type nat hook prerouting priority -100; policy accept;
		iifname \"e2b-*\" ip daddr $sandbox_resolver udp dport 53 counter redirect to :$resolver_port comment \"sandbox-link-lookups\"
		ip saddr 10.11.0.0/16 ip daddr $sandbox_resolver udp dport 53 counter redirect to :$resolver_port comment \"sandbox-range-lookups\"
	}"
	resolver_names="resolver_lookups"
fi

# The chains, rule by rule. Not the whole table: that would include the
# note's contents, which change with every refusal.
listing() {
	for chain in outbound inbound forward $resolver_names; do
		nft -s list chain inet "$table" "$chain" 2>/dev/null || return 1
	done
}

rules() {
	cat <<EOF
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
		$tunnel_out
		$resolver_out
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
		$tunnel_in
		$resolver_in
		tcp dport { 3000-3003, 5007-5012, 5016-5018, 5109 } counter drop comment "runtime-ports"
	}
	chain forward {
		type filter hook forward priority -150; policy accept;
		# By the link a sandbox's traffic comes in on, and by the address the
		# runtime gives it: either alone would miss a renamed link or a forged address.
		iifname "e2b-*" ip daddr $private counter drop comment "sandbox-link-to-private"
		ip saddr 10.11.0.0/16 ip daddr $private counter drop comment "sandbox-range-to-private"
		iifname "e2b-*" meta nfproto ipv6 counter drop comment "sandbox-ipv6"
		$tunnel_forward
		$resolver_forward
	}
	$resolver_chains
}
EOF
}

load() {
	# "table" first so that "delete" has something to delete the first time;
	# the whole file is one transaction, so there is no moment without the rules.
	rules | nft -f -
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
		echo "guard: loaded (this machine's own addresses refused, the runtime's ports closed to the outside, nothing passed on from a sandbox to a private address${resolver_port:+, the sandboxes' lookups sent to this machine's resolver})"
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
render)
	rules
	;;
*)
	echo "usage: guard.sh apply | check | ensure | forget | refused | render" >&2
	exit 2
	;;
esac
