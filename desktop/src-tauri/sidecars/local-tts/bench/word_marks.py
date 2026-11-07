#!/usr/bin/env python3
"""Spike: where each word starts in a read-aloud sentence, from the audio alone.

Pocket TTS gives no word timings, only audio. This places a sentence's words on
its audio: each word's expected length from its syllables, the cuts snapped to
the quiet dips between words (and the pauses at punctuation), chosen together
by dynamic programming. Scored against local-stt's word start times (80 ms
steps, so ~±40 ms of its own noise) on the same clips.

  word_marks.py --sentences s.txt --wav-dir wav --stt-dir stt [--json OUT]

wav/NN.wav: mono 16-bit (drive.py --wav-dir). stt/NN.jsonl: local-stt's
messages for the same clip at 16 kHz (local-stt bench/drive.py). Stdlib only.
"""
import argparse
import difflib
import json
import math
import re
import statistics
import struct
import wave
from pathlib import Path

HOP_S = 0.010


def envelope(path):
    """RMS in dB per 10 ms, and the hop in seconds."""
    w = wave.open(str(path))
    rate, n = w.getframerate(), w.getnframes()
    raw = w.readframes(n)
    samples = struct.unpack(f"<{n}h", raw)
    hop = int(rate * HOP_S)
    env = []
    for i in range(0, n - hop + 1, hop):
        chunk = samples[i : i + hop]
        ms = sum(s * s for s in chunk) / hop
        env.append(10 * math.log10(ms + 1e-9))
    return env


def syllables(word):
    w = re.sub(r"[^a-z0-9]", "", word.lower())
    if not w:
        return 0.5
    if w.isdigit():
        return 1.5 * len(w)
    if word.isupper() and 2 <= len(word) <= 5:
        return float(len(w))  # spelled out
    groups = re.findall(r"[aeiouy]+", w)
    n = len(groups)
    if w.endswith("e") and not w.endswith(("le", "ee", "ye")) and n > 1:
        n -= 1
    if w.endswith(("ed",)) and not w.endswith(("ted", "ded")) and n > 1:
        n -= 1
    return float(max(1, n))


def words_of(text):
    return [t for t in text.split() if re.search(r"[A-Za-z0-9]", t)]


def place(env, words, method="audio"):
    """Start time (s) of each word."""
    top = max(env)
    floor = sorted(env)[len(env) // 10]
    thr = max(floor + 10, top - 38)
    voiced = [e > thr for e in env]
    first = next(i for i, v in enumerate(voiced) if v)
    last = len(voiced) - 1 - next(i for i, v in enumerate(reversed(voiced)) if v)
    n = len(words)
    weights = [syllables(w) + 0.35 for w in words]
    W = sum(weights)
    if method == "even":
        span = last + 1 - first
        return [(first + span * i / n) * HOP_S for i in range(n)]
    cum_voiced = [0]
    for v in voiced:
        cum_voiced.append(cum_voiced[-1] + (1 if v else 0))
    V = cum_voiced[last + 1] - cum_voiced[first]
    if method in ("syllables", "snap"):
        # Voiced time shared by syllables; each word starts where its share of voiced frames begins.
        pauses, i = [], first
        while i <= last:
            if not voiced[i]:
                j = next((k for k in range(i, last + 1) if voiced[k]), last + 1)
                if j - i >= 8:
                    pauses.append((i, j))
                i = j
            else:
                i += 1
        starts, acc, t = [], 0.0, first
        for k, wgt in enumerate(weights):
            target = acc / W * V
            while t <= last and cum_voiced[t] - cum_voiced[first] < target:
                t += 1
            onset = t
            if method == "snap" and k > 0 and re.search(r"[,.;:!?]$", words[k - 1]):
                near = [p for p in pauses if abs(p[1] - t) <= 40 or abs(p[0] - t) <= 40]
                if near:
                    end = min(near, key=lambda p: abs(p[1] - t))[1]
                    onset, t = end, max(t, end)
            while onset <= last and not voiced[onset]:
                onset += 1
            onset = max(min(onset, last), int(starts[-1] / HOP_S + 0.5) if starts else 0)
            starts.append(onset * HOP_S)
            acc += wgt
        return starts
    # Candidate cuts: local dips of the smoothed envelope, and onsets after a silence.
    sm = [sum(env[max(0, i - 1) : i + 2]) / len(env[max(0, i - 1) : i + 2]) for i in range(len(env))]
    cands = set()
    for t in range(first + 3, last - 2):
        if sm[t] <= sm[t - 1] and sm[t] <= sm[t + 1]:
            cands.add(t)
        if voiced[t] and not voiced[t - 1]:
            cands.add(t)
    cands = sorted(cands)
    span_db = max(1.0, top - thr)

    def silence_before(t):
        k = 0
        while t - 1 - k >= first and not voiced[t - 1 - k]:
            k += 1
        return k

    def cut_cost(t, prev_word):
        depth = min(1.0, max(0.0, (sm[t] - thr) / span_db))
        pause = silence_before(t)
        c = depth
        if pause >= 8:
            c = 0.0
        punct = bool(re.search(r"[,.;:!?]$", prev_word))
        if punct and pause < 5:
            c += 0.6
        return c

    def len_cost(a, b, i):
        v = cum_voiced[b] - cum_voiced[a]
        e = V * weights[i] / W
        return math.log((v + 2) / (e + 2)) ** 2

    INF = float("inf")
    positions = [first] + cands
    ends = last + 1
    # best[i][j]: cost with word i starting at positions[j]
    best = [[INF] * len(positions) for _ in range(n)]
    back = [[-1] * len(positions) for _ in range(n)]
    best[0][0] = 0.0
    for i in range(1, n):
        for j in range(1, len(positions)):
            b = positions[j]
            cc = cut_cost(b, words[i - 1])
            for k in range(0, j):
                if best[i - 1][k] == INF:
                    continue
                a = positions[k]
                c = best[i - 1][k] + len_cost(a, b, i - 1) + 0.8 * cc
                if c < best[i][j]:
                    best[i][j] = c
                    back[i][j] = k
    total, jbest = INF, -1
    for j in range(len(positions)):
        if best[n - 1][j] == INF:
            continue
        c = best[n - 1][j] + len_cost(positions[j], ends, n - 1)
        if c < total:
            total, jbest = c, j
    idx = [0] * n
    j = jbest
    for i in range(n - 1, -1, -1):
        idx[i] = j
        j = back[i][j]
    starts = []
    for i in range(n):
        t = positions[idx[i]]
        while t <= last and not voiced[t]:
            t += 1  # shown at its onset, after any pause
        starts.append(t * HOP_S)
    return starts


def stt_words(path):
    words = []
    for line in Path(path).read_text().splitlines():
        m = json.loads(line)
        msg = m.get("message") or {}
        if m.get("type") != "transcript" or not msg.get("is_final"):
            continue
        for alt in (msg.get("channel") or {}).get("alternatives", [])[:1]:
            for w in alt.get("words", []):
                words.append((w["word"], w["start"]))
    return words


def whisper_words(path):
    """Word starts from whisper.cpp's DTW token times (-ojf --dtw, in 10 ms units)."""
    words = []
    for seg in json.loads(Path(path).read_text())["transcription"]:
        for t in seg["tokens"]:
            text = t["text"]
            if text.startswith("[_") or t.get("t_dtw", -1) < 0:
                continue
            if text.startswith(" ") or not words:
                words.append([text.strip(), t["t_dtw"] / 100.0])
            else:
                words[-1][0] += text
    return [(w, s) for w, s in words if norm(w)]


def norm(w):
    return re.sub(r"[^a-z0-9]", "", w.lower())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sentences", required=True)
    ap.add_argument("--wav-dir", required=True)
    ap.add_argument("--stt-dir", required=True)
    ap.add_argument("--ref", choices=["stt", "whisper"], default="stt", help="local-stt jsonl, or whisper.cpp json (NN.json)")
    ap.add_argument("--json")
    a = ap.parse_args()
    sentences = [s.strip() for s in Path(a.sentences).read_text().splitlines() if s.strip()]
    errs = {"even": [], "syllables": [], "snap": [], "audio": []}
    for k, text in enumerate(sentences):
        wav = Path(a.wav_dir) / f"{k:02d}.wav"
        stt = Path(a.stt_dir) / (f"{k:02d}.json" if a.ref == "whisper" else f"{k:02d}.jsonl")
        if not wav.exists() or not stt.exists():
            continue
        env = envelope(wav)
        ws = words_of(text)
        ref = whisper_words(stt) if a.ref == "whisper" else stt_words(stt)
        sm = difflib.SequenceMatcher(None, [norm(w) for w in ws], [norm(w) for w, _ in ref], autojunk=False)
        pairs = [(m.a + d, m.b + d) for m in sm.get_matching_blocks() for d in range(m.size)]
        for method in errs:
            starts = place(env, ws, method)
            errs[method] += [starts[i] - ref[j][1] for i, j in pairs]
    out = {}
    for method, e in errs.items():
        if not e:
            continue
        bias = statistics.mean(e)
        out[method] = {
            "words": len(e),
            "bias_ms": round(bias * 1000),
            "mae_ms": round(statistics.mean(abs(x) for x in e) * 1000),
            "mae_unbiased_ms": round(statistics.mean(abs(x - bias) for x in e) * 1000),
            "p90_unbiased_ms": round(sorted(abs(x - bias) for x in e)[int(len(e) * 0.9)] * 1000),
        }
    print(json.dumps(out, indent=2))
    if a.json:
        Path(a.json).write_text(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
