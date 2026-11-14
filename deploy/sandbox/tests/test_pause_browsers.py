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
    # The live app: before listing number n (from 1), it resumes these sandboxes,
    # unless the runtime is closed to it (the Hold).
    resumes: dict = field(default_factory=dict)
    closed: bool = False
    listings: int = 0

    def find(self, sandbox_id):
        return next(info for info in self.sandboxes if info.sandbox_id == sandbox_id)


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
        self.world.find(self.sandbox_id).state = State.PAUSED
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
            world.listings += 1
            for sandbox_id in world.resumes.get(world.listings, ()):
                if world.closed:
                    world.events.append(("resume refused", sandbox_id))
                else:
                    world.events.append(("resumed by the app", sandbox_id))
                    world.find(sandbox_id).state = State.RUNNING
            world.events.append(("list", world.listings))
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


class FakeDoor:
    """The Hold, as pause_all sees it: closing it shuts the app out of the world."""

    def __init__(self, world, works=True):
        self.world, self.works = world, works

    def close(self, say):
        self.world.events.append(("door closed" if self.works else "door could not close",))
        self.world.closed = self.works
        return self.works


class PauseBrowsers(unittest.TestCase):
    def setUp(self):
        self.tool = load()
        self.lines = []

    def run_all(self, world, **kw):
        return self.tool.pause_all(fake_api(world), clock=world.clock, say=self.lines.append, **kw)

    def kinds(self, world, sandbox_id):
        return [e[0] for e in world.events if len(e) > 1 and e[1] == sandbox_id and e[0] in ("connect", "run", "pause")]

    def test_only_running_browsers_and_each_stopped_before_it_is_paused(self):
        world = World([browser(1), coding(1), browser(2), browser(3, State.PAUSED), coding(2, State.PAUSED), browser(4)])
        self.assertEqual(self.run_all(world), 0)
        touched = {e[1] for e in world.events if e[0] in ("connect", "run", "pause")}
        self.assertEqual(touched, {browser(1).sandbox_id, browser(2).sandbox_id, browser(4).sandbox_id})
        for sid in touched:
            self.assertEqual(self.kinds(world, sid), ["connect", "run", "pause"], sid)
            run = next(e for e in world.events if e[0] == "run" and e[1] == sid)
            self.assertEqual(run[2], "bash /opt/cloud-browser/stop.sh")
        # The runtime is asked for exactly this: running sandboxes whose metadata says browser.
        query, limit, _ = world.queries[0]
        self.assertEqual(query.metadata, {"niKind": "cloud-browser"})
        self.assertEqual(query.state, [State.RUNNING])
        # A second listing shows none running, and that is the end.
        self.assertEqual(world.listings, 2)
        self.assertIn("3 paused, none left running", self.lines[-1])
        for info in world.sandboxes:
            if info.sandbox_id.startswith("c"):
                self.assertEqual(self.kinds(world, info.sandbox_id), [], info.sandbox_id)

    def test_a_browser_resumed_between_passes_is_paused_again(self):
        b1, b2 = browser(1).sandbox_id, browser(2).sandbox_id
        # The live app resumes b1 just before the second listing, and b2 before the third.
        world = World([browser(1), browser(2)], resumes={2: [b1], 3: [b2]})
        self.assertEqual(self.run_all(world), 0)
        self.assertEqual(self.kinds(world, b1), ["connect", "run", "pause", "connect", "run", "pause"])
        self.assertEqual(self.kinds(world, b2), ["connect", "run", "pause", "connect", "run", "pause"])
        self.assertEqual(world.listings, 4)
        self.assertTrue(all(info.state == State.PAUSED for info in world.sandboxes))
        self.assertIn("(pass 3)", "\n".join(self.lines))
        self.assertIn("none left running", self.lines[-1])

    def test_with_the_door_closed_first_no_resume_gets_through(self):
        b1 = browser(1).sandbox_id
        world = World([browser(1), browser(2)], resumes={2: [b1], 3: [b1]})
        self.assertEqual(self.run_all(world, door=FakeDoor(world)), 0)
        # Closed before the first listing; every later resume refused; one pass, one clean listing.
        self.assertEqual(world.events[0], ("door closed",))
        self.assertLess(world.events.index(("door closed",)), world.events.index(("list", 1)))
        self.assertIn(("resume refused", b1), world.events)
        self.assertNotIn(("resumed by the app", b1), world.events)
        self.assertEqual(self.kinds(world, b1), ["connect", "run", "pause"])
        self.assertEqual(world.listings, 2)

    def test_the_door_is_closed_only_when_asked(self):
        world = World([browser(1)])
        self.run_all(world)
        self.assertFalse(any(e[0].startswith("door") for e in world.events))
        self.assertFalse(world.closed)

    def test_a_door_that_will_not_close_still_pauses_them_all(self):
        b1 = browser(1).sandbox_id
        world = World([browser(1)], resumes={2: [b1]})
        self.assertEqual(self.run_all(world, door=FakeDoor(world, works=False)), 0)
        self.assertEqual(self.kinds(world, b1), ["connect", "run", "pause", "connect", "run", "pause"])

    def test_a_browser_the_app_keeps_waking_is_given_up_after_the_passes(self):
        b1 = browser(1).sandbox_id
        world = World([browser(1)], resumes={n: [b1] for n in range(2, 20)})
        self.assertEqual(self.run_all(world), 1)
        self.assertEqual(len([e for e in world.events if e[0] == "pause"]), self.tool.ROUNDS)
        self.assertIn("out of passes with 1 browser(s) still running", "\n".join(self.lines))
        self.assertIn("1 left running", self.lines[-1])

    def test_a_runtime_that_ignores_the_query_still_has_its_coding_sandboxes_left_alone(self):
        world = World([coding(1), browser(1), coding(2, State.PAUSED), browser(2, State.PAUSED)], honour_query=False)
        self.assertEqual(self.run_all(world), 0)
        self.assertEqual({e[1] for e in world.events if e[0] in ("connect", "run", "pause")}, {browser(1).sandbox_id})

    def test_every_page_of_the_listing(self):
        world = World([browser(i) for i in range(7)], page_size=3)
        self.assertEqual(self.run_all(world, at_once=7), 0)
        self.assertEqual(len([e for e in world.events if e[0] == "pause"]), 7)

    def test_nothing_running_is_nothing_done(self):
        world = World([coding(1), browser(1, State.PAUSED)])
        self.assertEqual(self.run_all(world), 0)
        self.assertEqual([e for e in world.events if e[0] != "list"], [])
        self.assertIn("no browser is running", "\n".join(self.lines))

    def test_one_failure_does_not_stop_the_rest(self):
        a, b, c, d = (browser(i).sandbox_id for i in range(1, 5))
        world = World([browser(i) for i in range(1, 5)], fail_stop={a}, fail_pause={b}, fail_connect={c})
        self.assertEqual(self.run_all(world, at_once=1), 1)
        paused = [e[1] for e in world.events if e[0] == "pause"]
        # a's stop script failed: it is paused all the same (the pause keeps its memory), once.
        self.assertEqual(paused.count(a), 1)
        # b's pause failed, c could not be reached: both tried again in every pass; d is paused anyway.
        self.assertEqual(paused.count(b), self.tool.ROUNDS)
        self.assertNotIn(c, paused)
        self.assertEqual(paused.count(d), 1)
        text = "\n".join(self.lines)
        self.assertIn("2 paused, 2 left running", text)
        self.assertIn("its stop script failed", text)
        self.assertIn("not paused", text)
        self.assertIn("could not be reached", text)

    def test_the_time_budget_holds(self):
        # Each stop takes 20 s, one browser at a time, 60 s in all: the first three
        # fit, then the time is up and the rest are left running.
        world = World([browser(i) for i in range(6)], stop_takes=20)
        start = world.clock()
        code = self.run_all(world, budget=60, at_once=1)
        self.assertEqual(code, 1)
        self.assertLessEqual(world.clock() - start, 60 + 1)
        for e in world.events:
            if e[0] == "run":
                self.assertLessEqual(e[3], 60)
        paused = [e for e in world.events if e[0] == "pause"]
        self.assertGreaterEqual(len(paused), 2)
        self.assertLess(len(paused), 6)
        text = "\n".join(self.lines)
        self.assertIn("not begun: out of time", text)
        self.assertIn("out of time with", text)
        self.assertRegex(self.lines[-1], r"\d paused, \d left running")

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


class FakeRun:
    """Stands in for subprocess.run in the Hold: records each command, answers as told."""

    def __init__(self, fail=(), stopping=False, table=True):
        self.calls, self.fail, self.stopping, self.table = [], set(fail), stopping, table

    def __call__(self, args, **kw):
        self.calls.append((args, kw.get("input")))
        name = args[0].rsplit("/", 1)[-1]
        if name == "systemctl":
            return SimpleNamespace(returncode=0, stdout="stopping\n" if self.stopping else "running\n", stderr="")
        if name == "nft" and args[1:3] == ["list", "table"]:
            return SimpleNamespace(returncode=0 if self.table else 1, stdout="", stderr="")
        return SimpleNamespace(returncode=1 if name in self.fail else 0, stdout="", stderr="made-up failure")


class TheHold(unittest.TestCase):
    def setUp(self):
        self.tool = load()
        self.lines = []

    def test_the_way_back_is_set_before_the_table_is_loaded(self):
        run = FakeRun()
        self.assertTrue(self.tool.Hold(run=run, now=lambda: 1_800_000_000).close(self.lines.append))
        (timer, _), (load_, rules) = run.calls
        self.assertEqual(timer[0], "systemd-run")
        self.assertIn("--on-active=%d" % self.tool.RELEASE_AFTER, timer)
        self.assertIn("--unit=ni-sandbox-hold-release-1800000000", timer)
        self.assertEqual(timer[-5:], [self.tool.NFT, "delete", "table", "inet", "ni_sandbox_hold"])
        self.assertEqual(load_, [self.tool.NFT, "-f", "-"])
        # Refused from anywhere but loopback, on the runtime's API and traffic ports, ahead of the guard (-150).
        self.assertIn('iifname != "lo" tcp dport { 3000, 3002 }', rules)
        self.assertIn("priority -200", rules)
        self.assertIn("table inet ni_sandbox_hold {", rules)
        self.assertNotIn("ni_sandbox_guard", rules)

    def test_no_timer_no_hold_while_the_machine_runs(self):
        run = FakeRun(fail={"systemd-run"})
        self.assertFalse(self.tool.Hold(run=run).close(self.lines.append))
        self.assertFalse(any(args[:2] == [self.tool.NFT, "-f"] for args, _ in run.calls))
        self.assertIn("left open", self.lines[-1])

    def test_at_a_shutdown_it_holds_without_a_timer(self):
        # A shutdown is the restart: nothing needs to open it again.
        run = FakeRun(fail={"systemd-run"}, stopping=True)
        self.assertTrue(self.tool.Hold(run=run).close(self.lines.append))
        self.assertTrue(any(args[:2] == [self.tool.NFT, "-f"] for args, _ in run.calls))

    def test_a_table_that_will_not_load_leaves_it_open(self):
        run = FakeRun(fail={"nft"})
        self.assertFalse(self.tool.Hold(run=run).close(self.lines.append))
        self.assertIn("stays open", self.lines[-1])

    def test_release(self):
        run = FakeRun()
        self.assertTrue(self.tool.Hold(run=run).open(self.lines.append))
        self.assertEqual(run.calls[-1][0], [self.tool.NFT, "delete", "table", "inet", "ni_sandbox_hold"])
        run = FakeRun(table=False)
        self.assertTrue(self.tool.Hold(run=run).open(self.lines.append))
        self.assertEqual(len(run.calls), 1)

    def test_the_hold_is_for_the_unit_and_setup_only(self):
        setup = (SANDBOX / "setup.sh").read_text()
        self.assertIn("ExecStop=/usr/local/sbin/ni-sandbox-pause-browsers --hold", setup)
        self.assertIn('"$here/pause_browsers.py" --hold', setup)
        source = (SANDBOX / "pause_browsers.py").read_text()
        self.assertIn('door=Hold() if argv[1:] == ["--hold"] else None', source)

    def test_every_path_opens_it_again(self):
        setup = (SANDBOX / "setup.sh").read_text()
        # The unit's start, after a boot and after Docker and the runtime are back.
        self.assertIn("ExecStart=-/usr/sbin/nft delete table inet ni_sandbox_hold", setup)
        # setup.sh, right after its restart, whether the restart worked or not.
        restart = setup.index("systemctl restart ni-sandbox-runtime.service || { release_hold; die")
        self.assertLess(setup.index('"$here/pause_browsers.py" --hold'), restart)
        self.assertIn("release_hold\n", setup[restart:restart + 200])
        # Nothing slow between the last listing and the restart.
        between = setup[setup.index('"$here/pause_browsers.py" --hold'):restart]
        self.assertNotIn("docker compose pull", between)
        self.assertNotIn("image.py", between)
        # check.sh says when one was left in place.
        self.assertIn("nft list table inet ni_sandbox_hold", (SANDBOX / "check.sh").read_text())


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
