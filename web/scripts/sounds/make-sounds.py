#!/usr/bin/env python3
"""make-sounds: turn source sound effects into the app's UI sounds.

    npm run sounds -- <source-dir> [--only NAME ...] [--target-lufs -17] [--dry-run]
    python3 scripts/sounds/make-sounds.py <source-dir> [...]

Every <name>.wav in <source-dir> (a trailing "-fx" is dropped from the name)
becomes public/sounds/<name>.m4a. Every sound gets the same treatment, so a new
or re-recorded sound matches the others without hand tuning:

  1. Decode to 48 kHz float (ffmpeg).
  2. Fold to mono when the two channels are effectively the same (side 30 dB
     or more under mid). Genuinely wide sounds stay stereo.
  3. Trim audio under -60 dBFS off both ends (silence before a sound is delay
     after a click), keeping 3 ms / 20 ms, with a 2 ms fade-in and 10 ms fade-out.
  4. Level: one gain so the loudest 400 ms (BS.1770 momentary loudness; mono
     measured as dual-mono, the way it plays on two speakers) lands on
     --target-lufs. All sounds share that target, so they play equally loud.
  5. Look-ahead true-peak limiter at -1 dBTP (5 ms look-ahead, 80 ms release,
     the one make-voice uses for the read-aloud voices) for peaks the gain pushes
     over. Past 3 dB of limiting it warns: the sound is much peakier than the
     rest, and the take may be better softened at the source.
  6. Encode AAC-LC .m4a at 48 kHz: 64 kb/s mono, 128 kb/s stereo (AudioToolbox
     on macOS; ffmpeg's own aac at 96 / 160 kb/s elsewhere). AAC, not Opus:
     macOS 13's WebView (Safari 16) can't decode Opus in WebM or Ogg, and
     Apple's AAC decoder trims the encoder priming, so the sound starts on time.
  7. Verify the encode: it decodes, starts within 2 ms of the processed audio,
     its loudness is within 0.5 LU of the target and its true peak is at most
     0 dBTP. A sound that fails at the step-6 rate is encoded again at 1.5x,
     then 2x, that rate: 64 kb/s mono drops everything above 16 kHz, and a
     short, bright click can lose half a LU with it (stt-dictate-end gets
     128 kb/s). A sound that passes at the first rate is encoded as before.

Sources stay outside git (Liam's are in ~/code/speech-audio-bench/FX); commit
the .m4a files this writes. Needs ffmpeg, numpy and scipy.
"""

import argparse
import math
import re
import shutil
import subprocess
import sys
import tempfile
from collections import deque
from pathlib import Path

try:
    import numpy as np
    from scipy.signal import lfilter, resample_poly
except ImportError:
    sys.exit("[make-sounds] ERROR: needs numpy and scipy (pip3 install numpy scipy)")

RATE = 48_000
REPO = Path(__file__).resolve().parents[2]
DEFAULT_OUT = REPO / "public" / "sounds"
DEFAULT_TARGET_LUFS = -17.0  # near the middle of the first six sounds as made (-15.7), low enough that the peaky dictation click needs under 3 dB of limiting; the read-aloud voices peak near -10
CEILING_DB = -1.0
SILENCE_DB = -60.0
MONO_SIDE_DB = -30.0
KEEP_HEAD_S, KEEP_TAIL_S = 0.003, 0.020
FADE_IN_S, FADE_OUT_S = 0.002, 0.010
LOOKAHEAD, RELEASE_S = int(0.005 * RATE), 0.08
LIMIT_WARN_DB = 3.0
BITRATE_STEPS = (1.0, 1.5, 2.0)  # the step-6 rate, then higher ones for a sound the step-7 check refuses
NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def fail(msg):
    sys.exit(f"[make-sounds] ERROR: {msg}")


def db(v):
    return 20 * math.log10(max(float(v), 1e-12))


def decode(path):
    """(frames, channels) float64 at 48 kHz."""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    if probe.returncode != 0 or not probe.stdout.strip():
        fail(f"{path.name}: not an audio file ffmpeg can read")
    ch = min(int(probe.stdout.split()[0]), 2)
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-ac", str(ch), "-ar", str(RATE), "-f", "f32le", "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, dtype="<f4").astype(np.float64).reshape(-1, ch)


# BS.1770 K-weighting at 48 kHz: the head shelf, then the RLB high-pass.
K_SHELF = ([1.53512485958697, -2.69169618940638, 1.19839281085285], [1.0, -1.69065929318241, 0.73248077421585])
K_HIGHPASS = ([1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621])


def max_momentary_lufs(x):
    """Loudest 400 ms window (10 ms hop), BS.1770 momentary loudness. Mono counts
    as dual-mono (+3 dB), since a mono sound plays on both speakers."""
    z = lfilter(*K_HIGHPASS, lfilter(*K_SHELF, x, axis=0), axis=0)
    power = (z ** 2).sum(axis=1) * (2 if x.shape[1] == 1 else 1)
    win, hop = int(0.4 * RATE), int(0.01 * RATE)
    power = np.concatenate([power, np.zeros(max(0, win - len(power)))])
    csum = np.concatenate([[0.0], np.cumsum(power)])
    means = (csum[win::hop] - csum[: len(csum) - win : hop]) / win
    return -0.691 + 10 * math.log10(max(means.max(), 1e-20))


def peak_envelope(x):
    """Per sample, the true peak (4x oversampled, channels linked) at it and
    between it and the next sample."""
    up = np.abs(resample_poly(x, 4, 1, axis=0)).max(axis=1)[: 4 * len(x)]
    up = np.concatenate([up, np.zeros(4 * len(x) - len(up))]).reshape(-1, 4).max(axis=1)
    return np.maximum(np.abs(x).max(axis=1), up)


def true_peak_db(x):
    return db(peak_envelope(x).max())


def limit(x):
    """make-voice's limiter: the gain each sample needs to stay under the
    ceiling, held over the look-ahead window, released exponentially, then
    averaged over the look-ahead window, so gain reaches a peak's value by the
    peak (5 ms linear attack) without overshoot. Offline, so no delay."""
    ceiling = 10 ** (CEILING_DB / 20)
    env = peak_envelope(x)
    need = np.where(env > ceiling, ceiling / np.maximum(env, 1e-12), 1.0)
    n, L = len(need), LOOKAHEAD
    held, dq = np.ones(n), deque()
    for i in range(n - 1, -1, -1):  # held[i] = min(need[i .. i+L-1])
        while dq and need[dq[-1]] >= need[i]:
            dq.pop()
        dq.append(i)
        while dq[0] > i + L - 1:
            dq.popleft()
        held[i] = need[dq[0]]
    rel = 1 - math.exp(-1 / (RELEASE_S * RATE))
    released, prev = np.ones(n), 1.0
    for i in range(n):
        prev = min(held[i], prev + (1 - prev) * rel)
        released[i] = prev
    padded = np.concatenate([np.ones(L - 1), released])
    csum = np.concatenate([[0.0], np.cumsum(padded)])
    gain = (csum[L:] - csum[:-L]) / L  # mean of released[i-L+1 .. i]
    return x * gain[:, None], min(1.0, float(gain.min()))


def process(x):
    """Returns (processed audio, report dict)."""
    report = {"source_s": len(x) / RATE}
    if x.shape[1] == 2:
        mid, side = (x[:, 0] + x[:, 1]) / 2, (x[:, 0] - x[:, 1]) / 2
        width = db(np.sqrt((side ** 2).mean())) - db(np.sqrt((mid ** 2).mean()))
        if width < MONO_SIDE_DB:
            x = mid[:, None]
        report["width_db"] = width
    loud = np.where(np.abs(x).max(axis=1) > 10 ** (SILENCE_DB / 20))[0]
    if not len(loud):
        fail("the sound is silent (nothing above -60 dBFS)")
    start = max(0, loud[0] - int(KEEP_HEAD_S * RATE))
    end = min(len(x), loud[-1] + 1 + int(KEEP_TAIL_S * RATE))
    report["trimmed_head_ms"], report["trimmed_tail_ms"] = start / RATE * 1000, (len(x) - end) / RATE * 1000
    x = x[start:end].copy()
    fi, fo = int(FADE_IN_S * RATE), int(FADE_OUT_S * RATE)
    x[:fi] *= np.linspace(0, 1, fi, endpoint=False)[:, None]
    x[-fo:] *= np.linspace(1, 0, fo)[:, None]
    return x, report


def level(x, target):
    before = max_momentary_lufs(x)
    gain_db = target - before
    for _ in range(4):  # make up what the limiter takes off the loudness
        y, gmin = limit(x * 10 ** (gain_db / 20))
        got = max_momentary_lufs(y)
        if abs(got - target) < 0.1:
            break
        gain_db += target - got
    tp = true_peak_db(y)
    if tp > CEILING_DB:  # the gain curve moves between samples; trim any residue
        y *= 10 ** ((CEILING_DB - tp) / 20)
        got, tp = max_momentary_lufs(y), true_peak_db(y)
    return y, {"before_lufs": before, "gain_db": gain_db, "limited_db": max(0.0, -db(gmin)), "lufs": got, "true_peak_db": tp}


def encode(y, dest, work, step=1.0):
    """(the encoded file in `work`, its rate in kb/s): the step-6 rate times `step`."""
    wav = work / (dest.stem + ".wav")
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(RATE), "-ac", str(y.shape[1]), "-i", "-", "-c:a", "pcm_f32le", str(wav)],
        input=y.astype("<f4").tobytes(), check=True,
    )
    stereo = y.shape[1] == 2
    if has_audiotoolbox():
        kbps = round((128 if stereo else 64) * step)
        codec = ["-c:a", "aac_at", "-aac_at_mode", "cvbr", "-b:a", f"{kbps}k"]
    else:
        kbps = round((160 if stereo else 96) * step)
        codec = ["-c:a", "aac", "-b:a", f"{kbps}k"]
    tmp = work / dest.name
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(wav), *codec, "-movflags", "+faststart", str(tmp)], check=True)
    return tmp, kbps


_AT = None


def has_audiotoolbox():
    global _AT
    if _AT is None:
        out = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
        _AT = " aac_at " in out
    return _AT


def verify(path, y, target):
    z = decode(path)[:, : y.shape[1]]
    thr = 10 ** (-50 / 20)
    onset = lambda a: int(np.argmax(np.abs(a).max(axis=1) > thr))
    lag_ms = (onset(z) - onset(y)) / RATE * 1000
    got, tp = max_momentary_lufs(z), true_peak_db(z)
    problems = []
    if abs(lag_ms) > 2:
        problems.append(f"starts {lag_ms:+.1f} ms off")
    if abs(got - target) > 0.5:
        problems.append(f"loudness {got:.1f} LUFS")
    if tp > 0:
        problems.append(f"true peak {tp:+.1f} dBTP")
    return {"encoded_lufs": got, "encoded_true_peak_db": tp, "lag_ms": lag_ms}, problems


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source_dir", type=Path)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--only", nargs="+", metavar="NAME", help="process just these sounds (names without -fx)")
    ap.add_argument("--target-lufs", type=float, default=DEFAULT_TARGET_LUFS)
    ap.add_argument("--dry-run", action="store_true", help="measure and report, write nothing")
    args = ap.parse_args()
    if not shutil.which("ffmpeg"):
        fail("ffmpeg is not on PATH")
    if not -30 <= args.target_lufs <= -10:
        fail(f"--target-lufs must be between -30 and -10: {args.target_lufs}")
    sources = sorted(args.source_dir.glob("*.wav"))
    if not sources:
        fail(f"no .wav files in {args.source_dir}")
    wanted = set(args.only or [])
    args.out.mkdir(parents=True, exist_ok=True)
    rows, bad = [], []
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        for src in sources:
            name = re.sub(r"-fx$", "", src.stem.lower())
            if wanted and name not in wanted:
                continue
            if not NAME_RE.match(name):
                fail(f"{src.name}: name the file like voice-chat-start.wav (lowercase, dashes)")
            x, rep = process(decode(src))
            y, lev = level(x, args.target_lufs)
            rep.update(lev, name=name, channels=y.shape[1], seconds=len(y) / RATE)
            if not args.dry_run:
                for step in BITRATE_STEPS:
                    enc, kbps = encode(y, args.out / f"{name}.m4a", work, step)
                    ver, problems = verify(enc, y, args.target_lufs)
                    if not problems:
                        break
                rep.update(ver, kb=enc.stat().st_size / 1024, kbps=kbps)
                if problems:
                    bad.append(f"{name}: {', '.join(problems)} (at {kbps} kb/s)")
                else:
                    shutil.move(str(enc), args.out / f"{name}.m4a")
            rows.append(rep)
        if wanted - {r["name"] for r in rows}:
            fail(f"no source for: {', '.join(sorted(wanted - {r['name'] for r in rows}))}")

    print(f"[make-sounds] target {args.target_lufs:.1f} LUFS (loudest 400 ms), ceiling {CEILING_DB:.0f} dBTP -> {args.out}")
    for r in rows:
        warn = f"  WARNING: limited {r['limited_db']:.1f} dB" if r["limited_db"] > LIMIT_WARN_DB else ""
        size = f"{r['kb']:5.1f} KB at {r['kbps']:3d} kb/s" if "kb" in r else "   (dry)"
        print(
            f"  {r['name']:22s} {'stereo' if r['channels'] == 2 else 'mono  '} {r['source_s']:5.2f}s -> {r['seconds']:5.2f}s"
            f"  {r['before_lufs']:6.1f} -> {r['lufs']:6.1f} LUFS (gain {r['gain_db']:+5.1f} dB, limiter {r['limited_db']:.1f} dB)"
            f"  peak {r['true_peak_db']:5.1f} dBTP  {size}{warn}"
        )
    if bad:
        fail("encode check failed, nothing written for:\n  " + "\n  ".join(bad))
    if args.dry_run:
        print("[make-sounds] dry run: nothing written")
    else:
        print(f"[make-sounds] wrote {len(rows)} sound(s). Commit public/sounds/*.m4a (not the sources).")


if __name__ == "__main__":
    main()
