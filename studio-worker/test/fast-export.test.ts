/**
 * The FFmpeg export's gate, feature by feature: a made-up video that is only a recording and its camera bubble goes
 * through; each thing it was not proven on sends it to Chrome with a reason; a key it does not know fails closed. And
 * the frame arithmetic it is built on. (The pictures themselves: test/fast-export-e2e.ts.)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fastExportPlan, placedSlot, realise, realiseProblem, remotionFrame, segmentArgs, soundOnly, sourcesFit, stampsFit, type FastPlan } from '../src/fast-export.ts'
import { hashFrames, joinWavs, sampleFrames, soundRanges, usedFrames } from '../src/fast-export-run.ts'
import { loadConfig } from '../src/config.ts'
import { parseEditorProject, defaultCaptions, defaultPresentation } from '../src/engine.ts'
import type { EditorProject } from '../../web/src/lib/studio/engine/contracts.ts'

const require = createRequire(import.meta.url)
const { neutralMotion, neutralMotionVisual } = require('../../web/src/lib/studio/engine/motion-contracts.ts') as typeof import('../../web/src/lib/studio/engine/motion-contracts.ts')

const sha = (c: string) => c.repeat(64)
const video = (id: string, w: number, h: number, fps: number, frames: number, extra: object = {}) => ({ id, kind: 'video', name: `${id}.mp4`, file: `assets/${sha(id[0]!)}.mp4`, sha256: sha(id[0]!),
  bytes: 1000, width: w, height: h, durationSeconds: frames / fps, sourceFps: fps, sourceFrames: frames, hasAudio: false, sourceCursorHidden: false, ...extra })

/** A recording (60 fps, 1280×720, 6 s), its camera (30 fps) as the bubble, a microphone track. */
function base(over: (p: Record<string, any>) => void = () => {}): EditorProject {
  const p: Record<string, any> = {
    schemaVersion: 4, id: 'p', title: 'T', output: { width: 1280, height: 720, fps: 60 },
    assets: [video('a', 1280, 720, 60, 360), video('b', 1920, 1080, 30, 200), { id: 'c', kind: 'audio', name: 'mic.m4a', file: `assets/${sha('c')}.m4a`, sha256: sha('c'), bytes: 1000, durationSeconds: 6, hasAudio: true, sourceCursorHidden: false }],
    clips: [{ id: 'clip', assetId: 'a', trimStartSourceFrame: 0, trimEndSourceFrame: 360, audio: { muted: true, gain: 1 }, holdEndFrames: 0, zooms: [], motion: neutralMotion(), playbackRate: 1, dismissedActionIndices: [], view: { main: 'screen', bubble: true } }],
    presentation: structuredClone(defaultPresentation), cursor: { style: 'none', size: 18, clickFeedback: false },
    audioTracks: [{ id: 'mic', name: 'Microphone', role: 'voiceover', gain: 1, muted: false, segments: [{ id: 's', assetId: 'c', startFrame: 0, trimStartSeconds: 0, trimEndSeconds: 5.9 }] }],
    presenterTrack: { id: 'pt', assetId: 'b', audio: { muted: true, gain: 1 }, segments: [{ id: 'seg', startFrame: 0, endFrame: 360, sourceStartFrame: 0,
      visual: { ...structuredClone(neutralMotionVisual), rect: { x: 0.75, y: 0.6, width: 0.2, height: 0.35 } }, tracks: [] }], sync: { screenAssetId: 'a', offsetSeconds: 0.25 } },
    transcripts: [], captions: { ...defaultCaptions }, captionCorrections: {}, voiceoverDraft: { text: '', targetClipIds: [] },
  }
  over(p)
  return parseEditorProject(p)
}
const reason = (p: EditorProject) => { const r = fastExportPlan(p); return 'reason' in r ? r.reason : null }
const plan = (p: EditorProject) => { const r = fastExportPlan(p); assert.ok(!('reason' in r), 'reason' in r ? r.reason : ''); return r as FastPlan }

test('a recording with its camera bubble and a microphone is composed by FFmpeg', () => {
  const p = plan(base())
  assert.equal(p.frames, 360)
  assert.equal(p.segments.length, 1)
  const s = p.segments[0]!
  assert.deepEqual(s.screen.map.slice(0, 4), [0, 1, 2, 3])
  // The camera starts 0.25 s in (15 frames), its 30 fps frames each shown twice.
  assert.equal(s.bubble!.offset, 15)
  assert.deepEqual(s.bubble!.camera.map.slice(0, 5), [0, 0, 1, 1, 2])
  assert.equal(s.bubble!.radius, s.bubble!.square.side / 2, 'a circle')
})

test('cuts in one recording blend at the cut, a 2x stretch takes every other frame, a take may start mid-source', () => {
  const p = plan(base((x) => {
    x.assets[0].trace = { viewport: { width: 1280, height: 720, scale: 1 }, cursor: [], actions: [{ t: 2000, end: 3200, kind: 'type', label: 'Typing', box: null }] }
    x.clips = [
      { ...x.clips[0], id: 'c1', trimStartSourceFrame: 7, trimEndSourceFrame: 101 },
      { ...x.clips[0], id: 'c2', trimStartSourceFrame: 121, trimEndSourceFrame: 187, playbackRate: 2 },
      { ...x.clips[0], id: 'c3', trimStartSourceFrame: 211, trimEndSourceFrame: 333 },
    ]
  }))
  const [a, b, c] = p.segments
  assert.deepEqual(a!.screen.map.slice(0, 2), [7, 8])
  assert.equal(a!.screen.map.at(-1), 100)
  assert.deepEqual(b!.screen.map.slice(0, 3), [121, 123, 125])
  assert.deepEqual(b!.blend, { file: a!.screen.file, srcFps: 60, index: 100, frames: 7 })
  assert.equal(c!.blend!.index, b!.screen.map.at(-1))
  assert.equal(p.frames, 94 + 33 + 122)
})

test('each thing not proven sends the export to Chrome, with a reason', () => {
  const cases: [string, (p: Record<string, any>) => void, RegExp][] = [
    ['layers', (p) => { p.layers = [{ id: 'l', kind: 'text', startFrame: 0, endFrame: 10, text: 'Hi', style: {}, automation: [] }] }, /layers/],
    ['captions', (p) => { p.captions.enabled = true }, /captions/],
    ['a platform format', (p) => { p.delivery = { format: 'tiktok' } }, /format/],
    ['a zoom', (p) => { p.clips[0].zooms = [{ id: 'z', startClipFrame: 10, endClipFrame: 40, scale: 1.5, x: 0.5, y: 0.5, transitionFrames: 5 }] }, /zoom/],
    ['a held end', (p) => { p.clips[0].holdEndFrames = 10 }, /holds/],
    ['a chosen transition', (p) => { p.clips[0].transitionIn = { kind: 'dip-black', seconds: 0.5 } }, /transition/],
    ['a layout', (p) => { p.clips[0].view = { main: 'screen', bubble: false, layout: { kind: 'split', sources: ['screen', 'camera'] } } }, /layout/],
    ['the camera full frame', (p) => { p.clips[0].view = { main: 'camera', bubble: false } }, /camera/],
    ['padding', (p) => { p.presentation.padding = 40 }, /padding/],
    ['rounded window corners', (p) => { p.presentation.radius = 12 }, /rounded/],
    ['an image background', (p) => { p.presentation.background = { ...p.presentation.background, kind: 'image', assetId: 'b' } }, /background/],
    ['camera fill', (p) => { p.presentation.cameraFill = true }, /camera/],
    ['automation', (p) => { p.automation = { lanes: [{ param: 'zoom', points: [{ frame: 0, value: 1.2 }] }] } }, /automation/],
    ['volume automation', (p) => { p.automation = { lanes: [{ param: 'volume', points: [{ frame: 0, value: 0.5 }] }] } }, /automation/],
    ['a moving camera', (p) => { p.presenterTrack.segments[0].tracks = [{ id: 't', target: 'presenter', property: 'x', keys: [] }] }, /moves|camera/],
    ['a tilted camera', (p) => { p.presenterTrack.segments[0].visual.tiltX = 10 }, /tilted/],
    ['a cropped camera', (p) => { p.presenterTrack.segments[0].visual.crop = { x: 0.1, y: 0, width: 0.8, height: 1 } }, /cropped/],
    ["the camera's sound", (p) => { p.presenterTrack.audio.muted = false; p.assets[1].hasAudio = true }, /sound/],
    ['an unsynced camera', (p) => { delete p.presenterTrack.sync }, /synced/],
    ['punched-in takes', (p) => { p.presenterTrack.takes = [{ screenAssetId: 'a', assetId: 'b', offsetSeconds: 0 }] }, /takes/],
    ['a 60 fps camera in a 60 fps video', (p) => { p.assets[1] = video('b', 1920, 1080, 60, 400) }, /60 fps in a 60/],
    ['a drawn pointer', (p) => { p.assets[0].sourceCursorHidden = true; p.assets[0].trace = { viewport: { width: 1280, height: 720, scale: 1 }, cursor: [[0, 1, 1]], actions: [] }; p.cursor.style = 'arrow' }, /pointer/],
    ['a recording at another size', (p) => { p.output = { width: 1920, height: 1080, fps: 60 } }, /size/],
    ['a recording at another rate', (p) => { p.output.fps = 30 }, /rate/],
    ['24 fps', (p) => { p.output.fps = 24; p.assets[0] = video('a', 1280, 720, 24, 144) }, /24 fps/],
    ['a WebM recording', (p) => { p.assets[0].file = `assets/${sha('a')}.webm` }, /MP4/],
    ['subject cut-outs', (p) => { p.cutouts = [{ assetId: 'a', cutoutAssetId: 'b', mode: 'person' }] }, /cut-out/],
    ['extra recorded sources', (p) => { p.sources = [{ id: 'src-1', kind: 'window', assetId: 'b', name: 'Window' }] }, /extra/],
    ['no sound at all', (p) => { p.audioTracks = [] }, /sound/],
    // presenterRadius rounds to whole pixels: a radius under half a pixel is 0, a square the mask is not proven for.
    ['a rounded bubble with square corners', (p) => { p.presenterTrack.style = { shape: 'rounded', radius: 0.001 } }, /square/],
  ]
  for (const [name, change, why] of cases) {
    // Changed after the schema's check: the gate sees what the export job would see, whatever filled it.
    const project = structuredClone(base())
    change(project as unknown as Record<string, any>)
    const r = reason(project)
    assert.ok(r, `${name} went through`)
    assert.match(r!, why, `${name}: ${r}`)
  }
})

test('a key the gate does not know, at any level, fails closed', () => {
  const add = (where: (p: EditorProject) => object) => { const p = structuredClone(base()); Object.assign(where(p), { glow: 1 }); return reason(p) }
  assert.match(add((p) => p)!, /glow/)
  assert.match(add((p) => p.clips[0]!)!, /glow/)
  assert.match(add((p) => p.presentation)!, /glow/)
  assert.match(add((p) => p.presenterTrack!)!, /glow/)
  assert.match(add((p) => p.presenterTrack!.segments[0]!)!, /glow/)
  assert.match(add((p) => p.presenterTrack!.segments[0]!.visual)!, /glow/)
  assert.match(add((p) => (p.clips[0]!.view ??= { main: 'screen', bubble: true }))!, /glow/)
})

test("the frame @remotion/media shows: the latest at or before the clip's time, a millisecond's grace", () => {
  assert.deepEqual([0, 1, 2, 3].map((l) => remotionFrame(l, 60, 1, 0, 30)), [0, 0, 1, 1])
  assert.deepEqual([0, 1, 2].map((l) => remotionFrame(l, 30, 2, 7, 60)), [14, 18, 22])
  // A time a hair before a frame (float) still shows it; 0.137 s into a 30 fps camera is frame 4.
  assert.equal(remotionFrame(0, 30, 1, (77 / 30 + 0.2) * 30, 30), 83)
  assert.equal(remotionFrame(0, 60, 1, 0.137 * 60, 30), 4)
  // The millisecond's grace: frame 10 of a 30 fps camera is at 0.33333 s. At 0.3324 s (0.93 ms before it; 0.332 against
  // 0.333 rounded) it already shows; at 0.3322 s (1.13 ms before) the frame before does.
  assert.equal(remotionFrame(0, 60, 1, 0.3324 * 60, 30), 10)
  assert.equal(remotionFrame(0, 60, 1, 0.3322 * 60, 30), 9)
})

test('FFmpeg is placed to show exactly those frames, and refuses a placement a hair from a boundary', () => {
  const s = { file: 'x', srcFps: 30, rate: 1, startSeconds: 0.137, map: Array.from({ length: 90 }, (_, l) => remotionFrame(l, 60, 1, 0.137 * 60, 30)) }
  assert.equal(realiseProblem(s, 60), null)
  assert.equal(placedSlot(4, s, 60) + 0, 0)
  assert.equal(realiseProblem({ ...s, map: [...s.map.slice(0, 10), s.map[10]! + 1, ...s.map.slice(11)] }, 60)?.startsWith('FFmpeg would show'), true)
  assert.match(realise(s, 60, 90), /fps=60,trim=start=0.*trim=end_frame=90$/)
})

test("one clip's FFmpeg graph: the blend counts its frames by time, every stream on one 1/fps clock, the Chrome path's labels", () => {
  const p = plan(base((x) => { x.clips = [{ ...x.clips[0], id: 'c1', trimEndSourceFrame: 100 }, { ...x.clips[0], id: 'c2', trimStartSourceFrame: 140 }] }))
  const args = segmentArgs(p.segments[1]!, 60, (f) => `/cache/${f}`, '/tmp/out.mp4')
  const graph = args[args.indexOf('-filter_complex') + 1]!
  assert.match(graph, /blend=all_expr='A\*min\(1\\,\(round\(T\*60\)\+1\)\/8\)/)
  assert.match(graph, /\[sa\]trim=end_frame=7,settb=1\/60,setpts=N\[head\]/)
  assert.match(graph, /settb=1\/60,setpts=N\+\d+,format=yuva420p\[cam\]/)
  assert.match(graph, /setsar=1,setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709:range=tv/)
  assert.ok(args.includes('-copyts') && args.includes('veryfast') && args.includes('18'))
  assert.equal(args.filter((a) => a === '-i').length, 3, 'the recording, the held frame, the camera')
})

test('the files must be what the plan assumes', () => {
  const ok = { file: 'a', codec: 'h264', pixFmt: 'yuv420p', colorSpace: 'bt709', colorRange: 'tv', startTime: 0 }
  assert.equal(sourcesFit([ok, { ...ok, colorSpace: 'unknown', colorRange: 'unknown' }]), null)
  assert.match(sourcesFit([{ ...ok, codec: 'hevc' }])!, /H.264/)
  assert.match(sourcesFit([{ ...ok, pixFmt: 'yuv444p' }])!, /yuv444p/)
  assert.match(sourcesFit([{ ...ok, colorSpace: 'smpte170m' }])!, /colour/)
  assert.match(sourcesFit([{ ...ok, colorRange: 'pc' }])!, /pc range/)
  assert.match(sourcesFit([{ ...ok, startTime: 0.033 }])!, /start/)
  assert.equal(sourcesFit([{ ...ok, colorPrimaries: 'bt709', colorTransfer: 'bt709', sar: '1:1' }, { ...ok, sar: '0:1', rotation: 0 }]), null)
  assert.match(sourcesFit([{ ...ok, colorPrimaries: 'bt2020' }])!, /primaries/)
  assert.match(sourcesFit([{ ...ok, colorTransfer: 'smpte2084' }])!, /transfer/)
  assert.match(sourcesFit([{ ...ok, sar: '4:3' }])!, /square/)
  assert.match(sourcesFit([{ ...ok, rotation: -90 }])!, /turned/)
})

test("the frames shown must sit on their file's frame grid, each once", () => {
  const grid = Array.from({ length: 40 }, (_, i) => i / 30)
  assert.equal(stampsFit(grid, 30, 5, 30), null)
  assert.equal(stampsFit(grid.map((t, i) => (i === 31 ? t + 0.004 : t)), 30, 5, 30), null, 'a frame outside the stretch is not asked about')
  assert.match(stampsFit(grid.map((t, i) => (i === 12 ? t + 0.0004 : t)), 30, 5, 30)!, /frame 12 .* 0\.40 ms/)
  assert.match(stampsFit(grid.filter((_, i) => i !== 20), 30, 5, 30)!, /frame 20 is missing/)
  assert.match(stampsFit([...grid, 7 / 30 + 0.0001], 30, 5, 30)!, /frame 7 is there twice/)
  assert.equal(stampsFit([...grid, ...grid.slice(3, 9)], 30, 5, 30), null, 'a packet read twice (overlapping reads) is one frame')
  // Times a microsecond off (what ffprobe prints) are on the grid.
  assert.equal(stampsFit(grid.map((t) => Math.round(t * 1e6) / 1e6), 30, 0, 39), null)
})

test('the stretches of each file the plan shows: screens, held frames, the camera', () => {
  const p = plan(base((x) => { x.clips = [{ ...x.clips[0], id: 'c1', trimEndSourceFrame: 100 }, { ...x.clips[0], id: 'c2', trimStartSourceFrame: 140 }] }))
  const u = usedFrames(p)
  assert.deepEqual(u.get(p.segments[0]!.screen.file)!.map((x) => [x.first, x.last]), [[0, 99], [140, 359], [99, 99]])
  assert.equal(u.get(p.segments[0]!.bubble!.camera.file)!.length, 2)
})

test("the sound is Remotion's mix of the same video without the pictures that make none", () => {
  const p = base()
  const s = soundOnly(p)
  assert.ok(s.clips.every((c) => c.view?.main === 'slides' && !c.view.bubble))
  assert.equal(s.presenterTrack, null, 'a muted camera adds nothing to hear')
  assert.deepEqual(s.audioTracks, p.audioTracks)
  assert.deepEqual(s.clips.map((c) => [c.trimStartSourceFrame, c.trimEndSourceFrame, c.audio, c.playbackRate]), p.clips.map((c) => [c.trimStartSourceFrame, c.trimEndSourceFrame, c.audio, c.playbackRate]))
})

test('the frames checked against Chrome: the first with the bubble, a blended one, the one where the recording changes most', () => {
  const p = plan(base((x) => { x.clips = [{ ...x.clips[0], id: 'c1', trimEndSourceFrame: 100 }, { ...x.clips[0], id: 'c2', trimStartSourceFrame: 140 }] }))
  assert.deepEqual(sampleFrames(p), [15, 103, Math.floor(p.frames * 0.8)], 'with nothing known of the changes, one 80 % in')
  // Source frame 200 has the biggest packet: it shows at output frame 100 + (200 - 140) = 160.
  assert.deepEqual(sampleFrames(p, (_, i) => (i === 200 ? 9000 : 100)), [15, 103, 160])
})

test("where the graph's frames are compared with the source's: each clip's ends, after its blend, where it changes most", () => {
  const p = plan(base((x) => { x.clips = [{ ...x.clips[0], id: 'c1', trimEndSourceFrame: 100 }, { ...x.clips[0], id: 'c2', trimStartSourceFrame: 140 }] }))
  const seg = p.segments[1]!
  const h = hashFrames(seg, (file, i) => (file === seg.screen.file ? (i === 170 || i === 171 ? 5000 : 10) : (i === 80 ? 7000 : 10)))
  assert.deepEqual(h.screen, [0, 7, 30, 31, seg.screen.map.length - 1])
  // The camera's frames each show twice (30 fps in 60): only the first showing of a frame is a change.
  const at = seg.bubble!.camera.map.indexOf(80)
  assert.ok(h.camera.includes(at) && !h.camera.includes(at + 1) && h.camera[0] === 0 && h.camera.at(-1) === seg.bubble!.camera.map.length - 1)
  // A keyframe's size says nothing of change: no change known, only the ends (and the blend).
  assert.deepEqual(hashFrames(seg, () => 0).screen, [0, 7, seg.screen.map.length - 1])
})

test('STUDIO_FAST_EXPORT: on by default, off when asked, anything else refused', () => {
  const on = loadConfig({}, () => 4), off = loadConfig({ STUDIO_FAST_EXPORT: 'off' }, () => 4)
  assert.ok(!('problems' in on) && on.fastExport === true)
  assert.ok(!('problems' in off) && off.fastExport === false)
  assert.ok('problems' in loadConfig({ STUDIO_FAST_EXPORT: 'sometimes' }, () => 4))
})

test("the sound in consecutive stretches: whole frames each, joined to exactly their frames' samples", async () => {
  assert.deepEqual(soundRanges(248, 3), [[0, 82], [83, 164], [165, 247]])
  assert.deepEqual(soundRanges(40, 4), [[0, 39]], 'a short video in one')
  const { mkdtemp, writeFile, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'join-wav-'))
  // 16-bit stereo, each sample frame its own index (both channels), one extra frame at the end of each (as Remotion writes).
  const wav = (from: number, frames: number) => {
    const data = Buffer.alloc(frames * 4)
    for (let i = 0; i < frames; i++) { data.writeInt16LE((from + i) % 32000, i * 4); data.writeInt16LE((from + i) % 32000, i * 4 + 2) }
    const fmt = Buffer.alloc(16); fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(2, 2); fmt.writeUInt32LE(48000, 4); fmt.writeUInt32LE(192000, 8); fmt.writeUInt16LE(4, 12); fmt.writeUInt16LE(16, 14)
    const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); fmt.copy(h, 20); h.write('data', 36); h.writeUInt32LE(data.length, 40)
    return Buffer.concat([h, data])
  }
  await writeFile(join(dir, 'a.wav'), wav(0, 801)); await writeFile(join(dir, 'b.wav'), wav(800, 1601))
  await joinWavs([{ file: join(dir, 'a.wav'), samples: 800 }, { file: join(dir, 'b.wav'), samples: 1600 }], join(dir, 'out.wav'))
  const out = await readFile(join(dir, 'out.wav'))
  assert.equal(out.readUInt32LE(40), 2400 * 4)
  for (const i of [0, 799, 800, 801, 2399]) assert.equal(out.readInt16LE(44 + i * 4), i, `sample ${i} continues the one before`)
  await assert.rejects(joinWavs([{ file: join(dir, 'a.wav'), samples: 900 }], join(dir, 'x.wav')), /801 samples, not 900/)
})
