/**
 * The fast export's own sound mix, rule by rule as Remotion mixes (fast-sound.ts), and its gate: which sounds it mixes
 * and which it leaves to Remotion. (Against Remotion's real mix, sample for sample: test/fast-export-e2e.ts.)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareWindow, framePosition, frameSamples, MAX_CHECKS, mixSound, soundPlan, soundWindows, SourceReader, spliceWindow, toS16 } from '../src/fast-sound.ts'
import { execFileSync } from 'node:child_process'
import type { EditorProject } from '../../web/src/lib/studio/engine/contracts.ts'

test("a frame's samples: from floor(t × 48 kHz) to ceil((t + 1/fps) × 48 kHz), with Remotion's floating-point fix", () => {
  assert.deepEqual(frameSamples({ trimBefore: 0, playbackRate: 1 }, 0, 60), [0, 800])
  assert.deepEqual(frameSamples({ trimBefore: 7, playbackRate: 1 }, 3, 60), [8000, 8800])
  // A start between samples (a microphone synced 16.667 ms in): one more sample, the next frame overwrites it.
  const [a, b] = frameSamples({ trimBefore: 0.016667 * 60, playbackRate: 1 }, 0, 60)
  assert.deepEqual([a, b], [800, 1601])
  assert.equal(framePosition(5, 60), 4000)
  assert.equal(framePosition(5, 30), 8000)
})

test("16 bits as Chrome makes them: ×32768 below zero, ×32767 above, the fraction dropped", () => {
  assert.deepEqual([1, -1, 0.5, -0.5, 0.25, 2, -2].map(toS16), [32767, -32768, 16383, -16384, 8191, 32767, -32768])
})

test("the cold start of a file played from its beginning goes to Remotion, and every layer is checked where it is loud", () => {
  const layers = [{ key: 'a', from: 0, duration: 300, trimBefore: 0, playbackRate: 1 }, { key: 'b', from: 120, duration: 100, trimBefore: 400, playbackRate: 1 }]
  const w = soundWindows(layers, 300, 60, new Map([['a', { frame: 3, energy: 9 }], ['b', { frame: 200, energy: 5 }]]))
  assert.deepEqual(w.warm, [[0, 5]], 'the first 100 ms of the file')
  // a's loudest frame is a cold one: its window keeps to the frames after them; b's sits around its loudest frame.
  assert.deepEqual(w.check, [[6, 9], [196, 205]])
  // A layer silent throughout is checked in its middle (Remotion must hear nothing there either).
  assert.deepEqual(soundWindows(layers, 300, 60, new Map([['a', { frame: 3, energy: 9 }], ['b', { frame: -1, energy: 0 }]])).check, [[6, 9], [166, 175]])
  // Many layers: at most MAX_CHECKS windows, the first and the last layer among them.
  const many = Array.from({ length: 40 }, (_, i) => ({ key: `c${i}`, from: i * 50, duration: 50, trimBefore: 600 + i * 50, playbackRate: 1 }))
  const c = soundWindows(many, 2000, 60).check
  assert.equal(c.length, MAX_CHECKS)
  assert.deepEqual([c[0], c.at(-1)], [[21, 30], [1971, 1980]])
})

const project = (over: Partial<EditorProject> = {}) => ({
  output: { width: 640, height: 360, fps: 60 }, assets: [{ id: 'a', kind: 'video', file: 'assets/a.mp4', hasAudio: true, sourceFps: 60, sourceFrames: 600 }, { id: 'm', kind: 'audio', file: 'assets/m.m4a', hasAudio: true }],
  clips: [{ id: 'c', assetId: 'a', trimStartSourceFrame: 0, trimEndSourceFrame: 300, audio: { muted: false, gain: 1 }, holdEndFrames: 0, zooms: [], playbackRate: 1 }],
  audioTracks: [{ id: 't', name: 'Mic', role: 'voiceover', gain: 0.9, muted: false, segments: [{ id: 's', assetId: 'm', startFrame: 10, trimStartSeconds: 0, trimEndSeconds: 3 }] }],
  automation: { lanes: [] }, ...over,
}) as unknown as EditorProject
const ok = { codec: 'aac', sampleRate: 48000, channels: 2, startTime: 0 }

test('the sounds it mixes, and those it leaves to Remotion', () => {
  const plan = soundPlan(project(), () => ok)
  assert.ok('layers' in plan && plan.layers.length === 2)
  const reason = (p: EditorProject, probe = (_: string) => ok as typeof ok | null) => { const r = soundPlan(p, probe); return 'reason' in r ? r.reason : null }
  assert.match(reason(project(), () => ({ ...ok, sampleRate: 44100 }))!, /44100 Hz/)
  assert.match(reason(project(), () => ({ ...ok, channels: 6 }))!, /6 channels/)
  assert.match(reason(project(), () => ({ ...ok, codec: 'opus' }))!, /opus/)
  assert.match(reason(project({ audioTracks: [{ id: 't', name: 'Music', role: 'music', gain: 1, muted: false, duck: { amount: 0.5 }, segments: [] }] } as never))!, /ducked/)
  assert.match(reason(project({ output: { width: 640, height: 360, fps: 24 } }))!, /24 fps/)
  // A stream that starts later than 0 in its file (an upload kept as it came): Remotion places it by its timestamps.
  assert.match(reason(project(), () => ({ ...ok, startTime: 0.3 }))!, /starts at 0.3 s/)
  assert.match(reason(project(), () => ({ ...ok, startTime: NaN }))!, /starts at NaN/)
  assert.equal(reason(project(), (file) => (file.endsWith('.mp4') ? null : ok)), null, 'a recording with no sound track adds nothing')
})

/** A 16-bit stereo 48 kHz WAV of the given sample frames. */
function wav(frames: [number, number][]): Buffer {
  const data = Buffer.alloc(frames.length * 4)
  frames.forEach(([l, r], i) => { data.writeInt16LE(l, i * 4); data.writeInt16LE(r, i * 4 + 2) })
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22)
  h.writeUInt32LE(48000, 24); h.writeUInt32LE(192000, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}
const samples = (buf: Buffer) => new Int16Array(buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + buf.length))

test('the mix: each frame its piece at its level (truncated), nothing at level 0, layers summed and clipped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fast-sound-'))
  await writeFile(join(dir, 'a.wav'), wav(Array.from({ length: 4000 }, () => [10000, -10001] as [number, number])))
  await writeFile(join(dir, 'b.wav'), wav(Array.from({ length: 4000 }, () => [30000, 30000] as [number, number])))
  const out = join(dir, 'mix.wav')
  const layers = [
    { kind: 'track' as const, key: 'a', assetId: 'a', from: 0, duration: 3, trimBefore: 0, playbackRate: 1, premountFor: 0, volume: (f: number) => [1, 0.5, 0][f]!, file: 'a.wav', channels: 2 },
    { kind: 'track' as const, key: 'b', assetId: 'b', from: 1, duration: 4, trimBefore: 0, playbackRate: 1, premountFor: 0, volume: () => 1, file: 'b.wav', channels: 2 },
  ]
  await mixSound(layers, 4, 60, (f) => join(dir, f), out)
  const s = samples(await readFile(out))
  // The files' 16 bits come back through float as Chrome's decoder hands them over (10000 → 9999, 30000 → 29999).
  const al = toS16(10000 / 32768), ar = toS16(-10001 / 32768), b = toS16(30000 / 32768)
  assert.equal(s.length, 4 * 800 * 2)
  assert.deepEqual([s[0], s[1]], [al, ar], 'frame 0: a at full level')
  assert.deepEqual([s[800 * 2], s[800 * 2 + 1]], [Math.min(32767, Math.trunc(al * 0.5) + b), Math.trunc(ar * 0.5) + b], 'frame 1: a at half (truncated) plus b, clipped')
  assert.deepEqual([s[1600 * 2], s[1600 * 2 + 1]], [b, b], 'frame 2: a at level 0 adds nothing')
  // A window of "Remotion's" mix spliced over frames 1–2, and compared.
  const win = join(dir, 'win.wav')
  await writeFile(win, wav(Array.from({ length: 1600 }, () => [1, 2] as [number, number])))
  const cmp = await compareWindow(out, win, [1, 2], 60)
  assert.deepEqual([cmp.samples, cmp.differing], [1600, 3200])
  await spliceWindow(out, win, [1, 2], 60)
  const t = samples(await readFile(out))
  assert.deepEqual([t[0], t[800 * 2], t[2399 * 2 + 1], t[2400 * 2]], [al, 1, 2, b])
})

/** A made-up sound file (FFmpeg's sine and noise, AAC in .m4a), `seconds` long, mono or stereo. */
function aac(file: string, seconds: number, channels: 1 | 2) {
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='0.3*sin(2*PI*(220+30*sin(0.7*t))*t)+0.05*(random(0)-0.5)':s=48000:c=${channels === 1 ? 'mono' : 'stereo'}:d=${seconds}`,
    '-c:a', 'aac', '-b:a', '96k', file])
}
const full = (file: string, channels: number) => {
  const raw = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'f32le', '-acodec', 'pcm_f32le', '-'], { maxBuffer: 1 << 30 })
  const f32 = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4), out = new Int16Array((f32.length / channels) * 2)
  for (let i = 0; i < f32.length / channels; i++) { out[i * 2] = toS16(f32[i * channels]!); out[i * 2 + 1] = toS16(f32[i * channels + (channels - 1)]!) }
  return out
}

test("a stretch of a file read from the middle is the whole decoding's same samples, to the bit", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fast-sound-'))
  for (const channels of [1, 2] as const) {
    const file = join(dir, `s${channels}.m4a`)
    aac(file, 20, channels)
    const whole = full(file, channels)
    for (const [a, b] of [[0, 4800], [1234, 9999], [480_007, 530_000], [whole.length / 2 - 3000, whole.length / 2 + 500]] as const) {
      const r = new SourceReader(file, channels, a, b)
      const got = new Int16Array(await r.take(a, b))
      r.close()
      const want = whole.subarray(a * 2, Math.min(b, whole.length / 2) * 2)
      assert.equal(got.length, want.length, `${channels} channel(s), [${a}, ${b}): length`)
      assert.ok(got.every((x, i) => x === want[i]), `${channels} channel(s), [${a}, ${b}): samples`)
    }
  }
})

test('the mix holds a block of sound, not the files: a 10-minute source, a short trim late in it and a layer playing all of it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fast-sound-'))
  const file = join(dir, 'long.m4a'), seconds = 600
  aac(file, seconds, 2)
  const fps = 30, frames = seconds * fps
  const layer = (key: string, from: number, duration: number, trimBefore: number) => ({ kind: 'track' as const, key, assetId: 'x', from, duration, trimBefore, playbackRate: 1, premountFor: 0, volume: () => 1, file: 'long.m4a', channels: 2 })
  const cases = [
    { name: '20 s from minute 9', frames: 20 * fps, layers: [layer('late', 0, 20 * fps, 540 * fps)] },
    { name: 'all ten minutes', frames, layers: [layer('all', 0, frames, 0)] },
  ]
  for (const c of cases) {
    const before = process.memoryUsage().rss
    let peak = before
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 5)
    const t = Date.now()
    await mixSound(c.layers, c.frames, fps, (f) => join(dir, f), join(dir, 'mix.wav'))
    clearInterval(timer)
    peak = Math.max(peak, process.memoryUsage().rss)
    // Ten minutes of stereo float is 230 MB; decoding the file whole took that and as much again.
    console.log(`[memory] ${c.name}: +${((peak - before) / 2 ** 20).toFixed(0)} MB, ${Date.now() - t} ms`)
    assert.ok(peak - before < 80 * 1024 * 1024, `${c.name}: the mix grew the process by ${((peak - before) / 2 ** 20).toFixed(0)} MB`)
    if (c.name.startsWith('20 s')) assert.ok(Date.now() - t < 5000, `${c.name}: took ${Date.now() - t} ms (the file was decoded from its start?)`)
  }
  // And the late trim is the right samples: the whole decoding's, at minute 9.
  const whole = full(file, 2), mix = samples(await readFile(join(dir, 'mix.wav')))
  assert.equal(mix.length, frames * 1600 * 2)
  for (const i of [0, 1, 777_777, mix.length - 1]) assert.equal(mix[i], whole[i])
})
