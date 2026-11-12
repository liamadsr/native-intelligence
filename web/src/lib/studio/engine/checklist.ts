// The revision checklist the assistant runs before handing a cut to the person (and the person can run any time):
// what's still missing, what would read badly, and how the cut compares with its reference. Each check says what to do.
import type { EditorProject } from './contracts';
import type { FaceTracks } from './director';
import type { VisualReport } from './server-types';
import { shotSegments, syncedTake, isCameraSource } from './shots';
import { scheduleProject, sourceTimeSeconds, projectDuration } from './timeline';
import { beatEnd, isPlaceholder, wordBudget, wordCount } from './storyboard';

export type Check = { check: string; ok: boolean; detail: string; at?: number };
const sec = (f: number, fps: number) => +(f / fps).toFixed(1);

export function checklist(project: EditorProject, options: { faces?: FaceTracks; reference?: { medianShot: number; cutsPerMinute: number }; visual?: VisualReport | null } = {}): Check[] {
  const fps = project.output.fps, out: Check[] = [], beats = project.storyboard?.beats ?? [], layers = project.layers ?? [];
  const add = (check: string, problems: { detail: string; at?: number }[], okDetail: string) => {
    if (!problems.length) out.push({ check, ok: true, detail: okDetail }); else for (const p of problems.slice(0, 8)) out.push({ check, ok: false, ...p }); };
  add('Takes', beats.filter(isPlaceholder).map(b => ({ detail: `${b.label ?? b.id} still needs its take: select it on the Storyboard track and Record`, at: sec(b.startFrame, fps) })), 'every beat that needs you has its take');
  add('Generated shots', beats.flatMap(b => { const g = b.generation; if (!g) return [];
    if (g.stage === 'still') return [{ detail: `${b.label ?? b.id}: the still is waiting for your OK`, at: sec(b.startFrame, fps) }];
    if (g.stage === 'clip') return [{ detail: `${b.label ?? b.id}: draft clip on the timeline; run the final once the prompt is settled`, at: sec(b.startFrame, fps) }];
    if (b.source === 'generated' && !g.clipAssetId) return [{ detail: `${b.label ?? b.id}: no generated clip yet`, at: sec(b.startFrame, fps) }]; return []; }), 'all generated shots are finals');
  add('Words fit', beats.filter(b => b.status === 'planned').flatMap(b => { const w = wordBudget(b, fps); return w.over > 1 ? [{ detail: `${b.label ?? b.id}: ${w.words} words in ${sec(b.durationFrames, fps)} s (about ${w.budget} fit); it will feel rushed`, at: sec(b.startFrame, fps) }] : []; }), 'every line fits its beat');
  // Text on screen long enough to read (≈3 words/s + 0.5 s) and big enough (≥3% of the frame height).
  add('Readable text', layers.flatMap(l => { const text = l.style.text ?? l.style.items?.join(' ') ?? l.style.title ?? ''; const n = wordCount(text); if (!n) return [];
    const shown = (l.endFrame - l.startFrame) / fps, need = n / 3 + 0.5, issues = [];
    if (!l.style.wordFrames && shown < need) issues.push({ detail: `“${text.slice(0, 40)}” is on screen ${shown.toFixed(1)} s; ${n} words need about ${need.toFixed(1)} s`, at: sec(l.startFrame, fps) });
    if (l.kind === 'text' && (l.style.size ?? 0.06) < 0.03) issues.push({ detail: `“${text.slice(0, 40)}” is small (${Math.round((l.style.size ?? 0) * 1000) / 10}% of the height); 3%+ reads on a phone`, at: sec(l.startFrame, fps) });
    return issues; }), 'all text is on long enough and big enough');
  // Full-frame layers that pop on or off in under 3 frames read as a flash.
  add('No flashes', layers.flatMap(l => l.width >= 0.95 && l.height >= 0.95 && !l.behind && (l.enter.preset === 'none' || l.enter.frames < 3) && (l.endFrame - l.startFrame) < 0.4 * fps
    ? [{ detail: `${l.name} fills the frame for ${sec(l.endFrame - l.startFrame, fps)} s with no ease: a flash`, at: sec(l.startFrame, fps) }] : []), 'no full-screen flashes');
  // Nothing covers the speaker's face in camera shots (layers marked behind sit under the cut-out, so they're fine).
  if (options.faces) { const schedule = scheduleProject(project), hits: { detail: string; at: number }[] = [];
    for (const seg of shotSegments(project)) { if (!isCameraSource(project, seg.view.main)) continue;
      for (let f = seg.from; f < seg.to; f += Math.round(fps / 2)) { const s = schedule.find(x => f >= x.startFrame && f < x.startFrame + x.durationFrames); if (!s) continue;
        const take = syncedTake(project, seg.view.main, s.asset.id); if (!take) continue; const t = sourceTimeSeconds(s.clip, s.asset, f - s.startFrame, fps) - take.offsetSeconds;
        const face = options.faces[take.assetId]?.reduce<{ t: number; faces: { x: number; y: number; w: number; h: number }[] } | null>((best, x) => !best || Math.abs(x.t - t) < Math.abs(best.t - t) ? x : best, null)?.faces[0]; if (!face) continue;
        for (const l of layers) { if (l.behind || f < l.startFrame || f >= l.endFrame || (l.width >= 0.95 && l.height >= 0.95)) continue;
          const lx = l.x - l.width / 2, ly = l.y - (l.height ?? 0.2) / 2, ix = Math.max(0, Math.min(lx + l.width, face.x + face.w) - Math.max(lx, face.x)), iy = Math.max(0, Math.min(ly + (l.height ?? 0.2), face.y + face.h) - Math.max(ly, face.y));
          if (ix * iy > 0.3 * face.w * face.h && !hits.some(h => h.detail.startsWith(l.name))) hits.push({ detail: `${l.name} covers your face at ${sec(f, fps)} s; move it aside or mark it behind (cut-out)`, at: sec(f, fps) }); } } }
    add('Face clear', hits, 'nothing covers your face'); }
  // The visual check measured the rendered frames: overlays on the person, text people can read.
  const visual = options.visual, round1 = (n: number) => Math.round(n * 10) / 10;
  if (visual) {
    add('Clear of you', visual.issues.filter(i => i.kind === 'covers-face' || i.kind === 'covers-person').map(i => ({ detail: `${i.name} ${i.detail} (${round1(i.from)}–${round1(i.to)} s)`, at: round1(i.from) })), 'no overlay lands on you (measured on the rendered frames)');
    add('Text legible', visual.issues.filter(i => i.kind === 'low-contrast' || i.kind === 'small-text' || i.kind === 'off-frame').map(i => ({ detail: `“${i.name}” ${i.detail}`, at: round1(i.from) })), 'every text has contrast and size to read (measured)');
  } else if (visual === null) out.push({ check: 'Visual check', ok: false, detail: 'not measured on this version yet: check stills of it for anything covering a face and for text too small to read' });
  // Rhythm against the reference film.
  if (options.reference) { const shots = shotSegments(project).map(s => (s.to - s.from) / fps).sort((a, b) => a - b), median = shots[Math.floor(shots.length / 2)] ?? 0, perMin = Math.max(0, shots.length - 1) / (projectDuration(project) / fps / 60);
    const off = (a: number, b: number) => b > 0 && (a / b > 1.6 || a / b < 0.6);
    add('Rhythm', off(perMin, options.reference.cutsPerMinute) ? [{ detail: `${perMin.toFixed(1)} cuts a minute against the reference's ${options.reference.cutsPerMinute}; median shot ${median.toFixed(1)} s vs ${options.reference.medianShot} s` }] : [], `cut rhythm close to the reference (${perMin.toFixed(1)}/min vs ${options.reference.cutsPerMinute})`); }
  // Sound: a music bed and loudness mastering on export.
  add('Sound', [...(project.audioTracks.some(t => t.role === 'music' && t.segments.length) ? [] : [{ detail: 'no music bed: add music on a music track' }]),
    ...(project.master ? [] : [{ detail: 'not mastered for the web: set a loudness target (-14 LUFS)' }])], 'music bed and mastering set');
  return out;
}
