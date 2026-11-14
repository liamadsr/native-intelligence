"""Pauses every running cloud browser on this server, each after its own stop
script, so that a restart of the runtime or of the machine does not end them.

A restart ends every RUNNING sandbox, and keeps paused ones (README, "What runs
here", and the reboot under "What was tried"). A browser ended that way loses
what its person signed in to since it last stopped. So before the runtime goes
down, each running browser is told to close Chrome (its stop script, which
writes Chrome's cookies and session to disk) and then paused. The app resumes
it on its next use as it resumes any paused browser.

    ni-sandbox-pause-browsers           pause them, within the time below
    ni-sandbox-pause-browsers --list    say how many are running; changes nothing

Run by the unit ni-sandbox-pause-browsers when it stops (before Docker, at every
shutdown and reboot, and whenever Docker is stopped or restarted), by setup.sh
before it replaces the runtime, and by hand before anything else that restarts
it. Installed by setup.sh to /usr/local/lib/ni-sandbox/; the command of that
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


def pause_all(api, budget: float = BUDGET_SECONDS, at_once: int = AT_ONCE, clock=time.monotonic, say=print) -> int:
    """Every running browser, at most `at_once` at a time, all within `budget`
    seconds. 0 when every browser found was paused, 1 otherwise."""
    deadline = clock() + budget
    try:
        ids = running_browsers(api)
    except Exception as error:
        say("pause-browsers: the runtime could not be asked for its browsers (%s): none paused" % type(error).__name__)
        return 1
    if not ids:
        say("pause-browsers: no browser is running")
        return 0
    say("pause-browsers: %d browser(s) running, pausing them" % len(ids))
    pool = ThreadPoolExecutor(max_workers=max(1, min(at_once, len(ids))))
    futures = {pool.submit(settle, api, i, deadline, clock): i for i in ids}
    done, late = wait(futures, timeout=max(0.0, deadline - clock()) + 1)
    # Never waits for a call that hangs past the deadline: whatever is still
    # going is left to the unit's own limit, and to the runtime's restart.
    pool.shutdown(wait=False, cancel_futures=True)
    paused = 0
    for future in done:
        sandbox_id, ok, note = future.result()
        paused += ok
        say("  %s: %s" % (sandbox_id, note))
    for future in late:
        say("  %s: still being stopped or paused when the time was up" % futures[future])
    say("pause-browsers: %d of %d paused" % (paused, len(ids)))
    return 0 if paused == len(ids) else 1


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
    key_file = os.environ.get("NI_SANDBOX_KEY_FILE", "/opt/e2b/sdk.env")
    try:
        os.environ.update(read_key_file(key_file))
    except OSError:
        print("pause-browsers: no runtime key in %s (run setup.sh): nothing paused" % key_file)
        return 1
    import e2b

    if argv[1:] == ["--list"]:
        try:
            ids = running_browsers(e2b)
        except Exception as error:
            print("pause-browsers: the runtime could not be asked for its browsers (%s)" % type(error).__name__)
            return 1
        print("pause-browsers: %d browser(s) running" % len(ids))
        return 0
    if argv[1:]:
        print("usage: ni-sandbox-pause-browsers [--list]", file=sys.stderr)
        return 2
    code = pause_all(e2b)
    sys.stdout.flush()
    # Calls still hanging in their threads are not waited for.
    os._exit(code)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
