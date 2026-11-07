#!/usr/bin/env python3
"""Spike helper: how far the two references (local-stt, whisper DTW) are from each other."""
import sys, difflib, statistics
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from word_marks import stt_words, whisper_words, norm  # noqa: E402

errs = []
for k in range(int(sys.argv[3])):
    a = stt_words(Path(sys.argv[1]) / f"{k:02d}.jsonl")
    b = whisper_words(Path(sys.argv[2]) / f"{k:02d}.json")
    sm = difflib.SequenceMatcher(None, [norm(w) for w, _ in a], [norm(w) for w, _ in b], autojunk=False)
    errs += [a[m.a + d][1] - b[m.b + d][1] for m in sm.get_matching_blocks() for d in range(m.size)]
bias = statistics.mean(errs)
print(f"words {len(errs)}  bias {bias*1000:.0f} ms  mae unbiased {statistics.mean(abs(e-bias) for e in errs)*1000:.0f} ms  p90 {sorted(abs(e-bias) for e in errs)[int(len(errs)*.9)]*1000:.0f} ms")
