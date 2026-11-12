import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAsset, measure, missingDuration } from '../src/assets.ts'
import { AssetCache, evictionPlan } from '../src/cache.ts'
import { constantFrameTiming, kindOfName, onFrameGrid, parseProbe, parseRate, parseStamps, VARIABLE_RATE, waveformPeaks, type Probe } from '../src/media.ts'
import { parseLoudnorm, parseTruePeak } from '../src/master.ts'
import { pngSize, unstagedNeeds } from '../src/render.ts'
import { failureMessage } from '../src/runner.ts'
import { JobError } from '../src/jobs/context.ts'
import { frameAt } from '../src/jobs/stills.ts'
import { thumbnailScale } from '../src/jobs/thumbnail.ts'
import { pageOrder } from '../src/jobs/slides.ts'
import { EditorAssetSchema } from '../src/engine.ts'

const SHA = 'a'.repeat(64)

test('a probe is read for the parts relied on, and junk is refused', () => {
  const p = parseProbe(JSON.stringify({ streams: [{ codec_type: 'video', width: 1280, height: 720, avg_frame_rate: '30/1' }, { nope: 1 }, null], format: { duration: '3.0' } }))
  assert.equal(p.streams.length, 1)
  assert.equal(p.format.duration, '3.0')
  assert.deepEqual(parseProbe('{}'), { streams: [], format: {} })
  assert.throws(() => parseProbe('not json'), /ffprobe/)
})

test('frame rates as ffprobe writes them', () => {
  assert.equal(parseRate('30/1'), 30)
  assert.ok(Math.abs(parseRate('30000/1001') - 29.97) < 0.001)
  assert.ok(Number.isNaN(parseRate('0/0')))
  assert.ok(Number.isNaN(parseRate(undefined)))
})

test('file names map to the kinds the editor imports', () => {
  assert.deepEqual(kindOfName('Take 1.MOV'), { kind: 'video', extension: 'mov' })
  assert.deepEqual(kindOfName('a.jpeg'), { kind: 'image', extension: 'jpeg' })
  assert.deepEqual(kindOfName('x.flac'), { kind: 'audio', extension: 'flac' })
  // The app takes .m4v (chat uploads, workspace files): the import reads it as the MP4 it is.
  assert.deepEqual(kindOfName('Trailer.M4V'), { kind: 'video', extension: 'mp4' })
  assert.equal(kindOfName('deck.pdf'), null)
  assert.equal(kindOfName('noextension'), null)
})

test('frame timing: a steady grid passes, a gap fails, WebM gets its millisecond slack', () => {
  const grid = Array.from({ length: 90 }, (_, i) => i / 30)
  assert.ok(constantFrameTiming(grid, 30, 'mp4'))
  const ms = grid.map((t) => Math.round(t * 1000) / 1000)
  assert.ok(constantFrameTiming(ms, 30, 'webm'), 'millisecond timestamps are fine in WebM')
  const gap = [...grid.slice(0, 30), ...grid.slice(30).map((t) => t + 0.05)]
  assert.ok(!constantFrameTiming(gap, 30, 'mp4'))
  assert.deepEqual(parseStamps('0.066\n0.000,\n0.033\n\nN/A\n'), [0, 0.033, 0.066])
  assert.ok(onFrameGrid(Array.from({ length: 10 }, (_, i) => i / 60), 60))
  assert.ok(!onFrameGrid(Array.from({ length: 10 }, (_, i) => i / 60), 30))
  assert.ok(!onFrameGrid([0], 30))
})

test('the waveform is the peak of each stretch, at most 600 bins, inside 0..1', () => {
  const n = 3000
  const buf = Buffer.alloc(n * 4)
  for (let i = 0; i < n; i++) buf.writeFloatLE(i < 1500 ? 0.25 * Math.sin(i) : -1.5, i * 4)
  const peaks = waveformPeaks(buf)
  assert.equal(peaks.length, 600)
  assert.ok(peaks.slice(0, 290).every((p) => p <= 0.25 && p >= 0))
  assert.ok(peaks.slice(310).every((p) => p === 1), 'clipped to 1')
  assert.deepEqual(waveformPeaks(Buffer.alloc(8)), [0, 0])
  assert.deepEqual(waveformPeaks(Buffer.alloc(0)), [])
})

const videoProbe = (over: Partial<Probe['streams'][number]> = {}, format: Probe['format'] = {}): Probe => ({
  streams: [{ codec_type: 'video', width: 1280, height: 720, avg_frame_rate: '30/1', nb_read_packets: '90', duration: '3.000000', ...over }, { codec_type: 'audio' }],
  format,
})

test('measuring follows the editor’s rules and says why it refuses', () => {
  const stamps = Array.from({ length: 90 }, (_, i) => i / 30)
  assert.deepEqual(measure(videoProbe(), 'video', 'mp4', stamps), { kind: 'video', extension: 'mp4', hasAudio: true, width: 1280, height: 720, durationSeconds: 3, sourceFps: 30, sourceFrames: 90 })
  assert.throws(() => measure({ streams: [{ codec_type: 'audio' }], format: { duration: '1' } }, 'video', 'mp4', []), /does not match its file type/)
  assert.throws(() => measure(videoProbe({ duration: undefined }), 'video', 'webm', stamps), /duration must be positive/)
  assert.throws(() => measure(videoProbe({ duration: '9000' }), 'video', 'mp4', stamps), /at most two hours/)
  assert.throws(() => measure(videoProbe({ avg_frame_rate: '0/0' }), 'video', 'mp4', stamps), /invalid frame timing/)
  assert.throws(() => measure(videoProbe(), 'video', 'mp4', [...stamps.slice(0, 45), ...stamps.slice(45).map((t) => t + 0.1)]), (e: Error) => e.message === VARIABLE_RATE)
  assert.throws(() => measure(videoProbe(), 'video', 'mp4', stamps.slice(1)), /verify constant frame timing/)
  const image = measure({ streams: [{ codec_type: 'video', width: 800, height: 600 }], format: {} }, 'image', 'png', null)
  assert.deepEqual(image, { kind: 'image', extension: 'png', hasAudio: false, width: 800, height: 600 })
  assert.ok(missingDuration({ streams: [{ codec_type: 'video' }], format: {} }))
  assert.ok(missingDuration({ streams: [{ codec_type: 'video', duration: 'N/A' }], format: {} }))
  assert.ok(!missingDuration({ streams: [{ codec_type: 'video' }], format: { duration: '2.5' } }))
})

test('an asset is named by its digest and checked by the engine’s schema', () => {
  const m = measure(videoProbe(), 'video', 'mp4', null)
  const asset = buildAsset(m, { sha256: SHA, bytes: 1234 }, { name: '  Demo take.mp4 ', waveform: [0, 0.5, 1], sourceCursorHidden: true, provenance: { from: 'test' } })
  assert.equal(asset.id, SHA)
  assert.equal(asset.file, `assets/${SHA}.mp4`)
  assert.equal(asset.name, 'Demo take.mp4')
  assert.equal(asset.sourceCursorHidden, true)
  assert.deepEqual(asset.waveform, [0, 0.5, 1])
  assert.ok(EditorAssetSchema.safeParse(asset).success)
  const quiet = buildAsset({ ...m, hasAudio: false }, { sha256: SHA, bytes: 1 }, { name: 'x', waveform: [1] })
  assert.equal(quiet.waveform, undefined, 'no waveform without sound')
  assert.equal(quiet.provenance, undefined)
  const trace = { viewport: { width: 1280, height: 720, scale: 2 }, cursor: [[0, 10, 10]], actions: [] }
  assert.deepEqual(buildAsset(m, { sha256: SHA, bytes: 1 }, { name: 'x', trace }).trace, trace)
  assert.throws(() => buildAsset(m, { sha256: SHA, bytes: 1 }, { name: 'x', trace: { cursor: 'nope' } }), (e: Error) => e instanceof JobError && /valid asset/.test(e.message))
  assert.throws(() => buildAsset(m, { sha256: SHA, bytes: 0 }, { name: 'x' }), /bytes/)
})

test('the cache evicts the least recently used first and never a pinned file', async () => {
  const e = (name: string, bytes: number, usedAt: number) => ({ name, bytes, usedAt })
  assert.deepEqual(evictionPlan([e('a', 5, 1), e('b', 5, 2), e('c', 5, 3)], 10, new Set()), ['a'])
  assert.deepEqual(evictionPlan([e('a', 5, 1), e('b', 5, 2), e('c', 5, 3)], 10, new Set(['a'])), ['b'])
  assert.deepEqual(evictionPlan([e('a', 5, 1)], 4, new Set(['a'])), [], 'over the bound, but in use')
  assert.deepEqual(evictionPlan([e('a', 5, 1)], 5, new Set()), [])

  const dir = await mkdtemp(join(tmpdir(), 'studio-cache-'))
  try {
    const cache = new AssetCache(dir, 10)
    await writeFile(join(dir, 'left-over.part'), 'x')
    await cache.init()
    assert.deepEqual(await readdir(dir), [], 'a cut-short download is cleared')
    const names = ['1', '2', '3'].map((d) => `${d.repeat(64)}.mp4`)
    for (const [i, n] of names.entries()) {
      await writeFile(join(dir, n), 'xxxxx')
      await utimes(join(dir, n), new Date(1000 * (i + 1)), new Date(1000 * (i + 1)))
    }
    assert.equal(await cache.lookup(`assets/${names[0]}`, 4), null, 'a file of the wrong size is not used (and goes)')
    assert.equal(await cache.lookup(`assets/${names[1]}`, 5), join(dir, names[1]!))
    const release = cache.pin([`assets/${names[2]}`])
    assert.deepEqual(await cache.trim(), [])
    release()
    assert.throws(() => cache.pathOf('assets/../etc/passwd'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('small pure helpers', () => {
  assert.equal(frameAt(1.5, 30, 90), 45)
  assert.equal(frameAt(99, 30, 90), 89)
  assert.equal(frameAt(-1, 30, 90), 0)
  assert.equal(frameAt(Number.NaN, 30, 90), 0)
  assert.equal(thumbnailScale(1920), 1 / 3)
  assert.equal(thumbnailScale(320), 1)
  assert.deepEqual(pageOrder(['page-10.png', 'page-2.png', 'page-1.png', 'x.txt']), ['page-1.png', 'page-2.png', 'page-10.png'])
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000002800000016808060000', 'hex')
  assert.deepEqual(pngSize(png), { width: 640, height: 360 })
  assert.throws(() => pngSize(Buffer.from('nope')))
  assert.equal(failureMessage(new JobError('Plain sentence'), null), 'Plain sentence')
  assert.equal(failureMessage(new Error('boom'), 'Cancelled'), 'Cancelled')
  assert.equal(failureMessage('x', null), 'x')
  const ln = parseLoudnorm('noise\n{\n "input_i" : "-23.1",\n "input_tp" : "-4.0",\n "input_lra" : "2.0",\n "input_thresh" : "-33.4",\n "target_offset" : "0.1"\n}\n')
  assert.equal(ln.input_i, '-23.1')
  assert.equal(parseTruePeak('  True peak:\n    Peak:        -1.3 dBFS'), -1.3)
  assert.equal(parseTruePeak('  True peak:\n    Peak:        -inf dBFS'), null)
})

test('what a project needs that the worker does not stage yet is named', () => {
  const base = { captions: { enabled: false, font: 'sans' }, layers: [] } as never
  assert.deepEqual(unstagedNeeds(base), [])
  const lines = unstagedNeeds({ captions: { enabled: true, font: 'serif' }, layers: [{ style: { font: 'Satoshi' } }, { style: { scene: { id: '0123456789abcdef', name: 'Orbit', fonts: ['Inter'] } } }] } as never)
  // Code scenes are staged now (scenes.ts): only the fonts are named.
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /Satoshi, Inter, serif/)
})
