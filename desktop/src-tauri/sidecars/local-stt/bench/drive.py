#!/usr/bin/env python3
"""Drive the dial8-local-stt sidecar over protocol v1, exactly as the app does.

Feeds a 16 kHz mono WAV into one stream, records every message the sidecar
emits (JSONL), and prints timing. Used by bench.sh and for manual checks.

  drive.py --sidecar .out/bin/dial8-local-stt --asr A.gguf --diar D.gguf \
           --wav meeting.wav --out messages.jsonl [--stream system] [--realtime]
           [--speech-contexts contexts.json]

--diar "" runs without the diarizer (the voice session's configure).
--speech-contexts is a JSON list of {"phrases": [...], "boost": N}, sent as
configure's speechContexts (word boosting; boost.py scores it).
"""
import argparse
import json
import struct
import subprocess
import sys
import threading
import time
import wave

KIND_JSON, KIND_AUDIO = 1, 2
STREAMS = {"mic": 0, "system": 1}


def frame(kind, payload):
    return struct.pack("<BI", kind, len(payload)) + payload


def send_json(pipe, msg):
    pipe.write(frame(KIND_JSON, json.dumps(msg).encode()))
    pipe.flush()


def read_frames(pipe, on_message):
    while True:
        header = pipe.read(5)
        if len(header) < 5:
            return
        kind, length = struct.unpack("<BI", header)
        payload = pipe.read(length)
        if kind == KIND_JSON:
            on_message(json.loads(payload))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sidecar", required=True)
    ap.add_argument("--asr", required=True)
    ap.add_argument("--diar", required=True)
    ap.add_argument("--wav", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--stream", default="system", choices=sorted(STREAMS))
    ap.add_argument("--chunk-ms", type=int, default=20)
    ap.add_argument("--realtime", action="store_true", help="pace audio at 1x")
    ap.add_argument("--right-context", type=int, default=6)
    ap.add_argument("--gpu", type=int, default=0)
    ap.add_argument("--speech-contexts", default=None, help="JSON file: [{phrases, boost}]")
    args = ap.parse_args()
    contexts = json.load(open(args.speech_contexts)) if args.speech_contexts else []

    w = wave.open(args.wav)
    assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2, "need 16k mono s16"
    pcm = w.readframes(w.getnframes())
    samples = struct.unpack(f"<{len(pcm) // 2}h", pcm)
    duration = len(samples) / 16000

    proc = subprocess.Popen([args.sidecar], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr)
    messages = []
    ready = threading.Event()
    first_result_at = []
    t_start = time.time()

    def on_message(msg):
        msg["_t"] = round(time.time() - t_start, 3)
        messages.append(msg)
        if msg.get("type") == "ready":
            ready.set()
        if msg.get("type") == "error":
            print("sidecar error:", msg, file=sys.stderr)
            ready.set()
        if msg.get("type") == "transcript" and not first_result_at:
            first_result_at.append(time.time())

    reader = threading.Thread(target=read_frames, args=(proc.stdout, on_message), daemon=True)
    reader.start()

    send_json(proc.stdin, {
        "type": "configure",
        "assets": {"asr": args.asr, "diarizer": args.diar},
        "streams": [{"id": 0, "name": "mic"}, {"id": 1, "name": "system"}],
        "language": "en-US",
        "rnntRightContext": args.right_context,
        "endpointing": True,
        "gpu": args.gpu,
        "speechContexts": contexts,
    })
    ready.wait(300)
    t_ready = time.time()
    hello = next((m for m in messages if m.get("type") == "hello"), {})
    print(f"hello {hello.get('version')}  ready after {t_ready - t_start:.2f}s", file=sys.stderr)

    step = 16 * args.chunk_ms
    sid = STREAMS[args.stream]
    t_audio0 = time.time()
    for n, i in enumerate(range(0, len(samples), step)):
        chunk = samples[i:i + step]
        payload = struct.pack("<BI", sid, 16000) + struct.pack(f"<{len(chunk)}f", *(s / 32768.0 for s in chunk))
        proc.stdin.write(frame(KIND_AUDIO, payload))
        if args.realtime:
            # Absolute schedule: chunk n is due at t0 + n*chunk, so per-chunk
            # overhead never accumulates into drift.
            proc.stdin.flush()
            delay = t_audio0 + (n + 1) * args.chunk_ms / 1000 - time.time()
            if delay > 0:
                time.sleep(delay)
    proc.stdin.flush()
    t_fed = time.time()
    send_json(proc.stdin, {"type": "finish"})
    proc.stdin.close()
    proc.wait(timeout=600)
    reader.join(timeout=10)
    t_done = time.time()

    for m in messages:
        m["_audio_t0"] = round(t_audio0 - t_start, 3)
    with open(args.out, "w") as f:
        for m in messages:
            f.write(json.dumps(m) + "\n")
    finals = sum(1 for m in messages if m.get("type") == "transcript" and m["message"].get("is_final"))
    interims = sum(1 for m in messages if m.get("type") == "transcript" and m["message"].get("type") == "Results" and not m["message"].get("is_final"))
    proc_time = t_done - t_ready
    print(
        f"audio {duration:.1f}s  processed in {proc_time:.1f}s ({duration / proc_time:.1f}x realtime)  "
        f"feed {t_fed - t_ready:.1f}s  finals {finals}  interims {interims}  exit {proc.returncode}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
