// The take -> video builder and how a take is placed into an open video (punch-in, storyboard beats), with made-up
// media: a 10 s screen take at 60 fps with an input trace, a camera that started 0.25 s late, a microphone 0.1 s early.
import { describe, expect, it } from 'vitest'
import { EditorProjectSchema, type EditorAsset, type EditorProject } from '../../engine/contracts'
import { scheduleProject } from '../../engine/timeline'
import {
  buildTakeProject,
  firstCut,
  parseSyncLabel,
  placeTake,
  RecordingInputSchema,
  resyncAudio,
  syncedAudioSegments,
  syncLabel,
  traceFocus,
  voiceAsset,
  wordsOnVoiceClock,
  type TakeMedia,
} from '../recordings'

const hex = (n: number) => n.toString(16).padStart(64, '0')
const trace = {
  viewport: { x: 0, y: 0, width: 1920, height: 1080, scale: 2 },
  cursor: [[0, 10, 10], [500, 400, 300]] as [number, number, number][],
  actions: [{ t: 1200, end: 1250, kind: 'click', label: 'Save', box: { x: 100, y: 100, w: 40, h: 20 } }],
}
function video(id: string, n: number, seconds: number, fps: number, extra: Partial<EditorAsset> = {}): EditorAsset {
  return { id, name: `${id}.mp4`, kind: 'video', file: `assets/${hex(n)}.mp4`, sha256: hex(n), bytes: 1000 + n, width: 1920, height: 1080,
    sourceFps: fps, sourceFrames: Math.round(seconds * fps), durationSeconds: seconds, hasAudio: false, sourceCursorHidden: false, ...extra }
}
function audio(id: string, n: number, seconds: number): EditorAsset {
  return { id, name: `${id}.webm`, kind: 'audio', file: `assets/${hex(n)}.webm`, sha256: hex(n), bytes: 500 + n, durationSeconds: seconds, hasAudio: true, sourceCursorHidden: false }
}
const screen = video('screen-1', 1, 10, 60, { trace, sourceCursorHidden: true })
const camera = video('camera-1', 2, 9.5, 30)
const mic = audio('mic-1', 3, 10.2)
const media: TakeMedia = { screen, camera: { asset: camera, offsetSeconds: 0.25 }, microphone: { asset: mic, offsetSeconds: -0.1 }, systemAudio: null }
const ID = '11111111-2222-4333-8444-555555555555'

describe('buildTakeProject', () => {
  it('opens a take as one whole clip at the screen rate, with the cursor redrawn from the trace', () => {
    const project = buildTakeProject({ id: ID, title: 'Demo take', media })
    expect(project.output).toEqual({ width: 1920, height: 1080, fps: 60 })
    expect(project.clips).toHaveLength(1)
    expect(project.clips[0]).toMatchObject({ assetId: 'screen-1', trimStartSourceFrame: 0, trimEndSourceFrame: 600, view: { main: 'screen', bubble: true } })
    expect(project.cursor.style).toBe('glass')
    expect(() => EditorProjectSchema.parse(project)).not.toThrow()
  })

  it('puts the camera on the screen clock as the presenter bubble', () => {
    const project = buildTakeProject({ id: ID, title: 'Demo take', media })
    const presenter = project.presenterTrack!
    expect(presenter.assetId).toBe('camera-1')
    expect(presenter.sync).toEqual({ screenAssetId: 'screen-1', offsetSeconds: 0.25 })
    expect(presenter.audio.muted).toBe(true)
    // 0.25 s late at 60 fps = frame 15; no longer than the camera (9.5 s = 570 frames).
    expect(presenter.segments[0]).toMatchObject({ startFrame: 15, endFrame: 15 + 570, sourceStartFrame: 0 })
  })

  it('lays the microphone under the screen clip, shifted by its offset', () => {
    const project = buildTakeProject({ id: ID, title: 'Demo take', media })
    const track = project.audioTracks.find((t) => t.name === 'Microphone')!
    expect(track.role).toBe('voiceover')
    expect(track.segments).toHaveLength(1)
    // mic time = screen time + 0.1: screen 0..10 s is mic 0.1..10.1 s.
    expect(track.segments[0]).toMatchObject({ assetId: 'mic-1', startFrame: 0, trimStartSeconds: 0.1, trimEndSeconds: 10.1, label: syncLabel('screen-1', -0.1) })
  })

  it('starts a late microphone where it starts on the timeline', () => {
    const late: TakeMedia = { ...media, microphone: { asset: mic, offsetSeconds: 0.5 } }
    const project = buildTakeProject({ id: ID, title: 'Demo take', media: late })
    const segment = project.audioTracks[0]!.segments[0]!
    expect(segment.startFrame).toBe(30)
    expect(segment.trimStartSeconds).toBe(0)
    expect(segment.trimEndSeconds).toBeCloseTo(9.5, 6)
  })

  it('makes a plain take without a trace, camera or microphone', () => {
    const plain = video('screen-2', 4, 4, 60)
    const project = buildTakeProject({ id: ID, title: 'Plain', media: { screen: plain, camera: null, microphone: null, systemAudio: null } })
    expect(project.clips).toHaveLength(1)
    expect(project.clips[0]!.view).toEqual({ main: 'screen', bubble: false })
    expect(project.clips[0]!.audio.muted).toBe(true)
    expect(project.presenterTrack).toBeNull()
    expect(project.audioTracks).toEqual([])
    expect(project.cursor.style).toBe('none')
  })

  it('refuses a screen take it cannot read', () => {
    expect(() => buildTakeProject({ id: ID, title: 'x', media: { ...media, screen: { ...screen, sourceFps: undefined } } })).toThrow(/could not be read/)
  })
})

describe('first cut', () => {
  it('reads focus changes from the trace', () => {
    expect(traceFocus({ ...trace, focus: [{ t: 3000, focus: 'slides' }, { ms: 6000, slides: false }] } as never)).toEqual([{ ms: 3000, slides: true }, { ms: 6000, slides: false }])
    expect(traceFocus({ ...trace, actions: [...trace.actions, { t: 2000, end: 2000, kind: 'focus', label: 'Slides', box: null, slides: true }] } as never)).toEqual([{ ms: 2000, slides: true }])
    expect(traceFocus(undefined)).toEqual([])
  })

  it('cuts between the screen and the slides when the take has slides to cut to', () => {
    const focused = { ...screen, trace: { ...trace, focus: [{ t: 3000, slides: true }, { t: 7000, slides: false }] } } as EditorAsset
    const whole = buildTakeProject({ id: ID, title: 'x', media: { ...media, screen: focused } }).clips[0]!
    const cut = firstCut({ ...whole, view: undefined }, focused, { camera: true, slides: true })
    expect(cut.map((c) => c.view?.main)).toEqual(['screen', 'slides', 'screen'])
    expect(cut.map((c) => [c.trimStartSourceFrame, c.trimEndSourceFrame])).toEqual([[0, 180], [180, 420], [420, 600]])
    // Without slides in the take there is nothing else to show: one clip.
    expect(firstCut(whole, focused, { camera: true, slides: false })).toHaveLength(1)
  })
})

describe('synced audio', () => {
  it('follows every clip of its screen take after cuts and moves', () => {
    let project = buildTakeProject({ id: ID, title: 'x', media })
    // Cut the first 2 s away: the clip now starts at source frame 120 and sits at timeline frame 0.
    project = { ...project, clips: [{ ...project.clips[0]!, trimStartSourceFrame: 120 }] }
    const segments = syncedAudioSegments(project, 'screen-1', mic, -0.1)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ startFrame: 0, trimStartSeconds: 2.1, trimEndSeconds: 10.1 })
    const resynced = resyncAudio(project)
    expect(resynced.audioTracks[0]!.segments[0]).toMatchObject({ trimStartSeconds: 2.1, startFrame: 0 })
  })

  it('leaves sped-up clips silent and other segments alone', () => {
    const project = buildTakeProject({ id: ID, title: 'x', media })
    const fast = { ...project, clips: [{ ...project.clips[0]!, playbackRate: 2 }] }
    expect(syncedAudioSegments(fast, 'screen-1', mic, -0.1)).toEqual([])
    const music = audio('music-1', 9, 30)
    const withMusic = { ...project, assets: [...project.assets, music], audioTracks: [...project.audioTracks, { id: 'music', name: 'Music', role: 'music' as const, gain: 1, muted: false, segments: [{ id: 'm1', assetId: 'music-1', startFrame: 0, trimStartSeconds: 0, trimEndSeconds: 5 }] }] }
    expect(resyncAudio(withMusic).audioTracks.find((t) => t.id === 'music')).toEqual(withMusic.audioTracks.find((t) => t.id === 'music'))
  })

  it('reads its label back', () => {
    expect(parseSyncLabel(syncLabel('screen-1', 0.25))).toEqual({ screenAssetId: 'screen-1', offsetSeconds: 0.25 })
    expect(parseSyncLabel(syncLabel('screen-1', -1.5))).toEqual({ screenAssetId: 'screen-1', offsetSeconds: -1.5 })
    expect(parseSyncLabel('Applause')).toBeNull()
    expect(parseSyncLabel(undefined)).toBeNull()
  })
})

describe('transcript words', () => {
  it('moves words from the screen clock onto the microphone clock and drops what falls outside', () => {
    const voice = voiceAsset(media)!
    expect(voice.asset.id).toBe('mic-1')
    const words = wordsOnVoiceClock([{ text: 'hello', startMs: 500, endMs: 800 }, { text: 'there', startMs: 900, endMs: 1200 }, { text: 'late', startMs: 20_000, endMs: 20_500 }], voice)
    expect(words).toEqual([{ text: 'hello', startMs: 600, endMs: 900 }, { text: 'there', startMs: 1000, endMs: 1300 }])
  })

  it('uses the screen take when there is no microphone file but the screen has sound', () => {
    const loud = { ...screen, hasAudio: true }
    expect(voiceAsset({ screen: loud, camera: null, microphone: null, systemAudio: null })).toEqual({ asset: loud, offsetSeconds: 0 })
    expect(voiceAsset({ screen, camera: null, microphone: null, systemAudio: null })).toBeNull()
  })
})

/** A target video: a 6 s screen take of its own at 60 fps with its own synced microphone. */
function target(): EditorProject {
  const own = video('screen-0', 10, 6, 60)
  const ownMic = audio('mic-0', 11, 6)
  return buildTakeProject({ id: '99999999-2222-4333-8444-555555555555', title: 'Target', media: { screen: own, camera: null, microphone: { asset: ownMic, offsetSeconds: 0 }, systemAudio: null } })
}

describe('placing a take', () => {
  const info = { sessionId: ID, at: '2026-11-12T09:00:00.000Z', screenAssetId: 'screen-1' }

  it('inserts a punch-in with its narration, and moves the narration after it along', () => {
    const before = target()
    const take = buildTakeProject({ id: ID, title: 'Take', media: { ...media, camera: null } })
    const placed = placeTake(before, take, { kind: 'punch', fromFrame: 120, toFrame: 120 }, info)
    const schedule = scheduleProject(placed)
    expect(schedule.map((s) => [s.asset.id, s.startFrame, s.durationFrames])).toEqual([['screen-0', 0, 120], ['screen-1', 120, 600], ['screen-0', 720, 240]])
    const mics = placed.audioTracks.filter((t) => t.name === 'Microphone')
    expect(mics).toHaveLength(1)
    const segments = mics[0]!.segments
    // The target's narration is split around the take and its second part moved with its picture.
    expect(segments.map((s) => [s.assetId, s.startFrame, s.trimStartSeconds, s.trimEndSeconds])).toEqual([
      ['mic-0', 0, 0, 2], ['mic-1', 120, 0.1, 10.1], ['mic-0', 720, 2, 6],
    ])
    expect(placed.assets.some((a) => a.id === 'mic-1')).toBe(true)
  })

  it('replaces a stretch with the take', () => {
    const take = buildTakeProject({ id: ID, title: 'Take', media: { ...media, camera: null, microphone: null } })
    const placed = placeTake(target(), take, { kind: 'punch', fromFrame: 60, toFrame: 180 }, info)
    expect(scheduleProject(placed).map((s) => [s.asset.id, s.durationFrames])).toEqual([['screen-0', 60], ['screen-1', 600], ['screen-0', 180]])
  })

  it('records into storyboard beats, split by the teleprompter marks', () => {
    const base = target()
    const withBoard: EditorProject = { ...base, storyboard: { beats: [
      { id: 'b1', words: 'First line', startFrame: 0, durationFrames: 120, source: 'screen', status: 'planned' },
      { id: 'b2', words: 'Second line', startFrame: 120, durationFrames: 120, source: 'screen', status: 'planned' },
    ] } }
    const take = buildTakeProject({ id: ID, title: 'Take', media: { ...media, camera: null } })
    const placed = placeTake(withBoard, take, { kind: 'beats', beatIds: ['b1', 'b2'], marks: [{ ms: 4000, beat: 1 }], extraCameraSlots: ['B', 'C', 'D'] }, info)
    const beats = placed.storyboard!.beats
    expect(beats.map((b) => b.status)).toEqual(['recorded', 'recorded'])
    expect(beats[0]!.takes?.[0]).toMatchObject({ sessionId: ID, screenAssetId: 'screen-1' })
    expect(beats[1]!.startFrame).toBe(beats[0]!.startFrame + beats[0]!.durationFrames)
    // Beat 2 starts at the mark (4 s into the take).
    expect(beats[0]!.durationFrames).toBe(240)
    // Every piece of the take keeps its narration under it.
    const takeClips = scheduleProject(placed).filter((s) => s.asset.id === 'screen-1')
    const micSegments = placed.audioTracks.flatMap((t) => t.segments).filter((s) => s.assetId === 'mic-1')
    expect(micSegments.length).toBe(takeClips.length)
    for (const [i, s] of takeClips.entries()) expect(micSegments[i]!.startFrame).toBe(s.startFrame)
    expect(() => EditorProjectSchema.parse(placed)).not.toThrow()
  })
})

describe('the request', () => {
  const key = (n: number) => `uploads/${String(n).repeat(8)}-0000-4000-8000-000000000000`
  it('accepts a browser take and a desktop take with a trace and words', () => {
    expect(RecordingInputSchema.parse({ screen: { uploadKey: key(1), name: 'Screen.webm' }, microphone: { uploadKey: key(2), name: 'Mic.webm', offsetSeconds: 0.02 } })).toMatchObject({ recorder: 'browser', sourceCursorHidden: false })
    const desktop = RecordingInputSchema.parse({ recorder: 'desktop', screen: { uploadKey: key(1), name: 'Screen.mov' }, trace, sourceCursorHidden: true, transcript: { words: [{ text: 'hi', startMs: 0, endMs: 200 }] },
      punch: { projectId: ID, fromFrame: 10, toFrame: 20 } })
    expect(desktop.punch).toEqual({ projectId: ID, fromFrame: 10, toFrame: 20 })
  })

  it('refuses keys that are not uploads, a backwards punch, and a punch with beats', () => {
    expect(() => RecordingInputSchema.parse({ screen: { uploadKey: 'assets/x', name: 'Screen.webm' } })).toThrow()
    expect(() => RecordingInputSchema.parse({ screen: { uploadKey: key(1), name: 'S.webm' }, punch: { projectId: ID, fromFrame: 20, toFrame: 10 } })).toThrow()
    expect(() => RecordingInputSchema.parse({ screen: { uploadKey: key(1), name: 'S.webm' }, punch: { projectId: ID, fromFrame: 1, toFrame: 1 }, beats: { projectId: ID, beatIds: ['b1'] } })).toThrow()
  })
})
