"""The sandbox images this server's runtime starts from, built on it.

    image.py wanted                  the images this server builds and checks: the
                                     coding agent's always, the cloud browser's only
                                     once setup.sh --with-browser has asked for it
    image.py build <MiB> [<image>]   build each wanted image (or the one named) when it is
                                     missing, when its definition here changed, or
                                     when the runtime's free-disk limit did (an
                                     image keeps the limit it was built under)
    image.py check <GiB> [<image>]   start one sandbox from each wanted one (or the one named)
                                     and see from inside that it is as it should be,
                                     that much free disk included
    image.py resolvers               for resolver.sh, before it has the guard send
                                     lookups to this server's resolver: no sandbox
                                     is running, and a new one carries the list of
                                     resolvers below

Run by setup.sh and check.sh, as root, with the runtime's key in the environment.

Two images (README, "The coding agent's image" and "The cloud browser's image"):

  ni-coding-agent   the agent framework's own base image (the one its hosted
                    sandboxes start from) with the workspace handed to the
                    runtime's user. The framework's version in BASE must be the
                    one the app uses ("eve" in web/package.json):
                    deploy/sandbox/tests pins the two together.
  ni-cloud-browser  the cloud browser: Xvfb, Chrome, x11vnc and fonts, from the
                    same scripts as the hosted service's base snapshot
                    (web/scripts/cloud-browser/base), on a Node image.
"""
import base64
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# --- the coding agent's image --------------------------------------------------------
# These names are the coding agent's alone, as they were before there was a second
# image: what definition() hashes for it must not move, or this server would build it
# again for nothing (tests/test_image.py holds the hash).
NAME = "ni-coding-agent"
BASE = "ghcr.io/vercel/eve:0.79.1"
# What one coding sandbox gets. It reserves the memory from the server's pool
# for as long as it runs (README, "Memory, and how many sandboxes fit").
CPUS = 2
MEMORY_MB = 4096
# The resolvers a sandbox from these images asks: two ordinary public ones, for
# a sandbox with the open internet. Not the one the runtime itself gives a
# sandbox (8.8.8.8): that address is the one it opens to a sandbox narrowed to
# a list of names, and with resolver.sh set up, lookups for it are answered by
# this server's own resolver, for the narrowed levels' names only (README,
# "The resolver"). A narrowed sandbox cannot reach the two below; the app
# points it at that one address when it creates it
# (web/agents/coding-agent/lib/runtime-sandbox.ts, NARROWED_RESOLVER).
RESOLVERS = ["1.1.1.1", "9.9.9.9"]
RESOLV_CONF = "".join(f"nameserver {address}\n" for address in RESOLVERS)
RESOLVERS_STEP = ("root", "printf '" + RESOLV_CONF.replace("\n", "\\n") + "' > /etc/resolv.conf")
# Run in the image, in this order, as the user named. The runtime runs a
# sandbox's commands as its own user ("user"), not the image's: the workspace
# the agent works in has to be that user's.
# The resolvers come first: while an image is built, its steps ask the runtime's
# own resolver, which answers for the narrowed levels' names only once this
# server's resolver is set up. A step that fetches anything must come after.
STEPS = [
    RESOLVERS_STEP,
    ("root", "mkdir -p /workspace && chown -R user:user /workspace"),
]
# What the agent's setup and its tools call (web/agents/coding-agent/sandbox.ts
# and the framework's shell tool). git-lfs is not among them: the hosted image
# has none either.
NEEDS = ["bash", "git", "node", "npm", "pnpm", "python3", "rg", "curl", "jq", "realpath", "tail", "wc"]
# The definition this server last built, so that "build" knows when to build again.
RECORD = Path("/etc/ni-sandbox/image.ni-coding-agent")

# --- the cloud browser's image -------------------------------------------------------
BROWSER_NAME = "ni-cloud-browser"
# Debian 12 with Node 24 (the version the repository pins; the relay is built for
# Node 22 and up, web/scripts/cloud-browser/build-assets.mjs). An exact tag, read
# off Docker Hub's public API on 2026-11-14: published 2026-10-28, index digest
# sha256:d862bb5d082c5ae0210ac07e8c0344cb8cf7bef6d78e9b8c50c179da923108ea.
# The runtime's own build adds what it needs (sudo, systemd, the user "user").
BROWSER_BASE = "node:24.22.1-bookworm"
BROWSER_CPUS = 2
# The product's decision (web/src/lib/cloud-browser/config.ts: 2 vCPU / 4 GB). Each
# running browser reserves all of it from the pool for as long as it runs, the same
# as a coding run: with the 16 GiB this server sets aside, three sandboxes of 4 GiB
# run at once in all, browsers and coding runs together (README, "Memory, and how
# many sandboxes fit"). A paused browser gives its memory back.
BROWSER_MEMORY_MB = 4096
# The scripts the hosted service's base snapshot is made from, used here as they
# are: web/scripts/cloud-browser/build-base-snapshot.sh copies the same four.
BROWSER_FILES = ["install.sh", "start.sh", "stop.sh", "close-chrome.mjs"]
BROWSER_SCRIPTS = ROOT / "web" / "scripts" / "cloud-browser" / "base"
# The one difference from the hosted image: the runtime runs commands as "user",
# whose home is /home/user, not as ubuntu. install.sh and start.sh read the
# profile's place from this file when it is there (and keep /home/ubuntu/profile
# when it is not, as on the hosted service).
BROWSER_ENV_FILE = "/etc/opt/cloud-browser/env"
BROWSER_PROFILE = "/home/user/profile"
BROWSER_RECORD = Path("/etc/ni-sandbox/image.ni-cloud-browser")
# The browser's image is opt-in: built and checked only once `setup.sh
# --with-browser` has written this file, and from then on kept current by every
# run. Not the record above: setup.sh removes the records when the disk limit
# moves, and the choice must outlive that. Without it, setup.sh and check.sh do
# for the coding agent exactly what they did before there was a second image.
BROWSER_ENABLED = Path("/etc/ni-sandbox/browser.enabled")
# What the browser's scripts and the app's relay start call (start.sh, stop.sh,
# web/src/lib/cloud-browser/relay-start.ts). Not sudo: the image has none (below).
BROWSER_NEEDS = ["bash", "node", "curl", "Xvfb", "x11vnc", "pgrep", "pkill", "flock", "setsid", "nohup"]
# The last step: no way to root for the sandbox's user, so that a page that broke
# out of Chrome is that user and no more. The runtime's build gives every image's
# user "sudo" without a password, and its last phase (finalize, configure.sh in the
# runtime) runs AFTER these steps and writes that rule again; so the sudo program
# itself is removed, which finalize does not put back (it installs nothing). Root's
# password, which the runtime's first phase empties (provision.sh, `passwd -d
# root`; with Debian's `nullok`, `su` would then let anyone in), is locked: finalize
# does not touch root's. Nothing the app or this server runs in a browser needs
# root: start.sh, stop.sh and the relay run as the user, and the display's folder
# is made here.
# What this does NOT close, and cannot from a step: the same finalize phase makes
# /usr/local writable by everyone (`chmod -R 777 /usr/local`), and two of the
# runtime's own units run programs from /usr/local/bin as root
# (envd.service's ExecStartPre e2b-seed-certs, and e2b-chrony-source), at a boot
# and whenever envd is restarted. So the user can still put a program there that
# root runs later. Closing that takes one root command per sandbox after it is
# created (`chmod -R go-w /usr/local`, from the app, through the runtime's API);
# the check below reports it (README, "The cloud browser's image").
NO_ROOT_STEP = ("root", "SUDO_FORCE_REMOVE=yes DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq sudo && "
                "passwd -l root && passwd -S root | grep -q ' L '")
CHROME = "/opt/google/chrome/chrome"


def _write_file_step(path: str, text: str) -> tuple:
    # Inside the command itself, as base64: nothing to upload, and a change of a
    # script changes the definition, so the image is built again.
    data = base64.b64encode(text.encode()).decode()
    return ("root", f"mkdir -p {path.rsplit('/', 1)[0]} && printf %s '{data}' | base64 -d > {path}")


def browser_steps() -> list:
    staging = "/tmp/cloud-browser-base"
    steps = [
        RESOLVERS_STEP,
        # pgrep and pkill: the hosted image has them, a Debian image may not. Here,
        # not in install.sh, so that the hosted image's build stays what it is.
        ("root", "apt-get -q update && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq procps"),
        _write_file_step(BROWSER_ENV_FILE, f"CLOUD_BROWSER_PROFILE={BROWSER_PROFILE}\n"),
    ]
    missing = [name for name in BROWSER_FILES if not (BROWSER_SCRIPTS / name).is_file()]
    if missing:
        # A server's checkout may hold only deploy/ (a sparse checkout): the
        # browser's scripts live in the web app's folder.
        raise SystemExit(
            f"  {BROWSER_NAME}: its scripts are not in this checkout ({BROWSER_SCRIPTS}: {', '.join(missing)}). "
            "As the checkout's owner, not root: git sparse-checkout add web/scripts/cloud-browser/base"
        )
    for name in BROWSER_FILES:
        steps.append(_write_file_step(f"{staging}/{name}", (BROWSER_SCRIPTS / name).read_text()))
    steps += [
        # As root: install.sh's sudo then asks for nothing, and Chrome's policies,
        # /opt/cloud-browser and the profile's seed are written as on the hosted image.
        ("root", f"bash {staging}/install.sh && rm -rf {staging}"),
        # The profile is the runtime user's own; and the display's socket folder
        # exists already, so start.sh does not need sudo for it.
        ("root", f"chown -R user:user {BROWSER_PROFILE} && chmod 700 {BROWSER_PROFILE} && install -d -m 1777 /tmp/.X11-unix"),
        # The base image's yarn: files under /opt that are not root's, reached by
        # links in /usr/local/bin. The app closes /usr/local on every new browser
        # and refuses one whose links lead to a file that is not root's alone
        # (web/src/lib/cloud-browser/runtime-browser.ts, CLOSE_USR_LOCAL). Nothing
        # in a browser uses yarn.
        ("root", "rm -rf /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg"),
        NO_ROOT_STEP,
    ]
    return steps


class Image:
    def __init__(self, name, base, cpus, memory_mb, steps, record, check):
        self.name, self.base, self.cpus, self.memory_mb = name, base, cpus, memory_mb
        self._steps, self.record, self.check = steps, record, check

    @property
    def steps(self) -> list:
        return self._steps() if callable(self._steps) else self._steps

    def definition(self, disk_mib: int) -> str:
        return hashlib.sha256(json.dumps([self.name, self.base, self.cpus, self.memory_mb, self.steps, disk_mib], sort_keys=True).encode()).hexdigest()


def definition(disk_mib: int, image: "Image | None" = None) -> str:
    return (image or IMAGES[NAME]).definition(disk_mib)


def build_one(image: Image, disk_mib: int) -> int:
    from e2b import Template

    want = image.definition(disk_mib)
    have = image.record.read_text().strip() if image.record.exists() else ""
    if have == want and Template.alias_exists(image.name):
        print(f"  {image.name}: already built from this definition")
        return 0
    template = Template().from_image(image.base)
    for user, command in image.steps:
        template = template.run_cmd(command, user=user)
    problems = []

    def log(entry) -> None:
        text = str(entry)
        if "error" in text.lower() or "No space left" in text:
            problems.append(text[-300:])

    try:
        Template.build(template, alias=image.name, cpu_count=image.cpus, memory_mb=image.memory_mb, on_build_logs=log)
    except Exception as error:  # the build's own log says more than the exception does
        print(f"  {image.name}: the build failed: {str(error)[:300]}", file=sys.stderr)
        for line in problems[-5:]:
            print(f"    {line}", file=sys.stderr)
        return 1
    print(f"  {image.name}: built from {image.base} ({image.cpus} processors, {image.memory_mb} MiB)")
    # Only an image that passes its own check counts as built: a build can
    # succeed and still come out without the disk it was meant to have.
    if image.check(disk_mib // 1024 - 2) != 0:
        print(f"  {image.name}: built, but not as it should be: it will be built again on the next run", file=sys.stderr)
        return 1
    image.record.parent.mkdir(parents=True, exist_ok=True)
    image.record.write_text(want + "\n")
    return 0


def build(disk_mib: int) -> int:
    """The coding agent's image (what this was called before there were two)."""
    return build_one(IMAGES[NAME], disk_mib)


def _runner(sandbox):
    def out(command: str, timeout: int = 30) -> str:
        try:
            return (sandbox.commands.run(command, timeout=timeout).stdout or "").strip()
        except Exception as error:
            return f"FAILED: {str(error)[:120]}"
    return out


def _common(out, image: Image, record: Path, min_free_gib: int, folder: str) -> tuple:
    """What both images must be: their resolvers, a name looked up with them, the
    disk and the memory. Returns (ok, free GiB, MiB of memory)."""
    resolvers = out("awk '$1 == \"nameserver\" { print $2 }' /etc/resolv.conf | paste -sd, -")
    # Not one of the narrowed levels' names: a sandbox with the open internet
    # looks it up all the same, at its own resolvers.
    elsewhere = out("getent hosts example.org | wc -l")
    free_kb = out(f"df -k --output=avail {folder} | tail -1")
    memory_kb = out("awk '/^MemTotal:/ { print $2 }' /proc/meminfo")
    ok = True
    if resolvers != ",".join(RESOLVERS):
        print(f"  a sandbox from {image.name} asks the resolvers {resolvers or 'none'}, not {','.join(RESOLVERS)}: was the image built before it had that list? (sudo rm {record}, then setup.sh)")
        ok = False
    if elsewhere in ("", "0") or not elsewhere.isdigit():
        print(f"  a sandbox from {image.name} with the whole internet cannot look up a name outside the narrowed levels' names")
        ok = False
    free_gib = int(free_kb) // 1048576 if free_kb.isdigit() else -1
    if free_gib < min_free_gib:
        print(f"  only {free_gib} GiB of free disk in a sandbox from {image.name}, {min_free_gib} wanted: was the image built before the limit was raised? (sudo rm {record}, then setup.sh)")
        ok = False
    memory_mib = int(memory_kb) // 1024 if memory_kb.isdigit() else -1
    if memory_mib < image.memory_mb * 0.9:
        print(f"  a sandbox from {image.name} has {memory_mib} MiB of memory, {image.memory_mb} wanted")
        ok = False
    return ok, free_gib, memory_mib


def check(min_free_gib: int) -> int:
    """One sandbox from the coding agent's image, looked at from inside."""
    from e2b import Sandbox

    image = IMAGES[NAME]
    sandbox = Sandbox.create(NAME, timeout=120)
    try:
        out = _runner(sandbox)
        # In a login shell, from the workspace: how the agent runs every command.
        missing = out("bash -lc 'for c in %s; do command -v $c >/dev/null 2>&1 || printf \"%%s \" $c; done'" % " ".join(NEEDS))
        workspace = out("bash -lc 'cd /workspace && touch .ni-check && rm .ni-check && echo writable'")
        home = out("bash -lc 'printf %s \"$HOME\"'")
        ok, free_gib, memory_mib = _common(out, image, RECORD, min_free_gib, "/workspace")
    finally:
        sandbox.kill()
    if missing:
        print(f"  MISSING in the image: {missing}")
        ok = False
    if workspace != "writable":
        print(f"  the workspace is not writable by the sandbox's user: {workspace}")
        ok = False
    if not home.startswith("/"):
        print(f"  no home folder for the sandbox's user: {home!r}")
        ok = False
    if ok:
        print(f"  a sandbox from {NAME}: every tool the agent calls is there, the workspace is its own, {free_gib} GiB of disk free, {memory_mib} MiB of memory, {len(RESOLVERS)} resolvers")
    return 0 if ok else 1


# Run in a sandbox from the browser's image, as the host runs it
# (web/src/lib/cloud-browser/host.ts, startBrowser): start.sh detached, then CDP
# polled. Prints one line, "cdp=<status> loopback=<0|1> failed=<why>".
BROWSER_START = (
    "setsid bash /opt/cloud-browser/start.sh </dev/null >/tmp/ni-check-start.out 2>&1 & "
    "for _ in $(seq 150); do curl -s -m 1 http://127.0.0.1:9222/json/version | grep -q Browser && break; sleep 0.3; done; "
    "code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:9222/json/version); "
    # CDP on loopback only: a page in Chrome, or anything else, never reaches it from outside.
    # Both loopbacks count: Chrome also takes [::1] when the machine has one.
    "where=$(ss -Hltn | awk '$4 ~ /:9222$/ && $4 !~ /^(127\\.0\\.0\\.1|\\[::1\\]):/ { print $4 }' | paste -sd, -); "
    "wide=$([ -z \"$where\" ] && echo 0 || echo 1); "
    "printf 'cdp=%s wide=%s where=%s failed=%s\\n' \"$code\" \"$wide\" \"$where\" \"$(head -c 160 /tmp/cloud-browser-start.failed 2>/dev/null | tr '\\n' ' ')\""
)
BROWSER_STOP = (
    "bash /opt/cloud-browser/stop.sh >/dev/null 2>&1; "
    "printf 'chrome=%s xvfb=%s\\n' \"$(pgrep -fc '^/opt/google/chrome/chrome --user-data-dir=' || true)\" \"$(pgrep -xc Xvfb || true)\""
)


def check_browser(min_free_gib: int) -> int:
    """One sandbox from the browser's image: its profile is the runtime user's own
    and holds only the seed install.sh writes, start.sh brings Chrome up with CDP
    on 127.0.0.1:9222, and stop.sh closes it."""
    from e2b import Sandbox

    image = IMAGES[BROWSER_NAME]
    sandbox = Sandbox.create(BROWSER_NAME, timeout=180)
    try:
        out = _runner(sandbox)
        who = out("id -un")
        missing = out("for c in %s; do command -v $c >/dev/null 2>&1 || printf '%%s ' $c; done; [ -x %s ] || printf chrome" % (" ".join(BROWSER_NEEDS), CHROME))
        node = out("node -p 'process.versions.node.split(\".\")[0]'")
        owner = out(f"stat -c '%U %a' {BROWSER_PROFILE}")
        # Read before Chrome first runs: what every person's browser starts from.
        contents = out(f"cd {BROWSER_PROFILE} && find . -mindepth 1 | sort | paste -sd, -")
        policies = out("cat /etc/opt/chrome/policies/managed/dial8.json")
        # No way to root: no sudo that answers, without a password or otherwise.
        sudo = out("sudo -n true </dev/null >/dev/null 2>&1 && echo yes || echo no")
        local_writable = out("[ -w /usr/local/bin ] && echo yes || echo no")
        # What the app's own step will refuse (CLOSE_USR_LOCAL): a link under
        # /usr/local to a file OUTSIDE it that is missing, not root's, or writable
        # by others. (What lies inside /usr/local the app's step makes root's alone
        # itself, on every new browser; the runtime leaves it open until then.)
        loose_links = out(
            "find /usr/local -type l | while read -r l; do t=$(readlink -f \"$l\") || { printf '%s ' \"$l\"; continue; }; "
            "case \"$t\" in /usr/local/*) continue ;; esac; "
            "[ -e \"$t\" ] && [ \"$(stat -c %u \"$t\")\" = 0 ] && [ $(( 0$(stat -c %a \"$t\") & 022 )) = 0 ] || printf '%s ' \"$l\"; done"
        )
        ok, free_gib, memory_mib = _common(out, image, BROWSER_RECORD, min_free_gib, BROWSER_PROFILE)
        started = out(BROWSER_START, timeout=90)
        stopped = out(BROWSER_STOP, timeout=60)
    finally:
        sandbox.kill()
    fields = dict(part.split("=", 1) for part in (started + " " + stopped).split() if "=" in part)
    if who != "user":
        print(f"  a sandbox from {BROWSER_NAME} runs commands as {who!r}, not user: the profile's place assumes user")
        ok = False
    if missing:
        print(f"  MISSING in {BROWSER_NAME}: {missing}")
        ok = False
    if not node.isdigit() or int(node) < 22:
        print(f"  {BROWSER_NAME} has Node {node or 'none'}: the relay needs 22 or later")
        ok = False
    if owner.split(" ")[0] != "user":
        print(f"  the profile ({BROWSER_PROFILE}) is not the sandbox user's own: {owner}")
        ok = False
    if contents != "./Default,./Default/Preferences":
        print(f"  the profile in the image is not empty but for its seed: {contents[:200]}")
        ok = False
    if sudo != "no":
        print(f"  the sandbox user of {BROWSER_NAME} can use sudo ({sudo}): its last step did not hold")
        ok = False
    if loose_links:
        print(f"  in {BROWSER_NAME}, links under /usr/local lead to files that are not root's alone: {loose_links[:300]} (the app would refuse every new browser)")
        ok = False
    if local_writable == "yes":
        # Said, not failed: the runtime's last phase does it after every step of ours.
        print(f"  note: in {BROWSER_NAME} the sandbox user can write /usr/local/bin, from which root runs two of the runtime's programs (the image's comment says what closes it)")
    if "DownloadRestrictions" not in policies:
        print(f"  Chrome's policies are not in {BROWSER_NAME}")
        ok = False
    if fields.get("cdp") != "200":
        print(f"  start.sh did not bring Chrome up with CDP on 127.0.0.1:9222 (answered {fields.get('cdp', '?')}): {started[:240]}")
        ok = False
    elif fields.get("wide") != "0":
        print(f"  CDP listens beyond loopback: {fields.get('where', '?')}")
        ok = False
    if fields.get("chrome") != "0" or fields.get("xvfb") != "0":
        print(f"  stop.sh left Chrome or Xvfb running: {stopped[:120]}")
        ok = False
    if ok:
        print(f"  a sandbox from {BROWSER_NAME}: Chrome answered on 127.0.0.1:9222 and stop.sh closed it, as the user, who has no sudo; the profile is the user's own and holds only its seed; Node {node}, {free_gib} GiB of disk free, {memory_mib} MiB of memory, {len(RESOLVERS)} resolvers")
    return 0 if ok else 1


IMAGES = {
    # The steps are read when asked for, so that what is hashed is always this module's list.
    NAME: Image(NAME, BASE, CPUS, MEMORY_MB, lambda: STEPS, RECORD, lambda gib: check(gib)),
    BROWSER_NAME: Image(BROWSER_NAME, BROWSER_BASE, BROWSER_CPUS, BROWSER_MEMORY_MB, browser_steps, BROWSER_RECORD, lambda gib: check_browser(gib)),
}


def wanted(enabled: Path = None) -> list:
    """The coding agent's image always; the browser's once it was asked for."""
    names = [NAME]
    if (enabled or BROWSER_ENABLED).exists():
        names.append(BROWSER_NAME)
    return names


def resolvers() -> int:
    from e2b import Sandbox

    # A sandbox started before the image had its list asks the runtime's own
    # resolver: once the guard sends that one to this server's, it could look
    # up nothing but the narrowed levels' names.
    # The listing holds paused sandboxes too (seen on this runtime): one from
    # before the list would wake up asking the runtime's own resolver.
    listing = Sandbox.list()
    there = listing.next_items() if hasattr(listing, "next_items") else list(listing)
    if there:
        print(f"  {len(there)} sandbox(es) running or paused: wait until none is")
        return 1
    sandbox = Sandbox.create(NAME, timeout=60)
    try:
        have = (sandbox.commands.run("awk '$1 == \"nameserver\" { print $2 }' /etc/resolv.conf | paste -sd, -", timeout=30).stdout or "").strip()
    finally:
        sandbox.kill()
    if have != ",".join(RESOLVERS):
        print(f"  a new sandbox asks the resolvers {have or 'none'}, not {','.join(RESOLVERS)}: build the image first (setup.sh)")
        return 1
    print(f"  no sandbox is running, and a new one asks {have}")
    return 0


def main() -> int:
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    number = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else None
    if action == "wanted":
        print(" ".join(wanted()))
        return 0
    names = sys.argv[3:] or wanted()
    if any(name not in IMAGES for name in names):
        print(f"image.py: no image by that name (there are {', '.join(IMAGES)})", file=sys.stderr)
        return 2
    if action == "build" and number is not None:
        # Each one, the coding agent's first; one that fails does not keep the next from being built.
        return max(build_one(IMAGES[name], number) for name in names)
    if action == "check" and number is not None:
        return max(IMAGES[name].check(number) for name in names)
    if action == "resolvers":
        return resolvers()
    print("usage: image.py wanted | build <the runtime's free-disk limit, MiB> [<image>] | check <GiB of free disk a sandbox must have> [<image>] | resolvers", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
