#!/usr/bin/env python3
"""Changes values in a root-only env file (stack/.env) without showing them.

Two ways in:

  envfile.py apply <file>            new values arrive on stdin as one JSON
                                     object, {"NAME": "value", ...}
  envfile.py prompt <file> NAME...   asks for each value at the terminal, with
                                     the typing hidden

Both only replace the value of a line the file already has. A name the file
does not have is refused, so a typo cannot add a setting that nothing reads.
The file is replaced in one move and keeps its owner and mode. Nothing here
ever prints a value: messages name the setting and, at most, its length.

pull-hosted-settings.sh and set-secret.sh send this program to the server and
run it there, so the server's checkout does not need to have it.
"""
import getpass
import json
import os
import re
import stat
import sys
import tempfile
import warnings


def die(message):
    sys.exit("envfile: " + message)


def fmt(name, value):
    """One value, written so that Docker Compose reads back exactly it.

    Checked against `docker compose config`: bare for plain values; single
    quotes (taken literally) for the rest; double quotes with \\\\, \\" and \\$
    escaped only where single quotes cannot work, which is a value containing
    a single quote or ending in a backslash.
    """
    v = "" if value is None else str(value)
    if any(ord(c) < 32 or ord(c) == 127 or c in "\x85\u2028\u2029" for c in v):
        die("%s contains a line break or control character; that cannot go into an env file." % name)
    if re.fullmatch(r"[A-Za-z0-9_./:@,+=-]*", v):
        return v
    if "'" not in v and not v.endswith("\\"):
        return "'" + v + "'"
    return '"' + v.replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$") + '"'


def known_names(path):
    try:
        with open(path) as f:
            return {line.split("=", 1)[0] for line in f.read().split("\n") if "=" in line}
    except OSError as e:
        die("cannot read %s (%s). Create it first: step 14 of deploy/README.md." % (path, e.strerror))


def apply(path, new):
    # Through a link, so the file it points at is the one replaced and no
    # second copy with the old values is left behind.
    path = os.path.realpath(path)
    if not new:
        die("nothing to write; the file was not changed.")
    for name in new:
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            die("not a setting name; nothing was changed.")
    try:
        with open(path) as f:
            lines = f.read().split("\n")
        before = os.stat(path)
    except OSError as e:
        die("cannot read %s (%s). Create it first: step 14 of deploy/README.md." % (path, e.strerror))
    last = {}
    for i, line in enumerate(lines):
        name = line.split("=", 1)[0]
        if "=" in line and name in new:
            last[name] = i
    missing = sorted(set(new) - set(last))
    if missing:
        die("%s has no line for %s; nothing was changed." % (path, ", ".join(missing)))
    for name, i in last.items():
        lines[i] = name + "=" + fmt(name, new[name])

    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)), prefix=".env.")
    try:
        with os.fdopen(fd, "w") as f:
            f.write("\n".join(lines))
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, stat.S_IMODE(before.st_mode))
        os.chown(tmp, before.st_uid, before.st_gid)
        os.replace(tmp, path)
    except BaseException:
        # Never leave a second copy of the secrets lying beside the file.
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    if stat.S_IMODE(before.st_mode) & 0o077:
        print("warning: %s can be read by others than its owner (mode %o)." % (path, stat.S_IMODE(before.st_mode)))
    print("%d setting(s) written to %s" % (len(new), path))


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ("apply", "prompt"):
        die("usage: envfile.py apply <file>  |  envfile.py prompt <file> NAME...")
    command, path = sys.argv[1], sys.argv[2]
    if command == "apply":
        try:
            new = json.load(sys.stdin)
        except ValueError:
            # A connection that died half-way ends up here: nothing is applied.
            die("what arrived was incomplete; the file was not changed.")
        if not isinstance(new, dict) or not all(isinstance(v, str) for v in new.values()):
            die("what arrived was not a set of values; the file was not changed.")
        apply(path, new)
        return
    names = sys.argv[3:]
    if not names:
        die("name the settings to ask for.")
    if not sys.stdin.isatty():
        die("this needs a terminal (with ssh: ssh -t).")
    # Before the first question, so a mistyped name does not cost what was
    # already pasted.
    missing = sorted(set(names) - known_names(path))
    if missing:
        die("%s has no line for %s; nothing was asked." % (path, ", ".join(missing)))
    # getpass falls back to visible typing, with a warning, when it cannot
    # take over the terminal. Here that is an error: better no answer than a
    # secret on the screen.
    warnings.simplefilter("error", getpass.GetPassWarning)
    new = {}
    for name in names:
        try:
            value = getpass.getpass("%s (hidden as you paste, then Enter): " % name).strip()
        except getpass.GetPassWarning:
            die("this terminal cannot hide what is typed; nothing was changed.")
        if not value:
            die("%s was left empty; nothing was changed." % name)
        print("   %s: %d characters" % (name, len(value)))
        new[name] = value
    apply(path, new)


if __name__ == "__main__":
    main()
