/**
 * The video's sound as layers (sound-layers.ts): what the composition plays and the studio worker's FFmpeg export mixes
 * (studio-worker/src/fast-sound.ts). Made-up projects.
 */
import { describe, expect, it } from 'vitest'
import type { EditorProject } from '../contracts'
import { soundLayers } from '../sound-layers'

const sha = (c: string) => c.repeat(64)
const video = (id: string) => ({ id, kind: 'video', name: `${id}.mp4`, file: `assets/${sha(id[0]!)}.mp4`, sha256: sha(id[0]!), bytes: 1, width: 1280, height: 720,
  sourceFps: 60, sourceFrames: 600, durationSeconds: 10, hasAudio: true, sourceCursorHidden: false })
const audio = (id: string) => ({ id, kind: 'audio', name: `${id}.m4a`, file: `assets/${sha(id[0]!)}.m4a`, sha256: sha(id[0]!), bytes: 1, durationSeconds: 10, hasAudio: true, sourceCursorHidden: false })
const clip = (id: string, from: number, to: number, extra: object = {}) => ({ id, assetId: 'a', trimStartSourceFrame: from, trimEndSourceFrame: to, audio: { muted: false, gain: 1 },
  holdEndFrames: 0, zooms: [], playbackRate: 1, ...extra })

function project(over: Partial<Record<string, unknown>> = {}): EditorProject {
  return { schemaVersion: 4, id: 'p', title: 'T', output: { width: 1280, height: 720, fps: 60 }, assets: [video('a'), audio('m'), audio('n')],
    clips: [clip('c1', 0, 120), clip('c2', 200, 320)], presentation: {}, cursor: {}, audioTracks: [], presenterTrack: null, transcripts: [], captions: { enabled: false },
    captionCorrections: {}, voiceoverDraft: { text: '', targetClipIds: [] }, automation: { lanes: [] }, ...over } as unknown as EditorProject
}

describe('soundLayers', () => {
  it("puts each recording's sound under its clip, with a fade at the cut on both sides", () => {
    const layers = soundLayers(project())
    expect(layers.map((l) => [l.kind, l.key, l.from, l.duration, l.trimBefore, l.playbackRate])).toEqual([
      ['clip', 'audio-c1', 0, 120, 0, 1], ['clip', 'audio-c2', 120, 120, 200, 1]])
    const [a, b] = layers
    expect(a!.volume(0)).toBe(1)
    expect(a!.volume(119)).toBeLessThan(0.5)
    expect(b!.volume(0)).toBeLessThan(0.5)
    expect(b!.volume(60)).toBe(1)
  })

  it('leaves out a muted clip and keeps a sped-up clip at its rate', () => {
    const layers = soundLayers(project({ clips: [clip('c1', 0, 120, { audio: { muted: true, gain: 1 } }), clip('c2', 200, 320)] }))
    expect(layers.map((l) => l.key)).toEqual(['audio-c2'])
  })

  it("plays each audio track's segments, with the track's gain, never on a muted track, cut at the video's end", () => {
    const tracks = [
      { id: 'mic', name: 'Mic', role: 'voiceover', gain: 0.5, muted: false, segments: [
        { id: 'audio-c1', assetId: 'm', startFrame: 30, trimStartSeconds: 1, trimEndSeconds: 2.5 },
        { id: 'late', assetId: 'm', startFrame: 200, trimStartSeconds: 0, trimEndSeconds: 3 },
        { id: 'past', assetId: 'm', startFrame: 400, trimStartSeconds: 0, trimEndSeconds: 1 }] },
      { id: 'off', name: 'Off', role: 'voiceover', gain: 1, muted: true, segments: [{ id: 's', assetId: 'n', startFrame: 0, trimStartSeconds: 0, trimEndSeconds: 1 }] },
    ]
    const layers = soundLayers(project({ audioTracks: tracks })).filter((l) => l.kind === 'track')
    // A segment whose id looks like a clip's sound is still a track's: kinds, not key prefixes, tell them apart.
    expect(layers.map((l) => [l.key, l.from, l.duration, l.trimBefore])).toEqual([['track-mic-audio-c1', 30, 90, 60], ['track-mic-late', 200, 40, 0]])
    expect(new Set(soundLayers(project({ audioTracks: tracks })).map((l) => l.key)).size).toBe(4)
    expect(layers[0]!.volume(10)).toBe(0.5)
  })
})
