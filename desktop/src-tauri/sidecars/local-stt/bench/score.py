#!/usr/bin/env python3
"""Score sidecar output (drive.py JSONL) against a cached Deepgram response.

Deepgram nova-3 is the reference, not ground truth — these numbers measure
agreement. Reproduces what the web would store: the final `Results` messages,
each labelled with its first word's speaker.

  score.py messages.jsonl reference.deepgram.json [--offset SECONDS] [--span SECONDS]

--offset/--span score one window of a longer run (the soak repeats one file).
Prints: speakers found, speaker agreement (best 1:1 mapping over word pairs),
the mapping, and transcript difference vs Deepgram (word edit distance / ref words).
"""
import argparse
import json
import re

import numpy as np
from scipy.optimize import linear_sum_assignment


def norm(text):
    text = text.lower().replace("’", "'")
    text = re.sub(r"[^a-z0-9' ]+", " ", text)
    return [t for t in text.split() if t]


def edit_distance(a, b):
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, y in enumerate(b, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y))
        prev = cur
    return prev[-1]


def final_words(path, offset, span):
    """Words of every final Results, each tagged with its segment's speaker."""
    words = []
    for line in open(path):
        msg = json.loads(line)
        if msg.get("type") != "transcript":
            continue
        m = msg["message"]
        if m.get("type") != "Results" or not m.get("is_final"):
            continue
        ws = m["channel"]["alternatives"][0].get("words", [])
        if not ws:
            continue
        seg_speaker = ws[0].get("speaker", 0)
        for w in ws:
            mid = (w["start"] + w["end"]) / 2 - offset
            if span is None or 0 <= mid < span:
                words.append({"word": w["word"], "mid": mid, "speaker": seg_speaker})
    return words


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("messages")
    ap.add_argument("reference")
    ap.add_argument("--offset", type=float, default=0.0)
    ap.add_argument("--span", type=float, default=None)
    args = ap.parse_args()

    ref = json.load(open(args.reference))["results"]["channels"][0]["alternatives"][0]["words"]
    hyp = final_words(args.messages, args.offset, args.span)
    if not hyp:
        print("no final words")
        return
    hyp_mid = np.array([w["mid"] for w in hyp])

    pairs = []
    for w in ref:
        m = (w["start"] + w["end"]) / 2
        j = int(np.abs(hyp_mid - m).argmin())
        if abs(hyp_mid[j] - m) <= 0.6:
            pairs.append((w["speaker"], hyp[j]["speaker"]))
    refs = sorted({r for r, _ in pairs})
    hyps = sorted({h for _, h in pairs})
    M = np.zeros((len(refs), len(hyps)))
    for r, h in pairs:
        M[refs.index(r), hyps.index(h)] += 1
    ri, ci = linear_sum_assignment(-M)
    agreement = M[ri, ci].sum() / M.sum()
    mapping = {int(refs[r]): int(hyps[c]) for r, c in zip(ri, ci)}

    counts = {}
    for w in hyp:
        counts[w["speaker"]] = counts.get(w["speaker"], 0) + 1
    speakers = sum(1 for c in counts.values() if c >= 10)

    ref_tokens = norm(" ".join(w.get("punctuated_word") or w["word"] for w in ref))
    hyp_tokens = norm(" ".join(w["word"] for w in hyp))
    diff = edit_distance(hyp_tokens, ref_tokens) / len(ref_tokens)

    print(
        f"speakers {speakers} (ref {len(set(w['speaker'] for w in ref))})  "
        f"agreement {agreement:.3f}  paired {len(pairs) / len(ref):.3f}  "
        f"transcript-diff {diff:.3f}  mapping {mapping}"
    )


if __name__ == "__main__":
    main()
