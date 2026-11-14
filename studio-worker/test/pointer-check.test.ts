/**
 * The fast export's pointer, in pieces small enough to test without Chrome: its tabs (one budget for every pass), its
 * bounds in the plan, its graph (only what the pointer touches changes), the frames its check samples and how it
 * scores them, the gate's keys for the pointer and the trace, and the FFmpeg it needs. (Against Chrome itself:
 * test/fast-export-e2e.ts.)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { chromePointerArt, clipPointer, glassWeight, gaussian, layerWindow, matte, placements, png, pointerBudgetProblem, pointerFilters, pointerNeeds, POINTER_LIMITS, spriteCrop, spriteSchedule, spriteProject,
  stateFrames, touchedMask, GLASS_WEIGHT, type PointerState, type Sprite } from '../src/fast-pointer.ts'
import { artInside, checkVerdict, heldBox, maskedPsnr, readTapWindow, pointerBoxes, pointerLayers, pointerSamples, pointerScore, sampleFrames, untouchedChanges, type PointerBox } from '../src/fast-export-run.ts'
import { fastExportPlan, hashTaps, segmentArgs, type FastPlan } from '../src/fast-export.ts'
import { ffmpegLacks, listedNames, missingComponents } from '../src/media.ts'
import { localRenderTabs } from '../src/local.ts'
import { FAST_LEFTOVERS, spriteTabs } from '../src/jobs/export.ts'
import { cgroupMemory, loadConfig } from '../src/config.ts'
import { concatLine } from '../src/platform.ts'
import { parseEditorProject, defaultCaptions, defaultPresentation } from '../src/engine.ts'
import { madeUpTrace } from './pointer-fixtures.ts'
import type { EditorProject } from '../../web/src/lib/studio/engine/contracts.ts'

const require = createRequire(import.meta.url)
const { neutralMotion } = require('../../web/src/lib/studio/engine/motion-contracts.ts') as typeof import('../../web/src/lib/studio/engine/motion-contracts.ts')

const sha = (c: string) => c.repeat(64)
/** A desktop take: a 60 fps recording with its pointer hidden and traced (points, half its pixels), a microphone, clips cut from it. */
function take(o: { style?: 'arrow' | 'glass' | 'none'; size?: number; seconds?: number; clips?: [number, number][]; clickEveryMs?: number; W?: number; H?: number } = {}): Record<string, any> {
  const W = o.W ?? 1280, H = o.H ?? 720, seconds = o.seconds ?? 6, frames = Math.round(seconds * 60)
  return {
    schemaVersion: 4, id: 'p', title: 'T', output: { width: W, height: H, fps: 60 },
    assets: [{ id: 'a', kind: 'video', name: 'Screen.mp4', file: `assets/${sha('a')}.mp4`, sha256: sha('a'), bytes: 1000, width: W, height: H, durationSeconds: seconds, sourceFps: 60, sourceFrames: frames,
      hasAudio: false, sourceCursorHidden: true, trace: madeUpTrace(seconds, { width: W / 2, height: H / 2, scale: 2 }, o.clickEveryMs ?? 1300, 650) },
    { id: 'c', kind: 'audio', name: 'mic.m4a', file: `assets/${sha('c')}.m4a`, sha256: sha('c'), bytes: 1000, durationSeconds: seconds, hasAudio: true, sourceCursorHidden: false }],
    clips: (o.clips ?? [[0, frames]]).map(([from, to], i) => ({ id: `c${i}`, assetId: 'a', trimStartSourceFrame: from, trimEndSourceFrame: to, audio: { muted: true, gain: 1 }, holdEndFrames: 0, zooms: [],
      motion: neutralMotion(), playbackRate: 1, dismissedActionIndices: [], view: { main: 'screen', bubble: false } })),
    presentation: structuredClone(defaultPresentation), cursor: { style: o.style ?? 'glass', size: o.size ?? 18, clickFeedback: true },
    audioTracks: [{ id: 'mic', name: 'Microphone', role: 'voiceover', gain: 1, muted: false, segments: [{ id: 's', assetId: 'c', startFrame: 0, trimStartSeconds: 0, trimEndSeconds: seconds - 0.1 }] }],
    presenterTrack: null, transcripts: [], captions: { ...defaultCaptions }, captionCorrections: {}, voiceoverDraft: { text: '', targetClipIds: [] },
  }
}
const parsed = (p: Record<string, any>) => parseEditorProject(p) as EditorProject
const planOf = (p: EditorProject) => { const r = fastExportPlan(p); assert.ok(!('reason' in r), 'reason' in r ? r.reason : ''); return r as FastPlan }
const reasonOf = (p: EditorProject) => { const r = fastExportPlan(p); return 'reason' in r ? r.reason : null }

// ---- finding: one budget of tabs for every pass ------------------------------------------------------------------------

test('the passes share one budget of tabs: never more at once than the budget, one after another when it is small', () => {
  assert.deepEqual(spriteSchedule(3, 4), { atOnce: 3, tabs: 1 })
  assert.deepEqual(spriteSchedule(4, 2), { atOnce: 2, tabs: 2 })
  assert.deepEqual(spriteSchedule(1, 4), { atOnce: 1, tabs: 1 })
  assert.deepEqual(spriteSchedule(0, 2), { atOnce: 1, tabs: 1 })
  for (let budget = 1; budget <= 16; budget++) for (const passes of [2, 4]) { const s = spriteSchedule(budget, passes); assert.ok(s.atOnce * s.tabs <= budget && s.atOnce >= 1 && s.tabs >= 1) }
  // The pointer's own budget: the CPUs this process may use (a container's quota), at most 8, at least 1; a lower
  // STUDIO_RENDER_CONCURRENCY someone set wins.
  assert.equal(spriteTabs(18), 8)
  assert.equal(spriteTabs(4), 4)
  assert.equal(spriteTabs(2), 2)
  assert.equal(spriteTabs(0), 1)
  assert.equal(spriteTabs(18, 1), 1)
  assert.equal(spriteTabs(18, 3), 3)
  assert.equal(spriteTabs(4, 12), 4)
  // One tab for every GB the process may use: the server's 6 GB container with 12 CPUs gets 6, a 4 GB laptop 4, half a GB still 1.
  const GB = 1024 ** 3
  assert.equal(spriteTabs(12, null, 6 * GB), 6)
  assert.equal(spriteTabs(18, null, 4 * GB), 4)
  assert.equal(spriteTabs(18, null, 0.5 * GB), 1)
  assert.equal(spriteTabs(18, 2, 64 * GB), 2)
  assert.equal(spriteTabs(18, null, 64 * GB), 8)
  for (const cpus of [1, 2, 4, 6, 12, 18, 64]) for (const mem of [1, 3, 6, 64]) for (const passes of [2, 4]) {
    const s = spriteSchedule(spriteTabs(cpus, null, mem * GB), passes)
    assert.ok(s.atOnce * s.tabs <= Math.min(8, cpus, mem))
  }
  // A container's memory limit is read from its cgroup (v2, then v1); none, or no cgroup, is no limit.
  assert.equal(cgroupMemory((f) => (f === '/sys/fs/cgroup/memory.max' ? '6442450944\n' : null)), 6 * GB)
  assert.equal(cgroupMemory((f) => (f === '/sys/fs/cgroup/memory.max' ? 'max\n' : null)), null)
  assert.equal(cgroupMemory((f) => (f === '/sys/fs/cgroup/memory/memory.limit_in_bytes' ? '4294967296' : null)), 4 * GB)
  assert.equal(cgroupMemory((f) => (f === '/sys/fs/cgroup/memory/memory.limit_in_bytes' ? '9223372036854771712' : null)), null)
  assert.equal(cgroupMemory(() => null), null)
  // The setting as the worker reads it: said, or not.
  const said = loadConfig({ STUDIO_RENDER_CONCURRENCY: '2' }, () => 18), unsaid = loadConfig({}, () => 18)
  assert.ok(!('problems' in said) && said.renderConcurrencySaid === 2 && !('problems' in unsaid) && unsaid.renderConcurrencySaid === null)
})

/** A fake Remotion that hands back made-up pictures of the right size, and counts the tabs open at once. */
function fakeRemotion(fill: (project: EditorProject) => number) {
  let open = 0
  const seen = { most: 0, asked: [] as number[], sizes: [] as string[] }
  const remotion = {
    selectComposition: async () => ({}),
    renderFrames: async (o: { inputProps: { project: EditorProject }; frameRange: [number, number]; everyNthFrame: number; concurrency: number; onFrameBuffer: (b: Buffer, f: number) => void }) => {
      open += o.concurrency; seen.most = Math.max(seen.most, open); seen.asked.push(o.concurrency); seen.sizes.push(`${o.inputProps.project.output.width}x${o.inputProps.project.output.height}`)
      await new Promise((r) => setTimeout(r, 15))
      const { width, height } = o.inputProps.project.output, value = fill(o.inputProps.project)
      const pixels = Buffer.alloc(width * height * 4)
      for (let i = 0; i < width * height; i++) pixels.set([value, value, value, 255], i * 4)
      for (let f = o.frameRange[0]; f <= o.frameRange[1]; f += o.everyNthFrame) o.onFrameBuffer(png(width, height, pixels, 4), f)
      open -= o.concurrency
    },
  }
  return { remotion, seen }
}

test("the pointer's tabs follow the export's budget, all passes together; its pictures go to disk; the made-up recordings are taken away", async () => {
  const p = parsed(take({ style: 'glass' })), plan = planOf(p).segments[0]!.pointer!
  const states = [{ x: 10.5, y: 20.25, press: 1, ring: null }, { x: 3.125, y: 7.75, press: 0.9, ring: 0.4 }]
  for (const style of ['arrow', 'glass'] as const) for (const budget of [1, 2, 3, 4, 8]) {
    const dir = await mkdtemp(join(tmpdir(), 'pointer-tabs-')), assets = join(dir, 'assets'), scratch = join(dir, 'scratch')
    await mkdir(assets, { recursive: true }); await mkdir(scratch, { recursive: true })
    // Over black 0, over white 255 (no pointer seen: coverage 0); the glass's checkerboard as flat as an encoder could leave it.
    const { remotion, seen } = fakeRemotion((sp) => (sp.assets[0]!.file.includes('white') ? 255 : sp.assets[0]!.file.includes('checker') ? 128 : 0))
    const project = { ...p, cursor: { ...p.cursor, style } } as EditorProject
    const art = chromePointerArt({ project, serveUrl: 'x', common: {}, assetsDir: assets, scratch, signal: new AbortController().signal, tabs: budget,
      encode: () => ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '1'], run: async (file, args, o) => Buffer.from(execFileSync(file, args, { input: o.input, maxBuffer: 1 << 28 })),
      remotion: remotion as never, inputProps: (sp) => ({ project: sp }), compositionId: 'c' })
    const drawing = art({ plan: { size: plan.size, style }, states })
    if (style === 'glass') await assert.rejects(drawing, /blur could not be measured/, 'a flattened checkerboard: no blur measured, refused')
    else assert.equal((await drawing).length, 2)
    assert.ok(seen.most <= budget, `${style}, budget ${budget}: ${seen.most} tabs at once`)
    assert.ok(seen.asked.every((t) => t <= budget))
    // Every tab draws the pointer's own small picture, never the 1280×720 take.
    const side = spriteProject(project, { size: plan.size }, states, { file: 'assets/x.mp4', sha256: sha('d'), bytes: 1 }).output.width
    assert.ok(side <= 256 && seen.sizes.length > 0 && seen.sizes.every((x) => x === `${side}x${side}`), seen.sizes.join(' '))
    // Nothing left behind: no link in the asset folder, nothing of the pointer in scratch.
    assert.deepEqual(await readdir(assets), [])
    assert.deepEqual(await readdir(join(scratch, 'pointer')), [])
  }
})

// ---- finding: the plan bounds the pointer ------------------------------------------------------------------------------

test('a long take with many clicks is refused by the plan, before Chrome draws anything', () => {
  // Ten minutes, a click every half second: thousands of pictures.
  const long = parsed(take({ seconds: 600, clickEveryMs: 500 }))
  assert.match(reasonOf(long)!, /pointer needs \d+ pictures, more than the 4000 this path draws/)
  // The largest pointer (100, drawn at 200 px) for a few minutes: too many bytes.
  const big = parsed(take({ seconds: 240, size: 100, clickEveryMs: 1300 }))
  assert.match(reasonOf(big)!, /pointer's pictures would take \d+ MB, more than the 256 MB this path holds/)
  // A clip whose pointer moves for too long: its graph's per-frame places.
  // Its window 2 px further every frame (one picture, a new place each frame), longer than a clip may move.
  const look = { size: 12, style: 'arrow' as const }
  const moving = (n: number) => Array.from({ length: n }, (_, l) => ({ x: 100 + 2 * (l % 1500), y: 100 + 2 * Math.floor(l / 1500), press: 1, ring: null }))
  assert.match(pointerBudgetProblem(look, [{ states: moving(POINTER_LIMITS.places + 10), held: null }], 4000, 4000)!, /clip 1's pointer moves for too long/)
  assert.equal(pointerBudgetProblem(look, [{ states: moving(POINTER_LIMITS.places - 10), held: null }], 4000, 4000), null)
  // One picture too large: a trace in tiny points (a 40-point-wide area on a 1280 px take) draws the pointer at 32 times its size.
  const tiny = take({ seconds: 6 }); tiny.assets[0].trace = madeUpTrace(6, { width: 40, height: 22.5, scale: 32 })
  assert.match(reasonOf(parsed(tiny))!, /its pointer is drawn 576 px wide, and its picture would be \d+ px a side, more than the 1024 this path draws/)
  assert.match(pointerBudgetProblem({ size: 120, style: 'glass' }, [{ states: [{ x: 10, y: 10, press: 1, ring: null }], held: null }], 300, 300)!, /window \(\d+×\d+ px\) is larger than the video/)
  assert.equal(pointerBudgetProblem({ size: 200, style: 'glass' }, [{ states: [{ x: 10, y: 10, press: 1, ring: null }], held: null }], 3472, 2266), null, 'the largest pointer the schema allows, on a big take')
  // The 15.7 s take shape and a usual 6 s one go through.
  assert.equal(reasonOf(parsed(take())), null)
})

// ---- finding: only what the pointer touches changes --------------------------------------------------------------------

test("the touched mask: whole 2×2 blocks wherever the picture covers or blurs anything, nothing elsewhere", () => {
  const w = 6, h = 4, rgba = Buffer.alloc(w * h * 4), blur = Buffer.alloc(w * h)
  rgba[(1 * w + 1) * 4 + 3] = 1 // one faint pixel at (1, 1): the block (0..1, 0..1)
  blur[3 * w + 4] = 9 // a blurred pixel at (4, 3): the block (4..5, 2..3)
  const m = touchedMask(rgba, blur, w, h)
  const on = [...m].map((v, i) => (v ? i : -1)).filter((i) => i >= 0)
  assert.deepEqual(on, [0, 1, 6, 7, 16, 17, 22, 23])
  assert.deepEqual([...touchedMask(rgba, null, w, h)].filter(Boolean).length, 4)
  assert.ok([...m].every((v) => v === 0 || v === 255))
})

test("the pointer's graph changes only the pixels its picture touches, and no pixel on a frame without it", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pointer-graph-'))
  const W = 64, H = 48, cw = 16, ch = 16
  // The source: a busy coloured picture (testsrc2), 3 frames, BT.709 limited range as every source here.
  const src = join(dir, 'src.mp4')
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=60:d=0.05`, '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', '-frames:v', '3', '-c:v', 'libx264', '-qp', '0', src])
  // A picture: a 4×4 opaque red square at (5, 5) in the window, one faint pixel at (12, 3).
  const rgba = Buffer.alloc(cw * ch * 4)
  for (let y = 5; y < 9; y++) for (let x = 5; x < 9; x++) rgba.set([255, 0, 0, 255], (y * cw + x) * 4)
  rgba.set([255, 255, 255, 3], (3 * cw + 12) * 4)
  const touched = touchedMask(rgba, null, cw, ch)
  await writeFile(join(dir, 'p.png'), png(cw, ch, rgba, 4)); await writeFile(join(dir, 'm.png'), png(cw, ch, touched, 1))
  await writeFile(join(dir, 'e.png'), png(cw, ch, Buffer.alloc(cw * ch * 4), 4)); await writeFile(join(dir, 'z.png'), png(cw, ch, Buffer.alloc(cw * ch), 1))
  const list = async (name: string, files: string[]) => { const f = join(dir, name); await writeFile(f, files.map((x) => concatLine(join(dir, x))).join('\n') + '\n'); return f }
  const layer = { cw, ch, cx: [8, 30, 0], cy: [10, 20, 0], shown: [true, true, false], sigma: 2 }
  const graph = ['[0:v]null[in]', ...pointerFilters('t', 'in', 'out', 1, 2, null, layer, 60)].join(';')
  const out = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', src, '-f', 'concat', '-safe', '0', '-i', await list('s.txt', ['p.png', 'p.png', 'e.png']), '-f', 'concat', '-safe', '0', '-i', await list('m.txt', ['m.png', 'm.png', 'z.png']),
    '-filter_complex', graph, '-map', '[out]', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], { maxBuffer: 1 << 24 })
  const before = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', src, '-frames:v', '3', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], { maxBuffer: 1 << 24 })
  const size = W * H * 1.5
  assert.equal(out.length, 3 * size)
  for (let f = 0; f < 3; f++) {
    const a = out.subarray(f * size, (f + 1) * size), b = before.subarray(f * size, (f + 1) * size)
    let inside = 0, outside = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const wx = x - layer.cx[f]!, wy = y - layer.cy[f]!, t = layer.shown[f] && wx >= 0 && wy >= 0 && wx < cw && wy < ch && touched[wy * cw + wx]
      if (a[y * W + x] !== b[y * W + x]) t ? inside++ : outside++
    }
    for (let p = 0; p < 2; p++) for (let y = 0; y < H / 2; y++) for (let x = 0; x < W / 2; x++) {
      const wx = 2 * x - layer.cx[f]!, wy = 2 * y - layer.cy[f]!, t = layer.shown[f] && wx >= 0 && wy >= 0 && wx < cw && wy < ch && touched[wy * cw + wx]
      const i = W * H + p * (W / 2) * (H / 2) + y * (W / 2) + x
      if (a[i] !== b[i] && !t) outside++
    }
    assert.equal(outside, 0, `frame ${f}: ${outside} samples changed outside what the pointer touches`)
    if (layer.shown[f]) assert.ok(inside >= 12, `frame ${f}: the red square is drawn (${inside})`)
    else assert.equal(inside, 0)
  }
})

// ---- the check: which frames, which windows, how scored -----------------------------------------------------------------

test('the frames whose pointer is checked: per clip near its start and its end, a ring, the first blended frame for the held pointer', () => {
  const p = parsed(take({ style: 'arrow', clips: [[0, 150], [170, 300]] })), plan = planOf(p)
  const [a, b] = plan.segments
  const got = pointerSamples(plan)
  const inA = got.filter((f) => f < b!.startFrame), inB = got.filter((f) => f >= b!.startFrame)
  // Clip 1: a frame in its first quarter, one in its last, a ring (clicks at 650 ms and every 1.3 s).
  const quarter = (n: number) => Math.ceil(n / 4)
  assert.ok(inA.some((f) => f < quarter(a!.frames)) && inA.some((f) => f >= a!.frames - quarter(a!.frames)), JSON.stringify(inA))
  assert.ok(inA.some((f) => a!.pointer!.states[f]!.ring !== null))
  // Clip 2: the first blended frame (the held pointer), and its own frames past the blend.
  assert.ok(b!.blend && b!.blend.pointer)
  assert.ok(inB.includes(b!.startFrame))
  assert.ok(inB.filter((f) => f > b!.startFrame).every((f) => f - b!.startFrame >= b!.blend!.frames))
  assert.ok(inB.some((f) => f - b!.startFrame >= b!.frames - quarter(b!.frames)), JSON.stringify(inB))
  // All checked against Chrome too.
  for (const f of got) assert.ok(sampleFrames(plan).includes(f))
})

test("the check samples a pointer the frame shows mostly whole over one mostly past an edge, and an edge one when there is no other", () => {
  const look = { size: 36, style: 'arrow' as const }, frame = { width: 1280, height: 720 }
  assert.equal(artInside({ x: 600, y: 300, press: 1, ring: null }, look, frame), 1)
  assert.ok(artInside({ x: 1279, y: 300, press: 1, ring: null }, look, frame) < 0.2)
  assert.ok(Math.abs(artInside({ x: 0, y: 0, press: 1, ring: null }, { size: 36, style: 'glass' }, frame) - 0.25) < 1e-9)
  const plan = planOf(parsed(take({ style: 'arrow' }))), seg = plan.segments[0]!
  // The pointer moves most where it is past the right edge; a whole one moving less is sampled instead.
  const states = seg.pointer!.states.map((s, l) => ({ x: l % 2 ? 1278 : 600 + l * 0.5, y: 300, press: 1, ring: null }))
  const edgy = { ...plan, segments: [{ ...seg, pointer: { ...seg.pointer!, states } }] }
  for (const f of pointerSamples(edgy)) assert.ok(artInside(states[f]!, look, frame) >= 0.75, `frame ${f}`)
  // Only past the edge: still sampled (the check is not dropped).
  const off = { ...plan, segments: [{ ...seg, pointer: { ...seg.pointer!, states: states.map((s) => ({ ...s, x: 1278 })) } }] }
  assert.ok(pointerSamples(off).length >= 1)
})

test("the checked windows: inside the frame always (a pointer at an edge is compared over what the frame shows), none in a blend or under the bubble", () => {
  const raw = take({ style: 'arrow', clips: [[0, 150], [170, 300]] })
  const plan = planOf(parsed(raw)), seg = plan.segments[1]!
  const boxes = pointerBoxes(seg, plan), { cw, ch } = layerWindow(seg.pointer!)
  for (const [l, b] of boxes.entries()) {
    if (l < seg.blend!.frames) { assert.equal(b, null); continue }
    assert.ok(b && b.bx >= 0 && b.by >= 0 && b.bx + b.bw <= plan.width && b.by + b.bh <= plan.height && b.bw === cw && b.bh === ch)
  }
  // A tip at the very corner: the window is clamped into the frame, not dropped.
  const corner = placements([{ x: 0.2, y: 0.1, press: 1, ring: null }, { x: plan.width - 0.5, y: plan.height - 0.5, press: 1, ring: null }], seg.pointer!, plan.width, plan.height)
  assert.deepEqual([corner[0]!.cx, corner[0]!.cy], [0, 0])
  assert.deepEqual([corner[1]!.cx + cw, corner[1]!.cy + ch], [plan.width, plan.height])
  const atEdge = { ...seg, blend: null, pointer: { ...seg.pointer!, states: seg.pointer!.states.map(() => ({ x: 0.5, y: 0.5, press: 1, ring: null })) } }
  assert.ok(pointerBoxes(atEdge, plan).every((b) => b && b.bx === 0 && b.by === 0))
  // Under the bubble: not checked.
  const bubbled = { ...atEdge, bubble: { offset: 0, camera: { file: 'x', srcFps: 30, rate: 1, startSeconds: 0, map: [0], width: 640, height: 480 }, square: { x: 0, y: 0, side: 200 }, radius: 100, crop: { x: 0, y: 0, width: 200, height: 200 } } }
  assert.ok(pointerBoxes(bubbled, plan).every((b) => b === null))
  assert.equal(heldBox(bubbled as never, plan), null)
  assert.ok(heldBox(seg, plan))
})

test("the masked score: PSNR over the mask's pixels, chroma where any of its four counts; empty mask NaN", () => {
  const w = 4, h = 2, mask = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0])
  const a = Buffer.alloc(w * h * 1.5, 100), b = Buffer.from(a)
  assert.equal(maskedPsnr(a, b, w, h, mask), Infinity)
  b[1] = 0 // a luma sample outside the mask: not counted
  assert.equal(maskedPsnr(a, b, w, h, mask), Infinity)
  b[0] = 90 // inside: 1 luma + 1 U + 1 V sample counted, one off by 10
  assert.ok(Math.abs(maskedPsnr(a, b, w, h, mask) - 10 * Math.log10((255 * 255 * 3) / 100)) < 1e-9)
  b[w * h] = 95 // the U sample of the masked block
  assert.ok(Math.abs(maskedPsnr(a, b, w, h, mask) - 10 * Math.log10((255 * 255 * 3) / 125)) < 1e-9)
  assert.ok(Number.isNaN(maskedPsnr(a, b, w, h, Buffer.alloc(w * h))))
})

test("a checked pointer: a missing tap or one of the wrong size throws, a score that is no number fails, so does a change outside it", () => {
  const w = 4, h = 2, size = w * h * 1.5
  const touched = Buffer.from([255, 255, 0, 0, 255, 255, 0, 0])
  const box: PointerBox = { bx: 0, by: 0, bw: w, bh: h, mask: Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]), area: 1, touched, held: false }
  const win = Buffer.alloc(size, 100), tap = { bytes: Buffer.concat([Buffer.alloc(size, 7), win]), index: 1, count: 2 }
  assert.throws(() => pointerScore({ frame: 9, box, tap: null, chrome: win, source: win }), /frame 9's pointer was not tapped/)
  assert.throws(() => pointerScore({ frame: 9, box, tap: { ...tap, count: 3 }, chrome: win, source: win }), /tap holds 24 bytes, not 36/)
  assert.deepEqual(pointerScore({ frame: 9, box, tap, chrome: win, source: win }), { score: Infinity, changed: 0 })
  const off = Buffer.from(win); off[3] = 0 // outside what the pointer touches
  assert.equal(pointerScore({ frame: 9, box, tap, chrome: win, source: off }).changed, 1)
  assert.ok(Number.isNaN(pointerScore({ frame: 9, box, tap, chrome: win.subarray(1), source: null }).score))
  assert.equal(untouchedChanges(win, off, w, h, touched), 1)
  const floor = { frame: 34, bubble: 25, pointer: { arrow: 30, glass: 34.5 } }
  assert.equal(checkVerdict({ frame: 1, whole: 40, bubble: Infinity, pointer: { score: 31, changed: 0 } }, floor, 'arrow'), null)
  assert.match(checkVerdict({ frame: 1, whole: 40, bubble: Infinity, pointer: { score: 31, changed: 0 } }, floor, 'glass')!, /not Chrome's/)
  assert.match(checkVerdict({ frame: 1, whole: 40, bubble: Infinity, pointer: { score: NaN, changed: 0 } }, floor, 'arrow')!, /not Chrome's/)
  assert.match(checkVerdict({ frame: 1, whole: 40, bubble: Infinity, pointer: { score: 50, changed: 3 } }, floor, 'arrow')!, /changed 3 samples outside/)
  assert.match(checkVerdict({ frame: 1, whole: 40, bubble: Infinity, pointer: { score: 50, changed: NaN } }, floor, 'arrow')!, /changed its window/)
  assert.equal(checkVerdict({ frame: 1, whole: 40, bubble: 30, pointer: null }, floor, 'arrow'), null)
  assert.match(checkVerdict({ frame: 1, whole: NaN, bubble: 30, pointer: null }, floor, 'arrow')!, /not Chrome's/)
})

test("each clip's pointer layer as files: one entry a frame, pictures written once, a touched mask beside each; the checked frames' boxes kept", async () => {
  const p = parsed(take({ style: 'glass', clips: [[0, 150], [170, 300]] })), plan = planOf(p)
  const look = plan.segments[0]!.pointer!, crop = spriteCrop(look.size)
  // Made-up art: every state a filled disk of coverage and blur around its tip.
  let asked: PointerState[] = []
  const art = async (o: { states: PointerState[] }): Promise<Sprite[]> => { asked = o.states; return o.states.map(() => {
    const rgba = Buffer.alloc(crop.w * crop.h * 4), blur = Buffer.alloc(crop.w * crop.h)
    for (let y = 0; y < crop.h; y++) for (let x = 0; x < crop.w; x++) if (Math.hypot(x - crop.tipX, y - crop.tipY) < look.size / 2) { rgba.set([255, 255, 255, 80], (y * crop.w + x) * 4); blur[y * crop.w + x] = 200 }
    return { w: crop.w, h: crop.h, rgba, blur }
  }) }
  const dir = await mkdtemp(join(tmpdir(), 'pointer-layers-')), checked = pointerSamples(plan)
  const { layers, boxes } = await pointerLayers({ plan, pointerArt: art, log: () => {} }, dir, checked)
  assert.equal(layers.size, 2)
  for (const [i, seg] of plan.segments.entries()) {
    const { layer, held } = layers.get(i)!
    for (const f of [layer.sprites, layer.masks, layer.blur!]) assert.equal((await readFile(f, 'utf8')).trim().split('\n').length, seg.frames)
    assert.equal(layer.shown.length, seg.frames)
    assert.equal(!!held, i === 1, 'the second clip blends over the first one\'s held pointer')
  }
  assert.ok(asked.length > 0 && asked.length < plan.frames, 'each picture drawn once')
  const files = await readdir(join(dir, 'pointer'))
  assert.equal(files.filter((f) => /^p\d+\.png$/.test(f)).length, files.filter((f) => /^m\d+\.png$/.test(f)).length)
  // Every checked frame has its box, the blended one a held box, each with its masks.
  for (const f of checked) assert.ok(boxes.has(f), `frame ${f}`)
  const b1 = plan.segments[1]!
  assert.equal(boxes.get(b1.startFrame)!.held, true)
  for (const b of boxes.values()) assert.ok(b.area > 0 && [...b.mask].every((v, i) => !v || b.touched[i]))
  // Each list's pictures as the graph reads them, and the taps of a clip in its graph.
  const { layer, held } = layers.get(1)!, own = checked.filter((f) => f > b1.startFrame).map((f) => f - b1.startFrame)
  const args = segmentArgs(b1, 60, (f) => f, join(dir, 'out.mp4'), undefined, undefined, { layer, held, tap: { frames: own, file: join(dir, 't.yuv') }, heldTap: { frames: [0], file: join(dir, 'h.yuv') } })
  const graph = args[args.indexOf('-filter_complex') + 1]!
  assert.match(graph, /alphamerge\[ptrpm\]/)
  assert.match(graph, /\[scr1\]split\[scr1q\]\[htapin\]/)
  assert.ok(args.includes(join(dir, 'h.yuv')) && args.includes(join(dir, 't.yuv')))
  assert.equal(hashTaps(own, b1.frames).length > own.length, true)
})

// ---- the glass's blur weight ----------------------------------------------------------------------------------------------

test("the glass's blur weight from the checkerboard: over = bare + k (blur(bare) − bare), then k / (1 − α)", () => {
  const w = 8, h = 8, px = w * h, sigma = 1
  const bare = Buffer.alloc(px * 3)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bare.fill((x + y) % 2 ? 235 : 16, (y * w + x) * 3, (y * w + x + 1) * 3)
  const blurred = gaussian(bare, w, h, sigma)
  // No picture anywhere (α 0): black 0, white 255. The pixels with x < 4 take half the blurred board (k 0.5), the rest none.
  const black = Buffer.alloc(px * 3), white = Buffer.alloc(px * 3, 255), over = Buffer.alloc(px * 3)
  for (let i = 0; i < px; i++) for (let c = 0; c < 3; c++) { const k = i % w < 4 ? 0.5 : 0; over[i * 3 + c] = Math.round(bare[i * 3 + c]! + k * (blurred[i * 3 + c]! - bare[i * 3 + c]!)) }
  const [s] = matte(1, w, h, black, white, { over, bare, sigma })
  for (let i = 1; i < px; i++) {
    const x = i % w
    if (x < 4) assert.ok(Math.abs(s!.blur![i]! - 128) <= 3, `pixel ${i}: ${s!.blur![i]}`)
    else assert.ok(s!.blur![i]! <= 3, `pixel ${i}: ${s!.blur![i]}`)
  }
  // The self-check: a glass whose disk takes about 0.8 of the blur passes, one flattened to nothing does not.
  const size = 36, crop = spriteCrop(size), state = { x: 0, y: 0, press: 1, ring: null }
  const disk = (k: number): Sprite => ({ w: crop.w, h: crop.h, rgba: Buffer.alloc(crop.w * crop.h * 4), blur: Buffer.alloc(crop.w * crop.h, Math.round(k * 255)) })
  assert.ok(glassWeight([disk(0.8)], [state], size) >= GLASS_WEIGHT.min && glassWeight([disk(0.8)], [state], size) <= GLASS_WEIGHT.max)
  assert.ok(glassWeight([disk(0)], [state], size) < GLASS_WEIGHT.min)
})

// ---- the gate ---------------------------------------------------------------------------------------------------------------

test('a take with the arrow or the glass, clicks on, is planned with its pointer', () => {
  for (const style of ['arrow', 'glass'] as const) {
    const plan = planOf(parsed(take({ style })))
    const ptr = plan.segments[0]!.pointer!
    assert.equal(ptr.style, style)
    assert.equal(ptr.size, 18 * 2)
    assert.equal(ptr.states.length, plan.frames)
    assert.ok(ptr.states.some((s) => s?.ring !== null))
  }
  // No pointer drawn: none planned.
  assert.equal(planOf(parsed(take({ style: 'none' }))).segments[0]!.pointer, null)
})

test("pointers drawn at different sizes in one video go to Chrome, by name", () => {
  const p = take({ style: 'arrow', clips: [[0, 150], [170, 300]] })
  // A second recording of the same picture size whose trace was in other points (another display's scale): a pointer of another size.
  p.assets.push({ ...p.assets[0], id: 'b', file: `assets/${sha('b')}.mp4`, sha256: sha('b'), trace: madeUpTrace(6, { width: 1280, height: 720, scale: 1 }) })
  p.clips[1].assetId = 'b'
  assert.match(reasonOf(parsed(p))!, /pointers are drawn at different sizes/)
})

test("an unknown key of the pointer's settings or of the trace the pointer is drawn from goes to Chrome; the recorder's own fields do not", () => {
  const p = parsed(take({ style: 'glass' }))
  const add = (where: (q: EditorProject) => object) => { const q = structuredClone(p); Object.assign(where(q), { glow: 1 }); return reasonOf(q) }
  assert.match(add((q) => q.cursor)!, /The pointer has glow/)
  assert.match(add((q) => q.assets[0]!.trace!)!, /trace has glow/)
  assert.match(add((q) => q.assets[0]!.trace!.viewport)!, /pointer area has glow/)
  assert.match(add((q) => q.assets[0]!.trace!.actions[0]!)!, /An action .* has glow/)
  // What the desktop recorder writes beside the pointer (recorder-bridge-types.ts, StudioTrace) is not a reason.
  const q = structuredClone(p), t = q.assets[0]!.trace! as Record<string, unknown>
  Object.assign(t, { version: 1, clock: { unit: 'ms', origin: 'screen-first-frame', t0HostTime: 1 }, focus: [], durationMs: 6000, mode: 'events', warnings: [] })
  Object.assign(q.assets[0]!.trace!.viewport, { x: 0, y: 0 }); Object.assign(q.assets[0]!.trace!.actions[0]!, { button: 'left' })
  assert.equal(reasonOf(q), null)
  // The schema lets a trace's and an action's extra fields through: a parsed project reaches these refusals.
  const raw = take({ style: 'arrow' }); raw.assets[0].trace.actions[0].pressure = 0.4; raw.assets[0].trace.speed = 2
  const kept = parsed(raw)
  assert.equal((kept.assets[0]!.trace as Record<string, unknown>).speed, 2)
  assert.match(reasonOf(kept)!, /trace has speed/)
  // A recording whose pointer is not drawn (style none) is not asked about its trace.
  const none = structuredClone(p); none.cursor.style = 'none'; Object.assign(none.assets[0]!.trace!, { glow: 1 })
  assert.equal(reasonOf(none), null)
})

// ---- the FFmpeg it needs, the tabs on a computer, the leftovers ---------------------------------------------------------------

test("what an FFmpeg has is read from its own lists; a missing filter or muxer is named in plain words", async () => {
  const filters = 'Filters:\n  T.. = Timeline support\n ---\n T.C overlay           VV->V      Overlay a video source on top of the input.\n ... alphamerge        VV->V      Copy the luma value.\n ... color             |->V       Provide an uniformly colored input.\n'
  const muxers = 'Formats:\n D.. = Demuxing supported\n .E. = Muxing supported\n ---\n  E  framemd5        Per-frame MD5 testing\n  E  mp4             MP4 (MPEG-4 Part 14)\n'
  const demuxers = 'Formats:\n D.. = Demuxing supported\n ---\n D   concat          Virtual concatenation script\n D   mov,mp4,m4a     QuickTime / MOV\n D d lavfi           Libavfilter virtual input device\n'
  const have = { filters: listedNames(filters, 'filters'), muxers: listedNames(muxers, 'formats'), demuxers: listedNames(demuxers, 'formats') }
  assert.deepEqual([...have.filters], ['overlay', 'alphamerge', 'color'])
  assert.deepEqual([...have.muxers], ['framemd5', 'mp4'])
  // FFmpeg 4.x to 6.0 (Debian's 5.1 in the server's image): two flag columns in the format lists; the filter list as above.
  const muxers5 = 'File formats:\n D. = Demuxing supported\n .E = Muxing supported\n --\n  E 3g2             3GP2 (3GPP2 file format)\n  E framemd5        Per-frame MD5 testing\n  E rawvideo        raw video\n DE image2          image2 sequence\n'
  const demuxers5 = 'File formats:\n D. = Demuxing supported\n .E = Muxing supported\n --\n D  aac             raw ADTS AAC (Advanced Audio Coding)\n D  concat          Virtual concatenation script\n DE image2          image2 sequence\n D  lavfi           Libavfilter virtual input device\n'
  const filters5 = 'Filters:\n  T.. = Timeline support\n  .S. = Slice threading\n  ..C = Command support\n  A = Audio input/output\n  V = Video input/output\n  N = Dynamic number and/or type of input/output\n  | = Source or sink filter\n ... abench            A->A       Benchmark part of a filtergraph.\n TSC gblur             V->V       Apply Gaussian Blur filter.\n T.C overlay           VV->V      Overlay a video source on top of the input.\n ... color             |->V       Provide an uniformly colored input.\n'
  assert.deepEqual([...listedNames(muxers5, 'formats')], ['3g2', 'framemd5', 'rawvideo', 'image2'])
  assert.deepEqual([...listedNames(demuxers5, 'formats')], ['aac', 'concat', 'image2', 'lavfi'])
  assert.deepEqual([...listedNames(filters5, 'filters')], ['abench', 'gblur', 'overlay', 'color'])
  // A list read as empty (a layout not known here) is asked part by part instead (`-h filter=…`), so a build that has
  // everything is never refused for its layout, and one missing a part still is.
  const empty = async () => ({ filters: new Set<string>(), muxers: new Set<string>(), demuxers: new Set<string>() })
  assert.equal(await ffmpegLacks(pointerNeeds('glass'), undefined, empty), null)
  assert.equal(await ffmpegLacks({ filters: ['gblur', 'nosuchfilter'], muxers: ['rawvideo', 'nosuchmuxer'], demuxers: [] }, undefined, empty), 'the nosuchfilter filter and the nosuchmuxer muxer')
  // A layout not known here reads as no names, never as names that are not there.
  assert.equal(listedNames('something else entirely\n --\n  E rawvideo  raw\n', 'formats').size, 0)
  assert.ok(have.demuxers.has('mp4') && have.demuxers.has('lavfi') && have.demuxers.has('concat'))
  assert.equal(missingComponents(have, { filters: ['overlay'], muxers: ['mp4'], demuxers: ['concat'] }), null)
  assert.equal(missingComponents(have, pointerNeeds('arrow')), 'the crop filter, the scale filter, the format filter, the split filter, the settb filter, the setpts filter, the select filter, the geq filter, the rawvideo muxer and the image2 demuxer')
  assert.equal(missingComponents({ ...have, filters: new Set([...have.filters, ...pointerNeeds('glass').filters].filter((n) => n !== 'gblur')), muxers: new Set(['rawvideo', 'framemd5']), demuxers: new Set(['concat', 'image2']) }, pointerNeeds('glass')), 'the gblur filter')
  assert.equal(missingComponents(have, pointerNeeds('glass'))?.includes('the gblur filter'), true)
  assert.equal(missingComponents(have, pointerNeeds('glass'))?.includes('the rawvideo muxer'), true)
  assert.equal(missingComponents(have, pointerNeeds('arrow'))?.includes('gblur'), false)
  // This machine's FFmpeg lists what the pointer needs (the image's and a developer's have all of it).
  const real = { filters: listedNames(execFileSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' }), 'filters'), muxers: listedNames(execFileSync('ffmpeg', ['-hide_banner', '-muxers'], { encoding: 'utf8' }), 'formats'),
    demuxers: listedNames(execFileSync('ffmpeg', ['-hide_banner', '-demuxers'], { encoding: 'utf8' }), 'formats') }
  assert.equal(missingComponents(real, pointerNeeds('glass')), null)
})

test('a local export keeps tabs said in STUDIO_RENDER_CONCURRENCY, else its own rule', () => {
  assert.equal(localRenderTabs({ STUDIO_RENDER_CONCURRENCY: '6' }, () => 3), 6)
  assert.equal(localRenderTabs({}, () => 3), 3)
  assert.equal(localRenderTabs({ STUDIO_RENDER_CONCURRENCY: ' ' }, () => 2), 2)
  assert.equal(localRenderTabs({ STUDIO_RENDER_CONCURRENCY: '0' }, () => 2), 2)
  assert.equal(localRenderTabs({ STUDIO_RENDER_CONCURRENCY: 'lots' }, () => 2), 2)
})

test("a fast export that falls back leaves nothing of its own, the pointer's folder included", () => {
  for (const name of ['fast-0.mp4', 'fast-check-12.png', 'video.fast.mp4', 'pointer']) assert.ok(FAST_LEFTOVERS.test(name), name)
  for (const name of ['video.partial.mp4', 'pointers', 'assets']) assert.ok(!FAST_LEFTOVERS.test(name), name)
})

test("the made-up sprite video's frames and its plain backgrounds are the states' own (unchanged by the budget)", () => {
  const p = parsed(take({ style: 'glass' })), plan = planOf(p).segments[0]!.pointer!
  const states = [{ x: 10.5, y: 20.25, press: 1, ring: null }, { x: 3.125, y: 7.75, press: 0.9, ring: 0.4 }]
  const sp = spriteProject(p, plan, states, { file: 'assets/pointer-x/black.mp4', sha256: sha('d'), bytes: 1 })
  assert.equal(sp.assets[0]!.file, 'assets/pointer-x/black.mp4')
  assert.equal(stateFrames(states).frames.length, 2)
})

test("a blend's held pointer is checked even when the incoming clip draws none: its look is the video's", async () => {
  const plan = planOf(parsed(take({ style: 'arrow', clips: [[0, 150], [170, 300]] })))
  const noPointer = { ...plan, segments: [plan.segments[0]!, { ...plan.segments[1]!, pointer: null }] }
  const b = noPointer.segments[1]!
  assert.ok(b.blend?.pointer && heldBox(b, noPointer))
  assert.ok(pointerSamples(noPointer).includes(b.startFrame))
  const look = plan.segments[0]!.pointer!, crop = spriteCrop(look.size)
  const art = async (o: { states: PointerState[] }): Promise<Sprite[]> => o.states.map(() => {
    const rgba = Buffer.alloc(crop.w * crop.h * 4)
    for (let y = 0; y < crop.h; y++) for (let x = 0; x < crop.w; x++) if (Math.hypot(x - crop.tipX, y - crop.tipY) < 10) rgba.set([255, 255, 255, 200], (y * crop.w + x) * 4)
    return { w: crop.w, h: crop.h, rgba, blur: null }
  })
  const { layers, boxes } = await pointerLayers({ plan: noPointer, pointerArt: art, log: () => {} }, await mkdtemp(join(tmpdir(), 'held-')), [b.startFrame])
  assert.ok(layers.get(1)?.held, 'the held layer is drawn')
  assert.equal(boxes.get(b.startFrame)?.held, true, 'and checked')
})

test("the check reads one window of a tap file from its place, and refuses a file of the wrong length", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tap-')), file = join(dir, 't.yuv'), size = 6
  await writeFile(file, Buffer.from([...Array(4 * size).keys()]))
  assert.deepEqual([...(await readTapWindow(file, 2, 4, size)).bytes], [12, 13, 14, 15, 16, 17])
  assert.deepEqual([...(await readTapWindow(file, 0, 4, size)).bytes], [0, 1, 2, 3, 4, 5])
  await assert.rejects(readTapWindow(file, 0, 5, size), /holds 24 bytes, not 30/)
  await assert.rejects(readTapWindow(file, 4, 4, size), /window 4 is not in the pointer's tap of 4/)
})
