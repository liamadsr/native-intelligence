#!/usr/bin/env python3
"""The server's reboot for security updates, held while a call is live.

Ubuntu's unattended upgrades install security updates every morning. Some (the
kernel, glibc) take effect only after a reboot, and they say so with
/var/run/reboot-required. Unattended upgrades would reboot at a fixed time; this
server's own timer (ni-reboot-when-quiet.timer, written by setup.sh) runs this
instead, at that time, and it reboots only once nobody is in a call:

  1. No reboot pending: nothing to do, and it ends.
  2. Packages still being installed (dpkg's lock is held): wait.
  3. A call live on this server's LiveKit (a room with someone in it): wait.
  4. Otherwise: reboot.

It looks again every few minutes (--every, 5 minutes), and gives up waiting after
--max-wait (6 hours): then it reboots whatever is going on, so that the updates land
the same day. Each look says why it waits in the journal
(journalctl -u ni-reboot-when-quiet).

When LiveKit cannot be asked, it counts as a live call: it waits (up to the same
limit). A check that fails because a busy LiveKit was slow to answer must not cut the
calls it was there to protect, and the most that waiting costs is the update a few
hours later. When LiveKit does not run at all (no container, or stopped, as on the
sandbox server), there is no call to cut, and it does not wait.

How it asks: ListRooms on LiveKit's server API, straight to the container's address
on ni-livekit-edge (port 7880, not published, reachable from the host only), with a
token that may only list rooms, made from the key pair in deploy/livekit/.env and
good for a minute. A room counts when num_participants is above 0: LiveKit does not
count hidden participants (the call recorder), so a room the recorder alone is still
in is not a live call.

  ni-reboot-when-quiet                     the timer's run (above)
  ni-reboot-when-quiet --check             says whether a call is live, reboots nothing:
                                           exit 0 quiet, 1 a call is live, 2 cannot tell
Options:
  --env <file>        LiveKit's settings (default /opt/native-intelligence/deploy/livekit/.env)
  --every <seconds>   between two looks (default 300)
  --max-wait <hours>  the most it waits before rebooting anyway (default 6)
"""
import argparse
import base64
import fcntl
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

CONTAINER = "ni-livekit"
NETWORK = "ni-livekit-edge"
REBOOT_REQUIRED = "/var/run/reboot-required"
DPKG_LOCKS = ("/var/lib/dpkg/lock-frontend", "/var/lib/dpkg/lock")


def say(text):
    print("ni-reboot-when-quiet: " + text, flush=True)


def parse_env(path):
    """KEY=VALUE lines, as make-keys.sh writes them (letters and digits, unquoted),
    with plain quotes taken off."""
    values = {}
    with open(path) as f:
        for line in f:
            m = re.match(r"([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line.rstrip("\n"))
            if not m:
                continue
            name, value = m.groups()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            values[name] = value.strip()
    return values


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def list_token(key, secret, now, ttl=60):
    """A LiveKit server API token that may only list rooms (HS256, the key as
    issuer, the grant under "video"), as deploy/app/check_settings.py makes one."""
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    claims = {"iss": key, "nbf": int(now) - 10, "exp": int(now) + ttl, "video": {"roomList": True}}
    body = b64url(json.dumps(claims, separators=(",", ":")).encode())
    signature = hmac.new(secret.encode(), ("%s.%s" % (header, body)).encode(), hashlib.sha256).digest()
    return "%s.%s.%s" % (header, body, b64url(signature))


def docker_inspect(container, run=subprocess.run):
    """The container's state and networks, or None when there is no such
    container (or no Docker)."""
    try:
        done = run(["docker", "inspect", container], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if done.returncode != 0:
        return None
    try:
        found = json.loads(done.stdout)
    except ValueError:
        return None
    return found[0] if found else None


def livekit_address(info):
    """The container's address on ni-livekit-edge (an ordinary bridge the host
    reaches), else on any network it has one on."""
    networks = (info.get("NetworkSettings") or {}).get("Networks") or {}
    preferred = (networks.get(NETWORK) or {}).get("IPAddress")
    if preferred:
        return preferred
    for net in networks.values():
        if (net or {}).get("IPAddress"):
            return net["IPAddress"]
    return None


def post_json(url, headers, timeout=10):
    request = urllib.request.Request(url, data=b"{}", method="POST",
                                     headers=dict(headers, **{"Content-Type": "application/json"}))
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read() or b"{}")


def in_room(room):
    """num_participants as Twirp's JSON spells it (the proto's own name; protojson's
    camelCase as well, should a release switch), 0 when absent (a field at its
    default may be left out)."""
    value = room.get("num_participants", room.get("numParticipants", 0))
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def live_calls(env_path, inspect=docker_inspect, post=post_json, now=time.time):
    """(count, note): how many rooms have someone in them. count is 0 when
    LiveKit does not run here, and None when it runs but cannot be asked."""
    info = inspect(CONTAINER)
    if info is None:
        return 0, "LiveKit does not run here (no %s container)" % CONTAINER
    if not (info.get("State") or {}).get("Running"):
        return 0, "LiveKit is stopped"
    address = livekit_address(info)
    if not address:
        return None, "LiveKit runs, but its container has no address to ask it at"
    try:
        env = parse_env(env_path)
    except OSError as e:
        return None, "LiveKit runs, but its settings cannot be read (%s)" % e.strerror
    key, secret = env.get("LIVEKIT_API_KEY", ""), env.get("LIVEKIT_API_SECRET", "")
    if not key or not secret:
        return None, "LiveKit runs, but %s has no key pair" % env_path
    url = "http://%s:7880/twirp/livekit.RoomService/ListRooms" % (
        "[%s]" % address if ":" in address else address)
    try:
        body = post(url, {"Authorization": "Bearer " + list_token(key, secret, now())})
    except urllib.error.HTTPError as e:
        return None, "LiveKit answered %d" % e.code
    except (urllib.error.URLError, OSError, ValueError) as e:
        return None, "LiveKit could not be asked (%s)" % (getattr(e, "reason", None) or e)
    rooms = (body or {}).get("rooms") or []
    busy = [r for r in rooms if in_room(r) > 0]
    people = sum(in_room(r) for r in busy)
    if not busy:
        return 0, "no call is live (%d room%s open, nobody in any)" % (len(rooms), "" if len(rooms) == 1 else "s")
    return len(busy), "%d call%s live, %d %s in them" % (
        len(busy), " is" if len(busy) == 1 else "s are", people, "person" if people == 1 else "people")


def packages_busy(locks=DPKG_LOCKS):
    """True while dpkg's lock is held (an upgrade is installing): a reboot then
    could leave a package half installed. Takes the lock for an instant only."""
    for path in locks:
        try:
            fd = os.open(path, os.O_RDWR)
        except OSError:
            continue
        try:
            fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.lockf(fd, fcntl.LOCK_UN)
        except OSError:
            return True
        finally:
            os.close(fd)
    return False


def reboot():
    subprocess.run(["systemctl", "reboot"], check=False)


def run(env_path, every, max_wait, reboot_required=REBOOT_REQUIRED, calls=live_calls,
        busy_packages=packages_busy, do_reboot=reboot, sleep=time.sleep, clock=time.monotonic):
    """The timer's run. Returns what it did: "nothing", "reboot" or "reboot-anyway"."""
    start = clock()
    while True:
        if not os.path.exists(reboot_required):
            say("no reboot is pending: nothing to do.")
            return "nothing"
        waited = clock() - start
        reasons = []
        if busy_packages():
            reasons.append("packages are being installed")
        count, note = calls(env_path)
        if count is None:
            reasons.append(note + "; counted as a live call")
        elif count > 0:
            reasons.append(note)
        if not reasons:
            say("a reboot is pending and %s: rebooting now." % note)
            do_reboot()
            return "reboot"
        if waited + every > max_wait:
            say("a reboot is pending; still %s after %d min of waiting, the most it waits: rebooting anyway."
                % ("; ".join(reasons), waited // 60))
            do_reboot()
            return "reboot-anyway"
        say("a reboot is pending, held: %s. Next look in %d min; at the latest it reboots in %d min."
            % ("; ".join(reasons), every // 60, (max_wait - waited) // 60))
        sleep(every)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="ni-reboot-when-quiet", description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true", help="say whether a call is live; reboot nothing")
    parser.add_argument("--env", default="/opt/native-intelligence/deploy/livekit/.env")
    parser.add_argument("--every", type=int, default=300)
    parser.add_argument("--max-wait", type=float, default=6.0, help="hours")
    args = parser.parse_args(argv)
    if args.every < 1 or args.max_wait < 0:
        parser.error("--every must be at least 1 and --max-wait at least 0")
    if args.check:
        count, note = live_calls(args.env)
        say(note + ("" if count is not None else " (cannot tell)"))
        return 2 if count is None else (1 if count else 0)
    if os.geteuid() != 0:
        say("run it as root: it reads LiveKit's key pair and reboots the server.")
        return 2
    run(args.env, args.every, int(args.max_wait * 3600))
    return 0


if __name__ == "__main__":
    sys.exit(main())
