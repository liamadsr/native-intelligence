/**
 * What the editor tells the app's agent when the person messages it with the Studio in front (../chat-note.ts): the
 * video and page; on the edit page the playhead, the format and what is selected, the most specific first; whether
 * edits are unsaved. Small: ids, short labels and seconds. Fixtures are made up.
 */
import { describe, expect, it } from 'vitest';
import type { EditorProject } from '@/lib/studio/engine/contracts';
import { editorChatNote, type EditorChatState } from '../chat-note';

const VIDEO = '9b0f3c1e-2d4a-4c6b-8e1f-0a1b2c3d4e5f';
const asset = { id: 'asset-canvas', name: 'canvas.mp4', kind: 'video', sourceFps: 60, sourceFrames: 600 };
const project = {
  id: VIDEO,
  title: 'Hello Studio',
  output: { width: 1920, height: 1080, fps: 60 },
  assets: [asset],
  clips: [
    { id: 'clip-1', assetId: asset.id, trimStartSourceFrame: 0, trimEndSourceFrame: 300, holdEndFrames: 0, playbackRate: 1, zooms: [{ id: 'zoom-1', startClipFrame: 60, endClipFrame: 120 }], motion: { layers: [{ id: 'm-title', kind: 'text', text: 'Inside the clip' }], tracks: [{ id: 'trk-1', target: 'm-title', property: 'opacity' }] } },
    { id: 'clip-2', assetId: asset.id, trimStartSourceFrame: 300, trimEndSourceFrame: 600, holdEndFrames: 0, playbackRate: 1, zooms: [], motion: { layers: [], tracks: [] } },
  ],
  layers: [{ id: 'layer-headline', kind: 'text', name: 'Headline', startFrame: 0, endFrame: 180, style: { text: 'Hello, Fernhill' } }],
  audioTracks: [{ id: 'music-1', name: 'Bed', role: 'music', segments: [{ id: 'seg-1' }] }],
  storyboard: { beats: [{ id: 'beat-1', label: 'The hook', startFrame: 0, durationFrames: 120 }] },
  delivery: { format: 'youtube' },
} as unknown as EditorProject;

const state = (patch: Partial<EditorChatState> = {}): EditorChatState => ({
  project,
  page: 'edit',
  frame: 144,
  selectedIds: ['clip-1'],
  selectedItems: [],
  selectedLayerId: null,
  selectedBeatIds: [],
  selectedZoom: null,
  selectedMotionLayerId: 'primary',
  selectedMotionTrackId: null,
  dirty: false,
  ...patch,
});

describe('the editor’s note for the agent', () => {
  it('no video open: nothing', () => {
    expect(editorChatNote(state({ project: null }))).toBeNull();
  });

  it('the edit page with nothing picked: the video, the playhead, the format and the clip the editor has selected', () => {
    expect(editorChatNote(state())).toEqual({
      v: { id: VIDEO, title: 'Hello Studio' },
      page: 'edit',
      t: 2.4,
      fmt: 'YouTube (16:9), 1920×1080 at 60 fps',
      sel: [{ k: 'clip', id: 'clip-1', label: 'canvas.mp4', from: 0, to: 5 }],
    });
  });

  it('a layer picked: the layer, with its words and its time, and not the clip under it', () => {
    const note = editorChatNote(state({ selectedLayerId: 'layer-headline', selectedItems: [{ kind: 'layer', id: 'layer-headline' }] }))!;
    expect(note.sel).toEqual([{ k: 'layer', id: 'layer-headline', kind: 'text', label: 'Headline', text: 'Hello, Fernhill', from: 0, to: 3 }]);
  });

  it('a zoom, a clip’s own layer and its motion track, and an audio track: each by id', () => {
    const note = editorChatNote(state({ selectedZoom: 'zoom-1', selectedMotionLayerId: 'm-title', selectedMotionTrackId: 'trk-1', selectedItems: [{ kind: 'audio', trackId: 'music-1', segmentId: 'seg-1' }] }))!;
    expect(note.sel).toEqual([
      { k: 'layer', id: 'm-title', kind: 'motion text', text: 'Inside the clip' },
      { k: 'track', id: 'trk-1', kind: 'motion', label: 'opacity of m-title' },
      { k: 'zoom', id: 'zoom-1', from: 1, to: 2 },
      { k: 'track', id: 'music-1', kind: 'music audio', label: 'Bed' },
    ]);
  });

  it('the storyboard: the beat picked, no playhead or format', () => {
    const note = editorChatNote(state({ page: 'storyboard', selectedBeatIds: ['beat-1'] }))!;
    expect(note).toEqual({ v: { id: VIDEO, title: 'Hello Studio' }, page: 'storyboard', sel: [{ k: 'beat', id: 'beat-1', label: 'The hook', from: 0, to: 2 }] });
  });

  it('the overview and the cast: the video and the page alone', () => {
    expect(editorChatNote(state({ page: 'overview' }))).toEqual({ v: { id: VIDEO, title: 'Hello Studio' }, page: 'overview' });
    expect(editorChatNote(state({ page: 'cast', selectedBeatIds: ['beat-1'] }))).toEqual({ v: { id: VIDEO, title: 'Hello Studio' }, page: 'cast' });
  });

  it('says when edits are unsaved', () => {
    expect(editorChatNote(state({ dirty: true }))!.dirty).toBe(true);
  });

  it('stays small: long words cut short, at most six things', () => {
    const long = { ...project, title: 'T'.repeat(300), layers: Array.from({ length: 9 }, (_, i) => ({ id: `l${i}`, kind: 'text', name: 'N'.repeat(100), startFrame: 0, endFrame: 60, style: { text: 'w '.repeat(1000) } })) } as unknown as EditorProject;
    const note = editorChatNote(state({ project: long, selectedItems: long.layers!.map(l => ({ kind: 'layer' as const, id: l.id })) }))!;
    expect(note.v.title.length).toBeLessThanOrEqual(120);
    expect(note.sel).toHaveLength(6);
    expect(note.sel![0].label!.length).toBeLessThanOrEqual(60);
    expect(note.sel![0].text!.length).toBeLessThanOrEqual(80);
    expect(new TextEncoder().encode(JSON.stringify(note)).length).toBeLessThan(2000);
  });
});
