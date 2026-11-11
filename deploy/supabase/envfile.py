#!/usr/bin/env python3
"""Changes values in a root-only env file (stack/.env) without showing them.

Two ways in:

  envfile.py apply <file>            new values arrive on stdin as one JSON
                                     object, {"NAME": "value", ...}
  envfile.py prompt <file> NAME...   asks for each value at the terminal, with
                                     the typing hidden. NAME=pattern asks for
                                     one part of a value: what is typed is
                                     percent-encoded and put where the pattern
                                     has {}, which is how a password goes into
                                     a connection string. NAME+nl keeps a line
                                     break at the end of what is typed, for a
                                     value that was stored somewhere else with
                                     one and is used with it (typing trims it).
                                     An empty answer leaves that one as it is;
                                     the others are still written

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
import urllib.parse
import warnings


def die(message):
    sys.exit("envfile: " + message)


def fmt(name, value):
    """One value, written so that Docker Compose reads back exactly it.

    Checked against `docker compose config`: bare for plain values; single
    quotes (taken literally) for the rest; double quotes with \\\\, \\" and \\$
    escaped only where single quotes cannot work, which is a value containing
    a single quote or ending in a backslash, or a line break: in double quotes
    Compose reads \\n as one (checked with a container's environment). Some
    values carry one by accident (pasted with it) and the app uses them with it,
    so it has to arrive. Any other control character is refused.
    """
    v = "" if value is None else str(value)
    if any((ord(c) < 32 and c != "\n") or ord(c) == 127 or c in "\x85\u2028\u2029" for c in v):
        die("%s contains a control character; that cannot go into an env file." % name)
    if re.fullmatch(r"[A-Za-z0-9_./:@,+=-]*", v):
        return v
    if "'" not in v and not v.endswith("\\") and "\n" not in v:
        return "'" + v + "'"
    return '"' + v.replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$").replace("\n", "\\n") + '"'


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
    asks = []
    newline = set()
    for arg in sys.argv[3:]:
        name, has_pattern, pattern = arg.partition("=")
        if name.endswith("+nl"):
            name = name[:-3]
            if has_pattern:
                die("%s: +nl and a pattern cannot go together." % name)
            newline.add(name)
        if has_pattern and pattern.count("{}") != 1:
            die("%s: the pattern after = needs {} exactly once, where the typed part goes." % name)
        asks.append((name, pattern if has_pattern else None))
    names = [name for name, _ in asks]
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
    for name, pattern in asks:
        label = "The PASSWORD ONLY, to go into %s" % name if pattern else name
        try:
            value = getpass.getpass("%s (hidden as you paste, then Enter): " % label).strip()
        except getpass.GetPassWarning:
            die("this terminal cannot hide what is typed; nothing was changed.")
        if not value:
            # Nothing at hand for this one: the rest of what was typed still counts.
            print("   %s: left as it was" % name)
            continue
        # The pattern already holds the address. An address pasted where the
        # password belongs would be accepted, encoded, and fail much later
        # with a message about the wrong thing.
        if pattern and ("://" in value or value.startswith("[")):
            die("%s: that looks like an address or a placeholder, not a password. Only the password goes here; nothing was changed." % name)
        if name in newline:
            value += "\n"
        print("   %s: %d characters%s" % (name, len(value), ", the last a line break" if name in newline else ""))
        # In a connection string the characters @ : / ? # and the like would
        # be read as part of the address, so every one of them is encoded.
        new[name] = pattern.replace("{}", urllib.parse.quote(value, safe="")) if pattern else value
    if not new:
        print("Nothing was entered; the file was not changed.")
        return
    apply(path, new)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        # Ctrl-C at a prompt: say so in a line instead of a page of traceback.
        print()
        die("cancelled; nothing was changed.")
