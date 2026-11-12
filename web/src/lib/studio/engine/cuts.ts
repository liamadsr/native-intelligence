import type { EditorProject } from './contracts';
import type { ScheduledClip } from './timeline';

/** Half-length of an audio crossfade at a cut (0.05 s each side ≈ 0.1 s blend) and length of a picture dissolve. */
export const audioFadeSeconds = 0.025, dissolveSeconds = 0.12;

export type CutAudio = { clipId: string; from: number; duration: number; trimBefore: number; gain: number; lead: number; tail: number; playback: number; fadeIn: number; fadeOut: number };
export type CutVideo = { extend: number; fadeIn: number; playOn: boolean };
export type Dip = { from: number; to: number; peak: number; color: string };

const audible = (s: ScheduledClip) => !s.clip.audio.muted && s.clip.playbackRate <= 1 && !!s.asset.hasAudio;
const touching = (a: ScheduledClip | undefined, b: ScheduledClip | undefined) => !!a && !!b && a.startFrame + a.durationFrames === b.startFrame;
/**
 * How each clip's sound plays at cuts. Nothing is borrowed from outside the kept range (that would let a deleted word
 * leak back in); instead each side fades over a few milliseconds inside what was kept, which removes the click of a hard
 * edit. Word cuts land in the quiet between words (see wordCutRanges), so the fade itself is inaudible.
 */
export function cutAudioPlan(project: EditorProject, schedule: ScheduledClip[]): CutAudio[] {
  const fps = project.output.fps, fade = Math.max(1, Math.round(audioFadeSeconds * fps));
  return schedule.flatMap((s, index): CutAudio[] => {
    if (!audible(s)) return [];
    const playback = s.durationFrames - s.clip.holdEndFrames, edge = Math.min(fade, Math.floor(playback / 2));
    const before = schedule[index - 1], next = schedule[index + 1], cutBefore = touching(before, s), cutAfter = touching(s, next) || s.clip.holdEndFrames > 0;
    // A chosen transition fades the sound with the picture: half its length into a dip, all of it across a dissolve.
    const len = (t: { kind: string; seconds: number } | undefined, half: boolean) => t ? Math.min(Math.floor(playback / 2), Math.max(1, Math.round(t.seconds * fps / (half && t.kind !== 'dissolve' ? 2 : 1)))) : 0;
    const tIn = s.clip.transitionIn, tNext = touching(s, next) ? next!.clip.transitionIn : undefined, tOut = !touching(s, next) ? s.clip.transitionOut : undefined;
    const fadeIn = tIn ? len(tIn, cutBefore) : cutBefore ? edge : 0, fadeOut = tNext ? len(tNext, true) : tOut ? len(tOut, false) : cutAfter ? edge : 0;
    return [{ clipId: s.clip.id, from: s.startFrame, duration: playback, trimBefore: s.clip.trimStartSourceFrame / s.asset.sourceFps! * fps,
      gain: s.clip.audio.gain, lead: 0, tail: 0, playback, fadeIn, fadeOut }];
  });
}

/** Volume at a frame of a clip's audio (frame 0 = its first, borrowed, frame). */
export function cutVolume(plan: CutAudio, frame: number) {
  let level = plan.gain;
  if (plan.fadeIn > 0) level *= Math.sin(Math.min(1, Math.max(0, (frame + 0.5) / plan.fadeIn)) * Math.PI / 2);
  if (plan.fadeOut > 0) { const end = plan.lead + plan.playback + plan.tail; level *= Math.sin(Math.min(1, Math.max(0, (end - frame - 0.5) / plan.fadeOut)) * Math.PI / 2); }
  return level;
}

/**
 * Picture: at a cut inside the same recording the outgoing shot holds its last kept frame for a moment while the next
 * fades in over it, so jump cuts read as a soft blend and no deleted footage is ever shown.
 */
export function cutVideoPlan(project: EditorProject, schedule: ScheduledClip[]): CutVideo[] {
  const fps = project.output.fps, length = Math.max(1, Math.round(dissolveSeconds * fps));
  const plan = schedule.map((s, index): { extend: number; playOn: boolean } => { const next = schedule[index + 1];
    if (!touching(s, next) || s.clip.holdEndFrames || s.asset.kind !== 'video') return { extend: 0, playOn: false };
    const t = next!.clip.transitionIn;
    if (t?.kind === 'dissolve') {
      // A chosen dissolve: the outgoing shot plays on under the incoming one when its recording has the footage and that
      // footage was not cut out of this same recording; otherwise it holds its last kept frame.
      const extend = Math.max(1, Math.min(Math.round(t.seconds * fps), next!.durationFrames - 1)), rate = s.clip.playbackRate ?? 1;
      const need = Math.ceil(extend * s.asset.sourceFps! / fps * rate), deleted = next!.asset.id === s.asset.id && next!.clip.trimStartSourceFrame >= s.clip.trimEndSourceFrame;
      return { extend, playOn: !deleted && (s.asset.sourceFrames ?? 0) - s.clip.trimEndSourceFrame >= need };
    }
    if (t || next!.asset.id !== s.asset.id) return { extend: 0, playOn: false };
    return { extend: Math.min(length, Math.floor(next!.durationFrames / 2), Math.floor(s.durationFrames / 2)), playOn: false };
  });
  return schedule.map((_, index) => ({ extend: plan[index]!.extend, fadeIn: index ? plan[index - 1]!.extend : 0, playOn: plan[index]!.playOn }));
}

/** Washes of colour over the whole picture: a dip peaks on its cut; the film's first clip can fade up from colour and
 *  its last (or the one before a gap) fade down to it. A dissolve on the first clip fades up from black. */
export function dipPlan(project: EditorProject, schedule: ScheduledClip[]): Dip[] {
  const fps = project.output.fps, out: Dip[] = [], color = (kind: string) => kind === 'dip-white' ? '#ffffff' : '#000000';
  schedule.forEach((s, index) => { const before = schedule[index - 1], next = schedule[index + 1], tIn = s.clip.transitionIn, tOut = s.clip.transitionOut;
    if (tIn) { const len = Math.max(1, Math.round(tIn.seconds * fps));
      if (!touching(before, s)) out.push({ from: s.startFrame, to: s.startFrame + Math.min(len, s.durationFrames), peak: s.startFrame, color: color(tIn.kind) });
      else if (tIn.kind !== 'dissolve') { const half = Math.max(1, Math.round(len / 2)); out.push({ from: s.startFrame - Math.min(half, before!.durationFrames), to: s.startFrame + Math.min(half, s.durationFrames), peak: s.startFrame, color: color(tIn.kind) }); } }
    if (tOut && !touching(s, next)) { const end = s.startFrame + s.durationFrames, len = Math.min(s.durationFrames, Math.max(1, Math.round(tOut.seconds * fps))); out.push({ from: end - len, to: end, peak: end, color: color(tOut.kind) }); }
  });
  return out;
}

/** Opacity of a dip's colour at a timeline frame (smooth up to the peak, smooth down after it). */
export function dipOpacity(dip: Dip, frame: number) {
  if (frame < dip.from || frame > dip.to) return 0;
  const side = frame <= dip.peak ? (dip.peak - dip.from || 1) : (dip.to - dip.peak || 1), x = 1 - Math.abs(frame - dip.peak) / side;
  const v = Math.max(0, Math.min(1, x)); return v * v * (3 - 2 * v);
}
