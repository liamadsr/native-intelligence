import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { clipPointer, drawnState, layerWindow, lookup, matte, placed, placements, png, spriteCrop, spriteProject, stateFrames, stateKey, LAYOUT_UNIT, STATE_GAP } from '../src/fast-pointer.ts'
import { parseEditorProject, defaultCaptions, defaultPresentation } from '../src/engine.ts'
import { madeUpTrace } from './pointer-fixtures.ts'
import type { EditorProject } from '../../web/src/lib/studio/engine/contracts.ts'

const require = createRequire(import.meta.url)
const { neutralMotion } = require('../../web/src/lib/studio/engine/motion-contracts.ts') as typeof import('../../web/src/lib/studio/engine/motion-contracts.ts')
const { pointerAt, clickAt } = require('../../web/src/lib/studio/engine/pointer.ts') as typeof import('../../web/src/lib/studio/engine/pointer.ts')
const { sourceTimeSeconds } = require('../../web/src/lib/studio/engine/timeline.ts') as typeof import('../../web/src/lib/studio/engine/timeline.ts')

const take = (style: 'arrow' | 'glass' | 'none', clickFeedback = true, rate = 1) => parseEditorProject({ schemaVersion: 4, id: 'p', title: 'P', output: { width: 2000, height: 1200, fps: 60 },
  assets: [{ id: 's', kind: 'video', name: 'Screen.mp4', file: `assets/${'a'.repeat(64)}.mp4`, sha256: 'a'.repeat(64), bytes: 1, width: 2000, height: 1200, sourceFps: 60, sourceFrames: 600,
    durationSeconds: 10, hasAudio: false, sourceCursorHidden: true,
    trace: (() => { const t = madeUpTrace(10, { width: 1000, height: 600, scale: 2 }); return { ...t, actions: [...t.actions, { t: 2000, end: 4000, kind: 'type', label: 'Typing', box: null }].sort((a, b) => a.t - b.t) } })() }],
  clips: [{ id: 'a', assetId: 's', trimStartSourceFrame: 120, trimEndSourceFrame: 240, audio: { muted: true, gain: 1 }, holdEndFrames: 0, zooms: [], motion: neutralMotion(), playbackRate: rate,
    dismissedActionIndices: [], view: { main: 'screen', bubble: false } }],
  presentation: structuredClone(defaultPresentation), cursor: { style, size: 18, clickFeedback }, transcripts: [], captions: { ...defaultCaptions }, captionCorrections: {},
  voiceoverDraft: { text: '', targetClipIds: [] }, audioTracks: [], presenterTrack: null }) as EditorProject

test("each frame's pointer is the engine's: its point at the clip's source time, the click, the press", () => {
  for (const rate of [1, 2]) {
    const p = take('arrow', true, rate), clip = p.clips[0]!, asset = p.assets[0]!
    const frames = rate === 1 ? 120 : 60
    const plan = clipPointer(p, clip, asset, frames)!
    assert.equal(plan.size, 18 * 2000 / 1000)
    assert.equal(plan.states.length, frames)
    for (const l of [0, 7, 31, frames - 1]) {
      const ms = sourceTimeSeconds(clip, asset, l, 60) * 1000, at = pointerAt(asset.trace!, ms)!, click = clickAt(asset.trace!, ms)
      assert.equal(plan.states[l]!.x, at[0] * 2000)
      assert.equal(plan.states[l]!.y, at[1] * 1200)
      assert.equal(plan.states[l]!.ring, click ? (ms - click.t) / 220 : null)
    }
    assert.ok(plan.states.some((s) => s!.ring !== null) && plan.states.some((s) => s!.press < 1))
  }
  // Click feedback off: no ring, no press. No pointer drawn: no plan.
  assert.ok(clipPointer(take('glass', false), take('glass').clips[0]!, take('glass').assets[0]!, 120)!.states.every((s) => s!.ring === null && s!.press === 1))
  assert.equal(clipPointer(take('none'), take('none').clips[0]!, take('none').assets[0]!, 120), null)
})

test("a state is drawn at its tip floored to Chrome's layout unit; the key holds what changes the picture", () => {
  const s = { x: 100.73, y: 50.2, press: 0.9, ring: 0.25 }
  assert.deepEqual(drawnState(s), { ...s, x: Math.floor(100.73 * LAYOUT_UNIT) / LAYOUT_UNIT, y: Math.floor(50.2 * LAYOUT_UNIT) / LAYOUT_UNIT })
  assert.equal(stateKey(s), stateKey({ ...s, x: s.x + 7 }))
  assert.notEqual(stateKey(s), stateKey({ ...s, x: s.x + 1 / 32 }))
  assert.notEqual(stateKey(s), stateKey({ ...s, ring: 0.3 }))
  // A tip a hair under a whole pixel (a trace's point times the width) is that pixel to Chrome, which reads a CSS length
  // as a 32-bit float: drawn there, not a sixteenth (and a whole pixel's place) before it.
  const hair = { x: 1532.9999999999998, y: 7.25, press: 1, ring: null }
  assert.deepEqual(drawnState(hair), { ...hair, x: 1533, y: 7.25 })
  assert.equal(stateKey(hair), stateKey({ ...hair, x: 1533 }))
  assert.equal(drawnState({ ...hair, x: 1532.99 }).x, 1532.9375, 'a real hundredth under it is under it')
})

test("FFmpeg's per-frame lookup gives each frame's value, runs folded", () => {
  const values = [50, 50, 50, 80, 90, 90, 120, 120, 120, 120, 70]
  const expr = lookup(values, 'N')
  const out = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=10', '-vf', `trim=end_frame=${values.length},format=gray,geq=lum='${expr}'`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
  assert.deepEqual([...Array(values.length).keys()].map((k) => out[k * 256]), values)
  assert.equal(lookup([]), '0')
})

test("the window goes where the sprite is, even, inside the frame; the sprite is placed in it", () => {
  const look = { size: 36, style: 'glass' as const }, { cw, ch, margin } = layerWindow(look), crop = spriteCrop(36)
  assert.equal(cw % 2, 0); assert.equal(ch % 2, 0)
  const [mid, edge, none] = placements([{ x: 1000.5, y: 600.25, press: 1, ring: null }, { x: 3, y: 1195, press: 1, ring: null }, null], look, 2000, 1200)
  assert.equal(mid!.cx % 2, 0); assert.equal(mid!.cy % 2, 0)
  assert.equal(mid!.cx + mid!.ix, 1000 - crop.tipX); assert.equal(mid!.cy + mid!.iy, 600 - crop.tipY)
  assert.ok(mid!.ix >= margin && mid!.ix <= margin + 1)
  assert.ok(edge!.cx === 0 && edge!.cy === 1200 - ch && edge!.cx + edge!.ix === 3 - crop.tipX)
  assert.deepEqual(none, { cx: 0, cy: 0, ix: 0, iy: 0 })
  const sprite = { w: 2, h: 1, rgba: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), blur: Buffer.from([9, 10]) }
  const out = placed(sprite, 'rgba', 4, 2, 1, 1)
  assert.deepEqual([...out.subarray(20, 28)], [1, 2, 3, 4, 5, 6, 7, 8])
  assert.deepEqual([...placed(sprite, 'blur', 3, 1, 2, 0)], [0, 0, 9])
})

test('a sprite from black and white: coverage, straight colour; the glass blur weight from the checkerboard', () => {
  // One pixel at 50 % white over: black 128, white 255 (Chrome's backgrounds 0 and 255), a plain pixel beside it.
  const black = Buffer.from([0, 0, 0, 128, 128, 128]), white = Buffer.from([255, 255, 255, 255, 255, 255])
  const [s] = matte(1, 2, 1, black, white)
  assert.deepEqual([...s!.rgba], [0, 0, 0, 0, 255, 255, 255, 128])
  // Backgrounds an encoder left a little off (RGB 2 and 252): still about 50 % white (128.5 and 253.5, rounded).
  const [t] = matte(1, 2, 1, Buffer.from([2, 2, 2, 128, 128, 128]), Buffer.from([252, 252, 252, 254, 254, 254]))
  assert.ok(Math.abs(t!.rgba[7]! - 128) <= 2 && t!.rgba[4]! >= 250, JSON.stringify([...t!.rgba]))
})

test('a PNG FFmpeg reads back as written', () => {
  const pixels = Buffer.from(Array.from({ length: 3 * 2 * 4 }, (_, i) => (i * 37) % 256))
  const out = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'image2pipe', '-c:v', 'png', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { input: png(3, 2, pixels, 4) })
  assert.deepEqual([...out], [...pixels])
})

test("the made-up sprite video: each state on its frame, its tip where the window's is, its click as long before", () => {
  const p = take('glass'), plan = clipPointer(p, p.clips[0]!, p.assets[0]!, 120)!
  const states = [{ x: 10.5, y: 20.25, press: 1, ring: null }, { x: 3.125, y: 7.75, press: 0.9, ring: 0.4 }]
  const sp = parseEditorProject(spriteProject(p, plan, states, { file: `assets/${'b'.repeat(64)}.mp4`, sha256: 'b'.repeat(64), bytes: 1 })) as EditorProject
  const asset = sp.assets[0]!, crop = spriteCrop(plan.size), W = sp.output.width
  assert.ok(W >= 128 && W % 2 === 0)
  for (const [k, s] of states.entries()) {
    const ms = sourceTimeSeconds(sp.clips[0]!, asset, stateFrames(states).frames[k]!, 60) * 1000, at = pointerAt(asset.trace!, ms)!
    assert.ok(Math.abs(at[0] * W - (crop.x + crop.tipX + s.x - Math.floor(s.x))) < 1e-9)
    assert.ok(Math.abs(18 * (W / asset.trace!.viewport.width) - plan.size) < 1e-9)
    const click = clickAt(asset.trace!, ms)
    assert.equal(click ? Math.round((ms - click.t) / 220 * 1e9) / 1e9 : null, s.ring)
  }
})

test("the proof's calibration (every frame, STUDIO_FAST_E2E_POINTER_ALL) is the proof's alone: no export reads it, the floors are fixed", async () => {
  const { readdirSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = join(import.meta.dirname, '..', 'src')
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []))
  for (const f of files(src)) assert.ok(!/STUDIO_FAST_E2E/.test(readFileSync(f, 'utf8')), f)
  const { checkFloor } = await import('../src/encoders.ts')
  for (const p of ['x264', 'videotoolbox', 'mf', 'lossless'] as const) assert.deepEqual(checkFloor(p).pointer, { arrow: 30, glass: 34.5 })
})

test("the states' frames: the plain ones one a frame, the clicks STATE_GAP apart after them, never reaching each other", () => {
  const plain = { x: 1, y: 1, press: 1, ring: null }, click = { x: 1, y: 1, press: 0.9, ring: 0.3 }
  const at = stateFrames([plain, click, plain, click, plain])
  assert.deepEqual(at.frames, [0, 3 + STATE_GAP - 1, 1, 3 + 2 * STATE_GAP - 1, 2])
  assert.deepEqual(at.ranges, [{ from: 0, to: 2, every: 1 }, { from: 3 + STATE_GAP - 1, to: 3 + 2 * STATE_GAP - 1, every: STATE_GAP }])
  assert.equal(at.length, 3 + 2 * STATE_GAP)
  // A ring lasts 220 ms: the last plain frame is far enough before the first click's frame, and two clicks from each other.
  assert.ok((STATE_GAP - 1) * 1000 / 60 > 220)
  assert.deepEqual(stateFrames([plain]).ranges, [{ from: 0, to: 0, every: 1 }])
})
