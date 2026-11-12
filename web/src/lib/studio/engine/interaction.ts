import type { EditorAsset, EditorClip, EditorProject, EditorZoom } from './contracts';
import { scheduleProject } from './timeline';

export type ZoomEditMode = 'move' | 'start' | 'end';
export type ZoomBounds = { min: number; max: number };
/** A drag stays in its original gap: it cannot jump through another zoom. */
export function zoomBounds(zoom: EditorZoom, neighbors: EditorZoom[], duration: number): ZoomBounds {
  return { min: Math.max(0, ...neighbors.filter(z => z.id !== zoom.id && z.endClipFrame <= zoom.startClipFrame).map(z => z.endClipFrame)),
    max: Math.min(duration, ...neighbors.filter(z => z.id !== zoom.id && z.startClipFrame >= zoom.endClipFrame).map(z => z.startClipFrame)) };
}
export function editZoom(zoom: EditorZoom, mode: ZoomEditMode, delta: number, bounds: ZoomBounds): EditorZoom {
  const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
  const frames = Math.round(delta), length = zoom.endClipFrame - zoom.startClipFrame;
  const startClipFrame = mode === 'end' ? zoom.startClipFrame : clamp(zoom.startClipFrame + frames, bounds.min, mode === 'move' ? bounds.max - length : zoom.endClipFrame - 1);
  const endClipFrame = mode === 'move' ? startClipFrame + length : mode === 'start' ? zoom.endClipFrame : clamp(zoom.endClipFrame + frames, zoom.startClipFrame + 1, bounds.max);
  return { ...zoom, startClipFrame, endClipFrame, transitionFrames: Math.min(zoom.transitionFrames, Math.floor((endClipFrame - startClipFrame) / 2)) };
}
export function clipTrim(clip: EditorClip, asset: EditorAsset, fps: number, mode: 'start' | 'end', delta: number): [number, number] {
  const minimum = Math.max(1, Math.ceil(asset.sourceFps! * clip.playbackRate / fps));
  const sourceDelta = Math.round(delta / fps * asset.sourceFps! * clip.playbackRate);
  return mode === 'start'
    ? [Math.max(0, Math.min(clip.trimEndSourceFrame - minimum, clip.trimStartSourceFrame + sourceDelta)), clip.trimEndSourceFrame]
    : [clip.trimStartSourceFrame, Math.min(asset.sourceFrames!, Math.max(clip.trimStartSourceFrame + minimum, clip.trimEndSourceFrame + sourceDelta))];
}
export type KeyboardMarker = { id: string; clipId: string; startFrame: number; endFrame: number; kind: 'type' | 'press'; label: string };
/** Existing trace milliseconds map through the same source trim and project FPS as video. */
export function keyboardMarkers(project: EditorProject): KeyboardMarker[] {
  return scheduleProject(project).flatMap(({ clip, asset, startFrame, durationFrames }) => {
    const sourceStart = clip.trimStartSourceFrame / asset.sourceFps! * 1000;
    const sourceEnd = clip.trimEndSourceFrame / asset.sourceFps! * 1000;
    return (asset.trace?.actions ?? []).flatMap((action, index): KeyboardMarker[] => {
      if (action.kind !== 'type' && action.kind !== 'press') return [];
      const end = Math.max(action.t, action.end);
      if (action.t >= sourceEnd || end < sourceStart || (end === sourceStart && action.t < sourceStart)) return [];
      // A long action may extend just past a source-frame split. Its tiny
      // clipped remainder cannot occupy an output frame, but the one-frame
      // minimum below would show a duplicate marker in the next clip. Keep
      // short actions that genuinely cross a cut: both sides remain a
      // meaningful share of their original action.
      const overlapMs = Math.min(sourceEnd, end) - Math.max(sourceStart, action.t);
      if (end > action.t && (action.t < sourceStart || end > sourceEnd)
        && overlapMs / clip.playbackRate < 1000 / project.output.fps
        && overlapMs < (end - action.t) * 0.05) return [];
      const localStart = Math.max(0, Math.min(durationFrames - 1, Math.floor((Math.max(sourceStart, action.t) - sourceStart) / 1000 * project.output.fps / clip.playbackRate + 1e-8)));
      const localEnd = Math.min(durationFrames, Math.max(localStart + 1, Math.ceil((Math.min(sourceEnd, end) - sourceStart) / 1000 * project.output.fps / clip.playbackRate - 1e-8)));
      return [{ id: `${clip.id}-key-${index}`, clipId: clip.id, startFrame: startFrame + localStart, endFrame: startFrame + localEnd, kind: action.kind, label: action.label }];
    });
  });
}
