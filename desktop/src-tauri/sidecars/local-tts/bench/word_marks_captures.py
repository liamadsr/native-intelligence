#!/usr/bin/env python3
"""Spike: check read-along's word places in real readings (the debug app saves each
sentence to /tmp/dial8-readalong as NAME.wav + NAME.json) against whisper DTW times.
Prints each sentence's error and, for the worst, the words and how far off each was.

  word_marks_captures.py [DIR] [--worst N]"""
import difflib, json, statistics, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from word_marks import whisper_words, norm  # noqa: E402

WHISPER = "/opt/homebrew/bin/whisper-cli"
MODEL = "/tmp/dial8-spike/rsvp/models/ggml-base.en.bin"
import argparse
ap = argparse.ArgumentParser()
ap.add_argument("dir", nargs="?", default="/tmp/dial8-readalong")
ap.add_argument("--worst", type=int, default=5)
opts = ap.parse_args()
d, worst_n = Path(opts.dir), opts.worst
rows = []
for j in sorted(d.glob("*.json")):
    if j.name.endswith(".wh.json"):
        continue
    wav, wh = j.with_suffix(".wav"), j.with_suffix(".wh.json")
    if not wh.exists():
        w16 = j.with_suffix(".16k.wav")
        subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", str(wav), str(w16)], check=True)
        subprocess.run([WHISPER, "-m", MODEL, "--dtw", "base.en", "-nfa", "-ojf", "-of", str(wh)[:-5], "-f", str(w16)],
                       check=True, capture_output=True)
    m = json.loads(j.read_text())
    ref = whisper_words(wh)
    sm = difflib.SequenceMatcher(None, [norm(w) for w in m["words"]], [norm(w) for w, _ in ref], autojunk=False)
    pairs = [(b.a + i, b.b + i) for b in sm.get_matching_blocks() for i in range(b.size)]
    errs = [(i, m["hops"][i] / 100.0 - ref[k][1]) for i, k in pairs]
    rows.append((j.stem, m["words"], errs))
allerr = [e for _, _, es in rows for _, e in es]
if not allerr:
    sys.exit("no captures")
bias = statistics.median(allerr)
print(f"{len(rows)} sentences, {len(allerr)} words, bias {bias*1000:.0f} ms")
a = sorted(abs(e - bias) for e in allerr)
print(f"mae {statistics.mean(a)*1000:.0f} ms  p90 {a[int(len(a)*.9)]*1000:.0f} ms  max {a[-1]*1000:.0f} ms")
scored = sorted(rows, key=lambda r: -max((abs(e - bias) for _, e in r[2]), default=0))
for name, words, errs in scored[:worst_n]:
    worst = max(abs(e - bias) for _, e in errs)
    print(f"\n{name}  worst {worst*1000:.0f} ms")
    off = {i: e - bias for i, e in errs}
    print("  " + " ".join(f"{w}[{off[i]*1000:+.0f}]" if i in off and abs(off[i]) > 0.15 else w for i, w in enumerate(words)))
