"""The Studio worker <-> earshot bridge. Run with earshot's own Python (isolated), from the worker (src/earshot.ts):
    $STUDIO_EARSHOT_DIR/.venv/bin/python -I python/earshot_bridge.py < request.json > result.json

earshot (ears and sound effects for agents) is an outside, MIT-licensed project, pinned to a reviewed commit
(studio-worker/README.md, "Sound"). This file is the only code of ours that imports it.

One JSON request on stdin, one JSON answer on stdout (errors: {"error": "..."} and exit 1).
  {"cmd": "list", "category"?: str, "kind"?: str}          the sound bank (252 sounds made in code)
  {"cmd": "presets"}                                        kit presets (launch / crisp / calm / minimal) and their roles
  {"cmd": "render", "out": dir, "preset": "launch", "music"?: wav, "cues": [cue, ...]}
      cue = {"id", "t" (s), "kind" (a kit role: pop, land, whoosh.short, hit, ...) and/or "sound" (a bank id),
             "pitch"?, "dur"?, "apex"?, "seed"?, "level_db"? (overrides the role), "weight"? (0..2, 1 = normal)}
      Each cue: the role's sound rendered (clean take: re-rolled on a failed audit like earshot kit), levelled against
      the music bed when one is given (else the role's level), placed so its sync point (onset / peak) lands on the
      cue with the role's offset. Returns per cue {id, file, start_s, trim_s, sound, role, gain_db, onset_s, peak_s,
      end_s, warnings}.
  {"cmd": "place_file", "file": wav, "out": dir, "t": s, "align"?: "onset"|"peak", "offset_ms"?: n, "level_db"?: n}
      Any sound file (a forge / fit render, a sourced recording): measured onset and peak, level applied, copied to out,
      start time computed so its sync point lands on t. A music bed (raw_start, end_s, fade_out_s) is cut to the
      video's end and faded out; source_start starts it from a moment.
  {"cmd": "listen", "audio": wav, "video"?: mp4, "cues"?: cue file, "out": dir, "checks"?: ["timeline", "critique", "sheet"]}
      earshot listens to the mix in ONE process (models load once): the listening transcript with sync to every cue,
      the launch-film scorecard and an annotated sheet PNG. Returns the summaries and the full JSON paths.
  {"cmd": "duck", "file": wav, "out": dir, "at_s": [s, ...], "depth_db"?: 9, "length_s"?: 0.4}
      The music stepped down before each big moment and back on it (the launch-film stop-down).
"""
import json
import os
import sys

import numpy as np

# What FFmpeg may open for the bridge: local files and pipes, in containers that hold sound and name no other file
# (the worker's SOUND_FORMATS). The worker hands it only WAVs it made and library sounds, but never trusts that.
FFMPEG_FENCE = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'wav,w64,mp3,flac,ogg,mov,matroska,aac,aiff,caf']


def main():
    req = json.load(sys.stdin)
    cmd = req.get('cmd')
    if cmd == 'list':
        from earshot.forge import bank
        rows = bank.list_sounds(category=req.get('category'), kind=req.get('kind'))
        return {'version': bank.VERSION, 'sounds': rows}
    if cmd == 'presets':
        from earshot.forge import kit
        out = {}
        for name in kit.presets():
            p = kit.preset(name)
            out[name] = {'note': p.get('note'), 'roles': {k: v for k, v in p['roles'].items() if v}}
        return {'presets': out}
    if cmd == 'render':
        return render(req)
    if cmd == 'place_file':
        return place_file(req)
    if cmd == 'listen':
        return listen(req)
    if cmd == 'duck':
        return duck(req)
    raise SystemExit(json.dumps({'error': f'unknown cmd {cmd!r}'}))


def role_for(roles, kind):
    """the preset's role for a cue kind: exact, else its family (whoosh.short for whoosh), else None"""
    if not kind:
        return None, None
    if roles.get(kind):
        return kind, roles[kind]
    fam = kind.split('.')[0]
    for name in (fam, fam + '.short', fam + '.light'):
        if roles.get(name):
            return name, roles[name]
    return None, None


def render(req):
    from earshot.forge import bank, kit, sfx
    import soundfile as sf
    sr = kit.SR
    preset = kit.preset(req.get('preset') or 'launch')
    roles = {k: v for k, v in preset['roles'].items() if v}
    out_dir = req['out']
    os.makedirs(out_dir, exist_ok=True)
    music = req.get('music')
    bed_audio = None
    if music:
        from earshot import audio
        bed_audio = audio.load(music)
    cues = sorted(req.get('cues') or [], key=lambda c: float(c['t']))
    # Runs keep the role's minimum gap (pops ~114 ms apart, keys ~87 ms), like a sound designer would space them.
    by_role = {}
    for c in cues:
        by_role.setdefault(role_for(roles, c.get('kind'))[0], []).append(c)
    for name, items in by_role.items():
        gap = (roles.get(name) or {}).get('min_gap_ms') if name else None
        if gap:
            times = kit.space_run([c['t'] for c in items], gap)
            for c, t in zip(items, times):
                c['t_spaced'] = t
    results, uses = [], {}
    for i, c in enumerate(cues):
        rname, role = role_for(roles, c.get('kind'))
        sound = c.get('sound') or (role or {}).get('sound')
        if not sound:
            results.append({'id': c.get('id'), 'skipped': f"no sound for kind {c.get('kind')!r} in preset {preset['name']}"})
            continue
        role = dict(role or {'align': 'onset', 'offset_ms': 0, 'level_db': -6.0})
        if c.get('align'):
            role['align'] = c['align']
        if c.get('over_bed_db') is not None:   # how far this cue rides over the music (a run that must read: keys, counter ticks)
            role['bed_db'] = float(c['over_bed_db'])
        # The first use of a sound is its delivered final (the bank's own seed); repeats are fresh takes of it.
        uses[sound] = uses.get(sound, -1) + 1
        own = int(bank.get(sound).get('seed') or 0)
        seed0 = int(c['seed']) if c.get('seed') is not None else own + 13 * uses[sound]
        y = meta = check = None
        for j in range(4):   # a take that fails the audit is re-rolled on a new seed (earshot kit does the same)
            y, meta = bank.render(sound, seed=seed0 + 1000 * j, dur=c.get('dur'), apex=c.get('apex'), pitch=c.get('pitch'),
                                  peak_db=-1.0, checks=False)
            check = sfx.check(y, category=bank.get(sound)['category'], role=rname, sound=sound)
            if check['ok']:
                break
        take = {'onset_s': meta['onset_s'], 'peak_s': meta['peak_s'], 'end_s': meta['end_s'], 'peak_db': meta['peak_db'],
                'l50_lufs': kit.loud_lufs(y, sr)}
        t = float(c.get('t_spaced', c['t']))
        bed = None
        if bed_audio is not None:
            try:
                bed = kit.bed_level(bed_audio, t)
            except Exception:  # noqa: BLE001  (no music before the cue)
                bed = None
        gain = float(c['level_db']) if c.get('level_db') is not None else kit.gain_db(take, role, bed)
        w = c.get('weight')
        if w is not None and float(w) > 0 and c.get('level_db') is None:
            gain += 20 * np.log10(float(w)) * 0.5   # weight 2 = +3 dB, 0.5 = -3 dB
        y = np.asarray(y, np.float32) * float(10 ** (gain / 20))
        peak = float(np.max(np.abs(y))) if y.size else 0.0
        if peak > 0.89:   # never over -1 dBFS
            y *= 0.89 / peak
        start = kit.place(take, role, t)
        trim = 0.0
        if start < 0:
            trim, start = -start, 0.0
        f = os.path.join(out_dir, f"{i:03d}-{sound.replace('/', '_')}.wav")
        sf.write(f, y, sr, subtype='PCM_24')
        results.append({'id': c.get('id'), 'file': f, 'start_s': round(start, 4), 'trim_s': round(trim, 4), 'sound': sound,
                        'role': rname, 'gain_db': round(gain, 2), 'bed_lufs': bed, 'onset_s': take['onset_s'],
                        'peak_s': take['peak_s'], 'end_s': take['end_s'], 'dur_s': round(len(y) / sr, 4),
                        'warnings': [w2.get('msg') for w2 in check.get('warnings', [])]})
    return {'preset': preset['name'], 'cues': results}


def _envelope_points(y, sr):
    x = np.abs(np.asarray(y, np.float64))
    if x.ndim > 1:
        x = x.max(axis=1)
    win = max(1, int(sr * 0.005))
    rms = np.sqrt(np.convolve(x ** 2, np.ones(win) / win, mode='same'))
    peak_i = int(np.argmax(rms))
    thr = rms[peak_i] * 10 ** (-30 / 20)
    onset_i = int(np.argmax(rms > thr))
    tail = np.nonzero(rms > rms[peak_i] * 10 ** (-45 / 20))[0]
    end_i = int(tail[-1]) if tail.size else len(rms) - 1
    return onset_i / sr, peak_i / sr, end_i / sr


def _read_any(path):
    """any ffmpeg-readable file (mp3, ogg, m4a, wav) as float32 at 48 kHz, stereo kept"""
    from earshot import audio
    try:
        import soundfile as sf
        y, sr = sf.read(path, always_2d=False, dtype='float32')
        return y, sr
    except Exception:  # noqa: BLE001  (mp3 / m4a: decode through ffmpeg)
        import subprocess
        # Local files and pipes only, and only containers that name no other file (no playlists, no concat lists).
        p = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', *FFMPEG_FENCE, '-i', path, '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', '2', '-ar', '48000', '-'],
                           capture_output=True, check=True)
        return np.frombuffer(p.stdout, np.float32).reshape(-1, 2).copy(), 48000


def place_file(req):
    import soundfile as sf
    y, sr = _read_any(req['file'])
    if req.get('source_start'):   # start the file from a moment (a music bed from its strongest section)
        y = y[int(float(req['source_start']) * sr):]
    onset, peak, end = _envelope_points(y, sr)
    if req.get('end_s'):   # a music bed: cut to the video's end, faded out over its last fade_out_s
        n = int(float(req['end_s']) * sr)
        y = y[:n].copy()
        f = int(float(req.get('fade_out_s') or 0) * sr)
        if f > 0 and len(y) > f:
            ramp = np.linspace(1.0, 0.0, f) ** 2
            y[-f:] = y[-f:] * (ramp[:, None] if y.ndim > 1 else ramp)
    gain = float(req.get('level_db') or 0.0)
    y = y * float(10 ** (gain / 20))
    pk = float(np.max(np.abs(y))) if y.size else 0.0
    if pk > 0.89:
        y = y * (0.89 / pk)
    align = req.get('align') or 'onset'
    t = float(req['t']) + float(req.get('offset_ms') or 0) / 1000.0
    start = t if req.get('raw_start') else t - (peak if align == 'peak' else onset)
    trim = 0.0
    if start < 0:
        trim, start = -start, 0.0
    os.makedirs(req['out'], exist_ok=True)
    f = os.path.join(req['out'], os.path.splitext(os.path.basename(req['file']))[0][:60] + '.wav')
    sf.write(f, y, sr, subtype='PCM_24')
    return {'file': f, 'start_s': round(start, 4), 'trim_s': round(trim, 4), 'onset_s': round(onset, 4), 'peak_s': round(peak, 4),
            'end_s': round(end, 4), 'dur_s': round(len(y) / sr, 4), 'gain_db': gain}


def listen(req):
    from earshot import api
    out = req['out']
    os.makedirs(out, exist_ok=True)
    checks = req.get('checks') or ['timeline', 'critique', 'sheet']
    audio, video, cues = req['audio'], req.get('video'), req.get('cues')
    res = {}
    tl = None
    if 'timeline' in checks or 'sheet' in checks:
        tl = api.timeline(audio, video=video, cues=cues, detail=req.get('detail') or 'normal')
        with open(os.path.join(out, 'timeline.json'), 'w') as fh:
            json.dump(tl, fh, default=str)
        from earshot.timeline import transcript
        res['timeline'] = {'summary': tl.get('summary'), 'text': transcript(tl)[:6000], 'json': os.path.join(out, 'timeline.json')}
    if 'critique' in checks:
        cr = api.critique(audio, video=video)
        with open(os.path.join(out, 'critique.json'), 'w') as fh:
            json.dump(cr, fh, default=str)
        from earshot.critique import critique_text
        res['critique'] = {'verdict': cr.get('verdict'), 'score': cr.get('score'), 'text': critique_text(cr)[:6000], 'json': os.path.join(out, 'critique.json')}
    if 'sheet' in checks:
        png = os.path.join(out, 'sheet.png')
        sh = api.sheet(audio, png, video=video, cues=cues, tl=tl)
        res['sheet'] = {'summary': (sh or {}).get('summary') if isinstance(sh, dict) else None, 'png': png}
    return res


def duck(req):
    """the launch-film stop-down: the music steps down depth_db over the length_s before each moment (a hit, a drop,
    a big whoosh, a swell) and comes back on it, so the moment lands on space instead of on a wall of music"""
    import soundfile as sf
    y, sr = _read_any(req['file'])
    g = np.ones(len(y), np.float64)
    depth = 10 ** (-float(req.get('depth_db', 9)) / 20)
    length, fall, back = float(req.get('length_s', 0.4)), 0.06, 0.012
    for t in req.get('at_s') or []:
        a, b = int((t - length) * sr), int(t * sr)
        if b <= 0 or a >= len(y):
            continue
        env = np.full(max(0, b - a), depth)
        f = min(len(env), int(fall * sr))
        env[:f] = np.linspace(1.0, depth, f) if f else env[:f]
        lo, hi = max(0, a), min(len(y), b)
        g[lo:hi] = np.minimum(g[lo:hi], env[lo - a:hi - a])
        r = min(len(y) - hi, int(back * sr))
        if r > 0:
            g[hi:hi + r] = np.minimum(g[hi:hi + r], np.linspace(depth, 1.0, r))
    out = y * (g[:, None] if y.ndim > 1 else g)
    os.makedirs(req['out'], exist_ok=True)
    f = os.path.join(req['out'], 'music-ducked.wav')
    sf.write(f, out.astype(np.float32), sr, subtype='PCM_24')
    return {'file': f, 'ducks': len(req.get('at_s') or [])}


if __name__ == '__main__':
    try:
        print(json.dumps(main(), default=lambda o: o.item() if hasattr(o, 'item') else str(o)))
    except SystemExit:
        raise
    except Exception as ex:  # noqa: BLE001
        print(json.dumps({'error': f'{type(ex).__name__}: {ex}'}))
        sys.exit(1)
