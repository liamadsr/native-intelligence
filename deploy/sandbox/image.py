"""The coding agent's sandbox image, built on this server's runtime.

    image.py build <MiB>   build it when it is missing, when its definition here
                           changed, or when the runtime's free-disk limit did
                           (an image keeps the limit it was built under)
    image.py check <GiB>   start one sandbox from it and see that the agent would
                           find what it needs, that much free disk included
    image.py resolvers     for resolver.sh, before it has the guard send lookups
                           to this server's resolver: no sandbox is running, and
                           a new one carries the list of resolvers below

Run by setup.sh and check.sh, as root, with the runtime's key in the environment.

The image is the agent framework's own base image (the one its hosted
sandboxes start from) with the workspace handed to the runtime's user. The
framework's version in BASE must be the one the app uses ("eve" in
web/package.json): deploy/sandbox/tests pins the two together.
"""
import hashlib
import json
import sys
from pathlib import Path

NAME = "ni-coding-agent"
BASE = "ghcr.io/vercel/eve:0.79.1"
# What one coding sandbox gets. It reserves the memory from the server's pool
# for as long as it runs (README, "Memory, and how many sandboxes fit").
CPUS = 2
MEMORY_MB = 4096
# The resolvers a sandbox from this image asks: two ordinary public ones, for
# a sandbox with the open internet. Not the one the runtime itself gives a
# sandbox (8.8.8.8): that address is the one it opens to a sandbox narrowed to
# a list of names, and with resolver.sh set up, lookups for it are answered by
# this server's own resolver, for the narrowed levels' names only (README,
# "The resolver"). A narrowed sandbox cannot reach the two below; the app
# points it at that one address when it creates it
# (web/agents/coding-agent/lib/runtime-sandbox.ts, NARROWED_RESOLVER).
RESOLVERS = ["1.1.1.1", "9.9.9.9"]
RESOLV_CONF = "".join(f"nameserver {address}\n" for address in RESOLVERS)
# Run in the image, in this order, as the user named. The runtime runs a
# sandbox's commands as its own user ("user"), not the image's: the workspace
# the agent works in has to be that user's.
STEPS = [
    ("root", "mkdir -p /workspace && chown -R user:user /workspace"),
    ("root", "printf '" + RESOLV_CONF.replace("\n", "\\n") + "' > /etc/resolv.conf"),
]
# What the agent's setup and its tools call (web/agents/coding-agent/sandbox.ts
# and the framework's shell tool). git-lfs is not among them: the hosted image
# has none either.
NEEDS = ["bash", "git", "node", "npm", "pnpm", "python3", "rg", "curl", "jq", "realpath", "tail", "wc"]
# The definition this server last built, so that "build" knows when to build again.
RECORD = Path("/etc/ni-sandbox/image.ni-coding-agent")


def definition(disk_mib: int) -> str:
    return hashlib.sha256(json.dumps([NAME, BASE, CPUS, MEMORY_MB, STEPS, disk_mib], sort_keys=True).encode()).hexdigest()


def build(disk_mib: int) -> int:
    from e2b import Template

    want = definition(disk_mib)
    have = RECORD.read_text().strip() if RECORD.exists() else ""
    if have == want and Template.alias_exists(NAME):
        print(f"  {NAME}: already built from this definition")
        return 0
    template = Template().from_image(BASE)
    for user, command in STEPS:
        template = template.run_cmd(command, user=user)
    problems = []

    def log(entry) -> None:
        text = str(entry)
        if "error" in text.lower() or "No space left" in text:
            problems.append(text[-300:])

    try:
        Template.build(template, alias=NAME, cpu_count=CPUS, memory_mb=MEMORY_MB, on_build_logs=log)
    except Exception as error:  # the build's own log says more than the exception does
        print(f"  {NAME}: the build failed: {str(error)[:300]}", file=sys.stderr)
        for line in problems[-5:]:
            print(f"    {line}", file=sys.stderr)
        return 1
    print(f"  {NAME}: built from {BASE} ({CPUS} processors, {MEMORY_MB} MiB)")
    # Only an image that passes its own check counts as built: a build can
    # succeed and still come out without the disk it was meant to have.
    if check(disk_mib // 1024 - 2) != 0:
        print(f"  {NAME}: built, but not as it should be: it will be built again on the next run", file=sys.stderr)
        return 1
    RECORD.parent.mkdir(parents=True, exist_ok=True)
    RECORD.write_text(want + "\n")
    return 0


def check(min_free_gib: int) -> int:
    from e2b import Sandbox

    sandbox = Sandbox.create(NAME, timeout=120)
    try:
        def out(command: str) -> str:
            try:
                return (sandbox.commands.run(command, timeout=30).stdout or "").strip()
            except Exception as error:
                return f"FAILED: {str(error)[:120]}"

        # In a login shell, from the workspace: how the agent runs every command.
        missing = out("bash -lc 'for c in %s; do command -v $c >/dev/null 2>&1 || printf \"%%s \" $c; done'" % " ".join(NEEDS))
        workspace = out("bash -lc 'cd /workspace && touch .ni-check && rm .ni-check && echo writable'")
        home = out("bash -lc 'printf %s \"$HOME\"'")
        free_kb = out("df -k --output=avail /workspace | tail -1")
        resolvers = out("awk '$1 == \"nameserver\" { print $2 }' /etc/resolv.conf | paste -sd, -")
        # Not one of the narrowed levels' names: a sandbox with the open internet
        # looks it up all the same, at its own resolvers.
        elsewhere = out("getent hosts example.org | wc -l")
        memory_kb = out("awk '/^MemTotal:/ { print $2 }' /proc/meminfo")
    finally:
        sandbox.kill()
    ok = True
    if missing:
        print(f"  MISSING in the image: {missing}")
        ok = False
    if workspace != "writable":
        print(f"  the workspace is not writable by the sandbox's user: {workspace}")
        ok = False
    if not home.startswith("/"):
        print(f"  no home folder for the sandbox's user: {home!r}")
        ok = False
    if resolvers != ",".join(RESOLVERS):
        print(f"  a sandbox asks the resolvers {resolvers or 'none'}, not {','.join(RESOLVERS)}: was the image built before it had that list? (sudo rm {RECORD}, then setup.sh)")
        ok = False
    if elsewhere in ("", "0") or not elsewhere.isdigit():
        print("  a sandbox with the whole internet cannot look up a name outside the narrowed levels' names")
        ok = False
    free_gib = int(free_kb) // 1048576 if free_kb.isdigit() else -1
    if free_gib < min_free_gib:
        print(f"  only {free_gib} GiB of free disk in a sandbox, {min_free_gib} wanted: was the image built before the limit was raised? (sudo rm {RECORD}, then setup.sh)")
        ok = False
    memory_mib = int(memory_kb) // 1024 if memory_kb.isdigit() else -1
    if memory_mib < MEMORY_MB * 0.9:
        print(f"  a sandbox has {memory_mib} MiB of memory, {MEMORY_MB} wanted")
        ok = False
    if ok:
        print(f"  a sandbox from {NAME}: every tool the agent calls is there, the workspace is its own, {free_gib} GiB of disk free, {memory_mib} MiB of memory, {len(RESOLVERS)} resolvers")
    return 0 if ok else 1


def resolvers() -> int:
    from e2b import Sandbox

    # A sandbox started before the image had its list asks the runtime's own
    # resolver: once the guard sends that one to this server's, it could look
    # up nothing but the narrowed levels' names.
    listing = Sandbox.list()
    running = listing.next_items() if hasattr(listing, "next_items") else list(listing)
    if running:
        print(f"  {len(running)} sandbox(es) running: wait until none is")
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
    if action == "build" and number is not None:
        return build(number)
    if action == "check" and number is not None:
        return check(number)
    if action == "resolvers":
        return resolvers()
    print("usage: image.py build <the runtime's free-disk limit, MiB> | check <GiB of free disk a sandbox must have> | resolvers", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
