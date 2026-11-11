#!/usr/bin/env bash
# Checks the sandbox server from the inside: the guard, the firewall, the
# runtime, the memory set aside for sandboxes, and, from inside a real
# sandbox, that this machine cannot be reached. It changes nothing except
# for the one sandbox it starts and removes.
#
#   sudo ./check.sh
#
# What it cannot see is the server from outside. From another machine, only
# SSH may answer: deploy/sandbox/README.md, "Checks", has that one line.
set -uo pipefail

runtime_dir=/opt/e2b
settings=/etc/ni-sandbox/runtime.env
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
failed=0
ok() { echo "ok    $*"; }
bad() { echo "FAIL  $*"; failed=1; }

[ "$(id -u)" = 0 ] || { echo "check: run it with sudo." >&2; exit 2; }

# 1. The guard.
if out="$(/usr/local/sbin/ni-sandbox-guard check 2>&1)"; then ok "$out"; else bad "$out"; fi
systemctl is-enabled --quiet ni-sandbox-guard.service && systemctl is-active --quiet ni-sandbox-guard-keep.timer &&
	ok "the guard is applied at boot and looked at every minute" || bad "the guard's units are not enabled (run setup.sh)"
[ -e /etc/systemd/system/docker.service.requires/ni-sandbox-guard.service ] &&
	ok "Docker does not start without the guard" || bad "Docker can start without the guard (run setup.sh)"

# 2. The firewall: nothing comes in but SSH and the sandboxes' own range.
status="$(ufw status verbose 2>/dev/null)"
echo "$status" | grep -q '^Status: active' && echo "$status" | grep -q 'deny (incoming)' &&
	ok "the firewall is on and refuses what comes in" || bad "the firewall is off, or lets things in by default"
open="$(echo "$status" | awk '/^To/ { rules = 1; next } rules && NF && !/^--/' | grep -v -E '^[0-9]+/tcp( \(v6\))? +LIMIT IN +Anywhere' | grep -v -E '^5010,5011,5012,5016,5017,5018/tcp +ALLOW IN +10\.11\.0\.0/16' || true)"
if [ -z "$open" ]; then ok "it opens SSH and the sandboxes' way out, nothing else"; else bad "the firewall opens more than SSH and the sandboxes' way out:"; echo "$open" | sed 's/^/        /'; fi

# 3. The runtime.
if [ -f "$runtime_dir/compose.yaml" ]; then
	states="$(cd "$runtime_dir" && docker compose ps --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null)"
	if echo "$states" | grep -q '^ready running' && ! echo "$states" | grep -q -E 'unhealthy|restarting|exited'; then
		ok "the runtime is up ($(echo "$states" | wc -l | tr -d ' ') services)"
	else
		bad "the runtime is not all up:"; echo "$states" | sed 's/^/        /'
	fi
	systemctl is-enabled --quiet ni-sandbox-runtime.service && ok "it starts after every boot" || bad "it does not start after a boot (run setup.sh)"
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
	# This machine's own addresses: every one that is not loopback, but of the
	# many the runtime gives its sandboxes' links, only the first two.
	addresses="$(ip -o addr show scope global | awk '$2 !~ /^e2b-/ { split($4, a, "/"); print a[1] }'; ip -o -4 addr show | awk '$2 ~ /^e2b-/ { split($4, a, "/"); print a[1] }' | head -2)"
	if (set -a && . "$runtime_dir/sdk.env" && set +a && "$runtime_dir/.venv/bin/python" "$here/check.py" $addresses); then
		ok "a sandbox cannot reach this machine, and can reach the internet"
	else
		bad "the check from inside a sandbox did not pass"
	fi
else
	bad "no client or key for the check from inside a sandbox (run setup.sh)"
fi

echo
[ "$failed" = 0 ] && echo "All checks passed." || echo "Some checks FAILED."
exit "$failed"
