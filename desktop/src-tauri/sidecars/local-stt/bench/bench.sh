#!/bin/bash
# Regression bench for the local-stt sidecar: runs the built sidecar (not
# upstream's CLI) over the test recordings exactly as the app does and scores
# it against the cached Deepgram responses. Run after every upstream bump.
#
#   bench.sh [AUDIO_DIR]     default AUDIO_DIR: ~/code/speech-audio-bench
#
# AUDIO_DIR holds <name>.wav + <name>.deepgram.json for interview, teams-call,
# fast-talk (any format ffmpeg reads; converted to 16 kHz mono here). Models
# come from the app's module store if present, else NEMO_ASR / NEMO_DIAR.
#
# Gates (docs/plans/local-modules.md Part 4): speaker agreement ≥ 0.97
# (interview, teams-call) and ≥ 0.85 (fast-talk); transcript difference vs
# Deepgram ≤ 0.07 / 0.07 / 0.18; exact speaker counts.
set -euo pipefail
cd "$(dirname "$0")/.."

AUDIO_DIR="${1:-$HOME/code/speech-audio-bench}"
SIDECAR=".out/bin/dial8-local-stt"
[ -x "$SIDECAR" ] || { echo "build first: ./build.sh release" >&2; exit 1; }

STORE="$HOME/Library/Application Support/ai.dial8.desktop/modules/local-stt"
ASSETS="$(ls -d "$STORE"/*/ 2>/dev/null | tail -1 || true)"
ASR="${NEMO_ASR:-${ASSETS}nemotron-speech-streaming-en-0.6b.q8_0.gguf}"
DIAR="${NEMO_DIAR:-${ASSETS}Nemotron-3-Diarization.q8_0.gguf}"
for f in "$ASR" "$DIAR"; do
    [ -f "$f" ] || { echo "model not found: $f (enable the module in the app, or set NEMO_ASR/NEMO_DIAR)" >&2; exit 1; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for name in interview teams-call fast-talk; do
    ffmpeg -loglevel error -y -i "$AUDIO_DIR/$name.wav" -ac 1 -ar 16000 -c:a pcm_s16le "$WORK/$name.wav"
    python3 bench/drive.py --sidecar "$SIDECAR" --asr "$ASR" --diar "$DIAR" \
        --wav "$WORK/$name.wav" --out "$WORK/$name.jsonl" 2>&1 | grep -E "^audio|error" || true
    printf '%-11s ' "$name"
    python3 bench/score.py "$WORK/$name.jsonl" "$AUDIO_DIR/$name.deepgram.json"
done
