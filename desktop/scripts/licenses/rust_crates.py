#!/usr/bin/env python3
"""Third-party notices for the Rust crates linked into the Dial8 app binary.

    rust_crates.py [--manifest-dir DIR] [--package NAME] [--target TRIPLE]
                   [--features LIST] OUT

Writes OUT/<package>/ (replacing it):

    NOTICES.txt                   one entry per crate: name, version, license
                                  expression, authors, repository, and the
                                  license texts that go with it
    <crate>-<version>/<file>      the crate's own license files, verbatim
    <crate>-<version>/<file>.notice.txt
                                  a notice written inside one of the crate's
                                  source files (source_notices.tsv), verbatim

Which crates: exactly the ones Cargo compiles into the package's binary for
TARGET, as Cargo's own build graph reports them —

    cargo tree --locked --offline -e normal,no-proc-macro --target TARGET
               -p PACKAGE --features LIST --prefix none -f '{p}'

run in --manifest-dir. Normal dependencies only (build- and dev-dependencies
are never linked), nothing reached through a procedural macro (it runs inside
the compiler), dependencies scoped to other platforms left out, and features
resolved the way the build resolves them. LIST defaults to
tauri/custom-protocol, the feature `cargo tauri build` adds (the release
build); TARGET defaults to the host, which `cargo tauri build` builds for.
`cargo metadata` supplies each crate's details (license, authors, repository,
source directory) — never the crate list: its resolve graph merges build-time
features and weak optional dependencies (`dep?/feature`) in, and lists crates
the binary does not contain. As a regression check, crates that only ever run
at build time (NOT_LINKED) must not be in the set. Path packages inside
--manifest-dir are Dial8's own code and are skipped.

Which files: every file in the crate's source directory (and below it) whose
name starts with LICENSE, LICENCE, COPYING, COPYRIGHT, NOTICE, UNLICENSE or
THIRD-PARTY / THIRD_PARTY, or that sits in a LICENSES/ folder, and is not
source code; plus the crate's `license-file` if it sets one.

When a crate's files don't contain the text of any one way to satisfy its
license expression (it ships no license file, or ships only the MIT half of
`BSD-3-Clause AND MIT`), the missing texts come from spdx/<id>.txt, written as
<crate>-<version>/LICENSE-<id>.generated.txt. Their copyright line names the
crate's copyright holders: from holders.tsv when that file has a row for the
crate (with the evidence on disk for it), else the crate's Cargo `authors`.
Of several alternatives it uses MIT, else Apache-2.0, else the only one there
is.

Notices written inside a crate's source files that its license files don't
carry — for code or text it took from elsewhere — are listed in
source_notices.tsv and copied out unchanged. To keep that list complete, every
compiled source file of every crate is scanned for license grants whose
conditions bind binary copies (SOURCE_GRANTS: MIT, ISC, BSD's binary-form
clause, W3C): a grant the crate's license texts don't carry must sit inside a
listed block.

Anything it cannot cover — no license expression and no license file, an
expression it cannot parse, a license with no template, a choice it cannot
make, a license grant in a source file that nothing carries — is listed on
stderr and exits 1. Nothing is skipped silently.

Output is deterministic: crates sorted by name then version, files sorted.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATES = os.path.join(HERE, "spdx")
HOLDERS_TABLE = os.path.join(HERE, "holders.tsv")
SOURCE_NOTICES_TABLE = os.path.join(HERE, "source_notices.tsv")
PLACEHOLDER = "<year> <copyright holders>"
# In holders.tsv, between holders that each get their own copyright line.
HOLDER_SEPARATOR = " | "
# Templates that must carry the copyright placeholder line.
NEEDS_HOLDER = {"MIT", "BSD-3-Clause", "Zlib"}
PREFERRED = ("MIT", "Apache-2.0")
# The feature `cargo tauri build` adds (tauri-cli: Rust::build_options).
RELEASE_FEATURES = "tauri/custom-protocol"

# Crates that only ever run while the app is compiled. `cargo metadata` lists
# them among the app's dependencies; Cargo's build graph must not. If one shows
# up, the crate list is wrong (or a dependency change really links it now —
# then remove it here, after checking with `cargo tree -i <crate>`).
NOT_LINKED = {
    "proc-macro2": "procedural-macro support; runs inside the compiler",
    "quote": "procedural-macro support; runs inside the compiler",
    "schemars": "tauri-utils' build-time feature, used by tauri-build",
    "swift-rs": "tauri-utils' build-time feature, used by tauri-build",
    "quinn": "reqwest's HTTP/3 support, which the app does not enable",
    "quinn-proto": "reqwest's HTTP/3 support, which the app does not enable",
    "quinn-udp": "reqwest's HTTP/3 support, which the app does not enable",
}

LICENSE_NAME = re.compile(
    r"^(licen[sc]e|copying|copyright|notice|unlicense|third[-_]?party)", re.IGNORECASE
)
# REUSE-style layout: the texts sit in LICENSES/<SPDX id>.txt.
LICENSE_DIR = re.compile(r"^licen[sc]es?$", re.IGNORECASE)
# Files that match LICENSE_NAME but are code, not license texts (objc2-foundation
# has src/copying.rs).
SOURCE_EXT = {
    ".rs", ".c", ".h", ".cc", ".cpp", ".hpp", ".m", ".mm", ".s", ".asm",
    ".py", ".sh", ".toml", ".json", ".yml", ".yaml", ".in", ".pl", ".go",
    ".js", ".ts", ".html", ".swift",
}

CRATES_IO = {
    "registry+https://github.com/rust-lang/crates.io-index",
    "sparse+https://index.crates.io/",
}

# License grants written into source files, by the condition that binds binary
# copies, as normalize() leaves it. A crate's compiled source file that carries
# one its license texts don't must have that notice in source_notices.tsv.
SOURCE_GRANTS = {
    "MIT": "the above copyright notice and this permission notice shall be included in all copies",
    "ISC": "provided that the above copyright notice and this permission notice appear in all copies",
    "BSD": "redistributions in binary form must reproduce the above copyright notice",
    "W3C": "provided that you include the following on all copies",
}
# What that scan reads: Rust, and the C, C++, Objective-C and assembly that
# -sys crates compile in; never folders that aren't compiled into a
# dependent's binary.
COMPILED_EXT = {".rs", ".c", ".h", ".cc", ".cpp", ".hpp", ".m", ".mm", ".s", ".asm", ".inc"}
NOT_COMPILED_DIRS = {".git", "target", "tests", "benches", "examples", "fuzz"}


class Failure(Exception):
    pass


def host_target(cwd: str) -> str:
    """The host triple of the toolchain that builds in `cwd` (`rustc -vV`)."""
    rustc = os.environ.get("RUSTC", "rustc")
    out = subprocess.run([rustc, "-vV"], cwd=cwd, check=True, capture_output=True, text=True).stdout
    for line in out.splitlines():
        if line.startswith("host: "):
            return line[len("host: "):].strip()
    raise Failure("`rustc -vV` printed no host triple")


# ─── SPDX expressions ────────────────────────────────────────────────────────


def alternatives(expr: str) -> list:
    """An SPDX expression as the list of license sets that each satisfy it
    (OR of ANDs). "X WITH Y" stays one id. Accepts the legacy "MIT/Apache-2.0"."""
    tokens = re.findall(r"\(|\)|[A-Za-z0-9.+:_-]+", expr.replace("/", " OR "))
    pos = 0

    def peek():
        return tokens[pos] if pos < len(tokens) else None

    def take():
        nonlocal pos
        if pos >= len(tokens):
            raise Failure(f"can't parse license expression {expr!r}")
        pos += 1
        return tokens[pos - 1]

    def keyword(tok, word):
        return tok is not None and tok.upper() == word

    def disjunction():
        alts = conjunction()
        while keyword(peek(), "OR"):
            take()
            alts = alts + conjunction()
        return alts

    def conjunction():
        alts = atom()
        while keyword(peek(), "AND"):
            take()
            right = atom()
            alts = [a | b for a in alts for b in right]
        return alts

    def atom():
        tok = take()
        if tok == "(":
            alts = disjunction()
            if take() != ")":
                raise Failure(f"can't parse license expression {expr!r}")
            return alts
        if tok == ")" or keyword(tok, "AND") or keyword(tok, "OR") or keyword(tok, "WITH"):
            raise Failure(f"can't parse license expression {expr!r}")
        if keyword(peek(), "WITH"):
            take()
            tok = f"{tok} WITH {take()}"
        return [frozenset([tok])]

    alts = disjunction()
    if pos != len(tokens) or not alts:
        raise Failure(f"can't parse license expression {expr!r}")
    # Deduplicate, keep a stable order.
    unique = []
    for alt in alts:
        if alt not in unique:
            unique.append(alt)
    return unique


def normalize(text: str) -> str:
    """`text` lower-cased, with plain quotes and dashes, comment markers at line
    starts removed and whitespace folded: a phrase then matches however it is
    wrapped, in a license file or in a source file's comments."""
    t = text.lower()
    for a, b in (("’", "'"), ("‘", "'"), ("“", '"'), ("”", '"'),
                 ("–", "-"), ("—", "-")):
        t = t.replace(a, b)
    # Some license files are a comment block too (untrusted: "// Permission to use, ...").
    t = "\n".join(re.sub(r"^\s*(//+!?|#+|/?\*+!?|;+)", "", line) for line in t.splitlines())
    return " ".join(t.split())


def detect(text: str) -> set:
    """SPDX ids whose full text appears in `text` (a license file)."""
    t = normalize(text)
    found = set()
    if "permission is hereby granted, free of charge, to any person obtaining a copy of this software" in t:
        found.add("MIT" if "the above copyright notice and this permission notice shall be included" in t else "MIT-0")
    if "apache license" in t and "version 2.0" in t and "terms and conditions for use, reproduction, and distribution" in t:
        found.add("Apache-2.0")
        if "llvm exceptions to the apache 2.0 license" in t:
            found.add("Apache-2.0 WITH LLVM-exception")
    if "redistribution and use in source and binary forms" in t:
        found.add("BSD-3-Clause" if "endorse or promote products derived from this software" in t else "BSD-2-Clause")
    for grant in ("permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted",
                  "permission to use, copy, modify, and distribute this software for any purpose with or without fee is hereby granted"):
        if grant in t:
            found.add("ISC" if "provided that the above copyright notice and this permission notice appear in all copies" in t else "0BSD")
    if "this software is provided 'as-is'" in t and "altered source versions must be plainly marked" in t:
        found.add("Zlib")
    if "mozilla public license version 2.0" in t and "1. definitions" in t:
        found.add("MPL-2.0")
    if "this is free and unencumbered software released into the public domain" in t:
        found.add("Unlicense")
    if "boost software license - version 1.0" in t:
        found.add("BSL-1.0")
    if "unicode license v3" in t:
        found.add("Unicode-3.0")
    if "community data license agreement" in t and "permissive" in t and "version 2.0" in t:
        found.add("CDLA-Permissive-2.0")
    if "cc0 1.0 universal" in t:
        found.add("CC0-1.0")
    return found


def choose(alts: list, covered: set):
    """The alternative to satisfy: (alternative, missing ids). An alternative
    the crate's own files already cover wins; otherwise MIT, else Apache-2.0,
    else the only alternative, each with the fewest texts to generate."""
    ranked = sorted(alts, key=lambda a: (len(a - covered), len(a), sorted(a)))
    for alt in ranked:
        if not alt - covered:
            return alt, set()
    for preferred in PREFERRED:
        with_it = [a for a in ranked if preferred in a]
        if with_it:
            return with_it[0], with_it[0] - covered
    if len(alts) == 1:
        return alts[0], alts[0] - covered
    raise Failure(
        "no license file covers any of "
        + " / ".join("+".join(sorted(a)) for a in alts)
        + ", and none of them is MIT or Apache-2.0 to fall back on"
    )


def template(spdx: str) -> str:
    path = os.path.join(TEMPLATES, f"{spdx}.txt")
    if not os.path.isfile(path):
        raise Failure(f"needs the {spdx} text, and there is no template {os.path.relpath(path, HERE)}")
    with open(path, encoding="utf-8") as f:
        text = f.read()
    if spdx in NEEDS_HOLDER and PLACEHOLDER not in text:
        raise Failure(f"template spdx/{spdx}.txt has lost its '{PLACEHOLDER}' line")
    return text


# ─── copyright holders for generated texts ───────────────────────────────────


class Holders:
    """holders.tsv: crate, license (an SPDX id, or * for any), holders (" | "
    between holders that each get a copyright line), evidence. Consulted
    before the crate's Cargo authors when a standard text is generated.
    Remembers which rows were used."""

    def __init__(self, path: str = HOLDERS_TABLE):
        self.path = path
        self.rows = {}
        self.used = set()
        if not os.path.isfile(path):
            raise Failure(f"{os.path.relpath(path, HERE)} is missing")
        with open(path, encoding="utf-8") as f:
            for number, line in enumerate(f, 1):
                line = line.rstrip("\n")
                if not line.strip() or line.lstrip().startswith("#"):
                    continue
                fields = line.split("\t")
                where = f"{os.path.basename(path)} line {number}"
                if len(fields) != 4 or not all(field.strip() for field in fields):
                    raise Failure(f"{where}: want 4 tab-separated fields "
                                  "(crate, license, holders, evidence), all filled in")
                crate, spdx, holders, _evidence = (field.strip() for field in fields)
                if (crate, spdx) in self.rows:
                    raise Failure(f"{where}: {crate} / {spdx} is listed twice")
                self.rows[(crate, spdx)] = holders

    def lookup(self, pkg: dict, spdx: str):
        """(holders, from_table) for the `spdx` text generated for `pkg`."""
        for key in ((pkg["name"], spdx), (pkg["name"], "*")):
            if key in self.rows:
                self.used.add(key)
                return self.rows[key], True
        if pkg["authors"]:
            return ", ".join(pkg["authors"]), False
        return f"the {pkg['name']} authors", False

    def unused(self) -> list:
        return sorted(key for key in self.rows if key not in self.used)


# ─── notices inside source files ─────────────────────────────────────────────


class SourceNotices:
    """source_notices.tsv: crate, version, file, lines (first-last), marker,
    evidence — notices written inside a crate's source files, to copy out as
    they are. Remembers which crates' rows were used."""

    def __init__(self, path: str = SOURCE_NOTICES_TABLE):
        self.rows = {}
        self.used = set()
        if not os.path.isfile(path):
            raise Failure(f"{os.path.relpath(path, HERE)} is missing")
        with open(path, encoding="utf-8") as f:
            for number, line in enumerate(f, 1):
                line = line.rstrip("\n")
                if not line.strip() or line.lstrip().startswith("#"):
                    continue
                fields = line.split("\t")
                where = f"{os.path.basename(path)} line {number}"
                if len(fields) != 6 or not all(field.strip() for field in fields):
                    raise Failure(f"{where}: want 6 tab-separated fields "
                                  "(crate, version, file, lines, marker, evidence), all filled in")
                crate, version, rel, span, marker, _evidence = (field.strip() for field in fields)
                m = re.fullmatch(r"(\d+)-(\d+)", span)
                if not m or not 1 <= int(m[1]) <= int(m[2]):
                    raise Failure(f"{where}: lines must be first-last, counted from 1 (not {span!r})")
                rel = os.path.normpath(rel)
                if os.path.isabs(rel) or rel.startswith(".."):
                    raise Failure(f"{where}: {rel!r} leaves the crate's folder")
                row = (rel, int(m[1]), int(m[2]), marker)
                rows = self.rows.setdefault((crate, version), [])
                if row[:3] in [r[:3] for r in rows]:
                    raise Failure(f"{where}: {crate} {version} {rel} lines {span} is listed twice")
                rows.append(row)

    def lookup(self, pkg: dict) -> list:
        """[(file, first, last, marker)] for `pkg`."""
        key = (pkg["name"], pkg["version"])
        if key in self.rows:
            self.used.add(key)
        return self.rows.get(key, [])

    def unused(self) -> list:
        return sorted(key for key in self.rows if key not in self.used)


def copy_block(src: str, rel: str, first: int, last: int, marker: str, dest: str) -> str:
    """Copies lines first..last of src/rel to `dest`, unchanged, and returns them."""
    path = os.path.join(src, rel)
    if not os.path.isfile(path):
        raise Failure(f"source_notices.tsv: {rel} is not in the crate")
    with open(path, "rb") as f:
        lines = f.read().split(b"\n")
    if lines and lines[-1] == b"":
        lines.pop()  # the newline that ends the last line
    if last > len(lines):
        raise Failure(f"source_notices.tsv: {rel} has {len(lines)} lines, not {last}")
    block = b"\n".join(lines[first - 1:last]) + b"\n"
    try:
        text = block.decode("utf-8")
    except UnicodeDecodeError:
        raise Failure(f"source_notices.tsv: lines {first}-{last} of {rel} are not UTF-8 text") from None
    if marker not in text:
        raise Failure(f"source_notices.tsv: lines {first}-{last} of {rel} don't contain {marker!r} "
                      "— the file has changed; find the notice's lines again")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "wb") as f:
        f.write(block)
    return text


def source_grants(src: str) -> dict:
    """{file: {grant: occurrences}} for the crate's compiled source files that
    carry SOURCE_GRANTS, files relative to `src`."""
    found = {}
    for root, dirs, files in os.walk(src):
        dirs[:] = sorted(d for d in dirs if d not in NOT_COMPILED_DIRS)
        for name in sorted(files):
            if os.path.splitext(name)[1].lower() not in COMPILED_EXT:
                continue
            rel = os.path.relpath(os.path.join(root, name), src)
            if rel == "build.rs":  # runs while the crate is compiled
                continue
            with open(os.path.join(root, name), encoding="utf-8", errors="replace") as f:
                text = normalize(f.read())
            counts = {grant: text.count(phrase) for grant, phrase in SOURCE_GRANTS.items() if phrase in text}
            if counts:
                found[rel] = counts
    return found


# ─── crates ──────────────────────────────────────────────────────────────────


def version_key(version: str):
    return [int(p) if p.isdigit() else p for p in re.split(r"[.+-]", version)]


TREE_LINE = re.compile(r"^(\S+) v(\S+)(?: \((.+)\))?$")
SEEN_BEFORE = " (*)"  # cargo tree's mark for a package whose subtree it already printed


def build_graph(manifest_dir: str, package: str, target: str, features: str) -> set:
    """(name, version, source hint) of every package in Cargo's build graph
    for the package's binary; the hint is cargo tree's parenthesised source
    (a path or git URL), None for crates.io."""
    cargo = os.environ.get("CARGO", "cargo")
    # --color never: a CI's CARGO_TERM_COLOR=always would colour the "(*)" marks.
    cmd = [cargo, "tree", "--locked", "--offline", "--color", "never", "-e", "normal,no-proc-macro",
           "--target", target, "-p", package, "--prefix", "none", "-f", "{p}"]
    if features:
        cmd += ["--features", features]
    out = subprocess.run(cmd, cwd=manifest_dir, check=True, capture_output=True, text=True).stdout
    graph = set()
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.endswith(SEEN_BEFORE):
            line = line[: -len(SEEN_BEFORE)]
        m = TREE_LINE.match(line)
        if not m:
            raise Failure(f"can't read this `cargo tree` line: {line!r}")
        name, version, hint = m.groups()
        if hint == "proc-macro":  # never with no-proc-macro, but be exact
            raise Failure(f"`cargo tree` listed the procedural macro {name} {version}")
        graph.add((name, version, hint))
    if not graph:
        raise Failure("`cargo tree` printed nothing")
    return graph


def linked_crates(meta: dict, graph: set, package: str, manifest_dir: str) -> list:
    """The metadata packages for the build graph, minus Dial8's own."""
    by_name_version = {}
    for pkg in meta["packages"]:
        by_name_version.setdefault((pkg["name"], pkg["version"]), []).append(pkg)

    def first_party(pkg):
        if pkg["source"] is not None:
            return False
        path = os.path.realpath(os.path.dirname(pkg["manifest_path"]))
        return os.path.commonpath([path, manifest_dir]) == manifest_dir

    def matches_hint(pkg, hint):
        if hint is None:
            return pkg["source"] in CRATES_IO
        if pkg["source"] is None:
            return os.path.realpath(os.path.dirname(pkg["manifest_path"])) == os.path.realpath(hint)
        return hint in pkg["source"] or pkg["source"].split("+", 1)[-1].startswith(hint.split("#")[0])

    crates, roots = {}, set()
    for name, version, hint in sorted(graph, key=str):
        candidates = by_name_version.get((name, version), [])
        if len(candidates) > 1:
            candidates = [p for p in candidates if matches_hint(p, hint)]
        if len(candidates) != 1:
            raise Failure(f"`cargo tree` lists {name} {version}"
                          + (f" ({hint})" if hint else "")
                          + f", which matches {len(candidates)} packages in `cargo metadata`")
        pkg = candidates[0]
        if name == package and pkg["source"] is None:
            roots.add(pkg["id"])
        elif not first_party(pkg):
            crates[pkg["id"]] = pkg
    if len(roots) != 1:
        raise Failure(f"package {package!r} is not (once) at the root of `cargo tree`")
    return sorted(crates.values(), key=lambda p: (p["name"].lower(), p["name"], version_key(p["version"])))


def license_files(src: str, pkg: dict) -> list:
    """Paths relative to `src`, sorted."""
    found = set()
    for root, dirs, files in os.walk(src):
        dirs[:] = sorted(d for d in dirs if d not in (".git", "target"))
        in_license_dir = LICENSE_DIR.match(os.path.basename(root)) and root != src
        for name in files:
            if os.path.splitext(name)[1].lower() in SOURCE_EXT:
                continue
            if LICENSE_NAME.match(name) or in_license_dir:
                found.add(os.path.relpath(os.path.join(root, name), src))
    if pkg.get("license_file"):
        declared = os.path.normpath(pkg["license_file"])
        if declared.startswith(".."):
            declared = os.path.basename(declared)  # cargo package puts it at the root
        if not os.path.isfile(os.path.join(src, declared)):
            raise Failure(f"license-file {pkg['license_file']!r} is not in {src}")
        found.add(declared)
    return sorted(found)


def write_crate(pkg: dict, out: str, holders: Holders, source_notices: SourceNotices = None) -> tuple:
    """Copies/generates the crate's license texts under out/<crate>-<version>/.
    Returns (NOTICES entry lines, own files, generated files, in-source notices).

    The texts come from the crate's source directory, or — for a crate known
    only from a record of its files (rust_std.py) — from pkg["notice_files"],
    a list of (relative path, text).

    With a source directory, the crate's rows in `source_notices` are copied
    out too, and its compiled source files are scanned: a license grant
    (SOURCE_GRANTS) that the crate's license texts don't carry must be inside
    one of those rows' blocks, else Failure."""
    folder = f"{pkg['name']}-{pkg['version']}"
    expr = pkg.get("license")
    if "notice_files" in pkg:
        src = None
        files = [(os.path.normpath(rel), text) for rel, text in pkg["notice_files"]]
        for rel, _ in files:
            if os.path.isabs(rel) or rel.startswith(".."):
                raise Failure(f"notice file path {rel!r} leaves the crate's folder")
    else:
        src = os.path.dirname(pkg["manifest_path"])
        files = [(rel, None) for rel in license_files(src, pkg)]
    if not expr and not files:
        raise Failure("has no license expression and no license file")

    covered = set()
    texts = []
    carried = []  # every license text written, normalized
    for rel, text in files:
        dest = os.path.join(out, folder, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if text is None:
            shutil.copyfile(os.path.join(src, rel), dest)
        else:
            with open(dest, "w", encoding="utf-8") as f:
                f.write(text)
        with open(dest, encoding="utf-8", errors="replace") as f:
            content = f.read()
        covered |= detect(content)
        carried.append(normalize(content))
        texts.append(f"{folder}/{rel}")

    generated = []
    if expr:
        _, missing = choose(alternatives(expr), covered)
        for spdx in sorted(missing):
            text = template(spdx)
            holder, from_table = None, False
            if spdx in NEEDS_HOLDER:
                holder, from_table = holders.lookup(pkg, spdx)
                text = fill_holders(text, holder)
            name = f"LICENSE-{spdx.replace(' ', '-')}.generated.txt"
            os.makedirs(os.path.join(out, folder), exist_ok=True)
            with open(os.path.join(out, folder, name), "w", encoding="utf-8") as f:
                f.write(text)
            carried.append(normalize(text))
            generated.append((spdx, f"{folder}/{name}", holder if from_table else None))

    rows = source_notices.lookup(pkg) if source_notices else []
    notices = []
    if src is None and rows:
        raise Failure("source_notices.tsv lists notices in its source files, which aren't available")
    if src is not None:
        blocks = {}
        for rel, first, last, marker in rows:
            name = f"{rel}.notice.txt"
            text = copy_block(src, rel, first, last, marker, os.path.join(out, folder, name))
            blocks.setdefault(rel, []).append(normalize(text))
            notices.append((rel, first, last, f"{folder}/{name}"))
        uncovered = []
        for rel, counts in source_grants(src).items():
            for grant, count in sorted(counts.items()):
                phrase = SOURCE_GRANTS[grant]
                if any(phrase in text for text in carried):
                    continue
                if sum(block.count(phrase) for block in blocks.get(rel, [])) < count:
                    uncovered.append(f"{rel} ({grant})")
        if uncovered:
            raise Failure("its source files grant licenses its license texts don't carry: "
                          + ", ".join(uncovered)
                          + " — copy each notice out with a row in source_notices.tsv")

    lines = [f"{pkg['name']} {pkg['version']}"]
    lines.append(f"  License: {expr}" if expr else f"  License: see {pkg['license_file']}")
    if pkg["authors"]:
        lines.append(f"  Authors: {', '.join(pkg['authors'])}")
    if pkg.get("repository"):
        lines.append(f"  Repository: {pkg['repository']}")
    if pkg["source"] in CRATES_IO:
        lines.append(f"  Source: https://crates.io/crates/{pkg['name']}/{pkg['version']}")
    elif pkg["source"]:
        lines.append(f"  Source: {pkg['source']}")
    if texts:
        lines.append("  License files: " + ", ".join(texts))
    for spdx, path, holder in generated:
        why = "ships no license file" if not texts else f"ships no {spdx} text"
        lines.append(f"  Standard {spdx} text (the crate {why}): {path}")
        if holder:
            lines.append("    naming the copyright holders: " + "; ".join(holder.split(HOLDER_SEPARATOR)))
    for rel, first, last, path in notices:
        lines.append(f"  In-source notice ({rel}, lines {first}-{last}): {path}")
    return lines, len(texts), len(generated), len(notices)


def fill_holders(text: str, holders: str) -> str:
    """The template's "Copyright (c) <year> <copyright holders>" line with the
    holders filled in — one such line per holder separated by " | "."""
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if PLACEHOLDER in line:
            prefix, suffix = line.split(PLACEHOLDER, 1)
            lines[i] = "\n".join(f"{prefix}{holder.strip()}{suffix}"
                                 for holder in holders.split(HOLDER_SEPARATOR))
            return "\n".join(lines)
    raise Failure(f"template has no '{PLACEHOLDER}' line")


def tree_digest(folder: str) -> str:
    digest = hashlib.sha256()
    for root, dirs, files in os.walk(folder):
        dirs.sort()
        for name in sorted(files):
            path = os.path.join(root, name)
            digest.update(os.path.relpath(path, folder).encode() + b"\0")
            with open(path, "rb") as f:
                digest.update(f.read())
    return digest.hexdigest()[:12]


def ships_as(target: str, binary: str) -> str:
    """Where the executable `binary` sits in what the app ships for `target`."""
    if "windows" in target:
        return f"Dial8.exe (the {binary} executable, in the folder Dial8's installer installs)"
    return f"Contents/MacOS/{binary}"


def header(count: int, target: str, bins: list) -> str:
    def para(text: str) -> str:
        return textwrap.fill(" ".join(text.split()), width=78)

    return "\n\n".join([
        f"Rust crates in the Dial8 app's main executable ({count} crates)",
        "Ships as:\n" + ("\n".join(f"  {ships_as(target, b)}" for b in bins) or "  (no binary target)"),
        para(f"The app's main executable is written in Rust. It statically links the {count} "
             f"third-party crates below: exactly the crates Cargo compiles into it for {target}, "
             "versions from Cargo.lock. Crates that only run while the app is compiled (build "
             "scripts, procedural macros and what they use) are not in the executable and are "
             "not listed. The Rust standard library, which the executable also links, has its "
             "own notices (Licenses/rust-std/). License paths are relative to this folder."),
        para("\"License files\" are the crate's own, copied unchanged. Where a crate ships no "
             "license file for the license it is used under, the standard text of that license "
             "is included instead (files ending in .generated.txt), naming the crate's copyright "
             "holders: its authors, or the holders its upstream license file names, where that "
             "is who holds the copyright."),
        para("Where a crate's source files carry a notice that its license files don't, for code "
             "or text it took from elsewhere, that notice is copied out unchanged too (files "
             "ending in .notice.txt)."),
    ]) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("out", help="directory to write <package>/ into")
    parser.add_argument("--manifest-dir", default=os.path.join(HERE, "..", "..", "src-tauri"))
    parser.add_argument("--package", default="dial8-desktop")
    parser.add_argument("--target", default=None, help="Rust target triple (default: the host's)")
    parser.add_argument("--features", default=RELEASE_FEATURES,
                        help=f"features the build enables (default: {RELEASE_FEATURES})")
    args = parser.parse_args()

    manifest_dir = os.path.realpath(args.manifest_dir)
    cargo = os.environ.get("CARGO", "cargo")
    try:
        target = args.target or host_target(manifest_dir)
        graph = build_graph(manifest_dir, args.package, target, args.features)
        meta = json.loads(subprocess.run(
            [cargo, "metadata", "--format-version", "1", "--locked", "--offline",
             "--filter-platform", target],
            cwd=manifest_dir, check=True, capture_output=True, text=True,
        ).stdout)
        crates = linked_crates(meta, graph, args.package, manifest_dir)
        holders = Holders()
        source_notices = SourceNotices()
    except subprocess.CalledProcessError as e:
        print(f"[licenses] ERROR: {' '.join(e.cmd)} failed:\n{e.stderr}", file=sys.stderr)
        return 1
    except Failure as e:
        print(f"[licenses] ERROR: {e}", file=sys.stderr)
        return 1
    if not crates:
        print(f"[licenses] ERROR: no crates found for {args.package} — refusing to write empty notices",
              file=sys.stderr)
        return 1

    wrong = sorted({p["name"] for p in crates if p["name"] in NOT_LINKED})
    if wrong:
        print(f"[licenses] ERROR: the crate list for {args.package} has crates that only run at build time:",
              file=sys.stderr)
        for name in wrong:
            print(f"[licenses]   {name} ({NOT_LINKED[name]})", file=sys.stderr)
        print("[licenses] The list must come from Cargo's build graph (see rust_crates.py). If a "
              "dependency change really links one now, confirm with `cargo tree -i <crate>` and "
              "remove it from NOT_LINKED.", file=sys.stderr)
        return 1

    package = next(p for p in meta["packages"] if p["name"] == args.package and p["source"] is None)
    bins = sorted(t["name"] for t in package["targets"] if "bin" in t["kind"])
    out = os.path.join(args.out, args.package)
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)

    entries, failures = [], []
    own = own_files = gen = gen_files = notice_files = 0
    for pkg in crates:
        try:
            lines, n_own, n_gen, n_notices = write_crate(pkg, out, holders, source_notices)
        except Failure as e:
            failures.append(f"{pkg['name']} {pkg['version']} ({pkg.get('license')}): {e}")
            continue
        entries.append("\n".join(lines))
        own += 1 if n_own else 0
        own_files += n_own
        gen += 1 if n_gen else 0
        gen_files += n_gen
        notice_files += n_notices
    if failures:
        print(f"[licenses] ERROR: {len(failures)} crate(s) linked into {args.package} can't be covered:",
              file=sys.stderr)
        for failure in failures:
            print(f"[licenses]   {failure}", file=sys.stderr)
        shutil.rmtree(out, ignore_errors=True)
        return 1

    with open(os.path.join(out, "NOTICES.txt"), "w", encoding="utf-8") as f:
        f.write(header(len(crates), target, bins) + "\n" + "\n\n".join(entries) + "\n")

    for crate, spdx in holders.unused():
        print(f"[licenses] note: holders.tsv row {crate} / {spdx} was not used "
              "(the crate is not linked, or ships that text itself)", file=sys.stderr)
    for crate, version in source_notices.unused():
        print(f"[licenses] note: source_notices.tsv rows for {crate} {version} were not used "
              "(that version is not linked)", file=sys.stderr)
    print(
        f"[licenses] {args.package}: {len(crates)} crates ({target}) — "
        f"{own} with their own license files ({own_files} files), "
        f"{gen} with standard texts generated ({gen_files} files), "
        f"{len(crates) - own} with no license file of their own, "
        f"{notice_files} in-source notices; "
        f"sha256 {tree_digest(out)}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
