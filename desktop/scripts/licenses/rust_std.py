#!/usr/bin/env python3
"""Third-party notices for the Rust standard library in the Native Intelligence app binary.

    rust_std.py [--manifest-dir DIR] [--target TRIPLE] OUT

Every Rust executable statically links the standard library of the toolchain
that built it: the Rust project's own std, core and alloc (and their in-tree
support crates) plus the crates.io crates they are built from. This writes
OUT/rust-std/ (replacing it):

    NOTICES.txt              the toolchain, what it links, and where each
                             part's license and notices are
    COPYRIGHT-library.txt    the toolchain's share/doc/rust/COPYRIGHT-library.html,
                             the Rust project's copyright file for the standard
                             library, converted to plain text (macOS textutil;
                             elsewhere, the Windows build, html_to_text)
    licenses/<id>.txt        the toolchain's share/doc/rust/licenses/ texts of
                             every license COPYRIGHT-library cites, unchanged
    <crate>-<version>/...    license files of linked crates COPYRIGHT-library
                             does not list (see below)

The toolchain is the one Cargo builds with in --manifest-dir (rustup resolves
it per directory). TARGET defaults to its host.

Which parts are linked: the rlibs rustc hands the linker for an empty program
for TARGET (`rustc --print link-args`) — the standard library's own crate
graph, the same one every Rust binary for TARGET links. A crate from crates.io
has its name and version compiled into its rlib (the /rust/deps/<crate>-<version>/
paths of its sources), or into the .rmeta beside it when the rlib's code keeps
no source paths; the Rust project's own crates (IN_TREE) have none.

COPYRIGHT-library.html does not always list every crate the standard library
links (Rust 1.87's and 1.98's leave out std's backtrace symbolizer: addr2line,
adler2, memchr, miniz_oxide, object). For each one it leaves out, the crate's own
license files are copied — from the local Cargo registry at that exact
version, else from the crate's section of the toolchain's COPYRIGHT.html —
the way rust_crates.py copies an app crate's (missing texts generated from
spdx/ the same way). If neither has it, or a license text a linked part needs
is missing, or the toolchain's docs are not installed (rustup component add
rust-docs), this fails with exit 1.
"""

from __future__ import annotations

import argparse
import glob
import html
import html.parser
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap

sys.dont_write_bytecode = True  # importing rust_crates must not leave a __pycache__
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import rust_crates as rc  # noqa: E402

PART = "rust-std"
CRATES_IO = "registry+https://github.com/rust-lang/crates.io-index"
# The standard library's own crates: code in the rust-lang/rust repository
# (library/), under COPYRIGHT-library's in-tree section. Any other rlib the
# link pulls in must carry a crates.io name and version, or this fails.
# compiler_builtins was the crates.io crate compiler_builtins-0.1.x up to Rust
# 1.87; from 1.88 it lives in the rust-lang/rust tree (library/compiler-builtins,
# its sources compiled from /rustc/<commit>/library/compiler-builtins/), under
# COPYRIGHT-library's in-tree "." entry.
# windows_link: the Windows std's own copy of windows-link, in the tree at
# library/windows_link (its sources compile from /rustc/<commit>/library\windows_link\).
IN_TREE = {
    "alloc", "core", "std", "std_detect", "panic_abort", "panic_unwind", "unwind",
    "proc_macro", "test", "profiler_builtins", "sysroot", "compiler_builtins",
    "rustc_std_workspace_alloc", "rustc_std_workspace_core", "rustc_std_workspace_std",
    "windows_link",
}
CRATE_HEADING = re.compile(r"^📦 (.+?)-(\d+\.\d+\.\d+\S*)$")


class Failure(rc.Failure):
    pass


def run(cmd: list, cwd: str) -> str:
    return subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True).stdout


def rustc() -> str:
    return os.environ.get("RUSTC", "rustc")


# ─── what the toolchain links ────────────────────────────────────────────────


def linked_rlibs(target: str, sysroot: str, cwd: str) -> list:
    """(crate name, rlib path) for every standard-library rlib an executable
    for `target` links, as rustc passes them to the linker."""
    rlib_dir = os.path.realpath(os.path.join(sysroot, "lib", "rustlib", target, "lib"))
    if not os.path.isdir(rlib_dir):
        raise Failure(f"the toolchain has no standard library for {target} "
                      f"(rustup target add {target})")
    with tempfile.TemporaryDirectory() as tmp:
        main = os.path.join(tmp, "main.rs")
        with open(main, "w", encoding="utf-8") as f:
            f.write("fn main() {}\n")
        args = run([rustc(), "--target", target, "--print", "link-args",
                    "-o", os.path.join(tmp, "main"), main], cwd)
    # rustc quotes every argument ("cc" "-arch" ... "/…/libstd-<hash>.rlib").
    paths = re.findall(r'"([^"]*\.rlib)"', args) or re.findall(r"(\S+\.rlib)", args)
    # MSVC's link args are Debug-quoted: C:\\Users\\… for C:\Users\….
    paths = [p.replace("\\\\", "\\") for p in paths]
    found = {}
    for path in paths:
        m = re.match(r"lib([A-Za-z0-9_]+)-[0-9a-f]+\.rlib$", os.path.basename(path))
        if m and os.path.realpath(os.path.dirname(path)) == rlib_dir:
            found[m.group(1)] = path
    if "std" not in found:
        raise Failure(f"`rustc --print link-args` for {target} named no standard-library rlibs")
    return sorted(found.items())


def rlib_package(name: str, path: str):
    """(package name, version) of a crates.io rlib, None for an in-tree one.

    The version is in the /rust/deps/<crate>-<version>/ paths of the crate's
    sources, which the rlib's object code carries — or, when its code keeps no
    source paths (Rust 1.98's adler2), the crate metadata rustc wrote next to it
    in the same compilation (<same stem>.rmeta, whose source-file table has them)."""
    pattern = re.escape(name).replace("_", "[-_]").encode()
    rmeta = os.path.splitext(path)[0] + ".rmeta"
    found = set()
    for candidate in (path, rmeta):
        if not os.path.isfile(candidate):
            continue
        with open(candidate, "rb") as f:
            data = f.read()
        found = {
            (m.group(1).decode(), m.group(2).decode())
            for m in re.finditer(
                # `/rust/deps/` on a Unix-built std, `/rust/deps\` on a Windows one.
                rb"/rust/deps[/\\](" + pattern + rb")-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(?:\+[0-9A-Za-z.-]+)?)"
                rb"(?=[^0-9A-Za-z.+-]|$)",
                data,
            )
        }
        if len(found) > 1:
            raise Failure(f"{os.path.basename(candidate)} names several versions of {name}: {sorted(found)}")
        if found:
            return found.pop()
    if name not in IN_TREE:
        raise Failure(f"{os.path.basename(path)} is neither one of the Rust project's own crates "
                      "nor a crates.io crate with a version in it — add it to IN_TREE only if it "
                      "is code from the rust-lang/rust repository")
    return None


# ─── COPYRIGHT-library ───────────────────────────────────────────────────────


class _TextOf(html.parser.HTMLParser):
    """COPYRIGHT-library.html as plain text, the way textutil lays it out:
    each block element on lines of its own, <pre> verbatim, entities decoded."""

    BLOCKS = {"p", "div", "h1", "h2", "h3", "h4", "li", "ul", "pre", "details", "summary", "title", "br", "tr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.pre = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in self.BLOCKS:
            self.out.append("\n")
        if tag == "pre":
            self.pre += 1

    def handle_endtag(self, tag):
        if tag == "pre":
            self.pre -= 1
        if tag in self.BLOCKS:
            self.out.append("\n")

    def handle_data(self, data):
        # Outside <pre>, runs of whitespace are one space (lines are stripped
        # after), so "<b>License:</b> MIT" reads "License: MIT".
        self.out.append(data if self.pre else re.sub(r"\s+", " ", data))


def html_to_text(raw: str) -> str:
    parser = _TextOf()
    parser.feed(raw)
    parser.close()
    lines = [line.strip() for line in "".join(parser.out).splitlines()]
    text = "\n".join(lines)
    return re.sub(r"\n{3,}", "\n\n", text).strip() + "\n"


def to_text(html_path: str) -> str:
    # textutil on macOS (what the Mac bundle has always shipped); elsewhere
    # (the Windows build) the same layout from html_to_text.
    if shutil.which("textutil") and not os.environ.get("NI_LICENSES_NO_TEXTUTIL"):
        text = run(["textutil", "-convert", "txt", "-stdout", html_path], os.path.dirname(html_path))
    else:
        with open(html_path, encoding="utf-8") as f:
            text = html_to_text(f.read())
    if "The Rust Standard Library" not in text:
        raise Failure(f"{html_path} converted to text doesn't read as the standard library's copyright file")
    return text


def parse_copyright_library(text: str):
    """(in-tree license expressions, {(crate, version): {authors, license, notices}})."""
    lines = text.splitlines()
    in_tree, crates, current = [], {}, None
    for line in lines:
        heading = CRATE_HEADING.match(line.strip())
        if heading:
            current = {"authors": "", "license": "", "notices": False}
            crates[heading.groups()] = current
            continue
        if current is None:
            if line.startswith("License: "):
                in_tree.append(line[len("License: "):].strip())
            continue
        # A crate's first Authors/License lines; anything after "Notices:" is
        # license text, which may have lines of its own starting that way.
        if current["notices"]:
            continue
        if line.startswith("Authors: ") and not current["authors"]:
            current["authors"] = line[len("Authors: "):].strip()
        elif line.startswith("License: ") and not current["license"]:
            current["license"] = line[len("License: "):].strip()
        elif line.strip() == "Notices:":
            current["notices"] = True
    if not in_tree or not crates or any(not c["license"] for c in crates.values()):
        raise Failure("COPYRIGHT-library's layout changed: can't find its in-tree licenses, "
                      "its crates, or a crate's License line")
    return in_tree, crates


def license_ids(expr: str) -> set:
    """Every license id an expression names ("X WITH Y" gives X and Y)."""
    ids = set()
    for alt in rc.alternatives(expr):
        for token in alt:
            ids.update(part.strip() for part in token.split(" WITH "))
    return ids


def satisfying_texts(expr: str, texts: set):
    """The ids of the fewest texts in `texts` that satisfy `expr`, or None."""
    options = []
    for alt in rc.alternatives(expr):
        ids = set()
        for token in alt:
            ids |= license_ids(token)
        if ids <= texts:
            options.append(sorted(ids))
    return min(options, key=lambda ids: (len(ids), ids)) if options else None


def satisfiable(expr: str, texts: set) -> bool:
    """Some way to satisfy `expr` has all its texts in `texts`."""
    return satisfying_texts(expr, texts) is not None


# ─── crates COPYRIGHT-library leaves out ─────────────────────────────────────


def registry_package(name: str, version: str, cwd: str):
    """The crate's package details from the local Cargo registry, or None."""
    cargo_home = os.environ.get("CARGO_HOME", os.path.join(os.path.expanduser("~"), ".cargo"))
    manifests = sorted(glob.glob(os.path.join(cargo_home, "registry", "src", "*", f"{name}-{version}", "Cargo.toml")))
    if not manifests:
        return None
    meta = json.loads(run([os.environ.get("CARGO", "cargo"), "metadata", "--no-deps", "--offline",
                           "--format-version", "1", "--manifest-path", manifests[0]], cwd))
    pkg = next((p for p in meta["packages"] if p["name"] == name and p["version"] == version), None)
    if pkg is None:
        return None
    pkg["source"] = CRATES_IO  # a crate in the registry's src/ came from crates.io
    return pkg


def copyright_html_package(doc: str, name: str, version: str):
    """The crate as the toolchain's COPYRIGHT.html records it (authors,
    license and its license files, verbatim), or None."""
    path = os.path.join(doc, "COPYRIGHT.html")
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as f:
        page = f.read()
    head = f"<h3>📦 {html.escape(name)}-{html.escape(version)}</h3>"
    start = page.find(head)
    if start < 0:
        return None
    end = len(page)
    for tag in ("<h3>", "<h2>", "</body>"):
        at = page.find(tag, start + len(head))
        if at >= 0:
            end = min(end, at)
    section = page[start:end]

    def field(label):
        m = re.search(r"<p><b>" + label + r":</b>(.*?)</p>", section, re.S)
        return html.unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip() if m else ""

    files = []
    for m in re.finditer(r"<summary><code>(.*?)</code></summary>\s*<pre>(.*?)</pre>", section, re.S):
        text = html.unescape(m.group(2))
        # The page wraps each file as "<pre>\n" + file + "\n" + indent + "</pre>".
        if text.startswith("\n"):
            text = text[1:]
        text = re.sub(r"\n[ \t]*\Z", "", text)
        files.append((html.unescape(m.group(1)).strip(), text))
    license_expr = field("License")
    if not license_expr:
        return None
    authors = field("Authors")
    return {
        "name": name, "version": version, "license": license_expr, "license_file": None,
        "authors": [authors] if authors else [], "repository": None, "source": CRATES_IO,
        "manifest_path": None, "notice_files": files,
    }


# ─── notices ─────────────────────────────────────────────────────────────────


def header(version: str, binary: str, target: str, in_tree: list, count: int,
           texts: list, left_out: list) -> str:
    def para(text: str, hang: str = "") -> str:
        return textwrap.fill(" ".join(text.split()), width=78, subsequent_indent=hang)

    parts = [
        f"The Rust Standard Library, from {version}",
        f"Ships as:\n  {rc.ships_as(target, binary)} (statically linked into the main executable)",
        "Copyright: The Rust Project Developers (https://thanks.rust-lang.org)\n"
        + para("License: MIT OR Apache-2.0 (licenses/MIT.txt, licenses/Apache-2.0.txt), "
               "with the exceptions COPYRIGHT-library.txt lists", hang="  "),
        para(f"The app's main executable is built with {version} for {target} and, like "
             "every Rust program, statically links that toolchain's standard library: the "
             f"Rust project's own crates ({', '.join(in_tree)}) and the {count} crates from "
             "crates.io listed below."),
        para("COPYRIGHT-library.txt is the Rust project's copyright file for this standard "
             "library, as the toolchain ships it (share/doc/rust/COPYRIGHT-library.html, "
             "converted to plain text, nothing else changed): the licenses of the standard "
             "library's own files and of the crates it is built from, with their notices. "
             "licenses/ holds the toolchain's texts (share/doc/rust/licenses/, unchanged) of "
             f"the licenses it names: {', '.join(texts)}. The MIT text there is the standard "
             "one; for the standard library its copyright holders are the Rust Project "
             "Developers."),
    ]
    if left_out:
        parts.append(para(
            f"The toolchain's COPYRIGHT-library.html does not list {len(left_out)} of the "
            f"crates below ({', '.join(left_out)}); their own license files are included "
            "here, in <crate>-<version>/."))
    parts.append("Crates from crates.io in the standard library:")
    return "\n\n".join(parts) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("out", help=f"directory to write {PART}/ into")
    parser.add_argument("--manifest-dir", default=os.path.join(HERE, "..", "..", "src-tauri"),
                        help="where Cargo builds the app (picks the toolchain)")
    parser.add_argument("--target", default=None, help="Rust target triple (default: the host's)")
    parser.add_argument("--binary", default="dial8-desktop", help="the executable it is linked into")
    args = parser.parse_args()
    cwd = os.path.realpath(args.manifest_dir)
    out = os.path.join(args.out, PART)

    try:
        version = run([rustc(), "-V"], cwd).strip()
        sysroot = run([rustc(), "--print", "sysroot"], cwd).strip()
        target = args.target or rc.host_target(cwd)
        doc = os.path.join(sysroot, "share", "doc", "rust")
        copyright_html = os.path.join(doc, "COPYRIGHT-library.html")
        texts_dir = os.path.join(doc, "licenses")
        if not os.path.isfile(copyright_html) or not os.path.isdir(texts_dir):
            raise Failure(f"the toolchain's license docs are missing ({copyright_html}, {texts_dir}/) "
                          "— install them: rustup component add rust-docs")

        copyright_text = to_text(copyright_html)
        in_tree_licenses, listed = parse_copyright_library(copyright_text)

        cited = set()
        for expr in in_tree_licenses + [c["license"] for c in listed.values()]:
            cited |= license_ids(expr)
        copied = {i for i in cited if os.path.isfile(os.path.join(texts_dir, f"{i}.txt"))}
        if not {"MIT", "Apache-2.0"} <= copied:
            raise Failure(f"{texts_dir}/ has no MIT or Apache-2.0 text — the standard library's own licenses")
        for expr in in_tree_licenses:
            if not satisfiable(expr, copied):
                raise Failure(f"COPYRIGHT-library's in-tree license {expr!r} needs a text {texts_dir}/ doesn't have")

        rlibs = linked_rlibs(target, sysroot, cwd)
        in_tree, packages = [], []
        for name, path in rlibs:
            package = rlib_package(name, path)
            if package is None:
                in_tree.append(name)
            else:
                packages.append(package)
        packages.sort(key=lambda p: (p[0].lower(), rc.version_key(p[1])))

        shutil.rmtree(out, ignore_errors=True)
        os.makedirs(os.path.join(out, "licenses"))
        with open(os.path.join(out, "COPYRIGHT-library.txt"), "w", encoding="utf-8") as f:
            f.write(copyright_text)
        for spdx in sorted(copied):
            shutil.copyfile(os.path.join(texts_dir, f"{spdx}.txt"), os.path.join(out, "licenses", f"{spdx}.txt"))

        holders = rc.Holders()
        source_notices = rc.SourceNotices()
        entries, left_out, failures = [], [], []
        for name, pkg_version in packages:
            info = listed.get((name, pkg_version))
            if info is not None:
                lines = [f"{name} {pkg_version}", f"  License: {info['license']}"]
                if info["authors"]:
                    lines.append(f"  Authors: {info['authors']}")
                lines.append(f"  Source: https://crates.io/crates/{name}/{pkg_version}")
                if info["notices"]:
                    lines.append("  Notices: in COPYRIGHT-library.txt")
                elif satisfiable(info["license"], copied):
                    needed = satisfying_texts(info["license"], copied)
                    lines.append("  License texts: " + ", ".join(f"licenses/{i}.txt" for i in needed)
                                 + " (COPYRIGHT-library.txt has no notices of its own for it)")
                else:
                    failures.append(f"{name} {pkg_version} ({info['license']}): COPYRIGHT-library lists "
                                    f"no notices for it and {texts_dir}/ lacks a text it needs")
                    continue
                entries.append("\n".join(lines))
                continue
            # Not in COPYRIGHT-library: the crate's own files.
            pkg = registry_package(name, pkg_version, cwd)
            where = "copied from the crate (local Cargo registry)"
            if pkg is None:
                pkg = copyright_html_package(doc, name, pkg_version)
                where = "as the toolchain's COPYRIGHT.html records them"
            if pkg is None:
                failures.append(f"{name} {pkg_version}: not in COPYRIGHT-library.html, and neither the local "
                                "Cargo registry nor the toolchain's COPYRIGHT.html has its license files "
                                f"(download it: `cargo fetch` in a project that depends on {name} = \"={pkg_version}\")")
                continue
            try:
                lines, _, _, _ = rc.write_crate(pkg, out, holders, source_notices)
            except rc.Failure as e:
                failures.append(f"{name} {pkg_version} ({pkg.get('license')}): {e}")
                continue
            lines.append(f"  Not listed in COPYRIGHT-library.txt; its license files are {where}")
            entries.append("\n".join(lines))
            left_out.append(name)
        if failures:
            shutil.rmtree(out, ignore_errors=True)
            print(f"[licenses] ERROR: {len(failures)} standard-library crate(s) can't be covered:", file=sys.stderr)
            for failure in failures:
                print(f"[licenses]   {failure}", file=sys.stderr)
            return 1
    except subprocess.CalledProcessError as e:
        shutil.rmtree(out, ignore_errors=True)
        print(f"[licenses] ERROR: {' '.join(e.cmd)} failed:\n{e.stderr}", file=sys.stderr)
        return 1
    except rc.Failure as e:
        shutil.rmtree(out, ignore_errors=True)
        print(f"[licenses] ERROR: {e}", file=sys.stderr)
        return 1

    text = header(version, args.binary, target, in_tree, len(packages), sorted(copied), left_out)
    with open(os.path.join(out, "NOTICES.txt"), "w", encoding="utf-8") as f:
        f.write(text + "\n" + "\n\n".join(entries) + "\n")
    print(
        f"[licenses] {PART}: {version}, {target} — {len(in_tree)} in-tree crates, "
        f"{len(packages)} crates.io crates ({len(packages) - len(left_out)} in COPYRIGHT-library, "
        f"{len(left_out)} not: {', '.join(left_out) or 'none'}), "
        f"{len(copied)} license texts; sha256 {rc.tree_digest(out)}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
