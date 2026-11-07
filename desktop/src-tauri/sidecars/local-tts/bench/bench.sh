#!/bin/bash
# Regression bench for the local-tts sidecar: drives the built sidecar (not
# upstream's CLI) over protocol v1 exactly as the app does, then reads its
# speech back through local-stt. Run after every upstream bump
# (scripts/modules/bump.sh local-tts <ref> runs it).
#
#   bench.sh [MODELS_DIR]
#
# MODELS_DIR holds module.json's assets under their "file" names. Default:
# $TTS_MODELS, else the app's module store (enable read-aloud in the app).
# Read-back needs a built local-stt (../local-stt/.out/bin, or
# LOCAL_STT_SIDECAR) and its models (the app's store, or NEMO_ASR/NEMO_DIAR);
# without them it is skipped, with a note.
#
# Gates (docs/plans/local-modules.md Part 3 / Phase 7, 2 threads, lsdSteps 8):
# first audio ≤ 60 ms median; ≥ 4× real time; stop ≤ 100 ms (every run); no
# audio after `cancelled`; read-back word error ≤ 3% on the chat set; warm-up
# and stdin EOF exit cleanly; every edge case (bench/edge.py: long and
# number-heavy sentences split and not truncated, an oversized frame, text
# with nothing speakable, a NUL, cancel between pieces) passes.
set -euo pipefail
cd "$(dirname "$0")/.."

SIDECAR=".out/bin/dial8-local-tts"
[ -x "$SIDECAR" ] || { echo "build first: ./build.sh release" >&2; exit 1; }

ASSETS_VERSION="$(sed -nE 's/.*"assetsVersion"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' module.json)"
MODELS="${1:-${TTS_MODELS:-$HOME/Library/Application Support/ai.dial8.desktop/modules/local-tts/$ASSETS_VERSION}}"
[ -d "$MODELS" ] || { echo "models not found: $MODELS (enable read-aloud in the app, or pass a folder)" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "[bench] warm-up (the enable flow):"
python3 -B bench/drive.py --sidecar "$SIDECAR" --models "$MODELS" --warmup-only 2>&1 | sed 's/^/  /'

echo "[bench] chat set, one speak at a time, then stop / error / EOF tests:"
python3 -B bench/drive.py --sidecar "$SIDECAR" --models "$MODELS" --threads 2 --lsd-steps 8 \
    --wav-dir "$WORK/wav" --json "$WORK/drive.json" 2>&1 | sed 's/^/  /'

echo "[bench] edge cases:"
# (a failure shows in its gate below, from edge.json)
python3 -B bench/edge.py --sidecar "$SIDECAR" --models "$MODELS" --threads 2 --lsd-steps 8 \
    --json "$WORK/edge.json" 2>&1 | sed 's/^/  /' || true

STT_SIDECAR="${LOCAL_STT_SIDECAR:-../local-stt/.out/bin/dial8-local-stt}"
STT_STORE="$(ls -d "$HOME/Library/Application Support/ai.dial8.desktop/modules/local-stt/"*/ 2>/dev/null | tail -1 || true)"
ASR="${NEMO_ASR:-${STT_STORE}nemotron-speech-streaming-en-0.6b.q8_0.gguf}"
DIAR="${NEMO_DIAR:-${STT_STORE}Nemotron-3-Diarization.q8_0.gguf}"
if [ -x "$STT_SIDECAR" ] && [ -f "$ASR" ] && [ -f "$DIAR" ]; then
    echo "[bench] read-back through local-stt:"
    python3 -B bench/readback.py --wav-dir "$WORK/wav" --sentences bench/chat.txt --stt-sidecar "$STT_SIDECAR" \
        --asr "$ASR" --diar "$DIAR" --json "$WORK/readback.json" 2>&1 | sed 's/^/  /'
else
    echo "[bench] read-back skipped: no local-stt sidecar ($STT_SIDECAR) or models — set LOCAL_STT_SIDECAR / NEMO_ASR / NEMO_DIAR"
fi

python3 - "$WORK/drive.json" "$WORK/readback.json" "$WORK/edge.json" <<'PY'
import json, sys, os
d = json.load(open(sys.argv[1]))
r = json.load(open(sys.argv[2])) if os.path.exists(sys.argv[2]) else None
e = json.load(open(sys.argv[3])) if os.path.exists(sys.argv[3]) else {}
gates = [
    ("first audio, median", f"{d['first_ms_median']:.0f} ms (p90 {d['first_ms_p90']:.0f})", d["first_ms_median"] <= 60),
    ("speed", f"{d['realtime_x']:.1f}x real time", d["realtime_x"] >= 4),
    ("stop", f"median {d['stop_ms_median']:.1f} ms, max {d['stop_ms_max']:.1f} ms", d["stop_ms_max"] <= 100),
    ("audio after cancelled", str(d["stop_late_events"]), d["stop_late_events"] == 0),
    ("stdin EOF", f"exit {d['eof_exit_code']} in {d['eof_exit_ms']} ms", d["eof_exit_code"] == 0 and d["eof_exit_ms"] <= 500 and not d["eof_truncated_frame"]),
]
failed = [k for k, v in e.items() if not v["pass"]]
gates.append(("edge cases", f"{len(e) - len(failed)}/{len(e)} pass" + (f" (failed: {', '.join(failed)})" if failed else ""),
              bool(e) and not failed))
if r:
    gates.append(("read-back word error", f"{100 * r['wer']:.1f}% ({r['errors']}/{r['words']} words)", r["wer"] <= 0.03))
print(f"[bench] {d['version']}, voice {d['voice']}, {d['threads']} threads, lsdSteps {d['lsd_steps']}: "
      f"load {d['load_s']:.2f}s, {d['cores_used']} cores, peak {d['peak_rss_mb']} MB")
ok = True
for name, value, passed in gates:
    ok &= passed
    print(f"  {'PASS' if passed else 'FAIL'}  {name}: {value}")
sys.exit(0 if ok else 1)
PY
