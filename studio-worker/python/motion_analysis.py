"""motion_analysis: watch a film's motion and review it scene by scene, from the picture (and its sound) alone.
The Studio worker runs it for the motion check and the video review (../src/jobs/checks.ts); it needs numpy and
OpenCV, nothing else (and ffmpeg on PATH for the sound levels).

    python motion_analysis.py watch film.mp4 --out dir [--refs ref/motion.json …] [--json]
                                                                        -> dir/motion.json, dir/motion.txt, dir/*.png
    python motion_analysis.py compare ours/motion.json ref/motion.json [...]
                                                                        -> what to fix first, measured against references
    python motion_analysis.py review film.mp4 --out dir [--context ctx.json] [--audio mix.wav] [--ocr reader] [--refs ref/review.json …]
                                                                        -> the whole video scene by scene: on-screen text, speech, motion,
                                                                           sound, where a viewer gets lost; dir/review.json|txt, scenes.png
    --ocr names a text reader for the keyframes: `tesseract` (its binary, read through its TSV output), or any program
    that takes image paths and prints one JSON line per image: {"file", "lines": [{"text", "confidence", "box": [x, y, w, h]}]}
    (box in fractions of the image, top-left origin). Without one, on-screen text is left out.

Works from the picture alone (analysis at 360 px tall) (no project data), so it measures a reference film exactly like our own export.
What it measures, per frame at analysis resolution (360 px tall):
  foreground  pixels that differ from the film's own background (its per-pixel median), split into elements
              (connected components): how much is on screen, how many things, how small (particles / dots)
  motion      dense optical flow inside the foreground: how much moves, how fast (screen widths per second),
              which way, expanding or shrinking (pops, zooms), and how coherently (a camera move moves everything)
  sharpness   whether moving things are blurred (motion blur) or crisp
Then the film's structure:
  moves       runs of motion: duration, peak speed, the shape of the speed curve (snap = fast start and a long
              settle; even = ease in and out; hard stop = still fast on its last frame), spring overshoot
              (direction or growth reverses after the peak), how many things move at once
  holds       stretches where nothing moves (a film that breathes has short holds and something always alive)
  handoffs    each time the picture becomes something else: is it a transform (motion never stops and something
              stays on screen), a crossfade, or a cut through an empty frame
Pictures for a reviewer who cannot watch video: a timeline strip (thumbnails over the motion curve), and per move an
onion skin (frames overlaid, early = light, late = dark, so spacing shows easing) and a filmstrip of every 2nd frame.
"""
import argparse
import json
import math
import os
import sys

import cv2
import numpy as np

AN_H = 360                      # analysis height (px); speeds are reported in screen widths / s so this cancels out
FG_THRESH = 22.0                # Lab distance from the background that counts as "something on screen"
MOVE_PX = 0.35                  # flow (analysis px / frame) below this is noise
VERSION = 1


# ---------------------------------------------------------------------------------------------------------------- io
class Frames:
    """The video at analysis size, decoded on demand (a 90 s film never sits in memory). Index k is the k-th kept frame
    (every `stride`-th source frame), so long or high-frame-rate videos are watched at <= fps_cap."""
    def __init__(self, path, fps_cap=60.0):
        self.path = path
        cap = cv2.VideoCapture(path)
        if not cap.isOpened():
            raise SystemExit(f'cannot open {path}')
        self.src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        w0, h0 = cap.get(cv2.CAP_PROP_FRAME_WIDTH), cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
        cap.release()
        self.stride = max(1, int(round(self.src_fps / fps_cap)))
        self.fps = self.src_fps / self.stride
        self.h = AN_H; self.w = int(round(w0 * AN_H / max(1, h0) / 2)) * 2
        self.n = max(1, count // self.stride)
        self.shape = (self.n, self.h, self.w, 3)
        self._cap = None; self._pos = -1; self._cache = {}

    def __len__(self):
        return self.n

    def _read(self, k):
        if self._cap is None:
            self._cap = cv2.VideoCapture(self.path)
        src = k * self.stride
        if src != self._pos + 1:
            self._cap.set(cv2.CAP_PROP_POS_FRAMES, src); self._pos = src - 1
        frame = None
        while self._pos < src:
            ok, frame = self._cap.read()
            if not ok:
                return None
            self._pos += 1
        return cv2.resize(frame, (self.w, self.h), interpolation=cv2.INTER_AREA)

    def __getitem__(self, k):
        k = max(0, min(self.n - 1, int(k)))
        if k not in self._cache:
            f = self._read(k)
            if f is None:                                   # frame count was optimistic: hold the last good frame
                self.n = max(1, min(self.n, k)); f = self._read(self.n - 1) if self.n - 1 != k else np.zeros((self.h, self.w, 3), np.uint8)
                if f is None: f = np.zeros((self.h, self.w, 3), np.uint8)
            if len(self._cache) > 96:
                self._cache.pop(next(iter(self._cache)))
            self._cache[k] = f
        return self._cache[k]

    def stream(self):
        """Every kept frame in order (sequential decode, fast)."""
        cap = cv2.VideoCapture(self.path); i = 0; k = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if i % self.stride == 0:
                yield k, cv2.resize(frame, (self.w, self.h), interpolation=cv2.INTER_AREA); k += 1
            i += 1
        cap.release()
        self.n = k; self.shape = (self.n, self.h, self.w, 3)


class Distance:
    """Lab distance of a frame from the film's background, on demand."""
    def __init__(self, frames, bg):
        self.frames = frames; self.bgl = cv2.cvtColor(bg, cv2.COLOR_BGR2LAB).astype(np.float32)

    def __getitem__(self, k):
        d = cv2.cvtColor(self.frames[k], cv2.COLOR_BGR2LAB).astype(np.float32) - self.bgl
        return np.sqrt((d * d).sum(-1))


# ----------------------------------------------------------------------------------------------------------- analysis
def background(frames):
    picks = np.linspace(0, len(frames) - 1, min(len(frames), 120)).astype(int)
    return np.median(np.stack([frames[int(k)] for k in picks]), axis=0).astype(np.uint8)


def analyse(path, fps_cap=60.0):
    frames = Frames(path, fps_cap)
    bg = background(frames)
    bgl = cv2.cvtColor(bg, cv2.COLOR_BGR2LAB).astype(np.float32)
    kernel = np.ones((3, 3), np.uint8)
    per, masks, thumbs, hists = [], [], [], []
    H, W = frames.h, frames.w
    prev_gray = prev_fgmask = None
    px_per_s = frames.fps / W                                                      # analysis px/frame -> screen widths/s
    for i, frame in frames.stream():
        lab = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB).astype(np.float32) - bgl
        dist = np.sqrt((lab * lab).sum(-1))
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        fg = (dist > FG_THRESH).astype(np.uint8)
        # no morphological opening: particles (2–4 px dots at this size) are content, not noise
        masks.append(cv2.resize(cv2.dilate(fg, np.ones((9, 9), np.uint8)), (60, 34), interpolation=cv2.INTER_AREA) > 0.15)
        thumbs.append(cv2.resize(frame, (160, int(round(160 * H / W))), interpolation=cv2.INTER_AREA))
        hsv = cv2.cvtColor(cv2.resize(frame, (160, 90)), cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1, 2], None, [12, 6, 6], [0, 180, 0, 256, 0, 256]); hists.append(cv2.normalize(hist, hist).flatten())
        ncomp, labels, stats, cents = cv2.connectedComponentsWithStats(fg, 8)
        areas = stats[1:, cv2.CC_STAT_AREA] if ncomp > 1 else np.array([], int)
        areas = areas[areas >= 3]
        row = {'fg': float(fg.mean()), 'fg_px': int(fg.sum()), 'elements': int(len(areas)),
               'element_px': float(np.median(areas)) if len(areas) else 0.0, 'luma': float(gray.mean() / 255)}
        if len(areas):
            ys, xs = np.nonzero(fg)
            row['bbox'] = [float(xs.min() / W), float(ys.min() / H), float(xs.max() / W), float(ys.max() / H)]
            row['centroid'] = [float(xs.mean() / W), float(ys.mean() / H)]
        if prev_gray is None:
            row.update(speed=0.0, p90=0.0, moving=0.0, activity=0.0, flow=[0.0, 0.0], radial=0.0, coherence=0.0, blur=None, change=0.0, changed=0.0)
            per.append(row); prev_gray, prev_fgmask = gray, fg > 0
            continue
        flow = cv2.calcOpticalFlowFarneback(prev_gray, gray, None, 0.5, 3, 15, 3, 5, 1.2, 0)
        mag = np.sqrt((flow ** 2).sum(-1))
        # graphics over a plain background: watch the foreground; full-frame footage (no stable background): the whole frame
        region = (fg > 0) | prev_fgmask if row['fg'] < 0.5 else np.ones_like(fg, bool)
        moving = region & (mag > MOVE_PX)
        diffimg = np.abs(gray.astype(np.int16) - prev_gray.astype(np.int16))
        moving &= cv2.dilate((diffimg > 6).astype(np.uint8), kernel, iterations=2) > 0      # flow on flat areas lies; demand a change
        row['change'] = float(diffimg.mean() / 255); row['changed'] = float((diffimg > 12).mean())   # share of pixels that changed (typing, a counter, UI filling in)
        m = int(moving.sum())
        if m >= 6:
            mags = mag[moving]
            fx, fy = flow[..., 0][moving], flow[..., 1][moving]
            ys, xs = np.nonzero(moving)
            cx, cy = xs.mean(), ys.mean()
            rx, ry = xs - cx, ys - cy
            rn = np.sqrt(rx * rx + ry * ry) + 1e-6
            radial = float(((fx * rx + fy * ry) / rn).mean())
            mean_vec = np.array([fx.mean(), fy.mean()])
            coherence = float(np.linalg.norm(mean_vec) / (mags.mean() + 1e-6))
            lap = np.abs(cv2.Laplacian(gray, cv2.CV_32F))
            still_fg = (fg > 0) & ~moving
            blur = float(lap[moving].mean() / (lap[still_fg].mean() + 1e-6)) if still_fg.sum() > 30 else None
            row.update(speed=float(np.median(mags) * px_per_s), p90=float(np.percentile(mags, 90) * px_per_s),
                       moving=m / (H * W), activity=float(mags.sum() / (H * W) * px_per_s * 100), flow=[float(mean_vec[0] * px_per_s), float(mean_vec[1] * px_per_s)],
                       radial=radial * px_per_s, coherence=coherence, blur=blur)
        else:
            row.update(speed=0.0, p90=0.0, moving=m / (H * W), activity=0.0, flow=[0.0, 0.0], radial=0.0, coherence=0.0, blur=None)
        per.append(row); prev_gray, prev_fgmask = gray, fg > 0
    n = len(per)
    meta = {'file': os.path.basename(path), 'fps': frames.fps, 'source_fps': frames.src_fps, 'stride': frames.stride, 'frames': n, 'seconds': n / frames.fps, 'size': [W, H]}
    return meta, per, frames, np.array(masks), Distance(frames, bg), np.array(thumbs), np.array(hists)


def smooth(x, k=3):
    if k <= 1:
        return np.asarray(x, float)
    return np.convolve(np.asarray(x, float), np.ones(k) / k, mode='same')


def segments(active, min_len, merge_gap):
    runs, start = [], None
    for i, a in enumerate(active):
        if a and start is None:
            start = i
        if not a and start is not None:
            runs.append([start, i]); start = None
    if start is not None:
        runs.append([start, len(active)])
    merged = []
    for r in runs:
        if merged and r[0] - merged[-1][1] <= merge_gap:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    return [r for r in merged if r[1] - r[0] >= min_len]


def gestures(per, fps):
    """Distinct moves: peaks of the speed curve, each spanning out to where its speed falls to a fifth of its peak.
    Idle motion (wobble, drift, a breathing waveform) stays below the bar and counts as life, not as a move."""
    sp = smooth([p['p90'] for p in per], max(3, int(round(fps / 12)) | 1))
    n = len(sp); floor = 0.12
    peaks = [i for i in range(1, n - 1) if sp[i] >= sp[i - 1] and sp[i] > sp[i + 1] and sp[i] > floor]
    out = []
    for k in sorted(peaks, key=lambda i: -sp[i]):
        if any(a <= k < b for a, b in out):
            continue
        lo = 0.2 * sp[k]; a = k; b = k
        while a > 0 and sp[a - 1] > lo and not (sp[a - 1] > sp[a] and sp[a] < 0.6 * sp[k]):
            a -= 1
        while b < n - 1 and sp[b + 1] > lo and not (sp[b + 1] > sp[b] and sp[b] < 0.6 * sp[k]):
            b += 1
        # prominence: the peak must stand clearly above where it starts and ends
        if sp[k] - max(sp[a], sp[b]) < 0.35 * sp[k]:
            continue
        if any(not (b + 1 <= x or a >= y) for x, y in out):
            a = max([a] + [y for x, y in out if y <= k]); b = min([b + 1] + [x for x, y in out if x > k]) - 1
        if b - a + 1 >= 3:
            out.append((a, b + 1))
    return sorted(out)


def describe_move(per, a, b, fps):
    sp = np.array([p['p90'] for p in per[a:b]])
    act = np.array([p['activity'] for p in per[a:b]])
    spk = smooth(sp, 3)
    k = int(np.argmax(spk)); peak = float(spk[k]) if len(spk) else 0.0
    dur = (b - a) / fps
    t_peak = (k + 0.5) / max(1, b - a)
    end_ratio = float(spk[-1] / peak) if peak > 0 else 0.0
    start_ratio = float(spk[0] / peak) if peak > 0 else 0.0
    # overshoot: after the peak, the dominant direction (or growth) reverses with real speed
    vecs = np.array([p['flow'] for p in per[a:b]])
    rad = np.array([p['radial'] for p in per[a:b]])
    dom = vecs[:k + 1].sum(0)
    over = False; over_amt = 0.0
    if np.linalg.norm(dom) > 1e-6 and k < len(vecs) - 2:
        u = dom / np.linalg.norm(dom)
        proj = vecs[k + 1:] @ u
        pk = float(np.abs(vecs[:k + 1] @ u).max())
        if pk > 0 and proj.min() < -0.12 * pk:
            over, over_amt = True, float(-proj.min() / pk)
    rad_dom = rad[:k + 1].sum()
    if not over and abs(rad_dom) > 1e-6 and k < len(rad) - 2:
        pk = float(np.abs(rad[:k + 1]).max())
        later = rad[k + 1:] * np.sign(rad_dom)
        if pk > 0 and later.min() < -0.15 * pk:
            over, over_amt = True, float(-later.min() / pk)
    if end_ratio > 0.45 and dur > 0.12:
        shape = 'hard stop'
    elif t_peak <= 0.34:
        shape = 'snap'                        # fast start, long settle (expo-out / spring)
    elif t_peak <= 0.66:
        shape = 'even'                        # ease in and out
    else:
        shape = 'slow start'                  # builds, then stops: reads late
    elems = [p['elements'] for p in per[a:b]]
    blurs = [p['blur'] for p in per[a:b] if p['blur'] is not None]
    coh = float(np.mean([p['coherence'] for p in per[a:b]]))
    return {'start': round(a / fps, 3), 'end': round(b / fps, 3), 'seconds': round(dur, 3), 'peak_speed': round(peak, 3),
            'peak_at': round(t_peak, 2), 'start_ratio': round(start_ratio, 2), 'end_ratio': round(end_ratio, 2), 'shape': shape,
            'overshoot': over, 'overshoot_amount': round(over_amt, 2), 'activity': round(float(act.mean()), 4),
            'elements': int(np.median(elems)), 'coherence': round(coh, 2), 'blur': round(float(np.median(blurs)), 2) if blurs else None,
            'frames': [a, b]}


def handoffs(masks, per, fps, empty_frames):
    """Moments the picture becomes something else, and how it gets there."""
    n = len(masks); win = max(4, int(round(0.5 * fps)))
    area = masks.reshape(n, -1).sum(1).astype(float)
    mean_area = max(1.0, float(np.median(area[area > 0])) if (area > 0).any() else 1.0)
    iou = np.ones(n)
    for i in range(n - win):
        a, b = masks[i], masks[i + win]
        u = (a | b).sum()
        iou[i] = (a & b).sum() / u if u else 1.0
    out, i = [], 0
    act = np.array([p['activity'] for p in per]); alive = act > 0.02
    while i < n - win:
        if iou[i] < 0.25:
            j = i
            while j < n - win and iou[j] < 0.25:
                j += 1
            a, b = i, min(n - 1, j + win)
            empty = int(empty_frames[a:b + 1].sum())
            moving = float(alive[a:b + 1].mean())
            kept = float((masks[a] & masks[b]).sum() / max(1, masks[a].sum()))       # how much of the old picture is still there
            if empty >= 2:
                kind = 'cut through empty'
            elif moving > 0.7:
                kind = 'transform'
            else:
                kind = 'crossfade'
            out.append({'start': round(a / fps, 3), 'end': round(b / fps, 3), 'kind': kind, 'empty_frames': empty,
                        'empty_seconds': round(empty / fps, 3), 'moving': round(moving, 2), 'kept': round(kept, 2)})
            i = j + win
        else:
            i += 1
    return out


def summarise(meta, per, masks):
    fps = meta['fps']; n = len(per)
    act = smooth([p['activity'] for p in per], 3)
    alive = act > 0.02
    moves = [describe_move(per, a, b, fps) for a, b in gestures(per, fps)]
    holds = [[a / fps, b / fps] for a, b in segments(~alive, max(2, int(0.2 * fps)), 0)]
    fg = np.array([p['fg'] for p in per])
    empty = np.array([p['fg_px'] for p in per]) < 12
    hands = handoffs(masks, per, fps, empty)
    shapes = {}
    for m in moves:
        shapes[m['shape']] = shapes.get(m['shape'], 0) + 1
    speeds = np.array([p['p90'] for p in per])
    blurs = [m['blur'] for m in moves if m['blur'] is not None]
    concurrent = [p['elements'] for p in per if p['activity'] > 0.02]
    cam = [m for m in moves if m['coherence'] > 0.8 and m['elements'] >= 3]
    s = {
        'alive': round(float(alive.mean()), 3),                                     # share of frames where something moves
        'longest_hold': round(max([b - a for a, b in holds], default=0.0), 2),
        'holds_over_1s': sum(1 for a, b in holds if b - a > 1.0),
        'median_hold': round(float(np.median([b - a for a, b in holds])) if holds else 0.0, 2),
        'empty_seconds': round(float(empty.sum() / fps), 2),
        'moves': len(moves), 'moves_per_s': round(len(moves) / meta['seconds'], 2),
        'median_move_s': round(float(np.median([m['seconds'] for m in moves])) if moves else 0.0, 2),
        'peak_speed_p50': round(float(np.median([m['peak_speed'] for m in moves])) if moves else 0.0, 3),
        'peak_speed_p90': round(float(np.percentile([m['peak_speed'] for m in moves], 90)) if moves else 0.0, 3),
        'speed_p95': round(float(np.percentile(speeds[speeds > 0], 95)) if (speeds > 0).any() else 0.0, 3),
        'shapes': shapes,
        'snap_share': round(shapes.get('snap', 0) / max(1, len(moves)), 2),
        'hard_stop_share': round(shapes.get('hard stop', 0) / max(1, len(moves)), 2),
        'overshoot_share': round(sum(m['overshoot'] for m in moves) / max(1, len(moves)), 2),
        'blur_when_moving': round(float(np.median(blurs)), 2) if blurs else None,
        'elements_median': int(np.median([p['elements'] for p in per])) if per else 0,
        'elements_when_moving': int(np.median(concurrent)) if concurrent else 0,
        'element_px_median': round(float(np.median([p['element_px'] for p in per if p['element_px'] > 0])) if any(p['element_px'] > 0 for p in per) else 0.0, 1),
        'coverage': round(float(np.median(fg[fg > 0])) if (fg > 0).any() else 0.0, 4),
        'handoffs': len(hands),
        'transforms': sum(h['kind'] == 'transform' for h in hands),
        'crossfades': sum(h['kind'] == 'crossfade' for h in hands),
        'cuts_through_empty': sum(h['kind'] == 'cut through empty' for h in hands),
        'camera_moves': len(cam),
    }
    return {**meta, 'version': VERSION, 'summary': s, 'moves': moves, 'holds': [[round(a, 2), round(b, 2)] for a, b in holds], 'handoffs': hands,
            'curve': {'activity': [round(float(v), 4) for v in act], 'speed': [round(float(p['p90']), 3) for p in per], 'fg': [round(float(v), 4) for v in fg],
                      'elements': [p['elements'] for p in per]}}


# ------------------------------------------------------------------------------------------------------------ pictures
def _label(img, text, org=(8, 18), scale=0.45):
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 255), 3, cv2.LINE_AA)
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, (30, 30, 30), 1, cv2.LINE_AA)


def timeline_png(result, frames, path, every=0.5):
    fps = result['fps']; n = len(frames); H, W = frames.shape[1:3]
    tw = 160; th = int(round(tw * H / W))
    times = np.arange(0, n / fps, every)
    cols = len(times)
    width = cols * tw
    plot_h = 150
    canvas = np.full((th + plot_h + 40, width, 3), 250, np.uint8)
    for c, t in enumerate(times):
        f = frames[min(n - 1, int(t * fps))]
        canvas[0:th, c * tw:(c + 1) * tw] = cv2.resize(f, (tw, th), interpolation=cv2.INTER_AREA)
        _label(canvas, f'{t:.1f}', (c * tw + 4, th - 6), 0.38)
    act = np.array(result['curve']['activity']); sp = np.array(result['curve']['speed'])
    y0 = th + 10
    def line(vals, color, top):
        if not len(vals) or top <= 0:
            return
        pts = [(int(i / n * width), int(y0 + plot_h - min(1.0, v / top) * (plot_h - 10))) for i, v in enumerate(vals)]
        cv2.polylines(canvas, [np.array(pts, np.int32)], False, color, 1, cv2.LINE_AA)
    for m in result['moves']:
        x0, x1 = int(m['start'] * fps / n * width), int(m['end'] * fps / n * width)
        color = {'snap': (210, 235, 205), 'even': (235, 225, 200), 'hard stop': (200, 205, 245), 'slow start': (200, 230, 245)}[m['shape']]
        cv2.rectangle(canvas, (x0, y0), (max(x0 + 1, x1), y0 + plot_h), color, -1)
        if m['overshoot']:
            cv2.circle(canvas, (x1 - 3, y0 + 6), 3, (60, 140, 60), -1)
    for a, b in result['holds']:
        cv2.rectangle(canvas, (int(a / result['seconds'] * width), y0 + plot_h - 6), (int(b / result['seconds'] * width), y0 + plot_h), (90, 90, 90), -1)
    line(sp, (200, 90, 40), max(1e-6, float(np.percentile(sp, 99)) if len(sp) else 1))
    line(act, (40, 40, 40), max(1e-6, float(np.percentile(act, 99)) if len(act) else 1))
    for h in result['handoffs']:
        x = int(h['start'] * fps / n * width)
        color = {'transform': (60, 160, 60), 'crossfade': (40, 150, 230), 'cut through empty': (40, 40, 220)}[h['kind']]
        cv2.line(canvas, (x, 0), (x, th + plot_h + 10), color, 2)
    _label(canvas, 'black: motion  blue: speed  bands: moves (green snap, beige even, red hard stop, yellow slow start; dot = overshoot)  grey: holds  '
                   'lines: handoffs (green transform, orange crossfade, red cut through empty)', (8, th + plot_h + 30), 0.42)
    cv2.imwrite(path, canvas)


def onion_png(frames, dist, a, b, path, title):
    """Frames a..b overlaid on the first: early light, late dark. The gaps between ghosts are the spacing (easing)."""
    seq = list(range(a, b, max(1, (b - a) // 14))) + [b - 1]
    base = np.full_like(frames[a], 255).astype(np.float32)
    k = len(seq)
    for j, i in enumerate(seq):
        w = (j + 1) / k
        m = np.clip((dist[i] - 10) / 30, 0, 1)[..., None] * (0.25 + 0.75 * w)
        tint = frames[i].astype(np.float32) * (0.35 + 0.65 * w) + 255 * (1 - (0.35 + 0.65 * w))
        base = base * (1 - m) + tint * m
    img = base.astype(np.uint8)
    _label(img, title)
    cv2.imwrite(path, img)


def strip_png(frames, a, b, path, title, step=2, cols=8):
    seq = list(range(a, min(b + 6, len(frames)), step))[:cols * 4]
    H, W = frames.shape[1:3]; tw = 240; th = int(round(tw * H / W))
    rows = math.ceil(len(seq) / cols)
    img = np.full((rows * th + 24, cols * tw, 3), 255, np.uint8)
    for j, i in enumerate(seq):
        r, c = divmod(j, cols)
        img[24 + r * th:24 + (r + 1) * th, c * tw:(c + 1) * tw] = cv2.resize(frames[i], (tw, th), interpolation=cv2.INTER_AREA)
        _label(img, f'{i}', (c * tw + 4, 24 + (r + 1) * th - 6), 0.35)
    _label(img, title, (6, 17))
    cv2.imwrite(path, img)


# -------------------------------------------------------------------------------------------------------------- text
def text_report(r):
    s = r['summary']
    lines = [f"{r['file']}: {r['seconds']:.1f} s at {r['fps']:.0f} fps.",
             f"Alive {s['alive']*100:.0f}% of the time (something moving); {s['moves']} moves ({s['moves_per_s']}/s), median {s['median_move_s']} s; "
             f"longest hold {s['longest_hold']} s, {s['holds_over_1s']} holds over 1 s; empty frame {s['empty_seconds']} s.",
             f"Move shapes: {', '.join(f'{k} {v}' for k, v in sorted(s['shapes'].items()))}; overshoot (spring) in {s['overshoot_share']*100:.0f}% of moves. "
             f"Peak speed median {s['peak_speed_p50']} screen widths/s (p90 {s['peak_speed_p90']}).",
             f"On screen: median {s['elements_median']} elements ({s['elements_when_moving']} while moving), typical element {s['element_px_median']} px at {r['size'][1]} px tall; "
             f"motion blur ratio {s['blur_when_moving']} (1 = crisp, lower = blurred).",
             f"Handoffs {s['handoffs']}: {s['transforms']} transforms, {s['crossfades']} crossfades, {s['cuts_through_empty']} cuts through an empty frame; camera moves {s['camera_moves']}.",
             '', 'MOVES   start    dur   shape        peak  peakAt end  overshoot elems coh  blur']
    for m in r['moves']:
        lines.append(f"  {m['start']:6.2f} {m['seconds']:6.2f}   {m['shape']:<11} {m['peak_speed']:5.2f}  {m['peak_at']:4.2f}  {m['end_ratio']:4.2f} "
                     f"{('yes %.2f' % m['overshoot_amount']) if m['overshoot'] else 'no':<9} {m['elements']:5d} {m['coherence']:4.2f} {m['blur'] if m['blur'] is not None else '-'}")
    lines += ['', 'HANDOFFS']
    for h in r['handoffs']:
        lines.append(f"  {h['start']:6.2f}-{h['end']:6.2f}  {h['kind']:<18} empty {h['empty_seconds']:.2f}s  moving {h['moving']:.2f}  kept {h['kept']:.2f}")
    lines += ['', 'HOLDS  ' + ', '.join(f'{a:.2f}-{b:.2f}' for a, b in r['holds'] if b - a >= 0.4)]
    return '\n'.join(lines)


def load_or_analyse(path, out, fps_cap=60.0):
    """Per-frame analysis, cached next to the results (re-run only when the video is newer). The numbers per frame
    and the run's facts are JSON; the arrays an .npz read with allow_pickle=False, so a cache file can never run code."""
    os.makedirs(out, exist_ok=True)
    cache, facts = os.path.join(out, 'analysis-v2.npz'), os.path.join(out, 'analysis-v2.json')
    if os.path.exists(cache) and os.path.exists(facts) and min(os.path.getmtime(cache), os.path.getmtime(facts)) > os.path.getmtime(path):
        try:
            with open(facts) as f:
                kept = json.load(f)
            meta, per = kept['meta'], kept['per']
            with np.load(cache, allow_pickle=False) as z:
                ok = {'masks', 'thumbs', 'hists'} <= set(z.files) and isinstance(meta, dict) and meta.get('fps_cap') == fps_cap and per and 'changed' in per[-1]
                if ok:
                    masks, thumbs, hists = z['masks'], z['thumbs'], z['hists']
            if ok:
                frames = Frames(path, fps_cap); frames.n = meta['frames']; frames.shape = (frames.n, frames.h, frames.w, 3)
                return meta, per, frames, masks, Distance(frames, background(frames)), thumbs, hists
        except (OSError, ValueError, KeyError, TypeError):
            pass   # a cache that can't be read is made again
    meta, per, frames, masks, dist, thumbs, hists = analyse(path, fps_cap)
    meta['fps_cap'] = fps_cap
    np.savez_compressed(cache, masks=np.asarray(masks), thumbs=np.asarray(thumbs), hists=np.asarray(hists))
    with open(facts, 'w') as f:
        json.dump({'meta': meta, 'per': per}, f)
    return meta, per, frames, masks, dist, thumbs, hists


def watch(path, out, pictures=True, top=10, fps_cap=60.0):
    meta, per, frames, masks, dist, thumbs, hists = load_or_analyse(path, out, fps_cap)
    r = summarise(meta, per, masks)
    r['text'] = text_report(r)
    pics = {}
    if pictures:
        pics['timeline'] = os.path.join(out, 'timeline.png'); timeline_png(r, frames, pics['timeline'])
        ranked = sorted(range(len(r['moves'])), key=lambda i: -r['moves'][i]['activity'] * r['moves'][i]['seconds'])[:top]
        for i in sorted(ranked):
            m = r['moves'][i]; a, b = m['frames']
            name = f"move_{m['start']:05.2f}"
            onion_png(frames, dist, a, b, os.path.join(out, name + '_onion.png'), f"{m['start']:.2f}s {m['shape']}{' overshoot' if m['overshoot'] else ''} {m['seconds']:.2f}s")
            strip_png(frames, max(0, a - 2), b, os.path.join(out, name + '_strip.png'), f"{m['start']:.2f}-{m['end']:.2f}s every 2nd frame")
            m['pictures'] = [name + '_onion.png', name + '_strip.png']
        for h in r['handoffs']:
            a, b = int(h['start'] * r['fps']), int(h['end'] * r['fps'])
            name = f"handoff_{h['start']:05.2f}"
            strip_png(frames, a, b, os.path.join(out, name + '.png'), f"{h['start']:.2f}-{h['end']:.2f}s {h['kind']}", step=max(1, (b - a) // 24 or 1))
            h['picture'] = name + '.png'
    r['pictures'] = pics
    with open(os.path.join(out, 'motion.json'), 'w') as f:
        json.dump(r, f)
    with open(os.path.join(out, 'motion.txt'), 'w') as f:
        f.write(r['text'] + '\n')
    return r


# ----------------------------------------------------------------------------------------------------------- compare
# metric: (label, weight, how to fix, direction). direction: 'match' = inside the references' range; 'max' = at most the references'
# (fewer empty frames or hard stops than the reference is fine); 'min' = at least the references' (more life is fine).
METRICS = [
    ('cuts_through_empty', 'Cuts through an empty frame', 3, 'the picture empties between beats; let the outgoing element become the next one (morph / particles) or overlap the next entrance with the exit', 'max'),
    ('alive', 'Share of time something moves', 3, 'add life: let held elements breathe (idle wobble, drift), start the next move before the last settles, add a slow camera drift', 'min'),
    ('longest_hold', 'Longest still hold (s)', 2, 'nothing moves for too long; keep a secondary motion running (idle, drift, a spinning accent) during reading holds', 'max'),
    ('transform_share', 'Handoffs that transform', 3, 'beats are separate islands; carry one element through the change (dots that regroup, a line that becomes bars, a ring that collapses into a logo)', 'min'),
    ('snap_share', 'Moves that snap (fast start, long settle)', 2, 'moves read slow or mechanical; use springs / expo-out so motion starts fast and settles'),
    ('hard_stop_share', 'Moves that stop hard', 2, 'moves stop dead; ease them out (spring settle)', 'max'),
    ('overshoot_share', 'Moves with spring overshoot', 1, 'no spring life; let pops and arrivals overshoot a little and settle', 'min'),
    ('median_move_s', 'Median move length (s)', 1, 'moves are too long or too short against the reference rhythm'),
    ('peak_speed_p50', 'Peak speed (screen widths/s)', 1, 'moves are too slow or too fast at their peak'),
    ('moves_per_s', 'Moves per second', 1, 'the rhythm is off: too few events (static) or too many (busy)'),
    ('elements_when_moving', 'Elements moving together', 1, 'motion is one block at a time; stagger several elements (particles, letters, icons) through each move', 'min'),
    ('blur_when_moving', 'Sharpness while moving (lower = motion blur)', 1, 'fast moves are crisp; add motion blur to fast moves'),
    ('empty_seconds', 'Seconds of empty frame', 2, 'the frame is empty; keep something on screen', 'max'),
]


def compare(ours_path, ref_paths):
    ours = json.load(open(ours_path))
    refs = [json.load(open(p)) for p in ref_paths]
    def val(r, key):
        s = r['summary']
        if key == 'transform_share':
            return s['transforms'] / max(1, s['handoffs'])
        return s.get(key)
    rows, issues = [], []
    for key, label, weight, fix, *direction in METRICS:
        direction = direction[0] if direction else 'match'
        v = val(ours, key); rv = [val(r, key) for r in refs]; rv = [x for x in rv if x is not None]
        if v is None or not rv:
            continue
        lo, hi = min(rv), max(rv)
        pad = 0.15 * max(abs(lo), abs(hi), 1e-6)
        lo2, hi2 = lo - pad, hi + pad
        ok = (v <= hi2) if direction == 'max' else (v >= lo2) if direction == 'min' else (lo2 <= v <= hi2)
        rows.append({'metric': key, 'label': label, 'ours': round(float(v), 3), 'refs': [round(float(x), 3) for x in rv], 'ok': ok})
        if not ok:
            off = (v - hi2) / (abs(hi2) + 1e-6) if v > hi2 else (lo2 - v) / (abs(lo2) + 1e-6)
            issues.append({'metric': key, 'label': label, 'ours': round(float(v), 3), 'refs': [round(float(x), 3) for x in rv],
                           'severity': round(weight * min(3.0, abs(off)) , 2), 'fix': fix})
    issues.sort(key=lambda i: -i['severity'])
    score = round(sum(r['ok'] for r in rows) / max(1, len(rows)), 3)
    lines = [f"compare: {ours['file']} vs {', '.join(r['file'] for r in refs)}", f"{sum(r['ok'] for r in rows)} of {len(rows)} motion metrics in range ({score*100:.0f}%).", 'FIX FIRST:']
    for n, i in enumerate(issues, 1):
        lines.append(f"  {n}. {i['label']}: ours {i['ours']}, reference {i['refs']} - {i['fix']}")
    lines += ['', 'ALL']
    for r in rows:
        lines.append(f"  {'ok ' if r['ok'] else 'OFF'} {r['label']:<46} ours {r['ours']:<8} ref {r['refs']}")
    bad = [h for h in ours['handoffs'] if h['kind'] != 'transform']
    if bad:
        lines += ['', 'HANDOFFS TO REWORK (ours)'] + [f"  {h['start']:.2f}-{h['end']:.2f}s {h['kind']}" for h in bad]
    stops = [m for m in ours['moves'] if m['shape'] in ('hard stop', 'slow start')]
    if stops:
        lines += ['', 'MOVES TO RE-EASE (ours)'] + [f"  {m['start']:.2f}s {m['seconds']:.2f}s {m['shape']}" for m in stops]
    return {'score': score, 'issues': issues, 'rows': rows, 'text': '\n'.join(lines)}


# ------------------------------------------------------------------------------------------------------------- review
STOP = set('a an and are as at be but by for from has have i if in into is it its just like me my no not of on or our so that the their them then there they this to too up us was we what when where which who will with you your'.split())


def _words(text):
    return [w for w in ''.join(c.lower() if c.isalnum() or c in "'" else ' ' for c in text).split() if w]


def shot_cuts(per, hists, fps):
    """Hard cuts: one frame where the picture's colour make-up jumps (and the pixels really change)."""
    n = len(hists); d = np.zeros(n)
    for i in range(1, n):
        d[i] = 1 - float(cv2.compareHist(hists[i - 1].astype(np.float32), hists[i].astype(np.float32), cv2.HISTCMP_CORREL))
    cuts = []
    for i in range(1, n):
        local = np.median(d[max(1, i - int(fps)):min(n, i + int(fps))]) if n > 2 else 0
        if d[i] > max(0.3, 5 * local) and per[i].get('change', 0) > 0.035:
            if cuts and i - cuts[-1] < 0.25 * fps:
                if d[i] > d[cuts[-1]]: cuts[-1] = i
            else:
                cuts.append(i)
    # soft scene changes (whips, slides, crossfades): the picture a quarter second before and after differs a lot
    w = max(2, int(round(0.25 * fps))); soft = np.zeros(n)
    for i in range(w, n - w):
        soft[i] = 1 - float(cv2.compareHist(hists[i - w].astype(np.float32), hists[i + w].astype(np.float32), cv2.HISTCMP_CORREL))
    softs = []
    for i in range(w, n - w):
        if soft[i] > 0.5 and soft[i] == soft[max(0, i - w):i + w + 1].max() and all(abs(i - c) > 0.4 * fps for c in cuts + softs):
            softs.append(i)
    return cuts, softs


def audio_levels(path, seconds):
    """RMS level (dBFS) every 100 ms of the soundtrack, or None when there is none."""
    import subprocess
    try:
        raw = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', path, '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'],
                             capture_output=True, timeout=300).stdout
    except Exception:
        return None
    x = np.frombuffer(raw, np.float32)
    if not len(x):
        return None
    hop = 1600; k = len(x) // hop
    rms = np.sqrt((x[:k * hop].reshape(k, hop) ** 2).mean(1) + 1e-12)
    return 20 * np.log10(rms)


def keyframe(path, t, max_w=1280):
    cap = cv2.VideoCapture(path); cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, t) * 1000); ok, f = cap.read(); cap.release()
    if not ok:
        return None
    h, w = f.shape[:2]
    return cv2.resize(f, (max_w, int(round(h * max_w / w))), interpolation=cv2.INTER_AREA) if w > max_w else f


def tesseract_lines(binary, file):
    """One image read with tesseract (its TSV output), as lines in the reader shape: text, confidence 0-1, box in fractions."""
    import subprocess
    img = cv2.imread(file)
    if img is None:
        return []
    h, w = img.shape[:2]
    res = subprocess.run([binary, file, 'stdout', '--psm', '11', 'tsv'], capture_output=True, text=True, timeout=120).stdout
    lines = {}
    for row in res.splitlines()[1:]:
        cols = row.split('\t')
        if len(cols) < 12 or not cols[11].strip():
            continue
        try:
            conf = float(cols[10]); x, y, bw, bh = (int(cols[i]) for i in (6, 7, 8, 9))
        except ValueError:
            continue
        if conf < 0:
            continue
        key = (cols[2], cols[3], cols[4])                   # block, paragraph, line
        line = lines.setdefault(key, {'words': [], 'conf': [], 'x0': x, 'y0': y, 'x1': x + bw, 'y1': y + bh})
        line['words'].append(cols[11].strip()); line['conf'].append(conf / 100)
        line['x0'] = min(line['x0'], x); line['y0'] = min(line['y0'], y); line['x1'] = max(line['x1'], x + bw); line['y1'] = max(line['y1'], y + bh)
    out = [{'text': ' '.join(l['words']), 'confidence': float(np.mean(l['conf'])),
            'box': [l['x0'] / w, l['y0'] / h, (l['x1'] - l['x0']) / w, (l['y1'] - l['y0']) / h]} for l in lines.values()]
    return sorted(out, key=lambda l: (round(l['box'][1] / 0.02), l['box'][0]))


def run_ocr(binary, files):
    import subprocess
    if not binary or not files or not os.path.exists(binary):
        return {}
    out = {}
    if os.path.basename(binary).startswith('tesseract'):
        for f in files:
            try:
                out[f] = [l for l in tesseract_lines(binary, f) if l['confidence'] >= 0.4 and len(l['text'].strip()) > 1]
            except Exception:
                continue
        return out
    for i in range(0, len(files), 40):
        try:
            res = subprocess.run([binary, *files[i:i + 40]], capture_output=True, text=True, timeout=600).stdout
        except Exception:
            continue
        for line in res.splitlines():
            try:
                row = json.loads(line)
            except Exception:
                continue
            if 'file' in row:
                out[row['file']] = [l for l in row.get('lines', []) if l.get('confidence', 0) >= 0.4 and len(l['text'].strip()) > 1]
    return out


def palette(thumbs, k=5):
    px = thumbs.reshape(-1, 3)[::7].astype(np.float32)
    if len(px) < k:
        return []
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
    _, labels, centers = cv2.kmeans(px, k, None, crit, 2, cv2.KMEANS_PP_CENTERS)
    share = np.bincount(labels.flatten(), minlength=k) / len(labels)
    order = np.argsort(-share)
    return [{'hex': '#%02x%02x%02x' % tuple(int(c) for c in centers[i][::-1]), 'share': round(float(share[i]), 3)} for i in order]


def review(path, out, context=None, audio=None, ocr_bin=None, fps_cap=30.0, refs=()):
    """The whole video, scene by scene: what is on screen (read with OCR), what is said (the transcript), what moves
    (the motion analysis above), what is heard (levels) — and where a viewer would get lost, bored or unable to read."""
    os.makedirs(out, exist_ok=True)
    ctx = context or {}
    meta, per, frames, masks, dist, thumbs, hists = load_or_analyse(path, out, fps_cap)
    motion = summarise(meta, per, masks)
    fps, n, total = meta['fps'], meta['frames'], meta['seconds']
    act = np.array(motion['curve']['activity']); alive = act > 0.02
    cuts, softs = shot_cuts(per, hists, fps)
    bounds = sorted(set([0] + cuts + softs + [int(round(h['start'] * fps)) for h in motion['handoffs'] if h['kind'] != 'transform' and h['start'] > 0.2]
                        + [int(round(h['end'] * fps)) for h in motion['handoffs'] if h['kind'] == 'transform']))
    merged = []
    for b in bounds + [n]:
        if merged and b - merged[-1] < 0.4 * fps:
            continue
        merged.append(b)
    if merged[-1] != n:
        merged[-1] = n
    spans = [(merged[i], merged[i + 1]) for i in range(len(merged) - 1) if merged[i + 1] > merged[i]]
    levels = audio_levels(audio or path, total)
    words = ctx.get('words') or []
    os.makedirs(os.path.join(out, 'scenes'), exist_ok=True)
    keyfiles = []
    scenes = []
    for si, (a, b) in enumerate(spans):
        t0, t1 = a / fps, b / fps
        picks = [t0 + (t1 - t0) * q for q in (0.18, 0.5, 0.88)] if t1 - t0 > 0.6 else [(t0 + t1) / 2]
        pick_times = []
        files = []
        for qi, t in enumerate(picks):
            f = keyframe(path, t)
            if f is None:
                continue
            fn = os.path.join(out, 'scenes', f'scene{si:02d}_{qi}.jpg'); cv2.imwrite(fn, f, [cv2.IMWRITE_JPEG_QUALITY, 88]); files.append(fn); pick_times.append(round(t, 3))
        keyfiles += files
        kind = 'start' if a == 0 else 'cut' if a in cuts else 'scene change' if a in softs else next((h['kind'] for h in motion['handoffs'] if abs(h['start'] * fps - a) <= 0.5 * fps or abs(h['end'] * fps - a) <= 0.5 * fps), 'change')
        said = [w for w in words if t0 <= w['t'] < t1]
        sc = {'index': si, 'start': round(t0, 2), 'end': round(t1, 2), 'seconds': round(t1 - t0, 2), 'enters_by': kind,
              'alive': round(float(alive[a:b].mean()), 2) if b > a else 0.0,
              'eventful': round(float(np.mean([alive[i] or per[i].get('changed', 0) > 0.0006 for i in range(a, b)])), 2) if b > a else 0.0,
              'moves': [m['start'] for m in motion['moves'] if t0 <= m['start'] < t1],
              'luma': round(float(np.mean([per[i]['luma'] for i in range(a, b)])), 2),
              'empty_seconds': round(sum(1 for i in range(a, b) if per[i]['fg_px'] < 12) / fps, 2),
              'said': ' '.join(w['text'] for w in said), 'words_spoken': len(said),
              'layers': [l for l in ctx.get('layers', []) if l['start'] < t1 and l['end'] > t0],
              'clicks': [c for c in ctx.get('clicks', []) if t0 <= c < t1], 'keyframes': [os.path.basename(f) for f in files], 'keytimes': pick_times}
        if levels is not None:
            seg = levels[int(t0 * 10):max(int(t0 * 10) + 1, int(t1 * 10))]
            sc['level_db'] = round(float(20 * np.log10(np.mean(10 ** (seg / 20)) + 1e-12)), 1) if len(seg) else None
            silent = seg < -45
            run = best = 0
            for v in silent:
                run = run + 1 if v else 0; best = max(best, run)
            sc['longest_silence'] = round(best / 10, 2)
        scenes.append(sc)
    ocr = run_ocr(ocr_bin, keyfiles)
    for sc in scenes:
        per_frame = [ocr.get(os.path.join(out, 'scenes', k), []) for k in sc['keyframes']]
        seen = {}
        for lines in per_frame:
            for l in lines:
                key = l['text'].strip()
                seen.setdefault(key, {'text': key, 'frames': 0, 'height': l['box'][3], 'y': l['box'][1]})
                seen[key]['frames'] += 1; seen[key]['height'] = max(seen[key]['height'], l['box'][3])
        # drop fragments of animating text ("ore" while "Learn more" types in)
        keys = list(seen)
        lines = [seen[k] for k in keys if not any(k != o and k.lower() in o.lower() for o in keys)]
        lines = sorted(lines, key=lambda l: (l['y'], -l['height']))
        sc['on_screen'] = [{'text': l['text'], 'height': round(l['height'], 3), 'frames': l['frames']} for l in lines]
        # what a viewer is meant to read: headline-sized lines (≥ ~36 px at 1080p), most in any one frame — not UI small print
        sc['words_on_screen'] = max([sum(len(_words(l['text'])) for l in fl if l['box'][3] >= 0.033) for fl in per_frame] or [0])
        sc['largest_text'] = round(max([l['height'] for l in lines], default=0.0), 3)
    # how long each headline line really stays up: from the first keyframe it is read in to the last (across scenes)
    norm = lambda t: ''.join(ch for ch in t.lower() if ch.isalnum())
    seen_at = {}
    for sc in scenes:
        for k, t in zip(sc['keyframes'], sc['keytimes']):
            for l in ocr.get(os.path.join(out, 'scenes', k), []):
                if l['box'][3] >= 0.033 and len(norm(l['text'])) >= 3:
                    seen_at.setdefault(norm(l['text']), []).append(t)
    def span(text):
        key = norm(text); ts = [t for k2, v in seen_at.items() if key and (key in k2 or k2 in key) for t in v]
        return (max(ts) - min(ts)) if ts else 0.0
    for sc in scenes:
        heads = [l for l in sc['on_screen'] if l['height'] >= 0.033]
        if heads:
            # keyframes sit inside the scene, so a line read at both ends was up ~ a fifth of a scene longer on each side
            sc['text_seconds'] = round(max(sc['seconds'], min(span(l['text']) for l in heads) + 0.36 * sc['seconds']), 2)
    # ---- what a viewer would notice
    issues = []
    def flag(sc, kind, severity, text):
        issues.append({'at': sc['start'], 'end': sc['end'], 'scene': sc['index'], 'kind': kind, 'severity': severity, 'text': text})
    for sc in scenes:
        d = sc['seconds']
        last = sc['index'] == len(scenes) - 1
        if d > (4.0 if last else 2.5) and sc['eventful'] < 0.25 and sc['words_spoken'] < 3:
            flag(sc, 'static', 3, f"nothing moves and nothing is said for {d:.1f} s: add motion (a push-in, a reveal, the next beat sooner) or cut it shorter")
        need = 0.6 + sc['words_on_screen'] / 3.5
        d = sc.get('text_seconds', d)
        if 4 <= sc['words_on_screen'] <= 18 and d < 0.8 * need:      # more than ~18 headline words is UI to glance at, not copy to read
            flag(sc, 'reading', 3, f"{sc['words_on_screen']} words on screen for {d:.1f} s — needs ~{need:.1f} s to read: hold it longer or say less")
        if sc['on_screen'] and sc['largest_text'] < 0.03 and sum(len(_words(l['text'])) for l in sc['on_screen']) >= 2:
            flag(sc, 'small text', 1, f"the biggest text is ~{sc['largest_text'] * 1080:.0f} px at 1080p: too small to read on a phone; make the key line ≥ 45 px")
        if sc.get('longest_silence', 0) > 1.2 and sc['eventful'] < 0.3:
            flag(sc, 'dead air', 2, f"{sc['longest_silence']:.1f} s of silence while little moves: add sound, music or cut")
        if sc['empty_seconds'] > 0.3:
            flag(sc, 'empty', 2, f"the frame is empty for {sc['empty_seconds']:.1f} s")
        if sc['words_spoken'] >= 6 and sc['words_on_screen'] >= 2:
            said = set(_words(sc['said'])) - STOP; shown = set(w for l in sc['on_screen'] for w in _words(l['text'])) - STOP
            if said and shown and not (said & shown):
                flag(sc, 'mismatch', 1, f"says \"{sc['said'][:60]}\" while the screen shows \"{sc['on_screen'][0]['text'][:40]}\" — make them point at the same thing")
    if scenes and scenes[0]['start'] == 0 and scenes[0]['eventful'] < 0.2 and scenes[0]['seconds'] > 1.0 and not scenes[0]['words_spoken']:
        flag(scenes[0], 'slow open', 3, 'the first second is still and silent: open on motion or a line that hooks')
    lengths = [sc['seconds'] for sc in scenes]
    pal = palette(thumbs)
    texts = [sc for sc in scenes if sc['on_screen']]
    profile = {'seconds': round(total, 2), 'scenes': len(scenes), 'median_scene_s': round(float(np.median(lengths)), 2) if lengths else 0,
               'scenes_per_min': round(len(scenes) / max(total, 1e-6) * 60, 1), 'cuts': len(cuts),
               'transform_share': round(motion['summary']['transforms'] / max(1, len(scenes)), 2),
               'luma': round(float(np.mean([p['luma'] for p in per])), 2), 'palette': pal,
               'text_scene_share': round(len(texts) / max(1, len(scenes)), 2),
               'words_on_screen_median': float(np.median([sc['words_on_screen'] for sc in texts])) if texts else 0.0,
               'text_height_median': round(float(np.median([sc['largest_text'] for sc in texts])), 3) if texts else 0.0,
               'speech_share': round(sum(1 for sc in scenes if sc['words_spoken']) / max(1, len(scenes)), 2),
               'alive': motion['summary']['alive'], 'moves_per_s': motion['summary']['moves_per_s'], 'peak_speed_p50': motion['summary']['peak_speed_p50'],
               'snap_share': motion['summary']['snap_share'], 'overshoot_share': motion['summary']['overshoot_share'], 'longest_hold': motion['summary']['longest_hold']}
    result = {'file': os.path.basename(path), 'version': VERSION, 'seconds': round(total, 2), 'profile': profile, 'scenes': scenes,
              'issues': sorted(issues, key=lambda i: (-i['severity'], i['at'])), 'motion': {k: motion[k] for k in ('summary', 'moves', 'holds', 'handoffs')},
              'title': ctx.get('title')}
    if refs:
        result['against'] = compare_profiles(profile, [json.load(open(r))['profile'] for r in refs], [os.path.basename(r) for r in refs])
    result['text'] = review_text(result)
    scenes_png(result, out)
    timeline_png(motion, frames, os.path.join(out, 'timeline.png'))
    result['pictures'] = {'scenes': 'scenes.png', 'timeline': 'timeline.png'}
    with open(os.path.join(out, 'review.json'), 'w') as f:
        json.dump(result, f)
    with open(os.path.join(out, 'review.txt'), 'w') as f:
        f.write(result['text'] + '\n')
    return result


PROFILE_CHECKS = [
    ('median_scene_s', 'Median scene length (s)', 'scenes run long against the references: cut each beat shorter or split it', 'scenes are shorter than the references: let beats land'),
    ('scenes_per_min', 'Scenes per minute', 'busier than the references', 'fewer changes than the references: more beats, quicker cuts'),
    ('alive', 'Share of time something moves', 'more motion than the references', 'the references are more alive: keep something moving through holds'),
    ('peak_speed_p50', 'Peak speed of moves', 'moves are faster than the references', 'moves are slower than the references: snappier springs, bigger travel'),
    ('snap_share', 'Moves that snap', '', 'moves ease in more than the references: start fast, settle slow'),
    ('overshoot_share', 'Spring overshoot', '', 'less spring than the references'),
    ('text_height_median', 'Size of the main text (frame heights)', 'text is bigger than the references', 'text is smaller than the references'),
    ('words_on_screen_median', 'Words on screen per scene', 'more words on screen than the references: say less per beat', ''),
    ('luma', 'Brightness (0 dark … 1 light)', 'lighter than the references', 'darker than the references'),
    ('longest_hold', 'Longest still hold (s)', 'holds longer than the references', ''),
]


def compare_profiles(ours, refs, names):
    rows = []
    for key, label, high, low in PROFILE_CHECKS:
        vals = [r.get(key) for r in refs if r.get(key) is not None]
        v = ours.get(key)
        if v is None or not vals:
            continue
        lo, hi = min(vals), max(vals); pad = 0.2 * max(abs(lo), abs(hi), 1e-6)
        state = 'high' if v > hi + pad else 'low' if v < lo - pad else 'ok'
        note = high if state == 'high' else low if state == 'low' else ''
        rows.append({'metric': key, 'label': label, 'ours': v, 'refs': vals, 'state': state if note or state == 'ok' else 'ok', 'note': note})
    return {'references': names, 'rows': rows, 'in_range': sum(r['state'] == 'ok' for r in rows), 'of': len(rows)}


def review_text(r):
    p = r['profile']
    pal = ', '.join(f"{c['hex']} {c['share'] * 100:.0f}%" for c in p['palette'][:4])
    lines = [f"{r['file']}: {r['seconds']:.1f} s, {p['scenes']} scenes (median {p['median_scene_s']} s, {p['scenes_per_min']}/min, {p['cuts']} hard cuts). "
             f"{'Light' if p['luma'] > 0.55 else 'Dark' if p['luma'] < 0.35 else 'Mid'} picture ({pal}). Text on screen in {p['text_scene_share'] * 100:.0f}% of scenes "
             f"(median {p['words_on_screen_median']:.0f} words, main text {p['text_height_median'] * 1080:.0f} px at 1080p); speech in {p['speech_share'] * 100:.0f}%. "
             f"Motion: alive {p['alive'] * 100:.0f}%, {p['moves_per_s']} moves/s, peak {p['peak_speed_p50']} widths/s, snap {p['snap_share'] * 100:.0f}%, overshoot {p['overshoot_share'] * 100:.0f}%."]
    if r['issues']:
        lines += ['', 'WHERE A VIEWER GETS LOST OR BORED (most important first)']
        lines += [f"  {i['at']:6.2f}-{i['end']:6.2f}  [{i['kind']}] {i['text']}" for i in r['issues']]
    if r.get('against'):
        a = r['against']
        lines += ['', f"STYLE AGAINST {', '.join(a['references'])}: {a['in_range']} of {a['of']} in range"]
        lines += [f"  {'ok ' if x['state'] == 'ok' else 'OFF'} {x['label']:<40} ours {x['ours']:<7} refs {x['refs']}{'  — ' + x['note'] if x['note'] else ''}" for x in a['rows']]
    lines += ['', 'SCENES']
    for sc in r['scenes']:
        shown = ' / '.join(l['text'] for l in sc['on_screen'][:4])
        lines.append(f"  {sc['index']:2d} {sc['start']:6.2f}-{sc['end']:6.2f} ({sc['seconds']:.1f} s, in by {sc['enters_by']}, alive {sc['alive'] * 100:.0f}%, {len(sc['moves'])} moves"
                     + (f", {sc['level_db']} dB" if sc.get('level_db') is not None else '') + ')')
        if shown: lines.append(f"       on screen: {shown[:160]}")
        if sc['said']: lines.append(f"       said: {sc['said'][:160]}")
        if sc['layers']: lines.append(f"       layers: {', '.join(l['name'] for l in sc['layers'])[:160]}")
    return '\n'.join(lines)


def scenes_png(r, out, tw=320):
    """One row per scene: its keyframes and a caption — the whole film at a glance."""
    rows = []
    for sc in r['scenes']:
        imgs = [cv2.imread(os.path.join(out, 'scenes', k)) for k in sc['keyframes']]
        imgs = [cv2.resize(i, (tw, int(round(i.shape[0] * tw / i.shape[1])))) for i in imgs if i is not None]
        if not imgs:
            continue
        th = imgs[0].shape[0]
        row = np.full((th + 34, tw * 3 + 8, 3), 250, np.uint8)
        for j, im in enumerate(imgs[:3]):
            row[34:34 + th, j * (tw + 4):j * (tw + 4) + tw] = im[:th]
        flags = [i['kind'] for i in r['issues'] if i['scene'] == sc['index']]
        _label(row, f"{sc['index']}  {sc['start']:.2f}-{sc['end']:.2f}s  {sc['seconds']:.1f}s  in by {sc['enters_by']}  alive {sc['alive'] * 100:.0f}%" + (f"  ! {', '.join(flags)}" if flags else ''), (6, 22), 0.5)
        rows.append(row)
    if not rows:
        return
    cols = 2 if len(rows) > 6 else 1
    per_col = math.ceil(len(rows) / cols)
    h = max(r_.shape[0] for r_ in rows); w = rows[0].shape[1]
    sheet = np.full((h * per_col, (w + 10) * cols, 3), 255, np.uint8)
    for i, row in enumerate(rows):
        c, rr = divmod(i, per_col)
        sheet[rr * h:rr * h + row.shape[0], c * (w + 10):c * (w + 10) + w] = row
    cv2.imwrite(os.path.join(out, 'scenes.png'), sheet)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    w = sub.add_parser('watch'); w.add_argument('video'); w.add_argument('--out', required=True); w.add_argument('--no-pictures', action='store_true'); w.add_argument('--top', type=int, default=10); w.add_argument('--json', action='store_true'); w.add_argument('--refs', nargs='*', default=[])
    c = sub.add_parser('compare'); c.add_argument('ours'); c.add_argument('refs', nargs='+'); c.add_argument('--json', action='store_true')
    rv = sub.add_parser('review'); rv.add_argument('video'); rv.add_argument('--out', required=True); rv.add_argument('--context'); rv.add_argument('--audio')
    rv.add_argument('--ocr'); rv.add_argument('--fps-cap', type=float, default=30.0); rv.add_argument('--refs', nargs='*', default=[]); rv.add_argument('--json', action='store_true')
    a = ap.parse_args()
    if a.cmd == 'review':
        r = review(a.video, a.out, json.load(open(a.context)) if a.context else None, a.audio, a.ocr, a.fps_cap, a.refs)
        print(json.dumps({k: r[k] for k in ('profile', 'issues', 'text', 'pictures', 'against') if k in r} | {'folder': os.path.abspath(a.out), 'scenes': len(r['scenes'])}) if a.json else r['text'])
        return
    if a.cmd == 'watch':
        r = watch(a.video, a.out, not a.no_pictures, a.top)
        verdict = compare(os.path.join(a.out, 'motion.json'), a.refs) if a.refs else None
        if verdict:
            with open(os.path.join(a.out, 'compare.txt'), 'w') as f:
                f.write(verdict['text'] + '\n')
        if a.json:
            print(json.dumps({'summary': r['summary'], 'text': r['text'], 'moves': len(r['moves']), 'handoffs': r['handoffs'], 'pictures': r['pictures'], 'folder': os.path.abspath(a.out),
                              'compare': verdict}))
        else:
            print(r['text'] + ('\n\n' + verdict['text'] if verdict else ''))
    else:
        r = compare(a.ours, a.refs)
        print(json.dumps(r) if a.json else r['text'])


if __name__ == '__main__':
    main()
