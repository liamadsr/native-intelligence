"""Pauses every running cloud browser on this server, each after its own stop
script, so that a restart of the runtime or of the machine does not end them.

A restart ends every RUNNING sandbox, and keeps paused ones (README, "What runs
here", and the reboot under "What was tried"). A browser ended that way loses
what its person signed in to since it last stopped. So before the runtime goes
down, each running browser is told to close Chrome (its stop script, which
writes Chrome's cookies and session to disk) and then paused. The app resumes
it on its next use as it resumes any paused browser.

    ni-sandbox-pause-browsers            pause them, within the time below, listing
                                         again after each pass until none runs
    ni-sandbox-pause-browsers --hold     the same, with the runtime first closed to
                                         the app until it is restarted, so that
                                         none can be resumed in between (Hold)
    ni-sandbox-pause-browsers --release  open the runtime to the app again
    ni-sandbox-pause-browsers --list     say how many are running and paused, then
                                         every browser sandbox: its name (niName),
                                         namespace, id, state and start time;
                                         changes nothing
    ni-sandbox-pause-browsers --remove <sandbox id> [--yes]
                                         remove one browser sandbox, and every
                                         sign-in in it, for good (without --yes it
                                         only says what it would remove)

--hold is for what a restart of the runtime follows: the unit
ni-sandbox-pause-browsers when it stops (before Docker, at every shutdown and
reboot, and whenever Docker is stopped or restarted) and setup.sh before it
replaces the runtime. Without it, by hand: for the way back (deploy/README.md,
"The cloud browser"), when the app no longer resumes them. Installed by setup.sh to /usr/local/lib/ni-sandbox/; the command of that
name reads the runtime's key from /opt/e2b/sdk.env and runs this with the
client in /opt/e2b/.venv.

A browser is a sandbox whose metadata says niKind=cloud-browser (the app sets
it when it creates one: web/src/lib/cloud-browser/backend-runtime.ts). Every
other sandbox, the coding agent's among them, is left as it is. Whatever is
left when the time is up is left running: a shutdown is never held for long,
and the app copes with a browser that ended (it starts it again, and the person
signs in again).
"""
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, wait

KIND_KEY = "niKind"
KIND = "cloud-browser"
STOP_SCRIPT = "/opt/cloud-browser/stop.sh"
# The whole run, from the first listing to the last pause. The unit gives it a
# little more (TimeoutStopSec) and then stops it whatever it is doing.
BUDGET_SECONDS = 90
# stop.sh waits up to about 18 s for Chrome and Xvfb (close-chrome.mjs, then 10 s
# for Chrome, then 3 s for Xvfb); a pause took 0.4 to 1.2 s here.
STOP_SECONDS = 25
PAUSE_SECONDS = 30
CONNECT_SECONDS = 10
# A browser is not begun with less than this left: its pause could not finish.
LEAST_SECONDS = 5
# Browsers handled at once. The pool holds a handful of 4 GiB sandboxes; all
# of them fit in one round.
AT_ONCE = 4
LISTING_PAGES = 20
# Passes at most: after each one the browsers are listed again, and one that was
# resumed meanwhile is paused in the next.
ROUNDS = 5
# How long the runtime stays closed to the app at most, if nothing else opens it
# (Hold, below).
RELEASE_AFTER = 600
NFT = "/usr/sbin/nft"


def running_browsers(api) -> list:
    """The ids of the running sandboxes whose metadata names them browsers.
    The metadata is asked of the runtime and looked at again here: a runtime
    that ignored the query would otherwise hand over every sandbox."""
    query = api.SandboxQuery(metadata={KIND_KEY: KIND}, state=[api.SandboxState.RUNNING])
    paginator = api.Sandbox.list(query=query, limit=100, request_timeout=CONNECT_SECONDS)
    ids = []
    pages = 0
    while paginator.has_next and pages < LISTING_PAGES:
        pages += 1
        for info in paginator.next_items():
            state = getattr(info.state, "value", info.state)
            if (info.metadata or {}).get(KIND_KEY) == KIND and state == "running" and info.sandbox_id not in ids:
                ids.append(info.sandbox_id)
    return ids


def settle(api, sandbox_id: str, deadline: float, clock) -> tuple:
    """Stop one browser's Chrome, then pause it. (id, paused, note). The stop is
    tried first and its failure does not keep the pause from happening: a pause
    keeps the sandbox's memory, Chrome's unwritten cookies with it."""
    left = deadline - clock()
    if left < LEAST_SECONDS:
        return sandbox_id, False, "not begun: out of time"
    try:
        sandbox = api.Sandbox.connect(sandbox_id, request_timeout=min(CONNECT_SECONDS, left))
    except Exception as error:
        return sandbox_id, False, "could not be reached: %s" % type(error).__name__
    note = "stopped"
    left = deadline - clock()
    stop_for = min(STOP_SECONDS, left - LEAST_SECONDS)
    if stop_for >= 1:
        try:
            sandbox.commands.run("bash %s" % STOP_SCRIPT, timeout=stop_for, request_timeout=stop_for + 5)
        except Exception as error:
            note = "its stop script failed (%s)" % type(error).__name__
    else:
        note = "not stopped first: out of time"
    left = deadline - clock()
    if left <= 0:
        return sandbox_id, False, note + ", not paused: out of time"
    try:
        sandbox.pause(request_timeout=min(PAUSE_SECONDS, left))
    except Exception as error:
        return sandbox_id, False, note + ", not paused: %s" % type(error).__name__
    return sandbox_id, True, note + ", paused"


def pause_all(api, budget: float = BUDGET_SECONDS, at_once: int = AT_ONCE, clock=time.monotonic, say=print,
              door=None, rounds: int = ROUNDS) -> int:
    """Every running browser, at most `at_once` at a time, all within `budget`
    seconds, listed again after each pass and paused again until a listing shows
    none running: a browser the app resumed meanwhile is paused in the next pass.
    With a `door` (--hold), the runtime is closed to the app first, so that from
    then on nothing can resume one at all (the Hold below). 0 when a listing
    showed none running at the end, 1 otherwise."""
    deadline = clock() + budget
    if door is not None:
        door.close(say)
    paused = set()
    left = None
    pass_no = 0
    while True:
        try:
            ids = running_browsers(api)
        except Exception as error:
            say("pause-browsers: the runtime could not be asked for its browsers (%s): %s" % (
                type(error).__name__, "none paused" if not paused else "%d paused before that" % len(paused)))
            return 1
        if not ids:
            left = 0
            if pass_no == 0:
                say("pause-browsers: no browser is running")
            break
        if pass_no >= rounds or deadline - clock() < LEAST_SECONDS:
            left = len(ids)
            say("pause-browsers: out of %s with %d browser(s) still running: those end with the restart" % (
                "passes" if pass_no >= rounds else "time", left))
            break
        pass_no += 1
        say("pause-browsers: %d browser(s) running, pausing them%s" % (len(ids), "" if pass_no == 1 else " (pass %d)" % pass_no))
        pool = ThreadPoolExecutor(max_workers=max(1, min(at_once, len(ids))))
        futures = {pool.submit(settle, api, i, deadline, clock): i for i in ids}
        done, late = wait(futures, timeout=max(0.0, deadline - clock()) + 1)
        # Never waits for a call that hangs past the deadline: whatever is still
        # going is left to the unit's own limit, and to the runtime's restart.
        pool.shutdown(wait=False, cancel_futures=True)
        for future in done:
            sandbox_id, ok, note = future.result()
            if ok:
                paused.add(sandbox_id)
            say("  %s: %s" % (sandbox_id, note))
        if late:
            for future in late:
                say("  %s: still being stopped or paused when the time was up" % futures[future])
            left = len(late)
            say("pause-browsers: out of time with %d browser(s) still being paused" % left)
            break
    say("pause-browsers: %d paused, %s" % (len(paused), "none left running" if left == 0 else "%d left running" % left))
    return 0 if left == 0 else 1


class Hold:
    """Closes the runtime to the app for the length of a restart, so that no
    browser can be resumed between the last listing and the runtime going down.

    The app reaches the runtime only through the tunnel, on two ports: the API
    (3000), which resumes a sandbox when asked to connect to it, and the traffic
    port (3002). A firewall table of this tool's own refuses both, from anywhere
    but this machine's loopback, ahead of the guard. This tool and the runtime's
    own parts keep using loopback, so the listings after the close still work,
    and a listing that shows none running is final: nothing can wake one after it.

    The table is not the guard's: the guard's timer does not take it away. What
    does, so that it is never left in place:
      - the unit's start (ExecStart), after every boot and after Docker and the
        runtime are back from a restart (the unit is ordered after both);
      - setup.sh, right after its restart of the runtime, failed or not;
      - a timer set before the table is loaded, RELEASE_AFTER seconds later,
        for every other case (the tool killed, a person stopping the unit by hand);
      - a reboot (firewall tables do not outlive one);
      - by hand: ni-sandbox-pause-browsers --release.
    While it is in place, every call from the app to the runtime is refused: the
    coding agent's included. A restart ends its running sandboxes anyway."""

    TABLE = "ni_sandbox_hold"
    RULES = """table inet ni_sandbox_hold
delete table inet ni_sandbox_hold
table inet ni_sandbox_hold {
	chain inbound {
		type filter hook input priority -200; policy accept;
		iifname != "lo" tcp dport { 3000, 3002 } counter reject with tcp reset comment "held-for-a-restart"
	}
}
"""

    def __init__(self, run=None, now=time.time):
        import subprocess

        self.run = run or (lambda args, **kw: subprocess.run(args, capture_output=True, text=True, **kw))
        self.now = now

    def stopping(self) -> bool:
        done = self.run(["systemctl", "is-system-running"])
        return (done.stdout or "").strip() == "stopping"

    def close(self, say=print) -> bool:
        # The way back first: a table nobody can take away is never loaded.
        unit = "ni-sandbox-hold-release-%d" % int(self.now())
        timer = self.run(["systemd-run", "--quiet", "--collect", "--unit=" + unit, "--on-active=%d" % RELEASE_AFTER,
                          NFT, "delete", "table", "inet", self.TABLE])
        if timer.returncode != 0 and not self.stopping():
            say("pause-browsers: no timer could be set to open the runtime again: it is left open to the app (a resume during the restart stays possible)")
            return False
        loaded = self.run([NFT, "-f", "-"], input=self.RULES)
        if loaded.returncode != 0:
            say("pause-browsers: the runtime could not be closed to the app (%s): it stays open" % (loaded.stderr or "").strip()[:120])
            return False
        say("pause-browsers: the runtime is closed to the app until it is restarted (or for %d s at most)" % RELEASE_AFTER)
        return True

    def open(self, say=print) -> bool:
        listed = self.run([NFT, "list", "table", "inet", self.TABLE])
        if listed.returncode != 0:
            say("pause-browsers: the runtime is not closed to the app")
            return True
        gone = self.run([NFT, "delete", "table", "inet", self.TABLE])
        say("pause-browsers: the runtime is open to the app again" if gone.returncode == 0 else "pause-browsers: could not open the runtime again")
        return gone.returncode == 0


def all_browsers(api) -> list:
    """Every browser sandbox the runtime has, running or paused, as dicts with its
    id, niName, niNs, state and start time, oldest first. Looked at again here, as
    in running_browsers. Nothing secret in it: no key, no token."""
    paginator = api.Sandbox.list(query=api.SandboxQuery(metadata={KIND_KEY: KIND}), limit=100, request_timeout=CONNECT_SECONDS)
    found, pages = {}, 0
    while paginator.has_next and pages < LISTING_PAGES:
        pages += 1
        for info in paginator.next_items():
            metadata = info.metadata or {}
            if metadata.get(KIND_KEY) != KIND:
                continue
            started = getattr(info, "started_at", None)
            found[info.sandbox_id] = {
                "id": info.sandbox_id,
                "name": metadata.get("niName", "?"),
                "ns": metadata.get("niNs", "?"),
                "state": getattr(info.state, "value", info.state),
                "started": started.strftime("%Y-%m-%d %H:%M:%S %Z").strip() if started else "?",
                "sort": started.timestamp() if started else 0,
            }
    return sorted(found.values(), key=lambda b: (b["name"], b["sort"], b["id"]))


def list_lines(browsers) -> list:
    """What --list prints: how many run, then one line per browser sandbox, its
    logical name first, so that two sandboxes of one name are side by side."""
    running = sum(1 for b in browsers if b["state"] == "running")
    names = {}
    for b in browsers:
        names[(b["ns"], b["name"])] = names.get((b["ns"], b["name"]), 0) + 1
    lines = ["pause-browsers: %d browser(s) running, %d paused" % (running, len(browsers) - running)]
    for b in browsers:
        twice = "  (one of %d with this name)" % names[(b["ns"], b["name"])] if names[(b["ns"], b["name"])] > 1 else ""
        lines.append("  %-40s %-8s %-20s %-8s started %s%s" % (b["name"], b["ns"], b["id"], b["state"], b["started"], twice))
    return lines


def remove(api, sandbox_id: str, yes: bool, say=print) -> int:
    """Remove one browser sandbox by its id: its VM, its disk and its memory, and so
    every sign-in its person had in it, for good. Only a sandbox the runtime lists
    as a browser; without --yes it only says what it would remove."""
    match = [b for b in all_browsers(api) if b["id"] == sandbox_id]
    if not match:
        say("pause-browsers: no browser sandbox has the id %s (coding sandboxes are never removed here)" % sandbox_id)
        return 1
    b = match[0]
    what = "%s (%s, %s, started %s)" % (b["id"], b["name"], b["state"], b["started"])
    if not yes:
        say("pause-browsers: would remove %s, and with it every sign-in in that copy of the browser, for good. Again with --yes to do it." % what)
        return 1
    try:
        gone = api.Sandbox.kill(sandbox_id, request_timeout=CONNECT_SECONDS * 3)
    except Exception as error:
        say("pause-browsers: %s could not be removed (%s)" % (sandbox_id, type(error).__name__))
        return 1
    say("pause-browsers: removed %s" % what if gone else "pause-browsers: %s was already gone" % sandbox_id)
    return 0


def read_key_file(path: str) -> dict:
    """The runtime's own settings file (`export NAME=value` lines), as setup.sh
    keeps it. Never printed."""
    values = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line.startswith("export "):
                line = line[len("export "):]
            name, sep, value = line.partition("=")
            if sep and name.startswith("E2B_"):
                values[name] = value.strip().strip("'\"")
    return values


def main(argv) -> int:
    if argv[1:] == ["--release"]:
        # Needs no key and no client: the table is this machine's own.
        return 0 if Hold().open() else 1
    key_file = os.environ.get("NI_SANDBOX_KEY_FILE", "/opt/e2b/sdk.env")
    try:
        os.environ.update(read_key_file(key_file))
    except OSError:
        print("pause-browsers: no runtime key in %s (run setup.sh): nothing paused" % key_file)
        return 1
    import e2b

    if argv[1:] == ["--list"]:
        try:
            lines = list_lines(all_browsers(e2b))
        except Exception as error:
            print("pause-browsers: the runtime could not be asked for its browsers (%s)" % type(error).__name__)
            return 1
        print("\n".join(lines))
        return 0
    if argv[1:2] == ["--remove"] and len(argv) in (3, 4) and argv[3:] in ([], ["--yes"]):
        try:
            return remove(e2b, argv[2], argv[3:] == ["--yes"])
        except Exception as error:
            print("pause-browsers: the runtime could not be asked for its browsers (%s)" % type(error).__name__)
            return 1
    if argv[1:] not in ([], ["--hold"]):
        print("usage: ni-sandbox-pause-browsers [--hold | --release | --list | --remove <sandbox id> [--yes]]", file=sys.stderr)
        return 2
    code = pause_all(e2b, door=Hold() if argv[1:] == ["--hold"] else None)
    sys.stdout.flush()
    # Calls still hanging in their threads are not waited for.
    os._exit(code)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
