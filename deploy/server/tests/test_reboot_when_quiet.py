"""The reboot for security updates, held while a call is live
(deploy/server/reboot_when_quiet.py, installed by setup.sh).

    python3 -m unittest discover -s deploy/server/tests

LiveKit is stood in for by a local HTTP server that checks the token as LiveKit
does (HS256 with the secret, the key as issuer, the roomList grant, not expired)
and answers ListRooms; Docker by a function that returns what `docker inspect`
would. Nothing here reboots anything or needs root.
"""
import base64
import hashlib
import hmac
import importlib.util
import json
import os
import re
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("reboot_when_quiet", SERVER / "reboot_when_quiet.py")
rwq = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rwq)

KEY, SECRET = "APIabcdefghijkl", "s" * 48


def unb64(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class FakeLiveKit(BaseHTTPRequestHandler):
    rooms = []
    status = 200
    seen = []

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        FakeLiveKit.seen.append(self.path)
        token = (self.headers.get("Authorization") or "").removeprefix("Bearer ")
        header, body, signature = token.split(".")
        good = hmac.new(SECRET.encode(), ("%s.%s" % (header, body)).encode(), hashlib.sha256).digest()
        claims = json.loads(unb64(body))
        ok = (hmac.compare_digest(good, unb64(signature)) and claims["iss"] == KEY
              and claims["video"] == {"roomList": True} and claims["nbf"] <= time.time() < claims["exp"])
        if self.path != "/twirp/livekit.RoomService/ListRooms" or not ok:
            self.send_response(401)
            self.end_headers()
            return
        self.send_response(FakeLiveKit.status)
        self.end_headers()
        self.wfile.write(json.dumps({"rooms": FakeLiveKit.rooms}).encode())

    def log_message(self, *_):
        pass


class Calls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = HTTPServer(("127.0.0.1", 0), FakeLiveKit)
        threading.Thread(target=cls.http.serve_forever, daemon=True).start()
        cls.port = cls.http.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.env = os.path.join(self.folder.name, ".env")
        with open(self.env, "w") as f:
            f.write("# LiveKit\nLIVEKIT_API_KEY=%s\nLIVEKIT_API_SECRET='%s'\nLIVEKIT_WEBHOOK_URL=\n" % (KEY, SECRET))
        FakeLiveKit.rooms, FakeLiveKit.status, FakeLiveKit.seen = [], 200, []

    def tearDown(self):
        self.folder.cleanup()

    def calls(self, info, env=None):
        # The real request, to the fake LiveKit on this machine's port.
        def post(url, headers):
            self.assertRegex(url, r"^http://127\.0\.0\.1:7880/twirp/livekit\.RoomService/ListRooms$")
            return rwq.post_json(url.replace(":7880", ":%d" % self.port), headers, timeout=5)
        return rwq.live_calls(env or self.env, inspect=lambda _name: info, post=post)

    running = {"State": {"Running": True},
               "NetworkSettings": {"Networks": {"ni-livekit": {"IPAddress": "10.9.9.9"},
                                                "ni-livekit-edge": {"IPAddress": "127.0.0.1"}}}}

    def test_no_livekit_is_no_call(self):
        self.assertEqual(self.calls(None)[0], 0)
        self.assertEqual(self.calls({"State": {"Running": False}})[0], 0)
        self.assertEqual(FakeLiveKit.seen, [])

    def test_rooms_with_people_are_calls(self):
        FakeLiveKit.rooms = [{"name": "a", "num_participants": 2}, {"name": "b", "num_participants": 0},
                             {"name": "c"}, {"name": "d", "numParticipants": 1}]
        count, note = self.calls(self.running)
        self.assertEqual(count, 2, note)
        self.assertIn("3 people", note)
        self.assertEqual(FakeLiveKit.seen, ["/twirp/livekit.RoomService/ListRooms"])

    def test_empty_rooms_are_quiet(self):
        FakeLiveKit.rooms = [{"name": "a", "num_participants": 0}]
        self.assertEqual(self.calls(self.running), (0, "no call is live (1 room open, nobody in any)"))
        FakeLiveKit.rooms = []
        self.assertEqual(self.calls(self.running)[0], 0)

    def test_cannot_tell_is_none(self):
        # A wrong secret: LiveKit refuses (401).
        with open(self.env, "w") as f:
            f.write("LIVEKIT_API_KEY=%s\nLIVEKIT_API_SECRET=%s\n" % (KEY, "t" * 48))
        self.assertEqual(self.calls(self.running)[0], None)
        # LiveKit failing, with the right pair.
        with open(self.env, "w") as f:
            f.write("LIVEKIT_API_KEY=%s\nLIVEKIT_API_SECRET=%s\n" % (KEY, SECRET))
        FakeLiveKit.status = 500
        self.assertEqual(self.calls(self.running, env=None)[0], None)
        # No key pair, no settings file, no address, nothing listening.
        with open(self.env, "w") as f:
            f.write("LIVEKIT_API_KEY=\n")
        self.assertIsNone(self.calls(self.running)[0])
        self.assertIsNone(self.calls(self.running, env=os.path.join(self.folder.name, "missing"))[0])
        self.assertIsNone(self.calls({"State": {"Running": True}, "NetworkSettings": {"Networks": {}}})[0])

    def test_nothing_listening_is_none(self):
        count, note = rwq.live_calls(self.env, inspect=lambda _n: self.running,
                                     post=lambda url, h: rwq.post_json("http://127.0.0.1:9/x", h, timeout=2))
        self.assertIsNone(count, note)

    def test_the_address_on_the_edge_network_first(self):
        self.assertEqual(rwq.livekit_address(self.running), "127.0.0.1")
        self.assertEqual(rwq.livekit_address({"NetworkSettings": {"Networks": {"other": {"IPAddress": "10.1.1.1"}}}}), "10.1.1.1")

    def test_the_token_only_lists_rooms_and_is_short(self):
        token = rwq.list_token(KEY, SECRET, 1_000_000)
        claims = json.loads(unb64(token.split(".")[1]))
        self.assertEqual(claims, {"iss": KEY, "nbf": 999_990, "exp": 1_000_060, "video": {"roomList": True}})


class TheRun(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.pending = os.path.join(self.folder.name, "reboot-required")
        self.now = 0
        self.reboots = []
        self.sleeps = []

    def tearDown(self):
        self.folder.cleanup()

    def run_with(self, answers, packages=lambda: False, every=300, max_wait=6 * 3600):
        answers = list(answers)

        def calls(_env):
            return answers.pop(0) if len(answers) > 1 else answers[0]

        def sleep(seconds):
            self.sleeps.append(seconds)
            self.now += seconds

        return rwq.run("unused", every, max_wait, reboot_required=self.pending, calls=calls,
                       busy_packages=packages, do_reboot=lambda: self.reboots.append(self.now),
                       sleep=sleep, clock=lambda: self.now)

    def pend(self):
        open(self.pending, "w").close()

    def test_nothing_pending_does_nothing(self):
        self.assertEqual(self.run_with([(2, "busy")]), "nothing")
        self.assertEqual(self.reboots, [])

    def test_quiet_reboots_at_once(self):
        self.pend()
        self.assertEqual(self.run_with([(0, "quiet")]), "reboot")
        self.assertEqual((self.reboots, self.sleeps), ([0], []))

    def test_waits_for_the_call_to_end(self):
        self.pend()
        self.assertEqual(self.run_with([(1, "a call"), (1, "a call"), (0, "quiet")]), "reboot")
        self.assertEqual(self.reboots, [600])

    def test_cannot_tell_waits_like_a_call(self):
        self.pend()
        self.assertEqual(self.run_with([(None, "LiveKit could not be asked"), (0, "quiet")]), "reboot")
        self.assertEqual(self.reboots, [300])

    def test_packages_being_installed_wait(self):
        self.pend()
        busy = iter([True, True, False])
        self.assertEqual(self.run_with([(0, "quiet")], packages=lambda: next(busy)), "reboot")
        self.assertEqual(self.reboots, [600])

    def test_the_wait_has_an_end(self):
        self.pend()
        self.assertEqual(self.run_with([(1, "a call that never ends")]), "reboot-anyway")
        # Looks at 0, 5, ..., 355 min; the next would pass 6 h, so it reboots at the last look.
        self.assertEqual(len(self.reboots), 1)
        self.assertLessEqual(self.reboots[0], 6 * 3600)
        self.assertGreater(self.reboots[0], 6 * 3600 - 300)

    def test_a_reboot_no_longer_pending_ends_the_wait(self):
        self.pend()
        answers = [(1, "a call")]

        def calls(_env):
            os.remove(self.pending)  # say an update was rolled back meanwhile
            return answers[0]

        result = rwq.run("unused", 300, 3600, reboot_required=self.pending, calls=calls,
                         busy_packages=lambda: False, do_reboot=lambda: self.reboots.append(1),
                         sleep=lambda s: None, clock=lambda: 0)
        self.assertEqual((result, self.reboots), ("nothing", []))


class TheLock(unittest.TestCase):
    def test_a_held_lock_is_busy_and_a_free_one_is_not(self):
        import subprocess
        import sys
        with tempfile.TemporaryDirectory() as folder:
            lock = os.path.join(folder, "lock-frontend")
            open(lock, "w").close()
            self.assertFalse(rwq.packages_busy((lock, os.path.join(folder, "missing"))))
            # Held by another process, as dpkg holds it.
            holder = subprocess.Popen([sys.executable, "-c", "import fcntl,os,sys,time; fd=os.open(sys.argv[1], os.O_RDWR); "
                                       "fcntl.lockf(fd, fcntl.LOCK_EX); print('held', flush=True); time.sleep(30)", lock],
                                      stdout=subprocess.PIPE, text=True)
            try:
                self.assertEqual(holder.stdout.readline().strip(), "held")
                self.assertTrue(rwq.packages_busy((lock,)))
            finally:
                holder.kill()
                holder.wait()
            self.assertFalse(rwq.packages_busy((lock,)))


class Setup(unittest.TestCase):
    """What setup.sh writes for it."""

    def setUp(self):
        self.text = (SERVER / "setup.sh").read_text()

    def test_unattended_upgrades_no_longer_reboot_by_themselves(self):
        self.assertIn('Unattended-Upgrade::Automatic-Reboot "false";', self.text)
        self.assertNotIn('Automatic-Reboot "true"', self.text)
        self.assertNotIn("Automatic-Reboot-Time", self.text)

    def test_the_timer_runs_it_at_the_reboot_time(self):
        self.assertIn('install -m 755 -o root -g root "$root/deploy/server/reboot_when_quiet.py" /usr/local/sbin/ni-reboot-when-quiet', self.text)
        self.assertIn("OnCalendar=*-*-* $reboot_time:00 UTC", self.text)
        self.assertIn("ExecStart=/usr/bin/python3 -I /usr/local/sbin/ni-reboot-when-quiet --env $root/deploy/livekit/.env", self.text)
        self.assertIn("systemctl enable --now ni-reboot-when-quiet.timer", self.text)
        # Longer than the longest wait, so systemd never kills a run that is waiting.
        self.assertRegex(self.text, r"TimeoutStartSec=7h")
        self.assertEqual(rwq.main.__defaults__, (None,))
        self.assertIn('default=6.0', (SERVER / "reboot_when_quiet.py").read_text())

    def test_the_units_come_after_the_checkout(self):
        self.assertLess(self.text.index('say "The files"'), self.text.index("/usr/local/sbin/ni-reboot-when-quiet"))

    def test_the_default_time_is_still_off_the_hour(self):
        self.assertRegex(self.text, r'reboot_time="08:37"')
        self.assertTrue(re.search(r"\^\(\[01\]\[0-9\]\|2\[0-3\]\):\[0-5\]\[0-9\]\$", self.text))


if __name__ == "__main__":
    unittest.main()
