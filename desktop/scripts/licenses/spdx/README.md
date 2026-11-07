# Standard license texts

`rust_crates.py` uses these only when a crate ships no license file for the
license it is used under (e.g. `objc2`, `alloc-stdlib`), or none for one half of
an `AND` expression (e.g. `brotli`: `BSD-3-Clause AND MIT`, ships only the MIT
text). `rust_std.py` does the same for a standard-library crate it has to
cover itself. The file name is the SPDX id.

Each text is copied byte for byte from a crate license file in the local Cargo
registry (`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/`), not
fetched from the web:

| File | Source | Change |
|---|---|---|
| `MIT.txt` | `half-2.4.1/LICENSES/MIT.txt` (SPDX template) | none |
| `Apache-2.0.txt` | `half-2.4.1/LICENSES/Apache-2.0.txt` (identical to the Rust toolchain's `share/doc/rust/licenses/Apache-2.0.txt`) | none |
| `MPL-2.0.txt` | `cssparser-0.29.6/LICENSE` | none |
| `BSD-3-Clause.txt` | `alloc-no-stdlib-2.0.4/LICENSE` | its first two lines (`Copyright (c) 2016 Dropbox, Inc.` / `All rights reserved.`) replaced by the placeholder line |
| `Zlib.txt` | `tinyvec-1.11.0/LICENSE-ZLIB.md` | its first line (`Copyright (c) 2019 Daniel "Lokathor" Gee.`) replaced by the placeholder line |

The placeholder line is `Copyright (c) <year> <copyright holders>`, as in the
SPDX MIT template. The generator replaces `<year> <copyright holders>` with the
crate's copyright holders: the row for that crate and license in
`../holders.tsv` when there is one (a crate whose Cargo `authors` are not who
holds the copyright — e.g. `alloc-stdlib` and `brotli`, Dropbox, Inc.; the
`objc2` crates, forks of Steven Sheldon's — each row naming the file on disk
that shows it), else the crate's `authors` from Cargo (there is no year to fill
in). It refuses to run if a template that needs the line (MIT, BSD-3-Clause,
Zlib) has lost it. Apache-2.0 and MPL-2.0 carry no copyright line; the crate's
authors are listed in its NOTICES entry.

To add a license: copy a text for it from a crate on disk, verbatim apart from
the copyright line, name it `<SPDX id>.txt`, and add a row here.
