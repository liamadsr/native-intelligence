#!/usr/bin/env python3
"""Fold a Licenses/ folder into one self-contained THIRD_PARTY_NOTICES.txt.

    third_party_notices.py LICENSES_DIR PART...

LICENSES_DIR holds one folder per part of the app (PART, in the order given):
PART/NOTICES.txt names the part's third-party components, and every other file
under PART/ is a license or notice text those notices cite. Writes
LICENSES_DIR/THIRD_PARTY_NOTICES.txt:

    header
    Part 1: every PART/NOTICES.txt, in full
    Part 2: every license/notice file, in full, each under a heading with its
            path (PART/...). Byte-identical files are printed once, under the
            paths of all of them.

Exits 1 — writing nothing — if a PART has no NOTICES.txt, if LICENSES_DIR has
a folder that is not a listed PART (its notices would be left out), or if a
file is not text.
"""

from __future__ import annotations

import os
import sys

OUT_NAME = "THIRD_PARTY_NOTICES.txt"
RULE = "=" * 80
THIN = "-" * 80

HEADER = """\
THIRD-PARTY SOFTWARE NOTICES
Native Intelligence for macOS

Native Intelligence includes the third-party open-source software listed in this file, and
this file holds every notice and license text for it:

  Part 1 lists each component, grouped by the part of the app it ships in,
         with its version, its license and its authors or copyright
         holders. Where a license asks that its source code be available,
         the component's Source or Repository link points to it.
  Part 2 reproduces in full every license and notice file named in Part 1.
         A text that several files share word for word is printed once,
         under the paths of all of them.

The same folders and files are inside the app, in
Native Intelligence.app/Contents/Resources/Licenses/. Part 2 gives each file's path in that
folder; the paths inside a part's notices are relative to that part's own
folder (Licenses/<part>/).

Parts of the app:
{parts}
"""


def fail(message: str) -> int:
    print(f"[licenses] ERROR: {message}", file=sys.stderr)
    return 1


def read_text(path: str) -> str:
    with open(path, "rb") as f:
        data = f.read()
    if b"\0" in data:
        raise ValueError(f"{path} is not a text file")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        print(f"[licenses] note: {path} is not UTF-8; reading it as Latin-1", file=sys.stderr)
        text = data.decode("latin-1")
    return text.lstrip("﻿")


def main(argv: list) -> int:
    if len(argv) < 2:
        return fail("usage: third_party_notices.py LICENSES_DIR PART...")
    root, parts = argv[0], argv[1:]
    if len(set(parts)) != len(parts):
        return fail(f"a part is listed twice: {' '.join(parts)}")
    if not os.path.isdir(root):
        return fail(f"{root} is not a folder")

    present = sorted(e for e in os.listdir(root) if os.path.isdir(os.path.join(root, e)))
    unlisted = [e for e in present if e not in parts]
    if unlisted:
        return fail(f"{root} has folders no part names: {' '.join(unlisted)} — their notices would be left out")

    notices, groups, order = {}, {}, []
    try:
        for part in parts:
            folder = os.path.join(root, part)
            path = os.path.join(folder, "NOTICES.txt")
            if not os.path.isfile(path) or os.path.getsize(path) == 0:
                return fail(f"{part} has no NOTICES.txt (or it is empty)")
            notices[part] = read_text(path).rstrip("\n")
            files = []
            for dirpath, dirs, names in os.walk(folder):
                dirs.sort()
                for name in names:
                    rel = os.path.relpath(os.path.join(dirpath, name), folder)
                    if rel != "NOTICES.txt":
                        files.append(rel)
            for rel in sorted(files):
                text = read_text(os.path.join(folder, rel))
                if not text.strip():
                    return fail(f"{part}/{rel} is empty")
                key = text
                if key not in groups:
                    groups[key] = []
                    order.append(key)
                groups[key].append(f"{part}/{rel}")
    except (OSError, ValueError) as e:
        return fail(str(e))

    width = max(len(p) for p in parts) + 3
    listing = "\n".join(
        f"  {part.ljust(width)}{notices[part].splitlines()[0].strip()}" for part in parts
    )
    out = [HEADER.format(parts=listing), "", "PART 1: COMPONENTS AND NOTICES", ""]
    for part in parts:
        out += ["", RULE, f"{part}  (Licenses/{part}/)", RULE, "", notices[part], ""]
    out += ["", "", "PART 2: LICENSE AND NOTICE TEXTS", ""]
    for text in order:
        paths = groups[text]
        out += ["", THIN, *paths]
        if len(paths) > 1:
            out.append(f"  (the same text, in {len(paths)} files)")
        out += [THIN, "", text.rstrip("\n"), ""]

    result = "\n".join(out) + "\n"
    target = os.path.join(root, OUT_NAME)
    tmp = target + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(result)
    os.replace(tmp, target)

    n_files = sum(len(p) for p in groups.values())
    print(
        f"[licenses] {OUT_NAME}: {len(parts)} parts ({', '.join(parts)}), "
        f"{n_files} license/notice files as {len(order)} distinct texts, "
        f"{len(result.encode('utf-8')):,} bytes",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
