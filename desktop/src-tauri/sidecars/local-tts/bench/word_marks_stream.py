#!/usr/bin/env python3
"""Spike: score read-along's word places while a sentence streams in (marks.json from
`cargo test --lib -- --ignored bench_streaming`) against whisper DTW times (wh/NN.json)."""
import difflib, json, statistics, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from word_marks import whisper_words, norm  # noqa: E402

d = Path(sys.argv[1])
marks = json.loads((d / "marks.json").read_text())
errs = {}
for k, row in marks.items():
    ref = whisper_words(d / "wh" / f"{k}.json")
    sm = difflib.SequenceMatcher(None, [norm(w) for w in row["words"]], [norm(w) for w, _ in ref], autojunk=False)
    pairs = [(m.a + i, m.b + i) for m in sm.get_matching_blocks() for i in range(m.size)]
    for key, v in row.items():
        if key == "words":
            continue
        errs.setdefault(key, []).extend(v[i] - ref[j][1] for i, j in pairs)
bias = statistics.mean(errs["final"])
for key, e in errs.items():
    a = sorted(abs(x - bias) for x in e)
    print(f"{key:8s} words {len(e):4d}  mae {statistics.mean(a)*1000:4.0f} ms  p90 {a[int(len(a)*.9)]*1000:4.0f} ms  max {a[-1]*1000:5.0f} ms")
