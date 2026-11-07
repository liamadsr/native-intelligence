#!/usr/bin/env python3
"""Intelligibility: read the bench's clips back through local-stt and score word error.

Concatenates NN.wav (from drive.py --wav-dir) with gaps, converts to 16 kHz
with afconvert, transcribes it with the local-stt sidecar (its own
bench/drive.py), maps each recognized word back to its sentence and prints
word error per sentence and overall. Misses are mostly local-stt homophones
("they're" heard as "their"), so compare runs, not absolutes. Stdlib only.

  readback.py --wav-dir DIR --sentences chat.txt --stt-sidecar dial8-local-stt
              --asr ASR.gguf --diar DIAR.gguf [--json OUT.json]
"""
import argparse
import json
import re
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
STT_DRIVE = HERE.parent.parent / "local-stt" / "bench" / "drive.py"
GAP_S, PAD_S = 1.5, 1.0


def norm_words(text):
    text = text.lower().replace("-", " ").replace("’", "'")
    text = re.sub(r"[^a-z0-9' ]+", " ", text)
    return [w.strip("'") for w in text.split() if w.strip("'")]


def edit_distance(a, b):
    d = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(b) + 1):
            cur = d[j]
            d[j] = min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] != b[j - 1]))
            prev = cur
    return d[len(b)]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--wav-dir", required=True)
    ap.add_argument("--sentences", required=True)
    ap.add_argument("--stt-sidecar", required=True)
    ap.add_argument("--asr", required=True)
    ap.add_argument("--diar", required=True)
    ap.add_argument("--json")
    args = ap.parse_args()

    sentences = [s for s in Path(args.sentences).read_text().splitlines() if s.strip()]
    clips = sorted(Path(args.wav_dir).glob("[0-9][0-9].wav"))
    if len(clips) != len(sentences):
        sys.exit(f"{len(clips)} clips for {len(sentences)} sentences")

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        spans, t, rate = [], PAD_S, None
        with wave.open(str(tmp / "all24.wav"), "wb") as out:
            for clip in clips:
                with wave.open(str(clip)) as w:
                    if rate is None:
                        rate = w.getframerate()
                        out.setnchannels(1)
                        out.setsampwidth(2)
                        out.setframerate(rate)
                        out.writeframes(b"\0\0" * int(PAD_S * rate))
                    pcm = w.readframes(w.getnframes())
                spans.append((t, t + len(pcm) / 2 / rate))
                out.writeframes(pcm + b"\0\0" * int(GAP_S * rate))
                t += len(pcm) / 2 / rate + GAP_S
            out.writeframes(b"\0\0" * int(PAD_S * rate))
        subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1",
                        str(tmp / "all24.wav"), str(tmp / "all16.wav")], check=True)
        subprocess.run([sys.executable, "-B", str(STT_DRIVE), "--sidecar", args.stt_sidecar, "--asr", args.asr,
                        "--diar", args.diar, "--wav", str(tmp / "all16.wav"), "--out", str(tmp / "stt.jsonl")],
                       check=True, stderr=subprocess.DEVNULL)
        heard = [[] for _ in sentences]
        for line in (tmp / "stt.jsonl").read_text().splitlines():
            m = json.loads(line)
            if m.get("type") != "transcript" or not m["message"].get("is_final"):
                continue
            for wd in m["message"]["channel"]["alternatives"][0].get("words", []):
                for k, (a, b) in enumerate(spans):
                    if a - 0.4 <= wd["start"] <= b + 0.6:
                        heard[k].append(wd.get("punctuated_word") or wd["word"])
                        break

    rows, total_ref, total_err = [], 0, 0
    for text, h in zip(sentences, heard):
        ref, hyp = norm_words(text), norm_words(" ".join(h))
        err = edit_distance(ref, hyp)
        total_ref += len(ref)
        total_err += err
        rows.append({"text": text, "heard": " ".join(h), "errors": err, "words": len(ref)})
        mark = "  " if err == 0 else f"{err:2d}"
        print(f"  {mark} {text}" + ("" if err == 0 else f"\n      heard: {' '.join(h)}"), file=sys.stderr)
    wer = total_err / total_ref if total_ref else 0.0
    result = {"wer": round(wer, 4), "errors": total_err, "words": total_ref,
              "sentences_with_errors": sum(1 for r in rows if r["errors"]), "rows": rows}
    if args.json:
        Path(args.json).write_text(json.dumps(result, indent=1))
    print(json.dumps({k: result[k] for k in ("wer", "errors", "words", "sentences_with_errors")}))


if __name__ == "__main__":
    main()
