// The director pass: from a raw multi-camera take to a cut you only tweak. It reads the words (where sentences end and
// breaths fall), where you are facing in each camera (face-track, macOS Vision), and what you did on screen (clicks,
// typing, slide changes), then picks a picture for each stretch with editor's rules: switch on sentence boundaries,
// prefer the camera you face, keep shots between a minimum and maximum length, never two cuts within a second, go to
// the screen when you work in it. False starts (a line started again) and dead air are cut first. Every chosen shot
// carries its reason. Browser-safe: no Node imports.
import type { EditorProject } from './contracts';
import { setShotRange, syncedTake, availableShotSources, isCameraSource, slideForClipFrame, type ShotSource } from './shots';
import { scheduleProject, sourceTimeSeconds, projectDuration, type ScheduledClip } from './timeline';
import { deleteTimelineRanges, transcriptWords } from './transcript';
import { beatEnd } from './storyboard';

export type Face = { x: number; y: number; w: number; h: number; yaw?: number; pitch?: number; confidence: number };
export type FaceSample = { t: number; faces: Face[] };
/** Face samples per camera recording (asset id), on that recording's own clock (seconds). */
export type FaceTracks = Record<string, FaceSample[]>;
export type DirectorOptions = { minShot?: number; maxShot?: number; minGap?: number; cutDeadAir?: boolean; deadAir?: number; falseStarts?: boolean; screen?: boolean };
export type DirectorShot = { from: number; to: number; main: ShotSource; reason: string };
export type DirectorReport = { removed: { from: number; to: number; why: string }[]; shots: DirectorShot[]; medianShot: number; cutsPerMinute: number; seconds: number };

const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9' ]/g, '').trim();
type Sentence = { from: number; to: number; text: string; words: number; rows: { from: number; to: number; text: string }[] };

/** Sentences on the timeline: end at . ! ? or a pause over 0.35 s. */
export function timelineSentences(project: EditorProject): Sentence[] {
  const fps = project.output.fps, rows = transcriptWords(project).filter(w => w.timingReliable && w.sourceKind === 'clip').sort((a, b) => a.startFrame - b.startFrame);
  const out: Sentence[] = []; let cur: typeof rows = [];
  const flush = () => { if (cur.length) out.push({ from: cur[0]!.startFrame, to: cur.at(-1)!.endFrame, text: cur.map(w => w.text).join(' '), words: cur.length, rows: cur.map(w => ({ from: w.startFrame, to: w.endFrame, text: w.text })) }); cur = []; };
  rows.forEach((w, i) => { cur.push(w); const next = rows[i + 1]; if (/[.!?…]["”')\]]*$/.test(w.text) || (next && next.startFrame - w.endFrame > 0.35 * fps)) flush(); });
  flush(); return out;
}

/** Stretches to remove: a line started again (keep the last try) and silences longer than `deadAir` seconds. */
export function cleanupRanges(project: EditorProject, sentences: Sentence[], options: DirectorOptions) {
  const fps = project.output.fps, out: { from: number; to: number; why: string }[] = [];
  if (options.falseStarts !== false) sentences.forEach(s => {
    // A restart inside one breath: the opening words come again ("Notes and follow… Notes and follow-ups").
    const words = s.rows.map(r => norm(r.text)); if (words.length < 4) return;
    for (let k = 2; k <= Math.min(4, words.length / 2); k++) { const head = words.slice(0, k).join(' ');
      for (let j = k; j + k <= words.length; j++) if (words.slice(j, j + k).join(' ') === head) { out.push({ from: s.rows[0]!.from, to: s.rows[j]!.from, why: `false start: “${s.rows.slice(0, j).map(r => r.text).join(' ')}” said again` }); return; } }
  });
  if (options.falseStarts !== false) sentences.forEach((s, i) => {
    const head = norm(s.text).split(' ').slice(0, 3).join(' '); if (head.split(' ').length < 2) return;
    const again = sentences.slice(i + 1, i + 4).find(t => norm(t.text).startsWith(head));
    if (again) out.push({ from: s.from, to: again.from, why: `false start: “${s.text.slice(0, 40)}” said again` });
  });
  if (options.cutDeadAir !== false) { const gap = (options.deadAir ?? 0.8) * fps, keep = Math.round(0.25 * fps);
    sentences.forEach((s, i) => { const next = sentences[i + 1]; if (next && next.from - s.to > gap) out.push({ from: s.to + keep, to: next.from - keep, why: `${((next.from - s.to) / fps).toFixed(1)} s of silence` }); }); }
  const lockedRanges = (project.storyboard?.beats ?? []).filter(b => b.locked).map(b => [b.startFrame, beatEnd(b)] as const);
  return out.filter(r => r.to > r.from && !lockedRanges.some(([a, b]) => r.from < b && r.to > a)).sort((a, b) => a.from - b.from);
}

function faceAt(samples: FaceSample[] | undefined, t: number) {
  if (!samples?.length) return null; let lo = 0, hi = samples.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (samples[mid]!.t < t) lo = mid + 1; else hi = mid; }
  const near = [samples[lo], samples[lo - 1]].filter(Boolean).sort((a, b) => Math.abs(a!.t - t) - Math.abs(b!.t - t))[0]!;
  return Math.abs(near.t - t) > 1.5 ? null : near;
}
/** How well a camera shows you over a stretch: you're in it, turned toward it, and big enough. 0–1. */
export function cameraScore(project: EditorProject, faces: FaceTracks, camera: ShotSource, from: number, to: number, schedule = scheduleProject(project)) {
  const fps = project.output.fps, step = Math.max(1, Math.round(fps * 0.25)); let total = 0, n = 0;
  for (let f = from; f < to; f += step) { const s = schedule.find(x => f >= x.startFrame && f < x.startFrame + x.durationFrames); if (!s) continue; n++;
    const take = syncedTake(project, camera, s.asset.id); if (!take) continue;
    const sample = faceAt(faces[take.assetId], sourceTimeSeconds(s.clip, s.asset, f - s.startFrame, fps) - take.offsetSeconds);
    const face = sample?.faces.filter(x => x.confidence > 0.4).sort((a, b) => b.h - a.h)[0]; if (!face) continue;
    total += 0.65 * (1 - Math.min(1, Math.abs(face.yaw ?? 0.6) / 0.9)) + 0.35 * Math.min(1, face.h / 0.3); }
  return n ? total / n : 0;
}
/** Working on the screen in this stretch (a click, typing, or a slide change)? */
function screenActivity(project: EditorProject, s: ScheduledClip, from: number, to: number) {
  const fps = project.output.fps, t0 = sourceTimeSeconds(s.clip, s.asset, Math.max(0, from - s.startFrame), fps) * 1000, t1 = sourceTimeSeconds(s.clip, s.asset, Math.max(0, to - s.startFrame), fps) * 1000;
  const acts = (s.asset.trace?.actions ?? []).filter(a => (a.kind === 'click' || a.kind === 'type') && a.t >= t0 && a.t < t1);
  if (acts.length) return acts[0]!.kind === 'type' ? 'typing on screen' : 'click on screen';
  if (project.slideDeck) { const a = slideForClipFrame(project, s, Math.max(0, from - s.startFrame)), b = slideForClipFrame(project, s, Math.max(0, to - 1 - s.startFrame)); if (a && b && a.page !== b.page) return 'slide changes'; }
  return null;
}

/** Choose the shots. Returns the plan; applyDirector writes it. */
export function planShots(project: EditorProject, faces: FaceTracks, options: DirectorOptions = {}): DirectorShot[] {
  const fps = project.output.fps, total = projectDuration(project), schedule = scheduleProject(project);
  const minShot = (options.minShot ?? 2.2) * fps, maxShot = (options.maxShot ?? 8) * fps, minGap = (options.minGap ?? 1) * fps;
  const cameras = availableShotSources(project).filter(id => isCameraSource(project, id));
  const sentences = timelineSentences(project);
  // Cut points: sentence starts (picture leads the voice by 2 frames), plus the edges of each recorded clip.
  const starts = [0, ...sentences.map(s => Math.max(0, s.from - 2))].filter((f, i, a) => i === 0 || f - a[i - 1]! >= 1);
  const units = starts.map((from, i) => ({ from, to: i + 1 < starts.length ? starts[i + 1]! : total })).filter(u => u.to > u.from);
  const locked = (project.storyboard?.beats ?? []).filter(b => b.locked);
  const shots: DirectorShot[] = [];
  for (const unit of units) {
    const s = schedule.find(x => unit.from >= x.startFrame && unit.from < x.startFrame + x.durationFrames); if (!s) continue;
    if (locked.some(b => unit.from >= b.startFrame && unit.from < beatEnd(b))) continue;
    const here = cameras.filter(c => syncedTake(project, c, s.asset.id));
    const work = options.screen !== false ? screenActivity(project, s, unit.from, unit.to) : null;
    const beat = project.storyboard?.beats.find(b => unit.from >= b.startFrame && unit.from < beatEnd(b));
    let pick: { main: ShotSource; reason: string };
    if (work) pick = { main: work === 'slide changes' ? 'slides' : 'screen', reason: work };
    else if (!here.length) pick = { main: 'screen', reason: 'no camera in this take' };
    else {
      const scored = here.map(c => ({ c, score: cameraScore(project, faces, c, unit.from, unit.to, schedule) + (beat && beatCamera(project, beat.source) === c ? 0.15 : 0) })).sort((a, b) => b.score - a.score);
      const last = shots.at(-1), current = last && here.includes(last.main) ? scored.find(x => x.c === last.main) : undefined, best = scored[0]!;
      const runFrom = runStart(shots), held = last ? unit.from - runFrom : Infinity;
      if (current && best.c !== current.c && (held < minShot || held < minGap || best.score - current.score < 0.12) && held < maxShot) pick = { main: current.c, reason: last!.reason };
      else if (current && held >= maxShot && best.c === current.c && scored[1] && scored[1].score > 0.2) pick = { main: scored[1].c, reason: `held ${(held / fps).toFixed(0)} s: change of angle` };
      else pick = { main: best.c, reason: best.score > 0.2 ? `facing ${cameraName(project, best.c)}` : `best view of you (${cameraName(project, best.c)})` };
    }
    const last = shots.at(-1);
    if (last && last.main === pick.main) last.to = unit.to; else shots.push({ from: unit.from, to: unit.to, ...pick });
  }
  // Too-short shots merge into their neighbour (except screen moments, which are short on purpose).
  for (let i = 1; i < shots.length; i++) { const s = shots[i]!; if (s.to - s.from < minGap && s.main !== 'screen' && s.main !== 'slides') { shots[i - 1]!.to = s.to; shots.splice(i, 1); i--; } }
  return shots;
}
const runStart = (shots: DirectorShot[]) => shots.at(-1)?.from ?? 0;
function beatCamera(project: EditorProject, source: string): ShotSource | null {
  if (source === 'camera:A') return project.presenterTrack ? 'camera' : null;
  if (!source.startsWith('camera:')) return null;
  const cams = (project.sources ?? []).filter(s => s.kind === 'camera'); return cams['BCD'.indexOf(source.slice(7))]?.id ?? null;
}
const cameraName = (project: EditorProject, id: ShotSource) => id === 'camera' ? 'the main camera' : project.sources?.find(s => s.id === id)?.name ?? id;

/** Run the pass: clean up, then choose and write the shots. */
export function applyDirector(project: EditorProject, faces: FaceTracks, options: DirectorOptions = {}): { project: EditorProject; report: DirectorReport } {
  const fps = project.output.fps;
  const removed = cleanupRanges(project, timelineSentences(project), options);
  let next = removed.length ? deleteTimelineRanges(project, removed.map(r => ({ startFrame: r.from, endFrame: r.to }))) : project;
  const shots = planShots(next, faces, options);
  for (const shot of shots) next = setShotRange(next, shot.from, shot.to, { main: shot.main, bubble: false, reason: shot.reason });
  const lengths = shots.map(s => (s.to - s.from) / fps).sort((a, b) => a - b), seconds = projectDuration(next) / fps;
  return { project: next, report: { removed: removed.map(r => ({ from: +(r.from / fps).toFixed(2), to: +(r.to / fps).toFixed(2), why: r.why })), shots: shots.map(s => ({ ...s, from: +(s.from / fps).toFixed(2), to: +(s.to / fps).toFixed(2) })),
    medianShot: +(lengths[Math.floor(lengths.length / 2)] ?? 0).toFixed(2), cutsPerMinute: +(Math.max(0, shots.length - 1) / Math.max(1 / 60, seconds / 60)).toFixed(1), seconds: +seconds.toFixed(2) } };
}
