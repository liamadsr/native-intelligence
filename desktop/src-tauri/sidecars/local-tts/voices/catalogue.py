#!/usr/bin/env python3
"""The voice catalogue (voices.json + <id>.emb), for build.sh and make-voice.sh.

  catalogue.py check   VOICES_DIR            validate; exit 1 on any problem
  catalogue.py embed   VOICES_DIR OUT.cpp    C++ source embedding the catalogue and every .emb
  catalogue.py notices VOICES_DIR            the voices' section of NOTICES.txt
  catalogue.py add     VOICES_DIR --id ID --name NAME --embedding FILE [--description ...]
                       [--source ...] [--source-sha256 ...] [--licence ...] [--attribution ...]
                       [--consent ...] [--replace]

Every voice is compiled into dial8-local-tts, so every voice is redistributed:
it needs either a licence from LICENCES (with its source and attribution) or
a reference to the speaker's signed consent (our own recordings).
Standard library only.
"""
import argparse
import hashlib
import json
import re
import struct
import sys
from pathlib import Path

LICENCES = {
    "CC-BY-4.0": ("Creative Commons Attribution 4.0 International (CC BY 4.0)",
                  "https://creativecommons.org/licenses/by/4.0/"),
    "CC0-1.0": ("CC0 1.0 Universal (public domain dedication)",
                "https://creativecommons.org/publicdomain/zero/1.0/"),
}
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
DIM = 1024  # Pocket TTS conditioning dimension


def load(voices_dir):
    return json.loads((Path(voices_dir) / "voices.json").read_text())


def save(voices_dir, cat):
    (Path(voices_dir) / "voices.json").write_text(json.dumps(cat, indent=2, ensure_ascii=False) + "\n")


def emb_shape(data):
    """Shape of a PocketTTS.cpp .emb file: "EMB1", ndims:i32, shape:i64[ndims], f32[]."""
    if len(data) < 8 or data[:4] != b"EMB1":
        return None
    (ndims,) = struct.unpack_from("<i", data, 4)
    if not 1 <= ndims <= 3 or len(data) < 8 + 8 * ndims:
        return None
    shape = struct.unpack_from(f"<{ndims}q", data, 8)
    count = 1
    for d in shape:
        count *= d
    return shape if len(data) == 8 + 8 * ndims + 4 * count else None


def problems(voices_dir):
    out = []
    try:
        cat = load(voices_dir)
    except (OSError, ValueError) as e:
        return [f"voices.json: {e}"], None
    if cat.get("version") != 1:
        out.append("voices.json: version must be 1")
    voices = cat.get("voices") or []
    ids = [v.get("id") for v in voices]
    if not voices:
        out.append("voices.json: no voices")
    if cat.get("default") not in ids:
        out.append(f"voices.json: default {cat.get('default')!r} is not a voice")
    for v in voices:
        vid = v.get("id") or "?"
        if not ID_RE.match(vid):
            out.append(f"{vid}: id must be lowercase letters, digits and dashes")
        if ids.count(vid) > 1:
            out.append(f"{vid}: duplicate id")
        if not v.get("name"):
            out.append(f"{vid}: no name")
        licence, consent = v.get("licence"), v.get("consent")
        if licence is not None and licence not in LICENCES:
            out.append(f"{vid}: licence {licence!r} is not one of {', '.join(LICENCES)} (add it to catalogue.py after a licence review)")
        if licence is None and not consent:
            out.append(f"{vid}: needs a licence or a consent reference")
        if licence is not None:
            if not v.get("attribution"):
                out.append(f"{vid}: a licensed voice needs its attribution")
            if not str(v.get("source") or "").startswith("https://"):
                out.append(f"{vid}: a licensed voice needs its source URL")
            if not re.fullmatch(r"[0-9a-f]{64}", str(v.get("sourceSha256") or "")):
                out.append(f"{vid}: sourceSha256 missing")
        emb = v.get("embedding") or ""
        path = Path(voices_dir) / emb
        if not emb or "/" in emb or not path.is_file():
            out.append(f"{vid}: embedding file {emb!r} missing (voices/make-voice.sh writes it)")
            continue
        data = path.read_bytes()
        shape = emb_shape(data)
        if not shape or len(shape) != 3 or shape[0] != 1 or shape[2] != DIM or shape[1] < 1:
            out.append(f"{vid}: {emb} is not a [1, frames, {DIM}] embedding")
        if hashlib.sha256(data).hexdigest() != v.get("embeddingSha256"):
            out.append(f"{vid}: {emb} does not match embeddingSha256")
    return out, cat


def cmd_check(args):
    errs, cat = problems(args.voices_dir)
    for e in errs:
        print(f"[voices] ERROR: {e}", file=sys.stderr)
    if errs:
        sys.exit(1)
    print(f"[voices] {len(cat['voices'])} voices ok: {', '.join(v['id'] for v in cat['voices'])} (default {cat['default']})")


def c_array(name, data, linkage=""):
    rows = [", ".join(f"0x{b:02x}" for b in data[i:i + 24]) for i in range(0, len(data), 24)]
    body = ",\n    ".join(rows) if rows else "0"
    return f"alignas(16) {linkage}const unsigned char {name}[] = {{\n    {body}\n}};\n"


def cmd_embed(args):
    errs, cat = problems(args.voices_dir)
    if errs:
        cmd_check(args)
    src = ["// Generated by voices/catalogue.py from voices/ — do not edit.", "#include <cstddef>", "",
           "namespace voices_data {", "struct File { const char* name; const unsigned char* data; size_t size; };", ""]
    catalogue = (Path(args.voices_dir) / "voices.json").read_bytes()
    src.append(c_array("kCatalogue", catalogue, "extern "))
    src.append(f"extern const size_t kCatalogueSize = {len(catalogue)};\n")
    files = []
    for i, v in enumerate(cat["voices"]):
        data = (Path(args.voices_dir) / v["embedding"]).read_bytes()
        src.append(c_array(f"kEmb{i}", data))
        files.append(f'    {{"{v["embedding"]}", kEmb{i}, {len(data)}}},')
    src += ["extern const File kFiles[] = {", *files, "};",
            f"extern const size_t kFileCount = {len(files)};", "}  // namespace voices_data", ""]
    out = Path(args.out)
    text = "\n".join(src)
    if not out.exists() or out.read_text() != text:  # keep the mtime (no rebuild) when unchanged
        out.write_text(text)


def cmd_notices(args):
    errs, cat = problems(args.voices_dir)
    if errs:
        cmd_check(args)
    for v in cat["voices"]:
        print(f"\n  {v['name']} (voice \"{v['id']}\")")
        if v.get("licence"):
            name, url = LICENCES[v["licence"]]
            print(f"    {v['attribution']}")
            print(f"    Source recording: {v['source']}")
            print(f"    License: {name}")
            print(f"    {url}")
            print("    Changed by Dial8: the recording was turned into a voice embedding")
            print("    (the output of Pocket TTS's Mimi encoder), compiled into dial8-local-tts.")
        else:
            who = f" ({v['attribution']})" if v.get("attribution") else ""
            print(f"    Made for Dial8{who} from the speaker's own voice, with their signed consent")
            print("    to its use for synthetic speech in Dial8. All rights reserved.")


def cmd_add(args):
    cat = load(args.voices_dir)
    at = next((i for i, v in enumerate(cat["voices"]) if v["id"] == args.id), None)
    if at is not None and not args.replace:
        sys.exit(f"[voices] ERROR: voice {args.id!r} already exists in voices.json (--replace rebuilds it)")
    if at is None and args.replace:
        sys.exit(f"[voices] ERROR: --replace: no voice {args.id!r} in voices.json")
    data = (Path(args.voices_dir) / args.embedding).read_bytes()
    entry = {
        "id": args.id,
        "name": args.name,
        "description": args.description or "",
        "source": args.source,
        "sourceSha256": args.source_sha256,
        "licence": args.licence,
        "attribution": args.attribution,
        "consent": args.consent,
        "embedding": args.embedding,
        "embeddingSha256": hashlib.sha256(data).hexdigest(),
    }
    if at is None:
        cat["voices"].append(entry)
    else:
        cat["voices"][at] = entry
    save(args.voices_dir, cat)
    errs, _ = problems(args.voices_dir)
    for e in errs:
        print(f"[voices] WARNING: {e}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("check", "notices"):
        sub.add_parser(name).add_argument("voices_dir")
    p = sub.add_parser("embed")
    p.add_argument("voices_dir")
    p.add_argument("out")
    p = sub.add_parser("add")
    p.add_argument("voices_dir")
    for flag in ("--id", "--name", "--embedding"):
        p.add_argument(flag, required=True)
    for flag in ("--description", "--source", "--source-sha256", "--licence", "--attribution", "--consent"):
        p.add_argument(flag)
    p.add_argument("--replace", action="store_true", help="replace the voice with this id, in place")
    args = ap.parse_args()
    {"check": cmd_check, "embed": cmd_embed, "notices": cmd_notices, "add": cmd_add}[args.cmd](args)


if __name__ == "__main__":
    main()
