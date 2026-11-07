#!/usr/bin/env python3
"""Drive the dial8-local-tts sidecar over protocol v1, exactly as the app does.

One session: configure → ready, then each sentence as its own `speak` (waiting
for `done` before the next, like read-aloud), then stop tests (`cancel` a set
time after the first audio), then the error cases (unknown voice, empty
text), then stdin EOF, which must end the process promptly. Reports load
time, first-audio latency (median / p90), speed vs real time, stop latency,
CPU cores used and peak memory. Standard library only.

  drive.py --sidecar .out/bin/dial8-local-tts --models DIR [--sentences chat.txt]
           [--voice aba] [--threads 2] [--lsd-steps 8] [--wav-dir DIR]
           [--cancel-sentence TEXT] [--cancel-after-ms 300] [--cancel-runs 5]
           [--json OUT.json]
  drive.py --sidecar ... --models DIR --warmup-only     # the enable flow's warm-up

--models holds the module.json assets under their "file" names (the app's
module store, or any folder with the same files).
"""
import argparse
import json
import resource
import statistics
import struct
import subprocess
import sys
import threading
import time
import wave
from pathlib import Path

KIND_JSON, KIND_AUDIO = 1, 2
HERE = Path(__file__).resolve().parent


def frame(kind, payload):
    return struct.pack("<BI", kind, len(payload)) + payload


class Sidecar:
    """The sidecar process plus a reader thread that timestamps every frame."""

    def __init__(self, path):
        self.proc = subprocess.Popen([path], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.events = []          # (t, "json", msg) | (t, "audio", nsamples, rate, samples_bytes)
        self.cv = threading.Condition()
        self.log = []
        self.truncated = False
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._stderr, daemon=True).start()

    def _read(self):
        out = self.proc.stdout
        while True:
            header = out.read(5)
            if len(header) < 5:
                break
            kind, length = struct.unpack("<BI", header)
            payload = out.read(length)
            if len(payload) < length:
                self.truncated = True  # the sidecar must never exit mid-frame
                break
            t = time.perf_counter()
            if kind == KIND_JSON:
                ev = (t, "json", json.loads(payload))
            else:
                stream, rate = struct.unpack_from("<BI", payload)
                ev = (t, "audio", (len(payload) - 5) // 4, rate, payload[5:])
            with self.cv:
                self.events.append(ev)
                self.cv.notify_all()
        with self.cv:
            self.events.append((time.perf_counter(), "eof", None))
            self.cv.notify_all()

    def _stderr(self):
        for line in self.proc.stderr:
            self.log.append(line.decode(errors="replace").rstrip())

    def send(self, msg):
        self.proc.stdin.write(frame(KIND_JSON, json.dumps(msg).encode()))
        self.proc.stdin.flush()
        return time.perf_counter()

    def wait_for(self, pred, start=0, timeout=120):
        """Index of the first event from `start` matching pred(ev)."""
        deadline = time.perf_counter() + timeout
        with self.cv:
            while True:
                for i in range(start, len(self.events)):
                    if pred(self.events[i]):
                        return i
                left = deadline - time.perf_counter()
                if left <= 0:
                    raise TimeoutError("sidecar did not answer; its log:\n" + "\n".join(self.log[-20:]))
                self.cv.wait(left)

    def wait_json(self, type_, start=0, timeout=120, **match):
        return self.wait_for(lambda e: e[1] == "json" and e[2].get("type") == type_ and
                             all(e[2].get(k) == v for k, v in match.items()), start, timeout)


def assets(models_dir):
    manifest = json.loads((HERE.parent / "module.json").read_text())
    paths = {a["name"]: str(Path(models_dir) / a["file"]) for a in manifest["assets"]}
    missing = [p for p in paths.values() if not Path(p).is_file()]
    if missing:
        sys.exit(f"model files missing: {', '.join(missing)}")
    return paths


def write_wav(path, samples_bytes, rate):
    n = len(samples_bytes) // 4
    floats = struct.unpack(f"<{n}f", samples_bytes)
    pcm = struct.pack(f"<{n}h", *(max(-32768, min(32767, int(x * 32767))) for x in floats))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)


def pct(values, p):
    s = sorted(values)
    return s[min(len(s) - 1, int(round(p * (len(s) - 1))))]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sidecar", required=True)
    ap.add_argument("--models", required=True)
    ap.add_argument("--sentences", default=str(HERE / "chat.txt"))
    ap.add_argument("--voice")
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--lsd-steps", type=int, default=8)
    ap.add_argument("--wav-dir")
    ap.add_argument("--cancel-sentence", default=(HERE / "cancel.txt").read_text().strip())
    ap.add_argument("--cancel-after-ms", type=float, default=300)
    ap.add_argument("--cancel-runs", type=int, default=5)
    ap.add_argument("--warmup-only", action="store_true")
    ap.add_argument("--json")
    ap.add_argument("--show-log", action="store_true", help="print the sidecar's stderr at the end")
    args = ap.parse_args()

    sc = Sidecar(args.sidecar)
    t0 = time.perf_counter()
    hello = sc.events[sc.wait_json("hello")][2]
    configure = {"type": "configure", "assets": assets(args.models), "threads": args.threads,
                 "lsdSteps": args.lsd_steps, "warmup": args.warmup_only}
    sc.send(configure)
    i = sc.wait_for(lambda e: e[1] == "json" and e[2].get("type") in ("ready", "error"))
    ready = sc.events[i][2]
    if ready["type"] != "ready":
        sys.exit(f"sidecar failed: {ready}")
    load_s = sc.events[i][0] - t0
    print(f"hello {hello['version']!r}  ready in {load_s:.2f}s  voices {ready['voices']}", file=sys.stderr)

    if args.warmup_only:
        t_close = time.perf_counter()
        sc.proc.stdin.close()
        code = sc.proc.wait(timeout=10)
        print(f"warm-up: exit {code} {1000 * (time.perf_counter() - t_close):.0f} ms after stdin EOF", file=sys.stderr)
        for line in sc.log:
            print("  log:", line, file=sys.stderr)
        sys.exit(0 if code == 0 else 1)

    voice = args.voice or ready["voices"][0]
    sentences = [s for s in Path(args.sentences).read_text().splitlines() if s.strip()]
    rows = []
    if args.wav_dir:
        Path(args.wav_dir).mkdir(parents=True, exist_ok=True)
    wall0 = time.perf_counter()
    for n, text in enumerate(sentences):
        sid = f"s{n}"
        start = len(sc.events)
        t_send = sc.send({"type": "speak", "id": sid, "text": text, "voice": voice})
        end = sc.wait_for(lambda e: e[1] == "json" and e[2].get("id") == sid and e[2].get("type") in ("done", "error"), start)
        if sc.events[end][2]["type"] == "error":
            sys.exit(f"speak failed: {sc.events[end][2]}")
        audio = [e for e in sc.events[start:end] if e[1] == "audio"]
        first_ms = 1000 * (audio[0][0] - t_send)
        total_s = sc.events[end][0] - t_send
        audio_s = sum(e[2] for e in audio) / 24000
        rows.append({"i": n, "text": text, "first_ms": round(first_ms, 1), "total_ms": round(1000 * total_s, 1),
                     "audio_s": round(audio_s, 3), "chunks": len(audio),
                     "reported_audio_s": sc.events[end][2]["audioSeconds"]})
        if args.wav_dir:
            write_wav(Path(args.wav_dir) / f"{n:02d}.wav", b"".join(e[4] for e in audio), audio[0][3])
        print(f"  {n:2d} first {first_ms:5.1f} ms  {audio_s:5.2f}s audio  {audio_s / total_s:4.1f}x  {text[:60]}", file=sys.stderr)
    speak_wall = time.perf_counter() - wall0

    # Stop tests: cancel args.cancel_after_ms after the first audio frame.
    cancels = []
    for n in range(args.cancel_runs):
        sid = f"c{n}"
        start = len(sc.events)
        sc.send({"type": "speak", "id": sid, "text": args.cancel_sentence, "voice": voice})
        # Queue a second utterance too: cancel must drop it without speaking it.
        sc.send({"type": "speak", "id": f"{sid}-queued", "text": "This must never be spoken.", "voice": voice})
        first = sc.wait_for(lambda e: e[1] == "audio", start)
        delay = sc.events[first][0] + args.cancel_after_ms / 1000 - time.perf_counter()
        if delay > 0:
            time.sleep(delay)
        t_cancel = sc.send({"type": "cancel"})
        at_cancel = len(sc.events)
        k = sc.wait_json("cancelled", start)
        t_done = sc.events[k][0]
        ids = sc.events[k][2]["ids"]
        after_cancel_frames = sum(1 for e in sc.events[at_cancel:k] if e[1] == "audio")
        time.sleep(0.3)  # nothing may follow `cancelled` for these ids
        late = [e for e in sc.events[k + 1:] if e[1] == "audio" or (e[1] == "json" and e[2].get("id") in (sid, f"{sid}-queued"))]
        cancels.append({"stop_ms": round(1000 * (t_done - t_cancel), 1), "ids": ids,
                        "frames_between": after_cancel_frames, "late_events": len(late)})
        print(f"  cancel {n}: cancelled {ids} after {1000 * (t_done - t_cancel):.1f} ms "
              f"({after_cancel_frames} audio frames in between, {len(late)} after)", file=sys.stderr)

    # Error cases: non-fatal replies, and the sidecar keeps working.
    start = len(sc.events)
    sc.send({"type": "speak", "id": "bad-voice", "text": "Hello there.", "voice": "nobody"})
    err_voice = sc.events[sc.wait_json("error", start, id="bad-voice")][2]
    sc.send({"type": "speak", "id": "empty", "text": "   "})
    err_empty = sc.events[sc.wait_json("error", start, id="empty")][2]
    t = sc.send({"type": "ping"})
    pong_ms = 1000 * (sc.events[sc.wait_json("pong", start)][0] - t)
    sc.send({"type": "speak", "id": "after-errors", "text": "Still here."})
    sc.wait_json("done", start, id="after-errors")
    print(f"  errors: {err_voice['code']} (fatal {err_voice['fatal']}), {err_empty['code']} "
          f"(fatal {err_empty['fatal']}); ping {pong_ms:.1f} ms; speaks after", file=sys.stderr)

    # stdin EOF mid-utterance: the process must exit at once.
    sc.send({"type": "speak", "id": "eof", "text": args.cancel_sentence, "voice": voice})
    sc.wait_for(lambda e: e[1] == "audio", start)
    t_close = time.perf_counter()
    sc.proc.stdin.close()
    code = sc.proc.wait(timeout=10)
    exit_ms = 1000 * (time.perf_counter() - t_close)
    wall = time.perf_counter() - t0
    ru = resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu = ru.ru_utime + ru.ru_stime
    sc.wait_for(lambda e: e[1] == "eof")
    print(f"  stdin EOF mid-utterance: exit {code} after {exit_ms:.0f} ms"
          f"{', LAST FRAME TRUNCATED' if sc.truncated else ', last frame whole'}", file=sys.stderr)
    if args.show_log:
        for line in sc.log:
            print("  log:", line, file=sys.stderr)

    first = [r["first_ms"] for r in rows]
    audio_s = sum(r["audio_s"] for r in rows)
    compute_s = sum(r["total_ms"] for r in rows) / 1000
    stops = [c["stop_ms"] for c in cancels]
    result = {
        "version": hello["version"], "voice": voice, "threads": args.threads, "lsd_steps": args.lsd_steps,
        "sentences": len(rows), "load_s": round(load_s, 3),
        "first_ms_median": statistics.median(first), "first_ms_p90": pct(first, 0.9), "first_ms_max": max(first),
        "realtime_x": round(audio_s / compute_s, 2), "audio_s": round(audio_s, 2),
        "stop_ms_median": statistics.median(stops) if stops else None, "stop_ms_max": max(stops) if stops else None,
        "stop_late_events": sum(c["late_events"] for c in cancels),
        "cores_used": round(cpu / wall, 2), "peak_rss_mb": round(ru.ru_maxrss / 1048576),  # bytes on macOS
        "unknown_voice": err_voice["code"], "empty_text": err_empty["code"],
        "eof_exit_code": code, "eof_exit_ms": round(exit_ms), "eof_truncated_frame": sc.truncated,
        "rows": rows, "cancels": cancels, "speak_wall_s": round(speak_wall, 2),
    }
    if args.json:
        Path(args.json).write_text(json.dumps(result, indent=1))
    keys = ["load_s", "first_ms_median", "first_ms_p90", "realtime_x", "stop_ms_median", "stop_ms_max",
            "cores_used", "peak_rss_mb", "eof_exit_ms"]
    print(json.dumps({k: result[k] for k in keys}))


if __name__ == "__main__":
    main()
