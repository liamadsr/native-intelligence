"""Starts one sandbox with the runtime's default network policy, the widest
there is, and checks from inside it that this machine itself is out of reach
while the internet is not. Called by check.sh, which passes this machine's own
addresses; it needs the runtime's key in the environment.

A target counts as reached when anything at all comes back from it. A refused
or silent connection does not: the runtime's proxy accepts every connection a
sandbox opens before it decides, so "it connected" proves nothing.
"""
import json
import sys

from e2b import Sandbox

# The runtime's own ports and SSH. 5008 is its control port: no password.
PORTS = [22, 3000, 3001, 3002, 3003, 5007, 5008, 5009, 5010, 5016, 5017, 5018, 5109]

PROBE = r"""
import json, socket, sys
from concurrent.futures import ThreadPoolExecutor

def probe(target):
    host, port = target.rsplit(",", 1)
    try:
        s = socket.create_connection((host, int(port)), timeout=5)
        s.settimeout(5)
        # Answered by an HTTP/2 server, an HTTP/1 server and (unasked) by SSH alike.
        s.sendall(b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n")
        try:
            got = len(s.recv(64))
        except Exception:
            got = 0
        s.close()
        return target, got
    except Exception:
        return target, 0

with ThreadPoolExecutor(16) as pool:
    print(json.dumps(dict(pool.map(probe, sys.argv[1:]))))
"""


def main() -> int:
    addresses = sys.argv[1:]
    if not addresses:
        print("check: no addresses given", file=sys.stderr)
        return 2
    own = [f"{a},{p}" for a in addresses for p in PORTS]
    outside = ["example.com,80", "one.one.one.one,80"]
    sandbox = Sandbox.create(timeout=120)
    try:
        sandbox.files.write("/tmp/probe.py", PROBE)
        result = sandbox.commands.run("python3 /tmp/probe.py " + " ".join(own + outside), timeout=90)
        got = json.loads(result.stdout)
    finally:
        sandbox.kill()
    reached = sorted(t for t in own if got.get(t, 0) > 0)
    internet = [t for t in outside if got.get(t, 0) > 0]
    print(f"  from inside a sandbox: {len(own)} address and port pairs of this machine tried, {len(reached)} reached")
    for t in reached:
        print(f"  REACHED: {t.replace(',', ' port ')}")
    print(f"  the internet from inside a sandbox: {'reached' if internet else 'NOT reached'}")
    return 0 if not reached and internet else 1


if __name__ == "__main__":
    sys.exit(main())
