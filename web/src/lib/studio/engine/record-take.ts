// Recording into placeholders: a take made for some beats of the storyboard is punched into their stretch of the
// timeline. Each beat gets its part of the take (found from the teleprompter's Next/Retake marks), earlier attempts
// of a line and the pause before the first line are cut, each beat shows its own camera or the screen, the stand-in
// layers go, and the beat's other layers (cards, product UI, the opener) stay attached to it.
import { EditorProjectSchema, type EditorLayer, type EditorProject } from './contracts';
import { punchIn } from './punch';
import { setShotRange } from './shots';
import { scheduleProject } from './timeline';
import { deleteTimelineRanges } from './transcript';
import { beatEnd, cameraSlot, slotFor, sortBeats, type Beat, type CameraSlot } from './storyboard';

/** One teleprompter mark, ms after the screen take's first frame: the line it moved to, or a retake of it. */
export type PrompterMark = { ms: number; beat?: number; retake?: number };
export type TakeInfo = { sessionId: string; at: string; screenAssetId: string; marks: PrompterMark[]; extraCameraSlots: CameraSlot[];
  /** Switching to an earlier take: keep the beat's take list as it is (the take is already in it). */
  reuse?: boolean; offsetMs?: number };

/** Where each recorded beat's kept part sits inside the take (frames from the take's start) and what was cut. */
export function beatSegments(planned: number[], marks: PrompterMark[], takeFrames: number, fps: number) {
  const f = (ms: number) => Math.max(0, Math.min(takeFrames, Math.round(ms / 1000 * fps)));
  const starts = planned.map((_, i) => { const own = marks.filter(m => m.beat === i || m.retake === i); return own.length ? { first: f(own[0]!.ms), last: f(own.at(-1)!.ms), attempts: own.filter(m => m.retake === i).length + 1 } : null; });
  const total = planned.reduce((a, b) => a + b, 0) || 1;
  // Beats with no mark (no prompter clicks) share the take in proportion to their planned length.
  let cursor = 0; const segments: { start: number; end: number; attempts: number }[] = [];
  planned.forEach((length, i) => {
    const mark = starts[i], next = starts.slice(i + 1).find(Boolean);
    const start = mark ? mark.last : i === 0 ? 0 : cursor;
    const end = next ? next.first : i === planned.length - 1 ? takeFrames : Math.min(takeFrames, start + Math.round(takeFrames * length / total));
    segments.push({ start, end: Math.max(start + 1, end), attempts: mark?.attempts ?? 1 }); cursor = Math.max(start + 1, end);
  });
  // A pause before the first line longer than ~0.3 s is cut (keep 0.15 s of breath).
  const lead = Math.max(0, segments[0]!.start - Math.round(0.15 * fps));
  if (lead > Math.round(0.3 * fps)) segments[0]!.start = lead; else segments[0]!.start = 0;
  return segments;
}

const inside = (layer: EditorLayer, from: number, to: number) => layer.startFrame >= from && layer.endFrame <= to;

export function recordIntoBeats(target: EditorProject, take: EditorProject, beatIds: string[], info: TakeInfo): EditorProject {
  const board = target.storyboard; if (!board) throw new Error('This project has no storyboard');
  const { beats: chosen, from, to } = slotFor(board, beatIds);
  const placeholders = new Set(chosen.flatMap(beat => beat.placeholders ?? []));
  // Layers fully inside the slot travel with their beat; stand-ins inside it are dropped; others are left to the edit.
  const attached: { layer: EditorLayer; beat: string; offset: number }[] = [];
  const keepLayers = (target.layers ?? []).filter(layer => {
    if (!inside(layer, from, to)) return true;
    if (!placeholders.has(layer.id)) { const overlap = (b: Beat) => Math.min(layer.endFrame, beatEnd(b)) - Math.max(layer.startFrame, b.startFrame);
      const beat = chosen.reduce((best, b) => overlap(b) > overlap(best) ? b : best, chosen[0]!);
      attached.push({ layer, beat: beat.id, offset: layer.startFrame - beat.startFrame }); }
    return false;
  });
  const others = board.beats.filter(beat => !chosen.includes(beat));
  let project: EditorProject = { ...target, layers: keepLayers, storyboard: { ...board, beats: others } };
  project = punchIn(project, take, from, to);
  const takeIds = new Set(take.clips.map(clip => `punch-${clip.id}`.slice(0, 120)));
  const placed = scheduleProject(project).filter(s => takeIds.has(s.clip.id));
  const at = placed[0]?.startFrame ?? from, length = placed.reduce((n, s) => n + s.durationFrames, 0), fps = project.output.fps;
  const segments = beatSegments(chosen.map(b => b.durationFrames), info.marks, length, fps);
  // Cut false starts and the lead-in, then lay the beats on what is left.
  const cuts: { startFrame: number; endFrame: number }[] = []; let keep = 0;
  segments.forEach(segment => { if (segment.start > keep) cuts.push({ startFrame: at + keep, endFrame: at + segment.start }); keep = segment.end; });
  if (keep < length) cuts.push({ startFrame: at + keep, endFrame: at + length });
  project = deleteTimelineRanges(project, cuts);
  let cursor = at;
  const ms = (f: number) => Math.round((info.offsetMs ?? 0) + f / fps * 1000);
  const recorded: Beat[] = chosen.map((beat, i) => { const d = segments[i]!.end - segments[i]!.start, entry = { sessionId: info.sessionId, at: info.at, screenAssetId: info.screenAssetId,
      ...(segments[i]!.attempts > 1 ? { attempts: segments[i]!.attempts } : {}), startMs: ms(segments[i]!.start), endMs: ms(segments[i]!.end) };
    const next: Beat = { ...beat, startFrame: cursor, durationFrames: d, status: 'recorded', placeholders: undefined, activeTake: info.sessionId,
      takes: info.reuse ? beat.takes : [...(beat.takes ?? []).filter(t => t.sessionId !== info.sessionId), entry] };
    delete next.placeholders; cursor += d; return next; });
  // Which picture each beat shows: camera A is the take's main camera, B/C/D the extra cameras in order, else the screen.
  const sourceFor = (beat: Beat) => {
    const slot = cameraSlot(beat.source);
    if (slot === 'A' && project.presenterTrack) return 'camera';
    if (slot && slot !== 'A') { const index = info.extraCameraSlots.indexOf(slot), extra = (take.sources ?? []).filter(s => s.kind === 'camera')[index];
      const found = extra && project.sources?.find(s => s.assetId === extra.assetId || s.takes?.some(t => t.assetId === extra.assetId)); if (found) return found.id; }
    if (beat.source === 'screen') return 'screen';
    return project.presenterTrack ? 'camera' : 'screen';
  };
  for (const beat of recorded) project = setShotRange(project, beat.startFrame, beatEnd(beat), { main: sourceFor(beat), bubble: false });
  const total = scheduleProject(project).reduce((n, x) => Math.max(n, x.startFrame + x.durationFrames), 0);
  const layers = [...(project.layers ?? []), ...attached.map(({ layer, beat, offset }) => { const home = recorded.find(b => b.id === beat)!;
    const start = Math.max(0, Math.min(home.startFrame + offset, beatEnd(home) - 1)), length = layer.endFrame - layer.startFrame, shift = start - layer.startFrame;
    // A layer that stayed inside its beat stays inside it (clamped if the beat got shorter); one that ran on into the next beat keeps its length.
    const within = layer.endFrame <= beatEnd(chosen.find(b => b.id === beat)!);
    const end = Math.min(total, Math.max(start + 1, within ? Math.min(start + length, beatEnd(home)) : start + length));
    return { ...layer, startFrame: start, endFrame: end, automation: layer.automation.map(lane => ({ ...lane, points: lane.points.map(p => ({ ...p, frame: Math.max(0, p.frame + shift) })) })) }; })];
  const storyboard = { ...project.storyboard!, beats: sortBeats([...project.storyboard!.beats, ...recorded]) };
  // A film made on a blank canvas: camera shots fill the frame (not the screen recording's shape).
  const film = target.assets.find(a => a.id === target.clips[0]?.assetId)?.provenance?.blank;
  return EditorProjectSchema.parse({ ...project, layers, storyboard, ...(film ? { presentation: { ...project.presentation, cameraFill: true } } : {}) });
}

/** Put an earlier take back into a beat: just that take's stretch (from its screen clock) replaces what the beat shows now. */
export function useTakeForBeat(target: EditorProject, take: EditorProject, beatId: string, sessionId: string): EditorProject {
  const beat = target.storyboard?.beats.find(b => b.id === beatId); if (!beat) throw new Error(`No beat ${beatId}`);
  const entry = beat.takes?.find(t => t.sessionId === sessionId); if (!entry || entry.startMs === undefined || entry.endMs === undefined) throw new Error('That take has no recorded stretch to bring back');
  const fps = take.output.fps, total = scheduleProject(take).reduce((n, s) => Math.max(n, s.startFrame + s.durationFrames), 0);
  const from = Math.max(0, Math.round(entry.startMs / 1000 * fps)), to = Math.min(total, Math.round(entry.endMs / 1000 * fps));
  const piece = deleteTimelineRanges(take, [{ startFrame: 0, endFrame: from }, { startFrame: to, endFrame: total }].filter(r => r.endFrame > r.startFrame));
  return recordIntoBeats(target, piece, [beatId], { sessionId, at: entry.at, screenAssetId: entry.screenAssetId, marks: [], extraCameraSlots: ['B', 'C', 'D'], reuse: true, offsetMs: entry.startMs });
}
