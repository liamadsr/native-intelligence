/**
 * The fast export's own sound mix, rule by rule as Remotion mixes (fast-sound.ts), and its gate: which sounds it mixes
 * and which it leaves to Remotion. (Against Remotion's real mix, sample for sample: test/fast-export-e2e.ts.)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareWindow, framePosition, frameSamples, mixSound, soundPlan, soundWindows, spliceWindow, toS16 } from '../src/fast-sound.ts'
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

test("the cold start of a file played from its beginning, and the checked frames, go to Remotion", () => {
  const w = soundWindows([{ from: 0, duration: 300, trimBefore: 0, playbackRate: 1 }, { from: 120, duration: 100, trimBefore: 400, playbackRate: 1 }], 300, 60)
  assert.deepEqual(w.warm, [[0, 5]], 'the first 100 ms of the file')
  assert.deepEqual(w.check, [[118, 127], [238, 247]])
})

const project = (over: Partial<EditorProject> = {}) => ({
  output: { width: 640, height: 360, fps: 60 }, assets: [{ id: 'a', kind: 'video', file: 'assets/a.mp4', hasAudio: true, sourceFps: 60, sourceFrames: 600 }, { id: 'm', kind: 'audio', file: 'assets/m.m4a', hasAudio: true }],
  clips: [{ id: 'c', assetId: 'a', trimStartSourceFrame: 0, trimEndSourceFrame: 300, audio: { muted: false, gain: 1 }, holdEndFrames: 0, zooms: [], playbackRate: 1 }],
  audioTracks: [{ id: 't', name: 'Mic', role: 'voiceover', gain: 0.9, muted: false, segments: [{ id: 's', assetId: 'm', startFrame: 10, trimStartSeconds: 0, trimEndSeconds: 3 }] }],
  automation: { lanes: [] }, ...over,
}) as unknown as EditorProject
const ok = { codec: 'aac', sampleRate: 48000, channels: 2 }

test('the sounds it mixes, and those it leaves to Remotion', () => {
  const plan = soundPlan(project(), () => ok)
  assert.ok('layers' in plan && plan.layers.length === 2)
  const reason = (p: EditorProject, probe = (_: string) => ok as typeof ok | null) => { const r = soundPlan(p, probe); return 'reason' in r ? r.reason : null }
  assert.match(reason(project(), () => ({ ...ok, sampleRate: 44100 }))!, /44100 Hz/)
  assert.match(reason(project(), () => ({ ...ok, channels: 6 }))!, /6 channels/)
  assert.match(reason(project(), () => ({ ...ok, codec: 'opus' }))!, /opus/)
  assert.match(reason(project({ audioTracks: [{ id: 't', name: 'Music', role: 'music', gain: 1, muted: false, duck: { amount: 0.5 }, segments: [] }] } as never))!, /ducked/)
  assert.match(reason(project({ output: { width: 640, height: 360, fps: 24 } }))!, /24 fps/)
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
    { key: 'a', assetId: 'a', from: 0, duration: 3, trimBefore: 0, playbackRate: 1, premountFor: 0, volume: (f: number) => [1, 0.5, 0][f]!, file: 'a.wav', channels: 2 },
    { key: 'b', assetId: 'b', from: 1, duration: 4, trimBefore: 0, playbackRate: 1, premountFor: 0, volume: () => 1, file: 'b.wav', channels: 2 },
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
