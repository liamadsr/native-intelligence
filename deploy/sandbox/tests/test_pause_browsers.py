"""The running cloud browsers are paused before the runtime stops
(deploy/sandbox/pause_browsers.py), against a stand-in for the runtime's client:
only browsers, each one's stop script before its pause, all within the time,
and one browser that fails never keeps the others from being paused.

The stand-in has the shape of the client setup.sh installs (e2b 2.46.0):
Sandbox.list(query=SandboxQuery(metadata=..., state=[...]), limit=..., **opts)
returns a paginator with has_next and next_items(); Sandbox.connect(id, **opts)
returns a sandbox with commands.run(cmd, timeout=, request_timeout=) and
pause(**opts).
"""
import enum
import importlib.util
import os
import tempfile
import threading
import unittest
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[3]
SANDBOX = ROOT / "deploy" / "sandbox"


def load():
    spec = importlib.util.spec_from_file_location("pause_browsers", SANDBOX / "pause_browsers.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class State(str, enum.Enum):
    PAUSED = "paused"
    RUNNING = "running"


@dataclass
class Query:
    metadata: dict = None
    state: list = None


@dataclass
class Info:
    sandbox_id: str
    metadata: dict
    state: State


class Clock:
    """Time that moves only when the stand-in says a call took some."""

    def __init__(self):
        self.now = 1000.0
        self.lock = threading.Lock()

    def __call__(self):
        return self.now

    def spend(self, seconds):
        with self.lock:
            self.now += seconds


@dataclass
class World:
    sandboxes: list
    clock: Clock = field(default_factory=Clock)
    events: list = field(default_factory=list)
    fail_stop: set = field(default_factory=set)
    fail_pause: set = field(default_factory=set)
    fail_connect: set = field(default_factory=set)
    stop_takes: float = 1.0
    honour_query: bool = True
    queries: list = field(default_factory=list)
    page_size: int = 2


class FakeCommands:
    def __init__(self, world, sandbox_id):
        self.world, self.sandbox_id = world, sandbox_id

    def run(self, cmd, timeout=60, request_timeout=None):
        self.world.events.append(("run", self.sandbox_id, cmd, timeout))
        self.world.clock.spend(min(self.world.stop_takes, timeout))
        if self.sandbox_id in self.world.fail_stop:
            raise RuntimeError("the command failed")
        return SimpleNamespace(stdout="", exit_code=0)


class FakeSandboxInstance:
    def __init__(self, world, sandbox_id):
        self.world, self.sandbox_id = world, sandbox_id
        self.commands = FakeCommands(world, sandbox_id)

    def pause(self, **opts):
        self.world.events.append(("pause", self.sandbox_id, opts.get("request_timeout")))
        self.world.clock.spend(0.5)
        if self.sandbox_id in self.world.fail_pause:
            raise RuntimeError("the pause failed")
        return True


class FakePaginator:
    def __init__(self, items, size):
        self.items, self.size = items, size

    @property
    def has_next(self):
        return bool(self.items)

    def next_items(self):
        page, self.items = self.items[: self.size], self.items[self.size:]
        return page


def fake_api(world):
    class Sandbox:
        @staticmethod
        def list(query=None, limit=None, **opts):
            world.queries.append((query, limit, opts))
            found = []
            for info in world.sandboxes:
                if world.honour_query and query is not None:
                    if any(info.metadata.get(k) != v for k, v in (query.metadata or {}).items()):
                        continue
                    if query.state and info.state not in query.state:
                        continue
                found.append(info)
            return FakePaginator(found, world.page_size)

        @staticmethod
        def connect(sandbox_id, **opts):
            world.events.append(("connect", sandbox_id))
            if sandbox_id in world.fail_connect:
                raise ConnectionError("not reachable")
            return FakeSandboxInstance(world, sandbox_id)

    return SimpleNamespace(Sandbox=Sandbox, SandboxQuery=Query, SandboxState=State)


def browser(i, state=State.RUNNING):
    return Info("b%019d" % i, {"niKind": "cloud-browser", "niName": "made-up-%d" % i, "niNs": "madeup01"}, state)


def coding(i, state=State.RUNNING):
    return Info("c%019d" % i, {"eveSessionId": "made-up-session-%d" % i}, state)


class PauseBrowsers(unittest.TestCase):
    def setUp(self):
        self.tool = load()
        self.lines = []

    def run_all(self, world, **kw):
        return self.tool.pause_all(fake_api(world), clock=world.clock, say=self.lines.append, **kw)

    def test_only_running_browsers_and_each_stopped_before_it_is_paused(self):
        world = World([browser(1), coding(1), browser(2), browser(3, State.PAUSED), coding(2, State.PAUSED), browser(4)])
        self.assertEqual(self.run_all(world), 0)
        touched = {e[1] for e in world.events}
        self.assertEqual(touched, {browser(1).sandbox_id, browser(2).sandbox_id, browser(4).sandbox_id})
        for sid in touched:
            mine = [e[0] for e in world.events if e[1] == sid]
            self.assertEqual(mine, ["connect", "run", "pause"], sid)
            run = next(e for e in world.events if e[0] == "run" and e[1] == sid)
            self.assertEqual(run[2], "bash /opt/cloud-browser/stop.sh")
        # The runtime is asked for exactly this: running sandboxes whose metadata says browser.
        query, limit, _ = world.queries[0]
        self.assertEqual(query.metadata, {"niKind": "cloud-browser"})
        self.assertEqual(query.state, [State.RUNNING])
        self.assertIn("3 of 3 paused", self.lines[-1])

    def test_a_runtime_that_ignores_the_query_still_has_its_coding_sandboxes_left_alone(self):
        world = World([coding(1), browser(1), coding(2, State.PAUSED), browser(2, State.PAUSED)], honour_query=False)
        self.assertEqual(self.run_all(world), 0)
        self.assertEqual({e[1] for e in world.events}, {browser(1).sandbox_id})

    def test_every_page_of_the_listing(self):
        world = World([browser(i) for i in range(7)], page_size=3)
        self.assertEqual(self.run_all(world, at_once=7), 0)
        self.assertEqual(len([e for e in world.events if e[0] == "pause"]), 7)

    def test_nothing_running_is_nothing_done(self):
        world = World([coding(1), browser(1, State.PAUSED)])
        self.assertEqual(self.run_all(world), 0)
        self.assertEqual(world.events, [])
        self.assertIn("no browser is running", self.lines[-1])

    def test_one_failure_does_not_stop_the_rest(self):
        a, b, c, d = (browser(i).sandbox_id for i in range(1, 5))
        world = World([browser(i) for i in range(1, 5)], fail_stop={a}, fail_pause={b}, fail_connect={c})
        self.assertEqual(self.run_all(world, at_once=1), 1)
        paused = [e[1] for e in world.events if e[0] == "pause"]
        # a's stop script failed: it is paused all the same (the pause keeps its memory).
        self.assertIn(a, paused)
        # b's pause failed, c could not be reached: d is paused anyway.
        self.assertIn(b, paused)
        self.assertNotIn(c, paused)
        self.assertIn(d, paused)
        text = "\n".join(self.lines)
        self.assertIn("2 of 4 paused", text)
        self.assertIn("its stop script failed", text)
        self.assertIn("not paused", text)
        self.assertIn("could not be reached", text)

    def test_the_time_budget_holds(self):
        # Each stop takes 20 s, one browser at a time, 60 s in all: the first two
        # fit, the third is cut short, and the rest are not begun.
        world = World([browser(i) for i in range(6)], stop_takes=20)
        start = world.clock()
        code = self.run_all(world, budget=60, at_once=1)
        self.assertEqual(code, 1)
        self.assertLessEqual(world.clock() - start, 60 + 1)
        runs = [e for e in world.events if e[0] == "run"]
        # No stop script was given more time than was left.
        for e in runs:
            self.assertLessEqual(e[3], 60)
        paused = [e for e in world.events if e[0] == "pause"]
        self.assertGreaterEqual(len(paused), 2)
        self.assertLess(len(paused), 6)
        self.assertIn("not begun: out of time", "\n".join(self.lines))

    def test_a_stop_is_never_given_more_than_its_own_limit(self):
        world = World([browser(1)])
        self.run_all(world, budget=600)
        run = next(e for e in world.events if e[0] == "run")
        self.assertEqual(run[3], self.tool.STOP_SECONDS)
        pause = next(e for e in world.events if e[0] == "pause")
        self.assertLessEqual(pause[2], self.tool.PAUSE_SECONDS)

    def test_a_listing_that_fails_pauses_nothing_and_says_so(self):
        world = World([browser(1)])
        api = fake_api(world)

        def broken(*_a, **_k):
            raise ConnectionError("down")

        api.Sandbox.list = broken
        self.assertEqual(self.tool.pause_all(api, clock=world.clock, say=self.lines.append), 1)
        self.assertEqual(world.events, [])
        self.assertIn("could not be asked", self.lines[-1])

    def test_the_budget_fits_inside_the_units_limit(self):
        setup = (SANDBOX / "setup.sh").read_text()
        limit = int(setup.split("TimeoutStopSec=", 1)[1].split()[0])
        self.assertLess(self.tool.BUDGET_SECONDS + 10, limit)


class TheKeyFile(unittest.TestCase):
    def test_reads_the_runtimes_own_lines_and_nothing_else(self):
        tool = load()
        with tempfile.NamedTemporaryFile("w", delete=False) as f:
            f.write("export E2B_API_KEY=e2b_madeup\nexport E2B_API_URL=http://127.0.0.1:3000\nexport E2B_SANDBOX_URL='http://127.0.0.1:3002'\nPATH=/nope\n# comment\n")
        try:
            self.assertEqual(tool.read_key_file(f.name), {"E2B_API_KEY": "e2b_madeup", "E2B_API_URL": "http://127.0.0.1:3000",
                                                         "E2B_SANDBOX_URL": "http://127.0.0.1:3002"})
        finally:
            os.unlink(f.name)


class TheUnit(unittest.TestCase):
    """The unit as setup.sh writes it: stopped before Docker and the runtime, and
    with Docker; started at boot; never restarted by setup.sh (a restart would
    pause every browser)."""

    def unit(self):
        setup = (SANDBOX / "setup.sh").read_text()
        return setup.split("/etc/systemd/system/ni-sandbox-pause-browsers.service <<'EOF'\n", 1)[1].split("\nEOF\n", 1)[0]

    def test_its_ordering(self):
        unit = self.unit()
        after = next(l for l in unit.splitlines() if l.startswith("After="))
        self.assertIn("docker.service", after)
        self.assertIn("ni-sandbox-runtime.service", after)
        self.assertIn("PartOf=docker.service", unit)
        self.assertIn("RemainAfterExit=yes", unit)
        self.assertIn("ExecStop=/usr/local/sbin/ni-sandbox-pause-browsers", unit)
        self.assertIn("WantedBy=multi-user.target", unit)

    def test_setup_starts_it_and_never_restarts_it(self):
        setup = (SANDBOX / "setup.sh").read_text()
        self.assertIn("systemctl start ni-sandbox-pause-browsers.service", setup)
        self.assertNotRegex(setup, r"(restart|reload-or-restart|try-restart)[^\n]*ni-sandbox-pause-browsers")

    def test_setup_pauses_them_before_it_replaces_the_runtime(self):
        setup = (SANDBOX / "setup.sh").read_text()
        pause = setup.index('"$here/pause_browsers.py"')
        restart = setup.index("systemctl restart ni-sandbox-runtime.service")
        self.assertLess(pause, restart)

    def test_check_looks_at_it(self):
        check = (SANDBOX / "check.sh").read_text()
        self.assertIn("ni-sandbox-pause-browsers.service", check)
        self.assertIn("is-active", check)
        self.assertIn("ni-sandbox-pause-browsers --list", check)


if __name__ == "__main__":
    unittest.main()
