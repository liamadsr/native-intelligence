#!/usr/bin/env bash
# Checks the sandbox server from the inside: the guard, the firewall, the
# runtime, the memory set aside for sandboxes, and, from inside a real
# sandbox, that this machine cannot be reached. It changes nothing except
# for the one sandbox it starts and removes.
#
#   sudo ./check.sh
#
# What it cannot see is the server from outside. From another machine, only
# SSH may answer: deploy/sandbox/README.md, "Checks", has those lines.
set -uo pipefail

runtime_dir=/opt/e2b
settings=/etc/ni-sandbox/runtime.env
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tunnel_settings=/etc/ni-sandbox/tunnel.env
failed=0
ok() { echo "ok    $*"; }
bad() { echo "FAIL  $*"; failed=1; }
note() { echo "note  $*"; }
# Runs a command and says whether it succeeded, without a pipeline in an "if".
passes() { "$@" >/dev/null 2>&1; }

[ "$(id -u)" = 0 ] || { echo "check: run it with sudo." >&2; exit 2; }

# This machine's own addresses that are not loopback and not one of the many
# the runtime gives its sandboxes' links.
own4="$(ip -o -4 addr show scope global | awk '$2 !~ /^e2b-/ { split($4, a, "/"); print a[1] }')"
own6="$(ip -o -6 addr show scope global | awk '$2 !~ /^e2b-/ { split($4, a, "/"); print a[1] }')"

# 1. The guard.
if out="$(/usr/local/sbin/ni-sandbox-guard check 2>&1)"; then ok "$out"; else bad "$out"; fi
if passes systemctl is-enabled ni-sandbox-guard.service && passes systemctl is-active ni-sandbox-guard-keep.timer; then
	ok "the guard is loaded at boot and looked at every minute"
else
	bad "the guard's units are not enabled (run setup.sh)"
fi
case "$(systemctl show docker.service -p ExecStartPre --value 2>/dev/null)" in
*ni-sandbox-guard*) ok "Docker loads the guard before it starts, and does not start without it" ;;
*) bad "Docker can start without the guard (run setup.sh)" ;;
esac
# Tried from this machine itself, both families: loopback must answer, or the
# refusals below would prove nothing.
if passes curl -fsS -m 4 http://127.0.0.1:3000/health; then
	reached=""
	for a in $own4; do passes curl -sS -m 4 -o /dev/null "http://$a:3000/health" && reached="$reached $a"; done
	for a in $own6; do passes curl -sS -m 4 -o /dev/null "http://[$a]:3000/health" && reached="$reached $a"; done
	passes curl -sS -m 4 -o /dev/null "http://[::1]:3000/health" && reached="$reached ::1"
	if [ -z "$reached" ]; then
		ok "from this machine, the runtime answers on loopback and on none of its own addresses ($(echo $own4 $own6 ::1 | wc -w | tr -d ' ') tried)"
	else
		bad "from this machine, the runtime answers on its own address:$reached"
	fi
else
	bad "the runtime does not answer on loopback, so the guard cannot be tried"
fi

# The guard knows a sandbox's link by its name. A link the runtime named the
# way it once did would slip past half of rule 3.
if ip -o link show | awk -F': ' '{ print $2 }' | grep -q -E '^veth-[0-9]'; then
	bad "the runtime made links named veth-<n>, which the guard does not know by name"
fi

# The tunnel to the app's server, when tunnel.sh has set one up here.
tunnel_if=""
tunnel_peer=""
tunnel_port=""
tunnel_public=""
if [ -r "$tunnel_settings" ]; then
	tunnel_if="$(sed -n 's/^TUNNEL_IF=//p' "$tunnel_settings")"
	tunnel_peer="$(sed -n 's/^TUNNEL_PEER=//p' "$tunnel_settings")"
	tunnel_port="$(sed -n 's/^TUNNEL_PORT=//p' "$tunnel_settings")"
	tunnel_public="$(sed -n 's/^TUNNEL_PEER_PUBLIC=//p' "$tunnel_settings")"
fi

# 2. The firewall: nothing comes in but SSH, the sandboxes' own range and, with a tunnel, its two rules.
status="$(ufw status verbose 2>/dev/null)"
if echo "$status" | grep -q '^Status: active' && echo "$status" | grep -q 'deny (incoming)'; then
	ok "the firewall is on and refuses what comes in"
else
	bad "the firewall is off, or lets things in by default"
fi
if [ "$(iptables -S INPUT 2>/dev/null | sed -n 1p)" = "-P INPUT DROP" ] && [ "$(ip6tables -S INPUT 2>/dev/null | sed -n 1p)" = "-P INPUT DROP" ]; then
	ok "it does so for IPv4 and for IPv6"
else
	bad "what comes in is not refused by default for both IPv4 and IPv6 (IPV6=yes in /etc/default/ufw?)"
fi
# The only rules that may be there: SSH's own ports, limited, and the sandboxes' way out.
ssh_ports="$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2 }' | paste -sd'|' -)"
open="$(echo "$status" | awk '/^To/ { rules = 1; next } rules && NF && !/^--/' |
	grep -v -E "^(${ssh_ports:-22})/tcp( \(v6\))? +LIMIT IN +Anywhere" |
	grep -v -E '^5010,5011,5012,5016,5017,5018/tcp +ALLOW IN +10\.11\.0\.0/16' || true)"
if [ -n "$tunnel_if" ]; then
	# The tunnel's port for the app server's address alone, and the runtime's two ports for what comes out of the tunnel.
	open="$(echo "$open" |
		grep -v -E "^${tunnel_port}/udp +ALLOW IN +${tunnel_public//./\\.}( |\$)" |
		grep -v -E "^3000,3002/tcp on ${tunnel_if} +ALLOW IN +${tunnel_peer//./\\.}( |\$)" || true)"
fi
if [ -z "$open" ]; then ok "its rules open SSH, the sandboxes' way out${tunnel_if:+ and the tunnel}, nothing else"; else bad "the firewall's rules open more than SSH, the sandboxes' way out${tunnel_if:+ and the tunnel}:"; echo "$open" | sed 's/^/        /'; fi
# Docker opens the ports its containers publish whatever ufw says, so those are looked at apart.
published="$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | tr ',' '\n' | grep -E -- '->' | grep -v -E '(^| )127\.0\.0\.1:' || true)"
if [ -z "$published" ]; then ok "no container publishes a port beyond loopback"; else bad "a container publishes a port beyond loopback (open to the internet, whatever the firewall says):"; echo "$published" | sed 's/^/        /'; fi

# The tunnel itself.
if [ -n "$tunnel_if" ]; then
	if passes ip link show "$tunnel_if" && [ "$(wg show "$tunnel_if" listen-port 2>/dev/null)" = "$tunnel_port" ]; then
		ok "the tunnel is up and listens on its port"
	else
		bad "the tunnel is set up but not up (sudo systemctl restart wg-quick@$tunnel_if)"
	fi
	last="$(wg show "$tunnel_if" latest-handshakes 2>/dev/null | awk '{ print $2 }' | sed -n 1p)"
	if [ -z "$last" ] || [ "$last" = 0 ]; then
		note "the app's server has not connected through the tunnel yet"
	elif [ $(($(date +%s) - last)) -le 180 ]; then
		ok "the app's server is connected through the tunnel"
	else
		bad "the app's server last spoke through the tunnel $((($(date +%s) - last) / 60)) minutes ago"
	fi
	# This machine opens nothing into the tunnel. The guard's own counter is the
	# proof: with the other end down the try would fail anyway.
	before="$(nft list chain inet ni_sandbox_guard outbound 2>/dev/null | sed -n 's/.*counter packets \([0-9][0-9]*\) .*into-the-tunnel.*/\1/p')"
	if passes curl -sS -m 4 -o /dev/null "http://$tunnel_peer:443/"; then
		bad "this machine can open a connection into the tunnel"
	else
		after="$(nft list chain inet ni_sandbox_guard outbound 2>/dev/null | sed -n 's/.*counter packets \([0-9][0-9]*\) .*into-the-tunnel.*/\1/p')"
		if [ -n "$before" ] && [ -n "$after" ] && [ "$after" -gt "$before" ]; then
			ok "this machine opens no connection into the tunnel: the guard refused the try"
		else
			bad "a try into the tunnel failed, but not because the guard refused it"
		fi
	fi
fi

# 3. The runtime: each of its lasting services, by name. The list belongs to
# the runtime version pinned in setup.sh.
if [ -f "$runtime_dir/compose.yaml" ]; then
	states="$(cd "$runtime_dir" && docker compose ps -a --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null)"
	down=""
	for service in api clickhouse client-proxy dashboard orchestrator postgres ready redis vector; do
		line="$(echo "$states" | awk -v s="$service" '$1 == s { print $2, $3 }')"
		case "$line" in "running " | "running" | "running healthy") ;; *) down="$down $service(${line:-missing})" ;; esac
	done
	if [ -z "$down" ]; then ok "the runtime's nine services are running, and healthy where they say"; else bad "the runtime is not all up:$down"; fi
	if passes systemctl is-enabled ni-sandbox-runtime.service; then ok "it starts after every boot"; else bad "it does not start after a boot (run setup.sh)"; fi
else
	bad "no runtime in $runtime_dir (run setup.sh)"
fi

# 4. The memory set aside for sandboxes.
want="$(sed -n 's/^HUGEPAGES=//p' "$settings" 2>/dev/null)"
have="$(awk '/^HugePages_Total:/ { print $2 }' /proc/meminfo)"
free="$(awk '/^HugePages_Free:/ { print $2 }' /proc/meminfo)"
if [ -n "$want" ] && [ "$have" = "$want" ]; then
	ok "$((have / 512)) GiB is set aside for sandboxes, $((free / 512)) GiB of it free"
else
	bad "memory for sandboxes: $settings asks for ${want:-nothing} pages, the machine has $have"
fi

# 5. From inside a sandbox.
if [ -r "$runtime_dir/sdk.env" ] && [ -x "$runtime_dir/.venv/bin/python" ]; then
	# With the first two of the runtime's link addresses, of which there are many.
	links="$(ip -o -4 addr show | awk '$2 ~ /^e2b-/ { split($4, a, "/"); print a[1] }' | sed -n 1,2p)"
	# And the app's server at the other end of the tunnel: out of a sandbox's reach as well.
	addresses="$(echo $own4 $links $tunnel_peer | tr ' ' ',')"
	# Every TCP port that listens here on more than loopback.
	ports="$(ss -Hltn | awk '{ print $4 }' | grep -v -E '^(127\.|\[::1\])' | sed -E 's/.*:([0-9]+)$/\1/' | sort -un | paste -sd, -)"
	if (set -a && . "$runtime_dir/sdk.env" && set +a && "$runtime_dir/.venv/bin/python" "$here/check.py" --addresses "$addresses" --ports "$ports"); then
		ok "a sandbox cannot reach this machine, and can reach the internet"
	else
		bad "the check from inside a sandbox did not pass"
	fi
else
	bad "no client or key for the check from inside a sandbox (run setup.sh)"
fi

echo
if [ "$failed" = 0 ]; then echo "All checks passed."; else echo "Some checks FAILED."; fi
exit "$failed"
