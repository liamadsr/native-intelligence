#!/bin/bash
# Make a dial8-local-tts voice from a clean recording, on a developer Mac.
#
#   voices/make-voice.sh <recording> <id> "<name>" [--description TEXT]
#       [--consent REF] [--licence SPDX --attribution TEXT --source URL] [--as-is]
#       [--speech-dbfs N] [--replace]
#
# The recording: 10–30 s of one speaker, quiet room, good mic, delivered
# naturally in the tone replies should have (anything afconvert reads).
#
# Consent: our own voices need --consent REF, a reference to the speaker's
# signed consent to synthetic speech in a commercial product. The recording
# and the consent stay in private storage; only voices/<id>.emb and the
# voices.json entry are committed. Without --consent, a clip needs --licence
# (one of voices/catalogue.py's LICENCES, e.g. CC-BY-4.0) plus --attribution
# and --source: a third-party clip under an open licence.
#
# It fetches the Mimi encoder (SHA-pinned; the encoder clones voices, so it
# lives only in ~/Library/Caches/dial8-local-tts/ and is never shipped),
# (MIMI_ENCODER=<file> uses a local copy instead, still SHA-checked),
# converts the recording to 24 kHz mono, trims leading and trailing silence,
# levels it, encodes it with .out/tools/dial8-tts-make-voice, writes
# voices/<id>.emb and appends the entry to voices.json. --as-is skips
# converting, trimming and levelling: the clip (WAV, MP3 or FLAC) is encoded
# exactly as PocketTTS.cpp would load it.
#
# Levelling: gain brings the speech (20 ms windows within 40 dB of the
# loudest) to --speech-dbfs (default -16), then a look-ahead peak limiter
# (5 ms look-ahead and attack, 80 ms release, 4x-oversampled true-peak
# detector) holds peaks under -1 dBTP, with make-up until the speech lands on
# the target. A voice renders at about its reference's speech level, 2 dB
# under it to 1 dB over depending on the take, so the target sets how loud the voice
# speaks. Replies should render at about -17 dBFS speech (Kyutai's alba, the
# old default): each voice's --speech-dbfs is in UPSTREAM.md's Voices table
# (aba -17, cha -15, ush -16.5, chichi -17.2, lori -17.1, lowli -17,
# tana -16.9, milton -17.9, nilo -16.5, ava -17.6). Check a new voice's render against theirs.
#
# --replace rebuilds an existing voice in place (same catalogue position).
#
# Then rebuild (./build.sh release) to compile the voice in, and listen:
#   bench/drive.py --sidecar .out/bin/dial8-local-tts --models <models> --voice <id> \
#       --wav-dir <dir> --cancel-runs 0
set -euo pipefail
cd "$(dirname "$0")/.."
HERE="$PWD"

ENCODER_URL="https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/58a6d00cf13d239b6748cb0769f35c580a8f606c/onnx/english_2026-04/mimi_encoder.onnx"
ENCODER_SHA256="853e2ca623b8782d94c3745ec6133bfdff7ce33d9b11128bd29ea03f28d76e3d"
CACHE="$HOME/Library/Caches/dial8-local-tts"
ENCODER="${MIMI_ENCODER:-$CACHE/mimi_encoder-58a6d00c.onnx}"
TOOL="$HERE/.out/tools/dial8-tts-make-voice"

usage() {
    sed -n '4,6p' "$0" | sed 's/^# //' >&2
    exit 2
}
fail() {
    echo "[make-voice] ERROR: $*" >&2
    exit 1
}

[ $# -ge 3 ] || usage
RECORDING="$1" ID="$2" NAME="$3"
shift 3
DESCRIPTION="" CONSENT="" LICENCE="" ATTRIBUTION="" SOURCE="" AS_IS=0 REPLACE=0 SPEECH_DBFS=-16
while [ $# -gt 0 ]; do
    case "$1" in
        --description) DESCRIPTION="${2:?}"; shift 2 ;;
        --consent) CONSENT="${2:?}"; shift 2 ;;
        --licence|--license) LICENCE="${2:?}"; shift 2 ;;
        --attribution) ATTRIBUTION="${2:?}"; shift 2 ;;
        --source) SOURCE="${2:?}"; shift 2 ;;
        --as-is) AS_IS=1; shift ;;
        --speech-dbfs) SPEECH_DBFS="${2:?}"; shift 2 ;;
        --replace) REPLACE=1; shift ;;
        *) usage ;;
    esac
done

[ -f "$RECORDING" ] || fail "no such recording: $RECORDING"
[[ "$ID" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || fail "id must be lowercase letters, digits and dashes: $ID"
[ -n "$NAME" ] || fail "a voice needs a name"
if [ -z "$CONSENT" ] && [ -z "$LICENCE" ]; then
    fail "refusing without --consent: our own voices need the speaker's signed consent (--consent <reference>); a third-party clip needs --licence, --attribution and --source"
fi
if [ -n "$LICENCE" ]; then
    [ -n "$ATTRIBUTION" ] && [[ "$SOURCE" == https://* ]] || fail "--licence needs --attribution and --source https://..."
fi
[[ "$SPEECH_DBFS" =~ ^-[0-9]+(\.[0-9]+)?$ ]] && python3 -c "import sys; sys.exit(not -30 <= float(sys.argv[1]) <= -10)" "$SPEECH_DBFS" \
    || fail "--speech-dbfs must be between -30 and -10: $SPEECH_DBFS"
if [ "$REPLACE" = 0 ]; then
    python3 -B - voices/voices.json "$ID" <<'PY' || fail "voice '$ID' already exists in voices.json (--replace rebuilds it)"
import json, sys
sys.exit(any(v["id"] == sys.argv[2] for v in json.load(open(sys.argv[1]))["voices"]))
PY
    [ ! -e "voices/$ID.emb" ] || fail "voices/$ID.emb already exists (--replace rebuilds it)"
fi

# The encoder tool (build.sh builds it first, before it checks voices/).
[ -x "$TOOL" ] || ./build.sh release >/dev/null || [ -x "$TOOL" ] || fail "could not build $TOOL"

# The encoder, pinned. A MIMI_ENCODER copy is only checked, never replaced.
if [ -z "${MIMI_ENCODER:-}" ]; then
    mkdir -p "$CACHE"
    if [ ! -f "$ENCODER" ] || [ "$(shasum -a 256 "$ENCODER" | cut -c1-64)" != "$ENCODER_SHA256" ]; then
        echo "[make-voice] fetching the Mimi encoder (40 MB) into $CACHE..."
        curl -fL --retry 3 -o "$ENCODER.part" "$ENCODER_URL"
        mv "$ENCODER.part" "$ENCODER"
    fi
fi
[ -f "$ENCODER" ] && [ "$(shasum -a 256 "$ENCODER" | cut -c1-64)" = "$ENCODER_SHA256" ] || fail "$ENCODER does not match its pinned SHA-256"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
if [ "$AS_IS" = 1 ]; then
    CLIP="$RECORDING"
else
    # 24 kHz, channels kept (downmixed below), 32-bit PCM for the stdlib reader.
    afconvert -f WAVE -d LEI32@24000 "$RECORDING" "$WORK/converted.wav" || fail "afconvert could not read $RECORDING"
    CLIP="$WORK/voice.wav"
    python3 -B - "$WORK/converted.wav" "$CLIP" "$SPEECH_DBFS" <<'PY' || exit 1
"""Mono, trimmed of leading/trailing silence, levelled."""
import array, math, struct, sys, wave
# afconvert writes WAVE_FORMAT_EXTENSIBLE, which the wave module can't read:
# walk the RIFF chunks for fmt (channels, rate) and the 32-bit PCM data.
blob = open(sys.argv[1], "rb").read()
pos, fmt, data = 12, None, None
while pos + 8 <= len(blob):
    cid, size = blob[pos:pos + 4], struct.unpack_from("<I", blob, pos + 4)[0]
    if cid == b"fmt ":
        fmt = struct.unpack_from("<HHIIHH", blob, pos + 8)
    elif cid == b"data":
        data = blob[pos + 8:pos + 8 + size]
    pos += 8 + size + (size & 1)
if not fmt or data is None or fmt[5] != 32:
    sys.exit("[make-voice] ERROR: unexpected afconvert output")
ch, rate = fmt[1], fmt[2]
raw = array.array("i", data[:len(data) // 4 * 4])
x = [sum(raw[i:i + ch]) / ch / 2147483648.0 for i in range(0, len(raw), ch)]
win = rate // 50  # 20 ms
rms = [math.sqrt(sum(s * s for s in x[i:i + win]) / win) for i in range(0, len(x) - win + 1, win)]
if not rms or max(rms) < 1e-4:
    sys.exit("[make-voice] ERROR: the recording is silent")
floor = max(max(rms) * 10 ** (-40 / 20), 10 ** (-60 / 20))  # 40 dB under the loudest speech
voiced = [i for i, r in enumerate(rms) if r > floor]
margin = int(0.15 * rate)
start, end = max(0, voiced[0] * win - margin), min(len(x), (voiced[-1] + 1) * win + margin)
x = x[start:end]
seconds = len(x) / rate
if seconds < 5:
    sys.exit("[make-voice] ERROR: under 5 s of voice — record 10–30 s")
if seconds < 10 or seconds > 30:
    print("[make-voice] WARNING: 10–30 s works best (the encoder uses at most 30 s)", file=sys.stderr)

# Levelling: gain to the speech target, then a look-ahead peak limiter, so a
# few loud peaks no longer hold the whole clip down (a plain peak cap left
# peaky takes 3-5 dB under target, and their voices rendered that much quieter).
TARGET_DB, CEILING_DB = float(sys.argv[3]), -1.0
LOOKAHEAD, RELEASE_S = max(1, int(0.005 * rate)), 0.08  # 5 ms attack/look-ahead, 80 ms release


def speech_db(y):
    """RMS of the speech: 20 ms windows within 40 dB of the loudest (as the trim)."""
    r = [math.sqrt(sum(s * s for s in y[i:i + win]) / win) for i in range(0, len(y) - win + 1, win)]
    fl = max(max(r) * 10 ** (-40 / 20), 10 ** (-60 / 20))
    act = [v for v in r if v > fl]
    return 10 * math.log10(sum(v * v for v in act) / len(act))


# True peak (inter-sample peaks too): 4x oversampling with a 16-tap
# Blackman-windowed sinc per phase, the way BS.1770 meters estimate it.
def _phase(frac, half=8):
    taps = []
    for k in range(-half + 1, half + 1):
        t = k - frac
        sinc = 1.0 if t == 0 else math.sin(math.pi * t) / (math.pi * t)
        w = 0.42 + 0.5 * math.cos(math.pi * t / half) + 0.08 * math.cos(2 * math.pi * t / half)
        taps.append(sinc * w)
    total = sum(taps)
    return [v / total for v in taps]


PHASES = [_phase(f) for f in (0.25, 0.5, 0.75)]
REACH = max(sum(abs(v) for v in h) for h in PHASES)  # an interpolated value is at most this x the local max


def sliding_max_abs(y, back, ahead):
    """max |y[k]| for k in [n - back, n + ahead], for every n (monotonic deque)."""
    from collections import deque
    n, out, dq = len(y), [0.0] * len(y), deque()
    for i in range(n + ahead):
        if i < n:
            v = abs(y[i])
            while dq and abs(y[dq[-1]]) <= v:
                dq.pop()
            dq.append(i)
        c = i - ahead
        if c >= 0:
            while dq[0] < c - back:
                dq.popleft()
            out[c] = abs(y[dq[0]])
    return out


def peak_envelope(y, floor):
    """Per sample: the largest |value| of the band-limited signal within one
    sample of it (the sample itself and the interpolated points either side).
    Interpolation runs only where the neighbourhood could reach `floor`."""
    n = len(y)
    env = [abs(s) for s in y]
    near = sliding_max_abs(y, 7, 8)
    for i in range(n - 1):
        if near[i] * REACH <= floor:
            continue
        for h in PHASES:  # points between y[i] and y[i+1]
            acc = 0.0
            for j, c in enumerate(h):
                k = i - 7 + j
                if 0 <= k < n:
                    acc += c * y[k]
            a = abs(acc)
            if a > env[i]:
                env[i] = a
            if a > env[i + 1]:
                env[i + 1] = a
    return env


def true_peak_db(y):
    return 20 * math.log10(max(peak_envelope(y, 10 ** (CEILING_DB / 20) * 0.5)) or 1e-12)


def limit(y):
    """Gain curve that keeps the true peak under the ceiling: required gain per
    sample, held over the look-ahead window (forward min), released
    exponentially, then averaged over the look-ahead window. Each averaged
    value is at most the required gain at a peak inside its window, so the
    gain reaches the peak's value by the peak (5 ms linear attack) and never
    overshoots; no delay is needed offline."""
    from collections import deque
    ceiling = 10 ** (CEILING_DB / 20)
    env = peak_envelope(y, ceiling)
    need = [ceiling / e if e > ceiling else 1.0 for e in env]
    n, L = len(y), LOOKAHEAD
    held, dq = [1.0] * n, deque()
    for i in range(n - 1, -1, -1):  # held[i] = min(need[i .. i+L-1])
        while dq and need[dq[-1]] >= need[i]:
            dq.pop()
        dq.append(i)
        while dq[0] > i + L - 1:
            dq.popleft()
        held[i] = need[dq[0]]
    rel = 1 - math.exp(-1 / (RELEASE_S * rate))
    g, run, prev, ring = [1.0] * n, float(L), 1.0, [1.0] * L  # ring: the last L released gains
    for i in range(n):
        prev = min(held[i], prev + (1 - prev) * rel)
        run += prev - ring[i % L]
        ring[i % L] = prev
        g[i] = run / L
    return [s * k for s, k in zip(y, g)], min(g), sum(1 for k in g if k < 10 ** (-0.5 / 20)) / n


before = speech_db(x)
gain_db = TARGET_DB - before
for _ in range(4):  # make up what the limiter takes off the speech level
    y, gmin, busy = limit([s * 10 ** (gain_db / 20) for s in x])
    got = speech_db(y)
    if abs(got - TARGET_DB) < 0.1:
        break
    gain_db += TARGET_DB - got
tp = true_peak_db(y)
if tp > CEILING_DB:  # the gain curve moves between samples; trim any residue
    y = [s * 10 ** ((CEILING_DB - tp) / 20) for s in y]
    got, tp = speech_db(y), true_peak_db(y)
print(f"[make-voice] {seconds:.1f} s of voice after trimming; speech {before:.1f} -> {got:.1f} dBFS "
      f"(gain {gain_db:+.1f} dB); limiter: at most {-20 * math.log10(gmin):.1f} dB, "
      f"{100 * busy:.1f}% of samples over 0.5 dB; true peak {tp:.1f} dBTP", file=sys.stderr)
out = array.array("i", (max(-2147483648, min(2147483647, int(s * 2147483647))) for s in y))
with wave.open(sys.argv[2], "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(4)
    w.setframerate(rate)
    w.writeframes(out.tobytes())
PY
fi

# Encode beside the catalogue first, so a failed rebuild leaves the old voice.
"$TOOL" --encoder "$ENCODER" --in "$CLIP" --out "$WORK/$ID.emb" || fail "encoding failed"
mv "$WORK/$ID.emb" "voices/$ID.emb"
SOURCE_SHA256="$(shasum -a 256 "$RECORDING" | cut -c1-64)"
args=(add voices --id "$ID" --name "$NAME" --embedding "$ID.emb" --description "$DESCRIPTION" --source-sha256 "$SOURCE_SHA256")
[ -z "$SOURCE" ] || args+=(--source "$SOURCE")
[ -z "$LICENCE" ] || args+=(--licence "$LICENCE")
[ -z "$ATTRIBUTION" ] || args+=(--attribution "$ATTRIBUTION")
[ -z "$CONSENT" ] || args+=(--consent "$CONSENT")
[ "$REPLACE" = 0 ] || args+=(--replace)
python3 -B voices/catalogue.py "${args[@]}"
python3 -B voices/catalogue.py check voices
echo "[make-voice] $([ "$REPLACE" = 1 ] && echo rebuilt || echo added) '$ID'. Commit voices/$ID.emb and voices/voices.json (not the recording), then ./build.sh release."
