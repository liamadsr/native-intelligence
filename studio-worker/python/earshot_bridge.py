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
  {"cmd": "judge", "action", "out": dir, "sounds": [src, ...], "description"?, "alts"?, "target"?: src, "start"?, "end"?,
   "category"?, "top"?}
      src = {"path": wav, "name", "assetId"?} (a WAV the worker decoded) or {"sound": bank id, "name"?} (rendered here).
      earshot's judge functions (describe + match, measure, compare, rank, find, ab, realness) with the answer made
      compact: numbers and short words, every file named by its name, never by a path (the worker's judge_result shape).
  {"cmd": "forge", "recipe", "description", "alts"?, "count", "budget"?, "out": dir}
      A sound made in code: the recipe's parameters searched toward the description by earshot's critic (designed
      mode, no references, the install's seed bank left alone). Returns {made: [{file, score}], summary}.
  {"cmd": "fit", "file": wav, "description"?, "out": dir}
      A recording turned into code (earshot fit, kind auto) and rendered again: {file, quality}.
  {"cmd": "doctor"}
      earshot's own health check, short: {summary, problems, notes, modelsCached, bank}.

The judge, forge, fit and doctor never reach the network: earshot is told to stay offline, so a model that is not in
its cache is a refusal that says so (`earshot doctor --fetch` where the worker runs), never a download.
"""
import json
import os
import re
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
    if cmd in ('judge', 'forge', 'fit', 'doctor'):
        stay_offline()
        try:
            with redirect_stdout_to_stderr():
                return {'judge': judge, 'forge': forge, 'fit': fit, 'doctor': doctor}[cmd](req)
        except Exception as ex:  # noqa: BLE001
            raise Refusal(plain_error(ex)) from None
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


# ---- the judge, the forge, the fit and the doctor -------------------------------------------------------------------

class Refusal(Exception):
    """a sentence the job fails with (printed as {"error": ...}, never a traceback)"""


def stay_offline():
    """these commands never reach the network: set before earshot or the model libraries are imported"""
    for k in ('EARSHOT_OFFLINE', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE'):
        os.environ[k] = '1'


# A path on the worker (two or more parts after a leading slash), never shown in an answer.
PATH_RE = re.compile(r'(?<![\w.])/(?:[^\s,;()\'"\[\]]+/)+[^\s,;()\'"\[\]]*')


def named(s, files):
    """earshot's words with every file called by its name, and any other path taken out"""
    s = str(s or '')
    for f in sorted(files, key=lambda f: -len(f['path'])):
        s = s.replace(f['path'], f['name']).replace(os.path.basename(f['path']), f['name'])
    return PATH_RE.sub('a file', s)


def plain_error(ex):
    """one sentence for a failure: a model missing from the cache says how to fetch it; no path, no traceback"""
    if isinstance(ex, Refusal):
        return str(ex)
    msg, kind = str(ex), type(ex).__name__
    low = (kind + ' ' + msg).lower()
    if any(w in low for w in ('offline', 'localentrynotfound', 'cannot find the requested files', "couldn't connect", 'outgoing traffic has been disabled')):
        return ("earshot's listening models are not on the worker (run `earshot doctor --fetch` where the Studio worker "
                'runs, once); nothing was downloaded.')
    return named(f'{kind}: {msg}', [])[:600]


def render_bank(sound, path):
    """one bank sound at its own settings (the delivered final), as a WAV to hear"""
    from earshot.forge import bank
    import soundfile as sf
    y, _ = bank.render(sound, checks=False)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sf.write(path, y, 48000, subtype='PCM_24')
    return path


def sources(items, out, prefix='sound'):
    """the sounds to hear as files: the worker's decoded WAVs as given, bank sounds rendered here once each"""
    files = []
    for i, it in enumerate(items):
        it = it or {}
        if it.get('path'):
            files.append({'path': it['path'], 'name': str(it.get('name') or f'sound {i + 1}')[:120], 'assetId': it.get('assetId')})
        elif it.get('sound'):
            path = render_bank(str(it['sound']), os.path.join(out, f'{prefix}-{i + 1:02d}.wav'))
            files.append({'path': path, 'name': str(it.get('name') or it['sound'])[:120], 'sound': str(it['sound'])})
        else:
            raise Refusal(f'Sound {i + 1} names no file and no bank sound.')
    return files


def ref(f):
    """a file as the answer names it: its name and the asset or bank sound it is"""
    return {k: f[k] for k in ('name', 'assetId', 'sound') if f.get(k)}


def need(files, n, what):
    if len(files) < n:
        raise Refusal(f'{what} needs at least {n} sound{"s" if n > 1 else ""}.')
    return files


MEASURE_KEYS = {'duration': 'seconds', 'lufs': 'lufs', 'true_peak_dbtp': 'truePeakDb', 'peak_dbfs': 'peakDb',
                'rms_dbfs': 'rmsDb', 'lra_lu': 'lraLu', 'noise_floor_dbfs': 'noiseFloorDb',
                'brightness_hz': 'brightnessHz', 'bandwidth_hz': 'bandwidthHz', 'attack_ms': 'attackMs',
                'decay_ms': 'decayMs', 'onset_count': 'onsets', 'f0_hz': 'f0Hz', 'clipped_samples': 'clippedSamples'}


def measures(m):
    """earshot's meter readings under the contract's names (numbers only)"""
    out = {}
    for k, name in MEASURE_KEYS.items():
        v = (m or {}).get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool) and np.isfinite(v):
            out[name] = float(v)
    return out


def j_measure(req, files, _target):
    from earshot import features
    from earshot.mcp_server import measure_summary
    f = need(files, 1, 'Measuring')[0]
    m = features.measure(f['path'], start=req.get('start'), end=req.get('end'))
    return {'summary': f"{f['name']}: {measure_summary(m)}", 'measures': measures(m)}


def j_describe(req, files, _target):
    from earshot import api
    f = need(files, 1, 'Describing')[0]
    start, end, desc = req.get('start'), req.get('end'), (req.get('description') or '').strip()
    d = api.describe(f['path'], start=start, end=end, top=6)
    res = {'summary': d.get('summary') or '', 'measures': measures(d.get('measurements')),
           'tags': [{'term': t.get('term'), 'category': t.get('category'), 'z': t.get('z')} for t in (d.get('top_tags') or [])[:6]],
           'character': list(d.get('character') or [])[:4],
           'labels': [{'label': a.get('label'), 'p': a.get('p')} for a in (d.get('audioset') or [])[:5]]}
    if desc:
        m = api.match(f['path'], desc, alts=req.get('alts') or None, start=start, end=end)
        res['match'] = {'description': desc, 'z': m.get('z'), 'verdict': m.get('verdict'), 'percentile': m.get('percentile'),
                        'pVsAlts': m.get('p_vs_alts'), 'soundsLike': [c.get('term') for c in (m.get('closest_vocab') or [])[:3]]}
        res['summary'] = f"{res['summary']} {m.get('summary') or ''}".strip()
    return res


def j_rank(req, files, target):
    from earshot import api
    need(files, 2, 'Ranking')
    by_path = {f['path']: f for f in files}
    top = int(req.get('top') or len(files))
    if target:
        # Closeness to the target sound: the candidates as references of the target, nearest first.
        c = api.compare(target['path'], [f['path'] for f in files], k=len(files))
        rows = [{**ref(by_path[n['path']]), 'cosine': n.get('cosine')} for n in (c.get('nearest') or []) if n.get('path') in by_path]
        s = f"Closest to {target['name']}: " + ', '.join(f"{r['name']} (cosine {r['cosine']:.2f})" for r in rows[:3]) + '.'
        return {'summary': s, 'ranked': rows[:top]}
    desc = (req.get('description') or '').strip()
    if not desc:
        raise Refusal('Ranking needs a description or a target sound.')
    r = api.rank([f['path'] for f in files], desc, top=top)
    rows = [{**ref(by_path[x['path']]), 'z': x.get('z'), 'cosine': x.get('cosine'), 'verdict': x.get('verdict'),
             'soundsLike': x.get('sounds_most_like')} for x in (r.get('results') or []) if x.get('path') in by_path]
    return {'summary': r.get('summary') or '', 'ranked': rows}


def bank_candidates(req, out):
    """the bank sounds a find without a sound searches: its category when given, rendered here"""
    from earshot.forge import bank
    rows = bank.list_sounds(category=req.get('category') or None)
    if not rows:
        raise Refusal(f"The bank has no category {req.get('category')!r}.")
    return sources([{'sound': r['id']} for r in rows], os.path.join(out, 'bank'), 'bank')


def j_find(req, files, _target):
    from earshot import api
    desc = (req.get('description') or '').strip()
    if not desc:
        raise Refusal('Finding needs a description of the sound.')
    top = int(req.get('top') or 5)
    if files:
        f = files[0]
        r = api.find(f['path'], desc, top=top)
        segs = [{'start': s.get('start'), 'end': s.get('end'), 'z': s.get('z'), 'verdict': s.get('verdict'), 'cut': s.get('cut') or None}
                for s in (r.get('segments') or [])]
        return {'summary': r.get('summary') or '', 'segments': segs}
    cands = bank_candidates(req, req['out'])
    by_path = {f['path']: f for f in cands}
    r = api.rank([f['path'] for f in cands], desc, top=top)
    rows = [{**ref(by_path[x['path']]), 'z': x.get('z'), 'cosine': x.get('cosine'), 'verdict': x.get('verdict'),
             'soundsLike': x.get('sounds_most_like')} for x in (r.get('results') or []) if x.get('path') in by_path]
    head = ', '.join(f"{x['name']} (z {x['z']:+.2f}, {x['verdict']})" for x in rows[:3])
    return {'summary': f"The bank's best for '{desc}' among {len(cands)} sounds: {head}.", 'ranked': rows, '_files': cands}


def j_compare(req, files, _target):
    from earshot import api
    need(files, 3, 'Comparing (one sound and two or more references)')
    by_path = {f['path']: f for f in files}
    c = api.compare(files[0]['path'], [f['path'] for f in files[1:]], k=min(5, len(files) - 1))
    diffs = [f"{k}: {d.get('value')} (references {d.get('refs_median')}, robust z {d.get('robust_z'):+.1f})"
             for k, d in (c.get('features') or {}).items() if abs(d.get('robust_z') or 0) >= 2][:6]
    typ = c.get('typicality') or {}
    return {'summary': c.get('summary') or '', 'nearest': [{**ref(by_path[n['path']]), 'cosine': n.get('cosine')} for n in (c.get('nearest') or []) if n.get('path') in by_path],
            'typicality': {'z': typ.get('z'), 'verdict': typ.get('verdict')} if typ else None, 'differences': diffs}


def j_ab(req, files, _target):
    from earshot import api
    from earshot.compare import differences
    a, b = need(files, 2, 'An A/B')[:2]
    refs = [f['path'] for f in files[2:]]
    desc = (req.get('description') or '').strip() or None
    r = api.ab(a['path'], b['path'], query=desc, refs=refs if len(refs) >= 2 else None)
    q, rf = r.get('query') or {}, r.get('refs') or {}
    closer = q.get('closer') if q else rf.get('closer')
    out = {'a': a['name'], 'b': b['name'], 'closer': closer, 'cosine': r.get('cosine_ab')}
    if q:
        out.update(zA=(q.get('a') or {}).get('z'), zB=(q.get('b') or {}).get('z'))
    elif rf:
        out.update(zA=(rf.get('a') or {}).get('z'), zB=(rf.get('b') or {}).get('z'))
    feats = r.get('features') or {}
    _, words = differences(feats.get('a') or {}, feats.get('b') or {})
    return {'summary': r.get('summary') or '', 'ab': out, 'differences': [f'B against A: {words}']}


def j_realness(req, files, _target):
    from earshot import api
    need(files, 1, 'Realness')
    try:
        if len(files) == 1:
            r = api.realness(files[0]['path'], start=req.get('start'), end=req.get('end'))
            rows = [{**ref(files[0]), 'pReal': r.get('p_real'), 'verdict': r.get('verdict'), 'why': r.get('why')}]
            return {'summary': r.get('summary') or '', 'realness': rows}
        r = api.realness_many([f['path'] for f in files])
    except (FileNotFoundError, OSError) as ex:
        raise Refusal('Realness is not available in this earshot install (its model file is missing): real against '
                      'code-made was NOT checked.') from ex
    by_path = {f['path']: f for f in files}
    rows = [{**ref(by_path.get(x.get('path')) or {'name': os.path.basename(str(x.get('path')))}), 'pReal': x.get('p_real'),
             'verdict': x.get('verdict'), 'why': x.get('why')} for x in (r.get('files') or [])]
    return {'summary': r.get('summary') or '', 'realness': rows}


JUDGES = {'describe': j_describe, 'measure': j_measure, 'rank': j_rank, 'find': j_find, 'compare': j_compare,
          'ab': j_ab, 'realness': j_realness}


def judge(req):
    out = req['out']
    os.makedirs(out, exist_ok=True)
    fn = JUDGES.get(req.get('action'))
    if not fn:
        raise Refusal(f"There is no judgement {req.get('action')!r}.")
    files = sources(req.get('sounds') or [], out)
    target = sources([req['target']], out, 'target')[0] if req.get('target') else None
    res = fn(req, files, target)
    heard = files + ([target] if target else []) + res.pop('_files', [])
    res['summary'] = named(res.get('summary'), heard)[:1500]
    for k in ('differences',):
        if res.get(k):
            res[k] = [named(d, heard) for d in res[k]]
    return {k: v for k, v in res.items() if v not in (None, [], {})}


def forge(req):
    """a sound made in code: the recipe's parameters searched toward the description (designed mode: no references)"""
    from earshot.forge import forge as run_forge, recipes
    recipe = str(req.get('recipe') or '')
    if recipe not in recipes():
        raise Refusal(f"earshot has no recipe {recipe!r} (it has {', '.join(recipes())}).")
    desc = (req.get('description') or '').strip()
    if not desc:
        raise Refusal('Making a sound needs a description of it.')
    count = max(1, min(4, int(req.get('count') or 1)))
    budget = max(16, min(160, int(req.get('budget') or 48)))
    out = req['out']
    log = lambda *a: print(*a, file=sys.stderr)  # noqa: E731  (progress lines go to stderr, the answer to stdout)
    with redirect_stdout_to_stderr():
        rep = run_forge(recipe, target=desc, alts=req.get('alts') or None, budget=budget, pop=8, keep=count, seed=int(req.get('seed') or 0),
                        out=out, log=log, outputs=False, bank=False, mode='designed', holdout=False)
    made = []
    for p in rep.get('picks') or []:
        if not p.get('file') or not os.path.isfile(p['file']):
            continue
        s = p.get('score') or {}
        made.append({'file': p['file'], 'name': p.get('name'),
                     'score': {'total': s.get('total'), 'passes': s.get('passes'), 'matchZ': s.get('match_z'), 'pReal': s.get('p_real'),
                               'soundsLike': list(s.get('sounds_like') or [])[:3], 'words': named(s.get('summary'), [])[:400]}})
    if not made:
        raise Refusal(f"The forge kept no sound for '{desc}' with {recipe}.")
    return {'recipe': recipe, 'description': desc, 'made': made, 'summary': named(rep.get('summary'), [])[:1500]}


def fit(req):
    """a recording turned into code (earshot fit, kind auto) and rendered again"""
    from earshot.forge.fit import run_fit
    src = req['file']
    out = req['out']
    os.makedirs(out, exist_ok=True)
    with redirect_stdout_to_stderr():
        r = run_fit(src, output=os.path.join(out, 'fitted.py'), target=(req.get('description') or '').strip() or None, verbose=False)
    q = r.get('quality') or {}
    wav = (r.get('files') or {}).get('wav')
    if not wav or not os.path.isfile(wav):
        raise Refusal('The fit rendered no sound.')
    lens = q.get('len_s') or (None, None)
    return {'file': wav, 'quality': {'melDb': q.get('mel_db'), 'envCorr': q.get('env_corr'), 'toneDb': q.get('tone_db'),
                                     'levelDb': q.get('level_db'), 'onsetErr': q.get('onset_err'), 'seconds': list(lens),
                                     'fitKind': r.get('chosen') or r.get('kind')},
            'summary': f"Fitted as {r.get('kind')} ({r.get('chosen')}): mel distance {q.get('mel_db')} dB, envelope correlation "
                       f"{q.get('env_corr')}, tonal balance {q.get('tone_db')} dB off, level {q.get('level_db')} dB."}


def doctor(_req):
    """earshot's own check of its install, short and without paths"""
    from earshot import doctor as d
    with redirect_stdout_to_stderr():
        r = d.check(load=False)
    cached = r.get('models_cached') or {}
    return {'summary': named(r.get('summary'), []), 'problems': [named(p, []) for p in (r.get('problems') or [])][:8],
            'notes': [named(n, []) for n in (r.get('notes') or [])][:8], 'modelsCached': bool(cached) and all(cached.values()),
            'bank': (r.get('bank') or {}).get('version'), 'realness': bool((r.get('data_files') or {}).get('realness_model.json'))}


def redirect_stdout_to_stderr():
    """earshot's own prints go to stderr: stdout carries only the answer"""
    import contextlib
    return contextlib.redirect_stdout(sys.stderr)


if __name__ == '__main__':
    try:
        print(json.dumps(main(), default=lambda o: o.item() if hasattr(o, 'item') else str(o)))
    except SystemExit:
        raise
    except Refusal as ex:
        print(json.dumps({'error': str(ex)}))
        sys.exit(1)
    except Exception as ex:  # noqa: BLE001
        print(json.dumps({'error': f'{type(ex).__name__}: {ex}'}))
        sys.exit(1)
