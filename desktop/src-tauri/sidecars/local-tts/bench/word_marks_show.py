#!/usr/bin/env python3
"""Spike helper: one sentence, word by word: local-stt's start, syllables', audio's (ms)."""
import sys, difflib
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from word_marks import envelope, words_of, stt_words, place, norm  # noqa: E402

sentences = [s.strip() for s in Path(sys.argv[1]).read_text().splitlines() if s.strip()]
k = int(sys.argv[2])
env = envelope(Path(sys.argv[3]) / f"{k:02d}.wav")
ws = words_of(sentences[k])
ref = stt_words(Path(sys.argv[4]) / f"{k:02d}.jsonl")
sm = difflib.SequenceMatcher(None, [norm(w) for w in ws], [norm(w) for w, _ in ref], autojunk=False)
m = {m.a + d: m.b + d for m in sm.get_matching_blocks() for d in range(m.size)}
sy, au = place(env, ws, "syllables"), place(env, ws, "audio")
for i, w in enumerate(ws):
    r = f"{ref[m[i]][1]*1000:5.0f}" if i in m else "    -"
    print(f"{w:16s} stt {r}  syl {sy[i]*1000:5.0f}  aud {au[i]*1000:5.0f}")
# the envelope, coarse: one char per 20 ms
top = max(env)
print("".join(" .:-=+*#%@"[max(0, min(9, int((e - top + 45) / 5)))] for e in env[::2]))
