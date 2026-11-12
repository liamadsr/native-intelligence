"""Starts one sandbox with the runtime's default network policy, the widest
there is, and checks from inside it that this machine itself is out of reach
while the internet is not. Called by check.sh, as root, with the runtime's key
in the environment:

    check.py --addresses <this machine's IPv4 addresses> --ports <its listening TCP ports>

Four things are tried from inside the sandbox:

1. Every address and port pair, straight. A pair counts as reached when
   anything at all comes back. "It connected" proves nothing: the runtime's
   proxy accepts every connection a sandbox opens before it decides.
2. The same machine by name: requests to an outside site that name this
   machine's loopback and its own addresses as the host, in case the proxy
   connects to the name it is told instead of the place it was pointed at.
3. A datagram (UDP) to every address. Those do not pass through the proxy.
4. The internet: a web port, another port, and a datagram that must be
   answered, so that "nothing reached" cannot simply mean "nothing works".
   They travel the same paths as the tries above. Two sites for each, of
   which one must answer, so that one site's bad day is not this server's.

And one thing is read on the machine: the guard's own note of the addresses
and ports it refused. A listener that says nothing to the probe (one that
speaks TLS, for one) looks the same reached or not, so silence is not taken
as proof: every try at a public address must be in that note.
"""
import argparse
import ipaddress
import json
import socket
import subprocess
import sys
import urllib.request

from e2b import Sandbox

# The runtime's ports and SSH, tried even when nothing listens on them right
# now, and the web's two (the app's server, at the other end of the tunnel,
# answers on those). 5008 is the runtime's control port: no password.
# check.sh adds every port that does listen here.
PORTS = [22, 80, 443, 3000, 3001, 3002, 3003, 5007, 5008, 5009, 5010, 5011, 5012, 5016, 5017, 5018, 5109, 6060, 6061]
UDP_PORT = 47631
GUARD = "/usr/local/sbin/ni-sandbox-guard"

PROBE = r"""
import json, socket, sys
from concurrent.futures import ThreadPoolExecutor

spec = json.loads(sys.argv[1])

def straight(target):
    host, port = target.rsplit(",", 1)
    try:
        s = socket.create_connection((host, int(port)), timeout=5)
        # First listen: SSH and mail servers speak first, and some hang up
        # without a word on a client that does.
        s.settimeout(1.5)
        try:
            got = len(s.recv(64))
        except Exception:
            got = 0
        if not got:
            # Then ask: answered by an HTTP/2 server and an HTTP/1 server alike.
            s.settimeout(5)
            s.sendall(b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n")
            try:
                got = len(s.recv(64))
            except Exception:
                got = 0
        s.close()
        return got
    except Exception:
        return 0

def named(name):
    # To an outside site, naming this machine as the host. The first site that
    # answers with HTTP at all is the answer: "no answer" must not pass for "refused".
    for site in spec["sites"]:
        try:
            s = socket.create_connection((site, 80), timeout=6)
            s.settimeout(6)
            s.sendall(("GET /health HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n" % name).encode())
            got = b""
            try:
                while len(got) < 2000:
                    chunk = s.recv(2000)
                    if not chunk:
                        break
                    got += chunk
            except Exception:
                pass
            s.close()
            if got.startswith(b"HTTP/"):
                return got.decode("latin-1")
        except Exception:
            pass
    return ""

def datagram(host):
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        for _ in range(3):
            s.sendto(b"ni-sandbox-check", (host, spec["udp_port"]))
        s.close()
    except Exception:
        pass

def clock(host):
    # A time request: a datagram out, and its answer back.
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(4)
        s.sendto(b"\x1b" + 47 * b"\0", (host, 123))
        got = len(s.recvfrom(64)[0])
        s.close()
        return got
    except Exception:
        return 0

with ThreadPoolExecutor(16) as pool:
    out = {
        "straight": dict(zip(spec["straight"], pool.map(straight, spec["straight"]))),
        "named": dict(zip(spec["named"], pool.map(named, spec["named"]))),
        "clock": dict(zip(spec["clocks"], pool.map(clock, spec["clocks"]))),
    }
    list(pool.map(datagram, spec["udp"]))
print(json.dumps(out))
"""


def guard_refused() -> set:
    """The (address, port) pairs the guard has noted since its note was last emptied."""
    listing = json.loads(subprocess.run([GUARD, "refused"], capture_output=True, text=True, check=True).stdout)
    pairs = set()

    def walk(node):
        if isinstance(node, dict):
            concat = node.get("concat")
            if isinstance(concat, list) and len(concat) == 2:
                pairs.add((str(concat[0]), int(concat[1])))
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(listing)
    return pairs


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--addresses", required=True, help="comma-separated IPv4 addresses of this machine")
    parser.add_argument("--ports", default="", help="comma-separated TCP ports that listen here")
    args = parser.parse_args()
    addresses = [a for a in args.addresses.split(",") if a]
    ports = sorted(set(PORTS) | {int(p) for p in args.ports.split(",") if p})
    if not addresses:
        print("  check: no addresses given", file=sys.stderr)
        return 2

    # What the runtime's API says on loopback: the words to look for in an
    # answer that should never come from it.
    with urllib.request.urlopen("http://127.0.0.1:3000/health", timeout=5) as r:
        own_answer = r.read().decode("latin-1").strip()
    if len(own_answer) < 8:
        print("  check: the runtime's own answer is too short to recognize", file=sys.stderr)
        return 2

    own = [f"{a},{p}" for a in addresses for p in ports]
    # The addresses the runtime's proxy does not refuse by itself: only the guard stands before these.
    public = [a for a in addresses if not ipaddress.ip_address(a).is_private]
    web = ["example.com,80", "one.one.one.one,80"]
    other = ["github.com,22", "gitlab.com,22"]
    outside = web + other
    names = [f"{h}:3000" for h in ["localhost", "127.0.0.1", "[::1]", "[::]", "0.0.0.0", "[::ffff:127.0.0.1]", "ip6-localhost", "localtest.me"] + addresses]

    listener = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    listener.bind(("0.0.0.0", UDP_PORT))
    listener.settimeout(0.2)

    clocks = ["time.cloudflare.com", "pool.ntp.org"]
    subprocess.run([GUARD, "forget"], check=True)
    sandbox = Sandbox.create(timeout=180)
    try:
        sandbox.files.write("/tmp/probe.py", PROBE)
        spec = {"straight": own + outside, "named": names, "sites": ["example.com", "one.one.one.one"], "udp": addresses, "udp_port": UDP_PORT, "clocks": clocks}
        sandbox.files.write("/tmp/spec.json", json.dumps(spec))
        result = sandbox.commands.run('python3 /tmp/probe.py "$(cat /tmp/spec.json)"', timeout=150)
        got = json.loads(result.stdout)
    finally:
        sandbox.kill()
    noted = guard_refused()

    datagrams = 0
    try:
        while True:
            listener.recvfrom(64)
            datagrams += 1
    except (socket.timeout, BlockingIOError):
        pass
    listener.close()

    reached = sorted(t for t in own if got["straight"].get(t, 0) > 0)
    by_name = sorted(n for n, answer in got["named"].items() if own_answer in answer)
    unanswered = sorted(n for n, answer in got["named"].items() if not answer.startswith("HTTP/"))
    web_up = [t for t in web if got["straight"].get(t, 0) > 0]
    other_up = [t for t in other if got["straight"].get(t, 0) > 0]
    clock_up = [c for c in clocks if got["clock"].get(c, 0) > 0]
    tried_public = {(a, p) for a in public for p in ports}
    unnoted = sorted(tried_public - noted)

    ok = True
    print(f"  from inside a sandbox: {len(own)} address and port pairs of this machine tried, {len(reached)} reached")
    for t in reached:
        print(f"  REACHED: {t.replace(',', ' port ')}")
    ok = ok and not reached
    print(f"  by name ({len(names)} names for this machine in a request to an outside site): {len(by_name)} answered by the runtime")
    for n in by_name:
        print(f"  REACHED BY NAME: {n}")
    if unanswered:
        print(f"  NO ANSWER AT ALL for {len(unanswered)} of them, so those prove nothing: {', '.join(unanswered[:4])}")
    ok = ok and not by_name and not unanswered
    print(f"  datagrams to this machine's addresses: {datagrams} arrived")
    ok = ok and datagrams == 0
    print(f"  the guard noted {len(tried_public) - len(unnoted)} of the {len(tried_public)} tries made at a public address as refused")
    for a, p in unnoted[:8]:
        print(f"  NOT NOTED: {a} port {p} (it did not reach the guard, so its silence proves nothing)")
    ok = ok and not unnoted
    print(f"  the internet from inside a sandbox: a web port {'reached' if web_up else 'NOT reached'}, another port {'reached' if other_up else 'NOT reached'}, a datagram {'answered' if clock_up else 'NOT answered'}")
    ok = ok and bool(web_up) and bool(other_up) and bool(clock_up)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
