// Sound design for the timeline: the picture's cue sheet (what moves on which frame) and placing rendered sound
// effects on the Sound effects track. Rendering and listening run in earshot (scripts/earshot_bridge.py, sound-server.ts).
import type { EditorProject, EditorAsset } from './contracts';
import { lanePoints } from './automation';
import { scheduleProject } from './timeline';
import { countProgress, typedLength, markup, iconTimes, type EditorLayer } from './layers';
import { particleTrips, type ParticleForm } from './particles';

/** One moment that wants a sound. kind = an earshot kit role (pop, land, whoosh.short, whoosh.long, hit, tick, tock,
 *  click, click.confirm, text, swell, riser, bell, key, snap, drop) or any word with `sound` set. t in seconds. */
export type SoundCue = { id: string; t: number; kind: string; sound?: string; pitch?: string; dur?: number; apex?: number; weight?: number; level_db?: number; over_bed_db?: number; label: string };

const AUTO = 'auto:';
/** Notes in a row climb a major-pentatonic run (D E G A B D), like a little melody building. */
const NOTE_RUN = ['D5', 'E5', 'G5', 'A5', 'B5', 'D6', 'E6'];
const round = (v: number) => Math.round(v * 1000) / 1000;

/** Keep a run playable: no two sounds closer than `gap` seconds (a key run ~11 a second, ticks ~14). */
function spaced<T extends { t: number }>(cues: T[], gap: number) { const out: T[] = []; for (const c of cues) if (!out.length || c.t - out.at(-1)!.t >= gap) out.push(c); return out; }

/** Key presses while a notification / card message types itself: a key each time characters appear (a softer
 *  thock on a space), spaced like real typing. */
const MAX_TYPING = 5;
function typingCues(layer: EditorLayer, fps: number): Omit<SoundCue, 'id'>[] {
  const text = layer.style.text ?? '', out: Omit<SoundCue, 'id'>[] = [];
  let shown = 0;
  for (let f = layer.startFrame; f < layer.endFrame && shown < text.length; f++) {
    const n = typedLength(text.length, layer, f, fps); if (n <= shown) continue;
    const chars = text.slice(shown, n); shown = n;
    out.push({ t: round(f / fps), kind: chars.trim() ? 'key' : 'key.space', weight: 0.4, label: `typing · ${layer.name}` });
  }
  // A hint of typing, not a key per character: a few soft taps, then the eye takes over.
  return spaced(out, 0.16).slice(0, MAX_TYPING);
}

/** A counting number flips like a mechanical counter: a tick each time the number on screen changes (rapid while it
 *  races, slowing as it settles; never closer than 50 ms), and a firmer tock on the frame it lands on its value. */
function countingCues(layer: EditorLayer, fps: number): Omit<SoundCue, 'id'>[] {
  const from = layer.style.countFrom; if (from === undefined) return [];
  const match = (layer.style.text ?? '').match(/\d[\d,]*(?:\.\d+)?/); if (!match) return [];
  const target = Number(match[0].replace(/,/g, '')), decimals = match[0].split('.')[1]?.length ?? 0;
  const shown = (f: number) => (from + (target - from) * countProgress(layer, f)).toFixed(decimals);
  const ticks: Omit<SoundCue, 'id'>[] = [], final = target.toFixed(decimals);
  let last = shown(layer.startFrame - 1), landed: number | null = null;
  for (let f = layer.startFrame; f < layer.endFrame; f++) {
    const now = shown(f); if (now === last) continue; last = now;
    if (now === final) { landed = f; break; }
    ticks.push({ t: round(f / fps), kind: 'tick.crisp', over_bed_db: 10, label: `counting · ${layer.name}` });
  }
  const out = spaced(ticks, 0.05);
  if (landed === null) return out;
  const t = round(landed / fps);
  return [...out.filter(c => t - c.t >= 0.06), { t, kind: 'tock', over_bed_db: 11, label: `count lands · ${layer.name}` }];
}

/** What a layer's entrance sounds like, and when (frames after its start: the moment the eye reads it land). */
function layerCues(layer: EditorLayer, fps: number): Omit<SoundCue, 'id'>[] {
  const s = layer.style, enter = layer.enter, at = (frames: number) => round((layer.startFrame + frames) / fps), label = layer.name;
  if (layer.track === 'captions') return s.font === 'heavy' ? [{ t: at(1), kind: 'tock', weight: 0.6, label: `caption · ${label}` }] : [];
  switch (layer.kind) {
    case 'background': return [{ t: at(Math.min(enter.frames, 6) * 0.5), kind: enter.preset === 'zoom-blur' || enter.preset === 'blur' ? 'swell' : 'whoosh.short', label: 'title beat' }];
    case 'notification': return [{ t: at(enter.frames * 0.4), kind: 'click.confirm', label: `notification · ${s.app ?? label}` }, ...typingCues(layer, fps)];
    case 'card': return [{ t: at(enter.frames * 0.6), kind: 'land', label: 'card lands' }, ...typingCues(layer, fps)];
    case 'chips': return (s.items ?? []).map((item, i) => ({ t: at(i * (s.stagger ?? 9) + 2), kind: 'pop', weight: 0.8, label: `chip · ${item}` }));
    case 'particles': { const t0 = layer.startFrame / fps, forms = (s.forms ?? []) as ParticleForm[];
      return particleTrips(forms).flatMap<Omit<SoundCue, 'id'>>(trip => { const f = forms[trip.index]!, prev = forms[trip.index - 1]!, name = `dots → ${trip.shape} · ${label}`;
        if ((f.opacity ?? 1) < 0.05 && (prev.opacity ?? 1) < 0.05) return [];
        if ((f.opacity ?? 1) < 0.05) return [{ t: round(t0 + trip.peak), kind: 'whoosh.short', weight: 0.45, label: `dots fade · ${label}` }];
        switch (trip.shape) {
          case 'bars': return [{ t: round(t0 + trip.at), kind: 'swell', weight: 0.7, label: name }];
          case 'ring': return [{ t: round(t0 + trip.at), kind: 'riser', dur: round(Math.max(0.4, (f.stagger ?? 0.2) + trip.duration * 0.8)), weight: 0.8, label: name }];
          case 'points': return [{ t: round(t0 + trip.settle), kind: 'pop', weight: 0.7, label: name }];
          case 'point': return [{ t: round(t0 + trip.peak), kind: 'whoosh.short', weight: 0.6, label: name }];
          default: return [{ t: round(t0 + trip.peak), kind: 'whoosh.short', weight: 0.75, label: name }];
        } }); }
    case 'waveform': return [{ t: at(1), kind: 'swell', weight: 0.7, label: 'waveform grows' }];
    case 'ring': return [{ t: at(0), kind: 'riser', dur: round(Math.max(0.4, enter.frames / fps)), weight: 0.8, label: 'ring draws in' },
      { t: at(enter.frames), kind: 'bell', sound: 'mallet/glock', pitch: 'A5', label: 'ring closes' }];
    case 'icons': { let note = 0;
      return (s.items ?? []).flatMap<Omit<SoundCue, 'id'>>((item, i) => { const { appear, act } = iconTimes(layer, i, fps), t0 = round((appear + 2) / fps), t1 = round(act / fps), name = `${item} · ${label}`;
        switch (item) {
          case 'note': return [{ t: t0, kind: 'bell', sound: 'mallet/glock', pitch: NOTE_RUN[note++ % NOTE_RUN.length], over_bed_db: 8, label: `note · ${label}` }];
          case 'key': return [{ t: t0, kind: 'key', sound: 'fit/key/thock', weight: 1.2, over_bed_db: 10, label: name }];
          case 'toggle': return [{ t: t0, kind: 'pop', weight: 0.7, label: name }, { t: t1, kind: 'click', sound: 'toggle/on', over_bed_db: 10, label: `toggle switches · ${label}` }];
          case 'bubbles': return [{ t: t0, kind: 'pop', weight: 0.7, label: name }, { t: t1, kind: 'pop', sound: 'drip/bubble', over_bed_db: 10, label: `bubbles burst · ${label}` }];
          case 'dash': return [{ t: t0, kind: 'pop', weight: 0.6, label: name }, { t: t1, kind: 'whoosh.short', label: `dash flies · ${label}` }];
          case 'mark': case 'spark': return [{ t: t0, kind: 'bell', label: name }];
          default: return [{ t: t0, kind: 'pop', weight: 0.8, label: name }];
        } }); }
    case 'image': return [{ t: at(enter.frames * 0.5), kind: 'pop', label: 'image pops in' }];
    case 'arrow': case 'box': case 'highlight': return [{ t: at(2), kind: 'tick', label: `${layer.kind} appears` }];
    case 'spotlight': return [{ t: at(1), kind: 'swell', weight: 0.6, label: 'spotlight' }];
    case 'text': {
      const p = enter.preset;
      if (p === 'streak' || p === 'scatter') return [{ t: at(enter.frames * 0.35), kind: 'whoosh.short', label: `title flies in · ${label}` }, ...countingCues(layer, fps)];
      // A counting number speaks through its ticks: no extra landing thump on top of them.
      if (p === 'zoom-blur' || p === 'drop') return s.countFrom !== undefined ? countingCues(layer, fps) : [{ t: at(enter.frames * 0.55), kind: 'land', label: `title lands · ${label}` }];
      if (p === 'pop' || p === 'zoom') return [{ t: at(enter.frames * 0.5), kind: 'pop', label: `text pops · ${label}` }, ...countingCues(layer, fps)];
      if (p === 'typewriter') { const text = markup(s.text ?? '').plain.slice(0, 60);
        return spaced([...text].map((ch, i) => ({ ch, i })).filter(({ ch }) => ch.trim()).map(({ i }) => ({ t: at(i * enter.frames / Math.max(1, text.length)), kind: 'key', weight: 0.35, label: 'typing' })), 0.16).slice(0, MAX_TYPING); }
      if (p === 'none') return countingCues(layer, fps);
      return [{ t: at(2), kind: 'text', label: `text · ${label}` }, ...countingCues(layer, fps)];
    }
    default: return [];
  }
}

/** Transitions are automation on the picture: find whips/pushes (a held jump in slide), punches (a fast zoom spike),
 *  tilt-ins (a big tilt settling to flat) and defocus blurs. */
function automationCues(project: EditorProject): Omit<SoundCue, 'id'>[] {
  const fps = project.output.fps, out: Omit<SoundCue, 'id'>[] = [];
  for (const param of ['shiftX', 'shiftY'] as const) for (const p of lanePoints(project, param)) if (p.curve === 'hold') out.push({ t: round(p.frame / fps), kind: 'whoosh.short', label: param === 'shiftX' ? 'whip / push' : 'vertical whip' });
  const zoom = lanePoints(project, 'zoom');
  zoom.forEach((p, i) => { const prev = zoom[i - 1], next = zoom[i + 1];
    if (prev && next && p.value > prev.value * 1.12 && p.value > next.value * 1.08 && p.frame - prev.frame <= fps * 0.25) out.push({ t: round(p.frame / fps), kind: 'hit', label: 'zoom punch' }); });
  for (const param of ['tiltX', 'tiltY'] as const) { const pts = lanePoints(project, param);
    pts.forEach((p, i) => { const next = pts[i + 1]; if (Math.abs(p.value) >= 12 && next && Math.abs(next.value) < 2) out.push({ t: round(p.frame / fps), kind: 'whoosh.long', label: 'tilt-in reveal' }); }); }
  const blur = lanePoints(project, 'blur'), whips = out.map(c => c.t);
  blur.forEach((p, i) => { const prev = blur[i - 1], next = blur[i + 1];
    if (p.value >= 20 && prev && next && prev.value < p.value && next.value < p.value && !whips.some(t => Math.abs(t - p.frame / fps) < 0.2)) out.push({ t: round(p.frame / fps), kind: 'whoosh.short', weight: 0.7, label: 'defocus' }); });
  return out;
}

/** Clicks recorded in the screen take, at their timeline time. */
export function clickCues(project: EditorProject): Omit<SoundCue, 'id'>[] {
  const fps = project.output.fps;
  return scheduleProject(project).flatMap(s => (s.asset.trace?.actions ?? []).flatMap(action => {
    if (action.kind !== 'click' || !s.asset.sourceFps) return [];
    const sourceFrame = action.t / 1000 * s.asset.sourceFps; if (sourceFrame < s.clip.trimStartSourceFrame || sourceFrame >= s.clip.trimEndSourceFrame) return [];
    return [{ t: round((s.startFrame + (sourceFrame - s.clip.trimStartSourceFrame) / s.asset.sourceFps * fps / s.clip.playbackRate) / fps), kind: 'click', label: `click${action.label ? ` · ${action.label}` : ''}` }];
  }));
}

/** The picture's cue sheet: every moment the automatic sound pass gives a sound, in time order, with stable ids. */
export function soundCues(project: EditorProject, options: { from?: number; to?: number; clicks?: boolean; captions?: boolean } = {}): SoundCue[] {
  const fps = project.output.fps;
  const raw = [
    ...(project.layers ?? []).filter(layer => options.captions !== false || layer.track !== 'captions').flatMap(layer => layerCues(layer, fps).map((cue, i) => ({ ...cue, id: `${AUTO}${layer.id}:${i}` }))),
    ...automationCues(project).map((cue, i) => ({ ...cue, id: `${AUTO}fx:${i}` })),
    ...(options.clicks === false ? [] : clickCues(project).map((cue, i) => ({ ...cue, id: `${AUTO}click:${i}` }))),
  ];
  const total = scheduleProject(project).reduce((end, s) => Math.max(end, s.startFrame + s.durationFrames), 0) / fps;
  const sorted = raw.filter(cue => cue.t >= (options.from ?? 0) && cue.t <= (options.to ?? total) && cue.t < total).sort((a, b) => a.t - b.t);
  return thin(sorted);
}

const family = (kind: string) => kind.split('.')[0]!;
const swooshy = new Set(['whoosh', 'swell', 'riser']);
/** One gesture at a time (earshot's launch-film rule): a title beat's backdrop stays silent when its title or a
 *  transition already sounds within 0.35 s, and two whoosh-like sounds never stack within 0.3 s (the first, or the
 *  bigger one, keeps it). Runs of pops / keys / ticks are left to the kit's own spacing. */
export function thin(cues: SoundCue[]): SoundCue[] {
  const beat = (c: SoundCue) => c.label === 'title beat';
  let out = cues.filter(c => !(beat(c) && cues.some(o => o !== c && !beat(o) && Math.abs(o.t - c.t) <= 0.35)));
  const kept: SoundCue[] = [];
  for (const c of out) {
    const clash = kept.find(k => swooshy.has(family(k.kind)) && swooshy.has(family(c.kind)) && Math.abs(k.t - c.t) < 0.3);
    if (!clash) { kept.push(c); continue; }
    if (c.kind === 'whoosh.long' && clash.kind !== 'whoosh.long') kept[kept.indexOf(clash)] = c;
  }
  out = kept;
  return out;
}

/** earshot's cue-file format (the contract its timeline / critique / sheet check sync against). */
export function earshotCueFile(project: EditorProject, cues = soundCues(project)) {
  const fps = project.output.fps;
  return { fps, total: Math.round(scheduleProject(project).reduce((end, s) => Math.max(end, s.startFrame + s.durationFrames), 0)),
    events: cues.map(cue => ({ f: Math.round(cue.t * fps * 100) / 100, kind: cue.kind.split('.')[0], id: cue.id, weight: cue.weight ?? 1, ...(cue.dur ? { dur: Math.round(cue.dur * fps) } : {}) })) };
}

/** Bank sounds never to use, and what plays instead. ui_pop/soft reads as the macOS "not allowed" error, not a success. */
export const bannedSounds: Record<string, string> = { 'ui_pop/soft': 'pro_pop_in/round' };

export const SFX_TRACK = 'sfx', MUSIC_TRACK = 'music';

/** A music bed on the Music track from `at` to the end of the video (the take already faded out at the end). */
export function placeMusic(project: EditorProject, asset: EditorAsset, at: number, label: string): EditorProject {
  const fps = project.output.fps, total = scheduleProject(project).reduce((end, s) => Math.max(end, s.startFrame + s.durationFrames), 0) / fps;
  const length = Math.min(asset.durationSeconds ?? 0, total - at); if (length <= 0.05) throw new Error('The music starts after the video ends');
  const track = { id: MUSIC_TRACK, name: 'Music', role: 'music' as const, gain: 1, muted: false, segments: [{ id: `music-${asset.id.slice(0, 10)}`, assetId: asset.id, startFrame: Math.round(at * fps), trimStartSeconds: 0, trimEndSeconds: round(length), sound: `file:${label}`.slice(0, 200), label: label.slice(0, 200) }] };
  return { ...project, assets: project.assets.some(a => a.id === asset.id) ? project.assets : [...project.assets, asset], audioTracks: [...project.audioTracks.filter(t => t.id !== MUSIC_TRACK), track] };
}
export type PlacedSound = { cueId: string; asset: EditorAsset; startSeconds: number; trimSeconds: number; durationSeconds: number; sound: string; label: string };

/** Put rendered sounds on the Sound effects track. Sample-accurate: the start rounds up to a frame and the trim takes
 *  up the difference. replaceAuto drops the automatic pass's earlier sounds first (hand-placed ones stay). */
export function placeSounds(project: EditorProject, placed: PlacedSound[], options: { replaceAuto?: boolean; replaceIds?: string[] } = {}): EditorProject {
  const fps = project.output.fps;
  let track = project.audioTracks.find(t => t.id === SFX_TRACK) ?? { id: SFX_TRACK, name: 'Sound effects', role: 'sfx' as const, gain: 1, muted: false, segments: [] };
  const drop = new Set(options.replaceIds ?? []);
  const kept = track.segments.filter(segment => !(options.replaceAuto && segment.cue?.startsWith(AUTO)) && !(segment.cue && drop.has(segment.cue)));
  const segments = placed.map((item, i) => {
    const startFrame = Math.ceil(item.startSeconds * fps - 1e-6), trim = item.trimSeconds + (startFrame / fps - item.startSeconds);
    return { id: `sfx-${item.asset.id.slice(0, 10)}-${startFrame}-${i}`, assetId: item.asset.id, startFrame, trimStartSeconds: round(trim), trimEndSeconds: round(Math.max(trim + 0.01, item.durationSeconds)),
      sound: item.sound.slice(0, 200), cue: item.cueId.slice(0, 200), label: item.label.slice(0, 200) };
  }).filter(segment => segment.trimEndSeconds > segment.trimStartSeconds);
  track = { ...track, segments: [...kept, ...segments].sort((a, b) => a.startFrame - b.startFrame) };
  const used = new Set(track.segments.map(s => s.assetId));
  const assets = [...project.assets, ...placed.map(p => p.asset).filter((a, i, all) => !project.assets.some(x => x.id === a.id) && all.findIndex(b => b.id === a.id) === i)];
  // Drop sound assets nothing uses any more (only ones this track brought in).
  const orphan = (a: EditorAsset) => a.kind === 'audio' && !!a.provenance && (a.provenance as Record<string, unknown>).earshot === true && !used.has(a.id) && !project.audioTracks.some(t => t.id !== SFX_TRACK && t.segments.some(s => s.assetId === a.id));
  return { ...project, assets: assets.filter(a => !orphan(a)), audioTracks: [...project.audioTracks.filter(t => t.id !== SFX_TRACK), track] };
}
