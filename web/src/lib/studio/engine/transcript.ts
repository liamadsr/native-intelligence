import { cutAutomation } from './automation';
import { cutLayers } from './layers';
import { cutBeats } from './storyboard';
import type { EditorProject, EditorTranscript, EditorAsset } from './contracts';
import { normalizeProjectZooms, projectDuration, scheduleProject } from './timeline';
import { sliceMotion } from './motion';
import { sliceMotionTrack } from './motion';

export type TimelineRange = { startFrame: number; endFrame: number };
export type TranscriptRow = TimelineRange & { id: string; wordId: string; transcriptId: string; instanceId: string; text: string; sourceKind: 'clip' | 'voiceover'; timingReliable: boolean; pauseTimingReliable: boolean };
/** Words are views of immutable source timings through the same trims as the media. */
export function transcriptWords(project: EditorProject): TranscriptRow[] {
  const rows: TranscriptRow[] = [], fps = project.output.fps, frameEpsilon = 1e-8;
  const add = (assetId: string, instance: string, sourceStart: number, sourceEnd: number, startFrame: number, duration: number, sourceKind: TranscriptRow['sourceKind'], rate=1) => {
    const transcript = project.transcripts.find(t => t.assetId === assetId); if (!transcript) return;
    const pauseTimingReliable = transcript.words.every(word => word.endMs > word.startMs);
    for (const word of transcript.words) { const timingReliable = word.endMs > word.startMs;
      const sourceStartFrame = (word.startMs / 1000 - sourceStart) * fps / rate;
      const sourceEndFrame = (word.endMs / 1000 - sourceStart) * fps / rate;
      const exclusiveEndFrame = (sourceEnd - sourceStart) * fps / rate;
      // Measured millisecond endpoints can straddle an exact rational frame by
      // a few floating-point ulps. Use the same tolerance as floor/ceil below.
      if ((timingReliable ? sourceEndFrame <= frameEpsilon : sourceStartFrame < -frameEpsilon) || sourceStartFrame >= exclusiveEndFrame - frameEpsilon) continue;
      const start = Math.max(0, Math.floor(sourceStartFrame + frameEpsilon));
      const end = timingReliable ? Math.min(duration, Math.max(start + 1, Math.ceil(sourceEndFrame - frameEpsilon))) : start;
      if (start >= duration || timingReliable && end <= start) continue;
      rows.push({ id: `${instance}:${word.id}`, wordId: word.id, transcriptId: transcript.id, instanceId: instance,
        text: project.captionCorrections[word.id] ?? word.text, sourceKind, timingReliable, pauseTimingReliable, startFrame: startFrame + start, endFrame: startFrame + end });
    }
  };
  for (const s of scheduleProject(project)) if (!s.clip.audio.muted && s.clip.playbackRate===1 && s.asset.hasAudio) add(s.asset.id, s.clip.id, s.clip.trimStartSourceFrame / s.asset.sourceFps!, s.clip.trimEndSourceFrame / s.asset.sourceFps!, s.startFrame, s.durationFrames - s.clip.holdEndFrames, 'clip',s.clip.playbackRate);
  for (const track of project.audioTracks) if (track.role === 'voiceover' && !track.muted) for (const s of track.segments) add(s.assetId, s.id, s.trimStartSeconds, s.trimEndSeconds, s.startFrame, Math.round((s.trimEndSeconds - s.trimStartSeconds) * fps), 'voiceover');
  const total = projectDuration(project);
  return rows.filter(r => r.startFrame < total).map(r => ({ ...r, endFrame: Math.min(total, r.endFrame) })).sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame || a.id.localeCompare(b.id));
}
export function fillerWords(rows: TranscriptRow[]): TranscriptRow[] { return rows.filter(w => w.timingReliable && /^(?:um+|uh+|erm+|er+|hmm+)[,.!?;:]?$/iu.test(w.text)); }
/** Gaps between aligned words, not acoustic silence detection. Keep a short natural pause. */
export function pauseRanges(rows: TranscriptRow[], fps: number, thresholdSeconds = .7, keepSeconds = .2): TimelineRange[] {
  const ranges: TimelineRange[] = []; let previous: TranscriptRow | undefined;
  const uncertainInstances = new Set(rows.filter(w => !w.timingReliable || !w.pauseTimingReliable).map(w => `${w.transcriptId}:${w.instanceId}`));
  for (const word of rows) { if (uncertainInstances.has(`${word.transcriptId}:${word.instanceId}`)) { previous = undefined; continue; }
    if (previous && word.transcriptId === previous.transcriptId && word.instanceId === previous.instanceId && word.startFrame - previous.endFrame > thresholdSeconds * fps) {
    const edge = Math.ceil(keepSeconds * fps / 2); const startFrame = previous.endFrame + edge, endFrame = word.startFrame - edge;
    if (endFrame > startFrame) ranges.push({ startFrame, endFrame });
  } if (!previous || word.endFrame > previous.endFrame) previous = word; }
  return ranges;
}
/** Word editing requires positive source timing, including for projects saved before local ASR guards. */
export function deleteTranscriptWords(project: EditorProject, rowIds: string[]): EditorProject {
  const rows = transcriptWords(project), selected = rows.filter(row => rowIds.includes(row.id));
  if (!selected.length) return project;
  if (selected.some(row => !row.timingReliable)) throw new Error('These words have uncertain timing. Transcribe this source again before deleting words.');
  return deleteTimelineRanges(project, wordCutRanges(rows, selected, project.output.fps));
}
export function mergeRanges(ranges: TimelineRange[], duration: number): TimelineRange[] {
  const result: TimelineRange[] = [];
  for (const r of ranges.map(r => ({ startFrame: Math.max(0, Math.round(r.startFrame)), endFrame: Math.min(duration, Math.round(r.endFrame)) })).filter(r => r.endFrame > r.startFrame).sort((a,b) => a.startFrame - b.startFrame)) {
    const last = result.at(-1); if (last && r.startFrame <= last.endFrame) last.endFrame = Math.max(last.endFrame, r.endFrame); else result.push({ ...r });
  } return result;
}
/** A single edit transaction cuts the same project intervals from picture and all sound tracks. */
export function deleteTimelineRanges(project: EditorProject, ranges: TimelineRange[]): EditorProject {
  const total = projectDuration(project), cuts = mergeRanges(ranges, total); if (!cuts.length) return project;
  const keeps: TimelineRange[] = []; let cursor = 0;
  for (const cut of cuts) { if (cut.startFrame > cursor) keeps.push({ startFrame: cursor, endFrame: cut.startFrame }); cursor = cut.endFrame; }
  if (cursor < total) keeps.push({ startFrame: cursor, endFrame: total });
  if (!keeps.length) throw new Error('Keep at least one video frame. Undo is available for earlier edits.');
  const fps = project.output.fps; let ordinal = 0;
  const unique = (id: string) => `${id.slice(0, 72)}-cut-${ordinal++}`;
  const mapFrame = (frame: number) => keeps.reduce((n, k) => n + Math.max(0, Math.min(frame, k.endFrame) - k.startFrame), 0);
  const clips = scheduleProject(project).flatMap(s => keeps.flatMap(keep => {
    const from = Math.max(keep.startFrame, s.startFrame), to = Math.min(keep.endFrame, s.startFrame + s.durationFrames); if (to <= from) return [];
    const localFrom = from - s.startFrame, localTo = to - s.startFrame, playbackFrames = s.durationFrames - s.clip.holdEndFrames;
    const minSource = Math.max(1, Math.ceil(s.asset.sourceFps! * s.clip.playbackRate / fps));
    const trimStartSourceFrame = Math.min(s.clip.trimEndSourceFrame - minSource, Math.round(s.clip.trimStartSourceFrame + localFrom / fps * s.asset.sourceFps! * s.clip.playbackRate));
    let trimEndSourceFrame = Math.min(s.clip.trimEndSourceFrame, Math.round(s.clip.trimStartSourceFrame + Math.min(localTo, playbackFrames) / fps * s.asset.sourceFps! * s.clip.playbackRate));
    if (trimEndSourceFrame - trimStartSourceFrame < minSource) throw new Error('This cut is shorter than a source frame. Choose a nearby source-frame boundary.');
    const playedFor = (end: number) => Math.round((end - trimStartSourceFrame) / s.asset.sourceFps! * fps / s.clip.playbackRate);
    let played = playedFor(trimEndSourceFrame);
    const expectedHold = Math.max(0, localTo - Math.max(localFrom, playbackFrames));
    let holdEndFrames = localFrom >= playbackFrames ? Math.max(0, to - from - played) : expectedHold;
    // Footage recorded at a lower rate than the project (a 30 fps take in a 60 fps edit) cannot end between its own
    // frames: snap to the nearest whole source frame and hold the last picture for the remaining output frame.
    while (played + holdEndFrames > to - from && trimEndSourceFrame - 1 - trimStartSourceFrame >= minSource) { trimEndSourceFrame -= 1; played = playedFor(trimEndSourceFrame); }
    if (played + holdEndFrames < to - from && to - from - played - holdEndFrames <= Math.ceil(fps / s.asset.sourceFps! * s.clip.playbackRate)) holdEndFrames = to - from - played;
    if (played + holdEndFrames !== to - from) throw new Error('This cut falls between source frames at the current project frame rate. Choose a nearby source-frame boundary.');
    return [{ ...s.clip, id: unique(s.clip.id), trimStartSourceFrame, trimEndSourceFrame, holdEndFrames, audio: localFrom >= playbackFrames ? { ...s.clip.audio, muted: true } : s.clip.audio,
      zooms: s.clip.zooms.filter(z => z.endClipFrame > localFrom && z.startClipFrame < localTo).map(z => ({ ...z, id: unique(z.id), startClipFrame: Math.max(0, z.startClipFrame - localFrom), endClipFrame: Math.min(localTo, z.endClipFrame) - localFrom })),motion:sliceMotion(s.clip.motion,localFrom,localTo,fps,project.assets,s.clip.playbackRate) }];
  }));
  if (!clips.length) throw new Error('The remaining selection is shorter than a source frame.');
  const audioTracks = project.audioTracks.map(track => ({ ...track, segments: track.segments.flatMap(segment => keeps.flatMap(keep => {
    const end = segment.startFrame + Math.round((segment.trimEndSeconds - segment.trimStartSeconds) * fps);
    const from = Math.max(keep.startFrame, segment.startFrame), to = Math.min(keep.endFrame, end); if (to <= from) return [];
    return [{ ...segment, id: unique(segment.id), startFrame: mapFrame(from), trimStartSeconds: segment.trimStartSeconds + (from - segment.startFrame) / fps, trimEndSeconds: Math.min(segment.trimEndSeconds, segment.trimStartSeconds + (to - segment.startFrame) / fps) }];
  })) }));
  const presenter=project.presenterTrack, presenterAsset=presenter?project.assets.find(asset=>asset.id===presenter.assetId):null;
  const presenterTrack=presenter?.sync?presenter:presenter&&presenterAsset?{...presenter,segments:presenter.segments.flatMap(segment=>keeps.flatMap(keep=>{
    const from=Math.max(keep.startFrame,segment.startFrame),to=Math.min(keep.endFrame,segment.endFrame);if(to<=from)return[];
    const offset=from-segment.startFrame,localTo=to-segment.startFrame;
    return[{...segment,id:unique(segment.id),startFrame:mapFrame(from),endFrame:mapFrame(from)+(to-from),
      sourceStartFrame:segment.sourceStartFrame+Math.round(offset*presenterAsset.sourceFps!/fps),
      tracks:segment.tracks.map(track=>sliceMotionTrack(track,offset,localTo))}];
  }))}:null;
  return normalizeProjectZooms({ ...project, clips, audioTracks, presenterTrack:presenterTrack?.segments.length?presenterTrack:null, voiceoverDraft: { ...project.voiceoverDraft, targetClipIds: [] }, automation: cutAutomation(project, cuts, mapFrame), ...(project.layers ? { layers: cutLayers(project.layers, cuts, mapFrame) } : {}), ...(project.storyboard ? { storyboard: cutBeats(project.storyboard, mapFrame) } : {}) });
}
export type VoiceoverResult = { asset: EditorAsset; transcript: EditorTranscript; cached: boolean; requestHash: string };
function voiceoverTarget(project: EditorProject, targetClipIds: string[]) {
  const schedule = scheduleProject(project), ids = targetClipIds.length ? targetClipIds : project.clips.map(c => c.id);
  const selected = schedule.filter(s => ids.includes(s.clip.id));
  if (!selected.length || selected.length !== new Set(ids).size) throw new Error('Select existing footage for the voiceover.');
  const first = schedule.indexOf(selected[0]!), last = schedule.indexOf(selected.at(-1)!);
  if (last - first + 1 !== selected.length) throw new Error('Select consecutive clips for this voiceover block.');
  return { selected, startFrame: selected[0]!.startFrame, endFrame: selected.at(-1)!.startFrame + selected.at(-1)!.durationFrames };
}
export function voiceoverTiming(project: EditorProject, result: VoiceoverResult, targetClipIds: string[]) {
  const target = voiceoverTarget(project, targetClipIds), availableFrames = target.endFrame - target.startFrame;
  const narrationFrames = Math.ceil(result.asset.durationSeconds! * project.output.fps), excessFrames = Math.max(0, narrationFrames - availableFrames);
  return { startFrame: target.startFrame, availableFrames, narrationFrames, excessFrames, beforeFrames: projectDuration(project), afterFrames: projectDuration(project) + excessFrames };
}
export function applyVoiceover(project: EditorProject, result: VoiceoverResult, targetClipIds: string[], policy: 'keep-footage' | 'hold-last-frame'): EditorProject {
  const target = voiceoverTarget(project, targetClipIds), timing = voiceoverTiming(project, result, targetClipIds);
  if (policy === 'keep-footage' && timing.excessFrames > 0) throw new Error('Narration is longer than the selected footage. Choose an ending hold or extend the footage.');
  const extra = policy === 'hold-last-frame' ? timing.excessFrames : 0, lastId = target.selected.at(-1)!.clip.id;
  const selectedIds = new Set(target.selected.map(s => s.clip.id));
  // Replace an existing voiceover in the selected block; preserve outside segments, including straddling ones.
  const audioTracks = project.audioTracks.map(track => ({ ...track, segments: track.segments.flatMap(segment => {
    const end = segment.startFrame + Math.round((segment.trimEndSeconds - segment.trimStartSeconds) * project.output.fps);
    if (track.role !== 'voiceover') return [{ ...segment, startFrame: segment.startFrame >= target.endFrame ? segment.startFrame + extra : segment.startFrame }];
    const pieces = [];
    if (segment.startFrame < target.startFrame) { const trimEndSeconds = Math.min(segment.trimEndSeconds, segment.trimStartSeconds + (target.startFrame - segment.startFrame) / project.output.fps); if (trimEndSeconds > segment.trimStartSeconds) pieces.push({ ...segment, id: `${segment.id.slice(0,85)}-before`, trimEndSeconds }); }
    if (end > target.endFrame) { const trimStartSeconds = Math.max(segment.trimStartSeconds, segment.trimStartSeconds + (target.endFrame - segment.startFrame) / project.output.fps); pieces.push({ ...segment, id: `${segment.id.slice(0,85)}-after`, startFrame: Math.max(segment.startFrame, target.endFrame) + extra, trimStartSeconds }); }
    return pieces;
  }) })).filter(t => t.segments.length);
  const stamp = result.requestHash.slice(0, 20); let sequence = project.audioTracks.length;
  const existingIds = new Set(project.audioTracks.flatMap(t => [t.id, ...t.segments.map(s => s.id)]));
  while (existingIds.has(`voice-${stamp}-${sequence}`) || existingIds.has(`speech-${stamp}-${sequence}`)) sequence++;
  audioTracks.push({ id: `voice-${stamp}-${sequence}`, name: `${result.transcript.voiceName ?? 'Narration'} voiceover`, role: 'voiceover', gain: 1, muted: false,
    segments: [{ id: `speech-${stamp}-${sequence}`, assetId: result.asset.id, startFrame: target.startFrame, trimStartSeconds: 0, trimEndSeconds: result.asset.durationSeconds! }] });
  const transcripts = [...project.transcripts.filter(t => t.assetId !== result.asset.id), result.transcript];
  const validWords = new Set(transcripts.flatMap(t => t.words.map(w => w.id)));
  return normalizeProjectZooms({ ...project, captionCorrections: Object.fromEntries(Object.entries(project.captionCorrections).filter(([id]) => validWords.has(id))),
    assets: project.assets.some(a => a.id === result.asset.id) ? project.assets : [...project.assets, result.asset],
    transcripts, audioTracks,
    clips: project.clips.map(c => ({ ...c, audio: selectedIds.has(c.id) ? { ...c.audio, muted: true } : c.audio, holdEndFrames: c.holdEndFrames + (c.id === lastId ? extra : 0) })),
  });
}

const bare = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
const fillerSounds = /^(?:um+|uh+|uhm+|erm+|er+|hmm+|mm+|ah+|eh+)$/u;
/** After these, "like" is a real verb or comparison ("I like it", "looks like"), so it stays. */
const likeKeepers = new Set(['i', 'you', 'we', 'they', 'would', "i'd", "you'd", "we'd", 'do', "don't", 'dont', "didn't", 'does', "doesn't", 'look', 'looks', 'looked', 'feel', 'feels', 'felt', 'seem', 'seems', 'sound', 'sounds', 'something', 'anything', 'nothing', 'things', 'stuff', 'just', 'really', 'more', 'much', 'what', "what's", 'is', 'was', 'be', 'not', "it's", "that's", 'its']);
/**
 * Words a one-click clean-up removes: filler sounds, filler "like", "you know"/"I mean" asides set off by commas,
 * and stutters (a word immediately repeated, keeping the last one). Only words with reliable timing are cut.
 */
export function cleanupWords(rows: TranscriptRow[]): TranscriptRow[] {
  const remove = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!, word = bare(row.text), prev = rows[i - 1], next = rows[i + 1];
    if (!row.timingReliable || !word) continue;
    if (fillerSounds.test(word)) { remove.add(i); continue; }
    if (word === 'like') {
      const after = prev && !/[,.!?]$/.test(prev.text) ? bare(prev.text) : '', before = next ? bare(next.text) : '';
      const verb = likeKeepers.has(after), comparison = /^(?:a|an|the|this|that|these|those|it|him|her|them|me|us|my|your|our|their|his)$/.test(before);
      if (/,$/.test(row.text) || !(verb || comparison)) { remove.add(i); continue; }
    }
    // "you know," / "I mean," used as asides.
    if (next && /,$/.test(next.text) && ((word === 'you' && bare(next.text) === 'know') || (word === 'i' && bare(next.text) === 'mean'))
      && (!prev || /[,.!?]$/.test(prev.text) || remove.has(i - 1))) { remove.add(i); remove.add(i + 1); i++; continue; }
    // Stutters: "one, one, one", "and and" — drop each repeat except the last.
    if (next && next.timingReliable && bare(next.text) === word && next.sourceKind === row.sourceKind) remove.add(i);
  }
  return rows.filter((_, index) => remove.has(index));
}

/**
 * Where to cut when words are removed. Whisper's word times start a little after the sound does, so cutting exactly on
 * them leaves the start of a deleted word audible. Each run of removed words is cut from just before its onset (never
 * into the previous word) through the following gap, leaving a short natural pause and the next word's onset intact.
 */
export function wordCutRanges(rows: TranscriptRow[], selected: TranscriptRow[], fps: number): TimelineRange[] {
  const chosen = new Set(selected.map(row => row.id)), ordered = [...rows].sort((a, b) => a.startFrame - b.startFrame);
  const onset = Math.round(0.12 * fps), breath = Math.round(0.04 * fps), pause = Math.round(0.18 * fps), guard = onset, tail = Math.round(0.08 * fps);
  const ranges: TimelineRange[] = [];
  for (const kind of ['clip', 'voiceover'] as const) {
    const lane = ordered.filter(row => row.sourceKind === kind);
    for (let i = 0; i < lane.length; i++) {
      if (!chosen.has(lane[i]!.id)) continue;
      let j = i; while (j + 1 < lane.length && chosen.has(lane[j + 1]!.id)) j++;
      const first = lane[i]!, last = lane[j]!, prev = lane[i - 1], next = lane[j + 1];
      let start = Math.max(0, first.startFrame - onset);
      if (prev) start = Math.min(first.startFrame, Math.max(start, prev.endFrame + Math.min(breath, Math.floor((first.startFrame - prev.endFrame) / 2))));
      let end = last.endFrame + tail;
      if (next) { const kept = prev ? start - prev.endFrame : pause, before = Math.max(guard, pause - kept);
        end = Math.min(next.startFrame, Math.max(last.endFrame, next.startFrame - before)); }
      if (end > start) ranges.push({ startFrame: start, endFrame: end });
      i = j;
    }
  }
  return ranges;
}
