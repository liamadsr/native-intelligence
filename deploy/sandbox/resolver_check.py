"""From inside two sandboxes, what this server's resolver must and must not do.

Run by check.sh when resolver.sh has set the resolver up, as root, with the
runtime's key in the environment. It starts two sandboxes from the coding
agent's image and removes them: one narrowed to a single name and pointed at
the runtime's one resolver, the way the app starts the coding agent's
isolated level, and one with the open internet.

    resolver_check.py            both sandboxes, every line below
    resolver_check.py --image X  from another image (the trial before a switch)
"""
import re
import subprocess
import sys

ALL = "0.0.0.0/0"
# The one resolver the runtime opens to a narrowed sandbox (guard.sh), and what
# the app runs in such a sandbox first (web/agents/coding-agent/lib/runtime-sandbox.ts).
RESOLVER = "8.8.8.8"
POINT_AT_IT = f"printf 'nameserver {RESOLVER}\\n' > /etc/resolv.conf && grep -qx 'nameserver {RESOLVER}' /etc/resolv.conf && echo pointed"


def dropped() -> int:
    """How many packets the guard has dropped on their way from a sandbox to the resolver's address."""
    chain = subprocess.run(["nft", "list", "chain", "inet", "ni_sandbox_guard", "forward"], capture_output=True, text=True).stdout
    return sum(int(n) for n in re.findall(r"counter packets (\d+) bytes \d+ drop comment \"sandbox-(?:link|range)-to-resolver-address\"", chain))


def resolvers_door() -> str:
    """One of this machine's link addresses with the resolver's port, as a sandbox would address it directly."""
    port = re.search(r"^RESOLVER_PORT=(\d+)$", open("/etc/ni-sandbox/resolver.env").read(), re.M).group(1)
    links = subprocess.run("ip -o -4 addr show | awk '$2 ~ /^e2b-/ { split($4, a, \"/\"); print a[1]; exit }'", shell=True, capture_output=True, text=True).stdout.strip()
    return f"{links}:{port}" if links else ""
ALLOWED = ["github.com", "api.github.com", "raw.githubusercontent.com", "registry.npmjs.org"]
OTHER = "example.org"


def ask(server: str, name: str) -> str:
    """One question straight to a resolver, whatever the sandbox's own list says."""
    return (
        "node -e \"const {Resolver}=require('dns').promises;const r=new Resolver({timeout:2500,tries:1});"
        f"r.setServers(['{server}']);r.resolve4('{name}').then(a=>console.log('answered')).catch(e=>console.log(e.code))\""
    )


def tls(port: int) -> str:
    """Whether the resolver's address answers on a TCP port. A bare connection
    proves nothing here: the runtime's proxy takes every connection before it
    tries the far end. A handshake only the far end can complete does."""
    return (
        "python3 -c \"import socket,ssl;c=ssl.create_default_context();c.check_hostname=False;c.verify_mode=ssl.CERT_NONE;"
        f"s=c.wrap_socket(socket.create_connection(('{RESOLVER}',{port}),timeout=5));print('answers')\" 2>/dev/null || echo 'no answer'"
    )


def main() -> int:
    from e2b import Sandbox

    image = sys.argv[2] if len(sys.argv) > 2 and sys.argv[1] == "--image" else "ni-coding-agent"
    failed = []

    def want(what: str, got: str, wanted) -> None:
        good = got in wanted if isinstance(wanted, (list, tuple, set)) else got == wanted
        print(f"  {'ok  ' if good else 'FAIL'}  {what}: {got}")
        if not good:
            failed.append(what)

    def out(sandbox, command: str, timeout: int = 40, **how) -> str:
        try:
            return (sandbox.commands.run(command, timeout=timeout, **how).stdout or "").strip()
        except Exception as error:
            return ((getattr(error, "stdout", "") or "").strip() or f"exit {getattr(error, 'exit_code', '?')}")[:80]

    print("  a sandbox narrowed to one name:")
    narrowed = Sandbox.create(image, timeout=180, network={"deny_out": [ALL], "allow_out": ["github.com"]})
    try:
        want("the image's own resolvers are out of its reach", out(narrowed, ask("1.1.1.1", "github.com")), ["ETIMEOUT", "ECONNREFUSED"])
        want("it is pointed at the runtime's one resolver, as the app does", out(narrowed, POINT_AT_IT, user="root"), "pointed")
        for name in ALLOWED:
            want(f"it looks up {name}", out(narrowed, f"getent hosts {name} >/dev/null && echo resolves || echo fails"), "resolves")
        want(f"it cannot look up {OTHER}", out(narrowed, f"getent hosts {OTHER} >/dev/null && echo resolves || echo fails"), "fails")
        seconds = out(narrowed, f"s=$(date +%s%N); getent hosts {OTHER} >/dev/null; echo $(( ($(date +%s%N) - s) / 1000000 ))")
        want("and is told so within two seconds", "yes" if seconds.isdigit() and int(seconds) < 2000 else f"{seconds} ms", "yes")
        want(f"asked directly, its resolver refuses {OTHER}", out(narrowed, ask(RESOLVER, OTHER)), "EREFUSED")
        want("a long made-up name under another domain is refused too", out(narrowed, ask(RESOLVER, "a1b2c3d4e5f6.data.example.net")), "EREFUSED")
        for port in (443, 853):
            want(f"the resolver's address on TCP {port}", out(narrowed, tls(port)), "no answer")
        # Nothing answers a datagram on this port either way, so the guard's own count is the proof.
        before = dropped()
        out(narrowed, f"for i in 1 2 3; do echo x > /dev/udp/{RESOLVER}/443; done")
        want("datagrams to the resolver's address on another port are dropped by the guard", "yes" if dropped() >= before + 3 else f"{dropped() - before} of 3 counted", "yes")
        want("the name it is allowed still answers over https", out(narrowed, "curl -s -m 10 -o /dev/null -w '%{http_code}' https://github.com/"), ["200", "301", "302"])
    finally:
        narrowed.kill()

    print("  a sandbox with the open internet:")
    wide = Sandbox.create(image, timeout=180, allow_internet_access=True)
    try:
        want(f"it looks up {OTHER}, at the image's own resolvers", out(wide, f"getent hosts {OTHER} >/dev/null && echo resolves || echo fails"), "resolves")
        want("and an allowed name", out(wide, "getent hosts github.com >/dev/null && echo resolves || echo fails"), "resolves")
        want("node's own resolver too", out(wide, f"node -e \"require('dns').promises.resolve4('{OTHER}').then(a=>console.log('resolves')).catch(e=>console.log(e.code))\""), "resolves")
        want("a site outside the allowed names answers", out(wide, f"curl -s -m 10 -o /dev/null -w '%{{http_code}}' https://{OTHER}/"), ["200", "301", "302"])
        # Its own business, said here so that nobody is surprised: the address is this server's resolver for every sandbox.
        want(f"asked directly at the runtime's resolver, it too is refused {OTHER}", out(wide, ask(RESOLVER, OTHER)), "EREFUSED")
        door = resolvers_door()
        if door:
            want("this machine's resolver does not answer a sandbox that addresses it directly", out(wide, ask(door, "github.com")), ["ETIMEOUT", "ECONNREFUSED"])
        else:
            want("a link address of this machine to try the resolver's port at", "none found", "one")
    finally:
        wide.kill()

    if failed:
        print(f"  {len(failed)} thing(s) not as they should be")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
