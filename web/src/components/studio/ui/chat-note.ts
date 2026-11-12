import type { EditorProject } from '@/lib/studio/engine/contracts';
import { formatPreset } from '@/lib/studio/engine/formats';
import { scheduleProject } from '@/lib/studio/engine/timeline';
import type { TimelineItem } from '@/lib/studio/engine/timeline-selection';
import { MAX_STUDIO_PICKS, seconds, type StudioNote, type StudioPick } from '@/lib/chat-cards/studio-note';
import { handOffToHome, type HomeHandoffResult } from '@/lib/chat/home-thread-client';
import { studioWorkspaceId } from '../studio-env';
import type { FilmPage } from './FilmPages';

/**
 * What the editor tells the app's agent when the person sends it a message while the Studio is in front
 * (lib/chat-cards/studio-note.ts): the video and page, and on the edit page the playhead, the delivery format, what
 * is selected and whether edits are still unsaved. App.tsx hands the card a reader that calls this with its state
 * of that moment; it runs once per message, never per frame or per click.
 */
export interface EditorChatState {
  project: EditorProject | null | undefined;
  page: FilmPage;
  /** The playhead, in frames. */
  frame: number;
  /** Clips picked on the timeline (the editor always has one). */
  selectedIds: readonly string[];
  /** Layers and audio segments picked on the timeline. */
  selectedItems: readonly TimelineItem[];
  /** The layer whose settings fill the inspector. */
  selectedLayerId: string | null;
  selectedBeatIds: readonly string[];
  selectedZoom: string | null;
  /** A clip's motion layer ('primary': the clip's own picture, nothing picked). */
  selectedMotionLayerId: string;
  selectedMotionTrackId: string | null;
  /** The editor holds edits that are not saved yet. */
  dirty: boolean;
}

/** A label or a layer's words on one line, cut short: the note rides the request's header. */
const words = (value: unknown, max = 80) => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const one = value.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

function at(fps: number, from: number, to: number): Pick<StudioPick, 'from' | 'to'> {
  const a = seconds(from / fps), b = seconds(to / fps);
  return a !== null && b !== null ? { from: a, to: b } : {};
}

/** The delivery format in words: its preset ("YouTube (16:9)") or the frame size as made. */
function formatOf(p: EditorProject): string {
  const preset = formatPreset(p.delivery?.format);
  const size = `${preset?.width ?? p.output.width}×${preset?.height ?? p.output.height} at ${p.output.fps} fps`;
  return preset ? `${preset.label}, ${size}` : size;
}

/** What is selected, the most specific first. A layer, beat, zoom or track picked says what "this" is; the clip
 *  the editor always has selected is named only when nothing more specific is. */
function picksOf(s: EditorChatState, p: EditorProject): StudioPick[] {
  const fps = p.output.fps, picks: StudioPick[] = [], seen = new Set<string>();
  const add = (pick: StudioPick) => { const key = `${pick.k}:${pick.id}`; if (seen.has(key)) return; seen.add(key); picks.push(pick); };
  const layerIds = [...(s.selectedLayerId ? [s.selectedLayerId] : []), ...s.selectedItems.flatMap(i => i.kind === 'layer' ? [i.id] : [])];
  for (const id of layerIds) {
    const layer = p.layers?.find(l => l.id === id); if (!layer) continue;
    const text = words((layer.style as { text?: unknown }).text);
    add({ k: 'layer', id: layer.id, kind: layer.kind, label: words(layer.name, 60), ...(text ? { text } : {}), ...at(fps, layer.startFrame, layer.endFrame) });
  }
  if (s.page === 'edit' || s.page === 'storyboard') for (const id of s.selectedBeatIds) {
    const beat = p.storyboard?.beats.find(b => b.id === id); if (!beat) continue;
    add({ k: 'beat', id: beat.id, ...(words(beat.label, 60) ? { label: words(beat.label, 60) } : {}), ...at(fps, beat.startFrame, beat.startFrame + beat.durationFrames) });
  }
  if (s.page === 'edit') {
    const schedule = scheduleProject(p);
    const clip = s.selectedIds.length ? p.clips.find(c => c.id === s.selectedIds[0]) : undefined;
    if (clip && s.selectedMotionLayerId !== 'primary') {
      const layer = clip.motion.layers.find(l => l.id === s.selectedMotionLayerId);
      if (layer) add({ k: 'layer', id: layer.id, kind: `motion ${layer.kind}`, ...(layer.kind === 'text' && words(layer.text) ? { text: words(layer.text) } : {}) });
    }
    if (clip && s.selectedMotionTrackId) {
      const track = clip.motion.tracks.find(t => t.id === s.selectedMotionTrackId);
      if (track) add({ k: 'track', id: track.id, kind: 'motion', label: words(`${track.property} of ${track.target}`, 60) });
    }
    if (clip && s.selectedZoom) {
      const zoom = clip.zooms.find(z => z.id === s.selectedZoom), placed = schedule.find(v => v.clip.id === clip.id);
      if (zoom && placed) add({ k: 'zoom', id: zoom.id, ...at(fps, placed.startFrame + zoom.startClipFrame, placed.startFrame + zoom.endClipFrame) });
    }
    for (const item of s.selectedItems) {
      if (item.kind !== 'audio') continue;
      const track = p.audioTracks.find(t => t.id === item.trackId);
      if (track) add({ k: 'track', id: track.id, kind: `${track.role} audio`, label: words(track.name, 60) });
    }
    if (!picks.length) for (const id of s.selectedIds) {
      const placed = schedule.find(v => v.clip.id === id); if (!placed) continue;
      add({ k: 'clip', id, label: words(placed.asset.name, 60), ...at(fps, placed.startFrame, placed.startFrame + placed.durationFrames) });
    }
  }
  return picks.slice(0, MAX_STUDIO_PICKS);
}

/** The note for the editor's state of this moment; null with no video open. */
export function editorChatNote(s: EditorChatState): StudioNote | null {
  const p = s.project;
  if (!p) return null;
  const note: StudioNote = { v: { id: p.id, title: words(p.title, 120) ?? 'Untitled video' }, page: s.page };
  if (s.page === 'edit') {
    const t = seconds(s.frame / p.output.fps);
    if (t !== null) note.t = t;
    note.fmt = formatOf(p);
  }
  const sel = picksOf(s, p);
  if (sel.length) note.sel = sel;
  if (s.dirty) note.dirty = true;
  return note;
}

/** What the editor hands the Studio card (studio-root.tsx `onLive`), for the card store to read when a turn is sent. */
export interface EditorChatLink {
  /** The note for this moment (editorChatNote over the editor's state now). */
  note: () => StudioNote | null;
  /** Save the person's edits, quietly: true when what the agent will read is what they see. */
  flush: () => Promise<boolean>;
}

/**
 * Ask the app's agent about the open video: the person's words go to the main chat as their own message, with the
 * Studio card staying where it is. The card's note (above) tells the agent which video, page and selection they
 * mean. What the editor's own agent panel used to do; it is the chat now.
 */
export function askAgentInChat(text: string): Promise<HomeHandoffResult> {
  return handOffToHome({ text, workspaceId: studioWorkspaceId() });
}
