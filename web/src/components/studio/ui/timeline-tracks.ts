import type { MotionTrack } from '@/lib/studio/engine/contracts';
import type { ScheduledClip } from '@/lib/studio/engine/timeline';

export function timelineCurveRows(schedule: ScheduledClip[], selectedIds: string[], layerId: string, all: boolean): { item: ScheduledClip; track: MotionTrack }[] {
  const selected = selectedIds.length === 1 ? schedule.find(item => item.clip.id === selectedIds[0]) : undefined;
  const target = selected?.clip.motion.layers.some(layer => layer.id === layerId) ? layerId : 'primary';
  return schedule.flatMap(item => item.clip.motion.tracks
    .filter(track => all || item === selected && track.target === target)
    .map(track => ({ item, track })));
}
