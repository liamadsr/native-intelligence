#!/usr/bin/env python3
"""Check the sidecar's `finalize` against a real recording (offline, no audio device).

Streams a WAV (s16 PCM; resampled to 16 kHz mono with scipy when needed)
into ONE stream named "mic" with no diarizer (the voice-session
configuration), paced at real time, and sends
`{"type":"finalize","stream":"mic","seq":k}` at points picked from the
Deepgram reference (see --every / --at-pauses). Then checks, per finalize:

  - the `finalized` ack arrives, echoing `seq` (latency = send → ack);
  - ORDERING: nothing received after the ack is about audio from before the
    finalize (no word, SpeechStarted or UtteranceEnd earlier than the push
    position, within TOLERANCE for word-time quantization);
  - TAIL: the reference words that ended shortly before the finalize are in a
    final received before the ack (the lookahead was flushed).

Also sends a finalize for an unknown stream (expects a non-fatal error), a
malformed one (must not crash the sidecar) and one without `seq` (expects an
ack without `seq`).

  finalize.py --sidecar .out/bin/dial8-local-stt --asr A.gguf \
      --wav meeting.wav --deepgram meeting.deepgram.json [--limit 120] \
      [--every 8 | --at-pauses] [--no-finalize] [--fast] [--out messages.jsonl]

--every finalizes mid-word (the worst case); --at-pauses finalizes 0.7 s into
each reference pause of at least 1 s (what a voice session's end-of-turn
does). --no-finalize runs the same audio without finalizes: compare its
"transcript difference" line with a finalize run's to see what the
finalizes cost in accuracy.
"""
import argparse
import json
import re
import struct
import subprocess
import sys
import threading
import time
import wave

KIND_JSON, KIND_AUDIO = 1, 2
CHUNK_MS = 20
# Word times are whole 80 ms encoder frames, and a word cut by the finalize
# restarts at the next frame: allow two frames either way.
TOLERANCE = 0.16
# A reference word must be in a pre-ack final if it ended this long before
# the finalize (a word still being spoken at the finalize can be cut).
TAIL_WINDOW = (1.5, 0.12)


def frame(kind, payload):
    return struct.pack("<BI", kind, len(payload)) + payload


def norm(text):
    text = text.lower().replace("’", "'")
    return re.sub(r"[^a-z0-9']+", "", text)


def load_wav_16k_mono(path):
    w = wave.open(path)
    rate, channels, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
    assert width == 2, "need s16 PCM"
    pcm = w.readframes(w.getnframes())
    samples = struct.unpack(f"<{len(pcm) // 2}h", pcm)
    if channels > 1:
        samples = [sum(samples[i:i + channels]) / channels for i in range(0, len(samples), channels)]
    samples = [s / 32768.0 for s in samples]
    if rate != 16000:
        import numpy as np
        from math import gcd
        from scipy.signal import resample_poly

        g = gcd(rate, 16000)
        samples = resample_poly(np.asarray(samples, dtype=np.float64), 16000 // g, rate // g).tolist()
    return samples


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sidecar", required=True)
    ap.add_argument("--asr", required=True)
    ap.add_argument("--wav", required=True)
    ap.add_argument("--deepgram", required=True)
    ap.add_argument("--limit", type=float, default=120.0, help="seconds of audio to stream")
    ap.add_argument("--every", type=float, default=8.0, help="finalize about this often")
    ap.add_argument("--at-pauses", action="store_true", help="finalize 0.7 s into each >= 1 s pause")
    ap.add_argument("--no-finalize", action="store_true")
    ap.add_argument("--fast", action="store_true", help="don't pace at real time")
    ap.add_argument("--out")
    args = ap.parse_args()

    samples = load_wav_16k_mono(args.wav)[: int(args.limit * 16000)]
    duration = len(samples) / 16000
    ref = json.load(open(args.deepgram))["results"]["channels"][0]["alternatives"][0]["words"]

    # Finalize points: the middle of the first reference word after each
    # `every` mark, so every finalize lands mid-utterance, mid-word.
    points = []
    if args.at_pauses and not args.no_finalize:
        for a, b in zip(ref, ref[1:]):
            if b["start"] - a["end"] >= 1.0 and a["end"] + 0.7 < duration - 2:
                points.append(round(a["end"] + 0.7, 2))
    elif not args.no_finalize:
        t = args.every
        while t < duration - 2:
            w = next((w for w in ref if w["start"] >= t and w["end"] - w["start"] >= 0.2), None)
            if not w or w["end"] > duration - 2:
                break
            points.append(round((w["start"] + w["end"]) / 2, 2))
            t = w["end"] + args.every

    proc = subprocess.Popen([args.sidecar], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    messages = []  # (wall time, message)
    ready = threading.Event()
    t0 = time.time()
    stderr_lines = []

    def reader():
        while True:
            header = proc.stdout.read(5)
            if len(header) < 5:
                return
            kind, length = struct.unpack("<BI", header)
            payload = proc.stdout.read(length)
            if kind != KIND_JSON:
                continue
            msg = json.loads(payload)
            messages.append((time.time(), msg))
            if msg.get("type") in ("ready", "error") and not ready.is_set():
                ready.set()

    def errlog():
        for line in proc.stderr:
            stderr_lines.append(line.decode(errors="replace").rstrip())

    threading.Thread(target=reader, daemon=True).start()
    threading.Thread(target=errlog, daemon=True).start()

    lock = threading.Lock()

    def send_json(msg):
        with lock:
            proc.stdin.write(frame(KIND_JSON, json.dumps(msg).encode()))
            proc.stdin.flush()

    send_json({
        "type": "configure",
        "assets": {"asr": args.asr},
        "streams": [{"id": 0, "name": "mic"}],
        "language": "en-US",
        "rnntRightContext": 6,
        "endpointing": True,
        "speechContexts": [],
    })
    ready.wait(300)
    print(f"ready after {time.time() - t0:.2f}s; {len(points)} finalize points in {duration:.0f}s", file=sys.stderr)

    # Protocol edge cases first.
    send_json({"type": "finalize", "stream": "system", "seq": 999})
    send_json({"type": "finalize", "stream": "mic"})  # no seq, before any audio
    send_json({"type": "finalize", "stream": 5, "seq": 998})  # malformed: an error, not a crash

    step = 16 * CHUNK_MS
    sent = []  # (seq, audio position s, wall time)
    pending = list(points)
    seq = 0
    t_audio0 = time.time()
    for n, i in enumerate(range(0, len(samples), step)):
        chunk = samples[i:i + step]
        payload = struct.pack("<BI", 0, 16000) + struct.pack(f"<{len(chunk)}f", *chunk)
        with lock:
            proc.stdin.write(frame(KIND_AUDIO, payload))
            proc.stdin.flush()
        pos = (i + len(chunk)) / 16000
        if pending and pos >= pending[0]:
            pending.pop(0)
            seq += 1
            sent.append((seq, pos, time.time()))
            send_json({"type": "finalize", "stream": "mic", "seq": seq})
        if not args.fast:
            delay = t_audio0 + (n + 1) * CHUNK_MS / 1000 - time.time()
            if delay > 0:
                time.sleep(delay)
    time.sleep(1.0)
    send_json({"type": "finish"})
    proc.stdin.close()
    proc.wait(timeout=120)
    time.sleep(0.2)

    if args.out:
        with open(args.out, "w") as f:
            for wall, m in messages:
                m = dict(m, _t=round(wall - t0, 3))
                f.write(json.dumps(m) + "\n")

    # ---- analysis ------------------------------------------------------------
    ok = True
    types = [m.get("type") for _, m in messages]
    err = next((m for _, m in messages if m.get("type") == "error" and m.get("seq") == 999), None)
    print(f"unknown stream  → {json.dumps(err)}")
    if not err or err.get("fatal") is not False or err.get("seq") != 999 or err.get("stream") != "system":
        ok = False
        print("  FAIL: expected a non-fatal finalize error echoing stream + seq")
    noseq = [m for _, m in messages if m.get("type") == "finalized" and "seq" not in m]
    print(f"no-seq finalize → {json.dumps(noseq[0]) if noseq else None}")
    if len(noseq) != 1:
        ok = False
        print("  FAIL: expected exactly one ack without seq")

    idx_of_ack = {}
    for i, (_, m) in enumerate(messages):
        if m.get("type") == "finalized" and "seq" in m:
            idx_of_ack[m["seq"]] = i
    latencies, violations, tail_total, tail_missing = [], [], 0, []
    for k, pos, wall in sent:
        if k not in idx_of_ack:
            ok = False
            print(f"finalize {k} @ {pos:.2f}s: NO ACK")
            continue
        ai = idx_of_ack[k]
        ack_wall = messages[ai][0]
        latencies.append(ack_wall - wall)
        # Ordering: everything after this ack.
        for wall2, m in messages[ai + 1:]:
            if m.get("type") != "transcript":
                continue
            msg = m["message"]
            if msg.get("type") == "Results":
                for w in msg["channel"]["alternatives"][0].get("words", []):
                    if w["start"] < pos - TOLERANCE:
                        violations.append((k, pos, "word", w["word"], w["start"], msg.get("is_final")))
            elif msg.get("type") == "SpeechStarted" and msg["timestamp"] < pos - TOLERANCE:
                violations.append((k, pos, "SpeechStarted", "", msg["timestamp"], None))
            elif msg.get("type") == "UtteranceEnd" and msg["last_word_end"] < pos - TOLERANCE:
                violations.append((k, pos, "UtteranceEnd", "", msg["last_word_end"], None))
        # Tail: reference words that ended just before the finalize.
        prev_ack = max([idx_of_ack[j] for j in idx_of_ack if j < k] or [-1])
        pre = []
        for _, m in messages[prev_ack + 1: ai]:
            if m.get("type") == "transcript" and m["message"].get("type") == "Results" and m["message"].get("is_final"):
                pre += m["message"]["channel"]["alternatives"][0].get("words", [])
        for w in ref:
            if pos - TAIL_WINDOW[0] <= w["end"] <= pos - TAIL_WINDOW[1]:
                tail_total += 1
                hit = any(norm(h["word"]) == norm(w["word"]) and abs(h["start"] - w["start"]) < 0.6 for h in pre)
                if not hit:
                    tail_missing.append((k, pos, w["word"], w["start"]))

    # Accuracy: final words vs the reference over the streamed window.
    span = duration - 2
    hyp = []
    for _, m in messages:
        if m.get("type") == "transcript" and m["message"].get("is_final"):
            hyp += [w["word"] for w in m["message"]["channel"]["alternatives"][0].get("words", [])
                    if w["start"] < span]
    ref_words = [w["word"] for w in ref if w["start"] < span]
    h, r = [x for x in map(norm, hyp) if x], [x for x in map(norm, ref_words) if x]
    prev = list(range(len(h) + 1))
    for i, x in enumerate(r, 1):
        cur = [i] + [0] * len(h)
        for j, y in enumerate(h, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y))
        prev = cur
    print(f"transcript difference vs Deepgram over {span:.0f}s: {prev[-1] / max(1, len(r)):.3f} ({len(h)} vs {len(r)} words)")

    finals = sum(1 for _, m in messages if m.get("type") == "transcript" and m["message"].get("is_final"))
    fz = sum(1 for _, m in messages if m.get("type") == "transcript" and m["message"].get("from_finalize"))
    print(f"messages {len(messages)}  finals {finals} (from_finalize {fz})  finalizes {len(sent)}  acks {len(idx_of_ack)}")
    if latencies:
        ls = sorted(latencies)
        print(f"ack latency ms: min {ls[0]*1000:.0f}  median {ls[len(ls)//2]*1000:.0f}  max {ls[-1]*1000:.0f}")
    print(f"ordering violations (after-ack items older than the finalize by > {TOLERANCE}s): {len(violations)}")
    for v in violations[:20]:
        print("  ", v)
    if violations:
        ok = False
    print(f"tail words (ref words ending {TAIL_WINDOW[1]}–{TAIL_WINDOW[0]}s before a finalize) found before the ack: "
          f"{tail_total - len(tail_missing)}/{tail_total}")
    for t in tail_missing[:20]:
        print("   missing", t)
    dropped = sum(int(m.group(1)) for line in stderr_lines
                  for m in [re.search(r"dropped (\d+) word", line)] if m)
    print(f"words dropped as late tokens from finalize padding: {dropped}")
    fatal = [m for _, m in messages if m.get("type") == "error" and m.get("fatal")]
    if fatal or proc.returncode != 0:
        ok = False
        print(f"FAIL: exit {proc.returncode}, fatal errors {fatal}")
        print("\n".join(stderr_lines[-20:]))
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
