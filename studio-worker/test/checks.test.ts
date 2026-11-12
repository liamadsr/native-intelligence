import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allowedKinds, analysisCapabilities, detectAnalysis, lastJsonLine, onPath, probePython, setAnalysisState } from '../src/analysis.ts'
import { loadConfig } from '../src/config.ts'
import { checkRange, keptFiles, motionResult, reviewResult, shiftContext } from '../src/jobs/checks.ts'
import { frameRange } from '../src/picture.ts'
import { contrastNeeded, contrastRatio, changedShare, fullFrame, hexRgb, issueDetail, layerBox, lookTimes, measureFrame, mergeFindings, settled, type Finding, type Rgb } from '../src/visual.ts'
import type { EditorLayer } from '../../web/src/lib/studio/engine/layers.ts'

// ---- the analysis: finding a Python, capabilities, kinds ----------------------------------------------------------

/** A fake Python: a shell script that answers like one that has (or lacks) numpy and OpenCV. */
async function fakePython(dir: string, ok: boolean): Promise<string> {
  const file = join(dir, ok ? 'python-ok' : 'python-bad')
  await writeFile(file, ok ? '#!/bin/sh\necho "OpenCV 4.10.0 numpy 2.1.0"\n' : '#!/bin/sh\necho "ModuleNotFoundError: No module named \'cv2\'" >&2\nexit 1\n')
  await chmod(file, 0o755)
  return file
}

test('analysis: a Python that imports numpy and OpenCV turns both checks on; one that cannot, none', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'checks-test-'))
  try {
    const good = await fakePython(dir, true)
    const bad = await fakePython(dir, false)
    assert.deepEqual(await probePython(good), { ok: true, versions: 'OpenCV 4.10.0 numpy 2.1.0' })
    const refused = await probePython(bad)
    assert.equal(refused.ok, false)
    assert.match(!refused.ok ? refused.reason : '', /No module named 'cv2'/)
    assert.match(!(await probePython(join(dir, 'missing'))).ok ? 'gone' : '', /gone/)

    const on = await detectAnalysis({ analysisPython: good }, { env: { PATH: '' } })
    assert.equal(on.python, good)
    assert.equal(on.tesseract, null, 'no tesseract on an empty PATH')
    assert.deepEqual(analysisCapabilities(on), ['motionCheck', 'review'])

    const off = await detectAnalysis({ analysisPython: bad }, { env: { PATH: '' } })
    assert.equal(off.python, null)
    assert.match(off.reason ?? '', /can't import numpy and OpenCV/)
    assert.deepEqual(analysisCapabilities(off), [])

    // Unset: python3 on PATH is tried.
    await writeFile(join(dir, 'python3'), '#!/bin/sh\necho "OpenCV 4 numpy 2"\n')
    await chmod(join(dir, 'python3'), 0o755)
    await writeFile(join(dir, 'tesseract'), '#!/bin/sh\n')
    await chmod(join(dir, 'tesseract'), 0o755)
    const found = await detectAnalysis({ analysisPython: null }, { env: { PATH: dir } })
    assert.equal(found.python, join(dir, 'python3'))
    assert.equal(found.tesseract, join(dir, 'tesseract'))
    assert.equal((await detectAnalysis({ analysisPython: null }, { env: { PATH: join(dir, 'none') } })).python, null)
    assert.equal(await onPath('python3', ''), null)
  } finally {
    setAnalysisState({ python: null, tesseract: null, reason: 'test' })
    await rm(dir, { recursive: true, force: true })
  }
})

test('analysis: the motion and review kinds are asked for only while the analysis can run', () => {
  const kinds = ['export', 'motion', 'review', 'look'] as const
  assert.deepEqual(allowedKinds(kinds, { python: null }), ['export', 'look'])
  assert.deepEqual(allowedKinds(kinds, { python: '/usr/bin/python3' }), ['export', 'motion', 'review', 'look'])
})

test('analysis: the answer is the last JSON line the script prints', () => {
  assert.deepEqual(lastJsonLine('warning: something\n{"a":1}\n{"b":2}\n'), { b: 2 })
  assert.deepEqual(lastJsonLine('{"a":1}\nnot json {\n'), { a: 1 })
  assert.equal(lastJsonLine('[1,2]\nplain'), null)
  assert.equal(lastJsonLine(''), null)
})

test('settings: STUDIO_ANALYSIS_PYTHON', () => {
  const set = loadConfig({ STUDIO_ANALYSIS_PYTHON: ' /opt/py/bin/python ' })
  const unset = loadConfig({ STUDIO_ANALYSIS_PYTHON: '' })
  assert.ok(!('problems' in set) && !('problems' in unset))
  if (!('problems' in set) && !('problems' in unset)) {
    assert.equal(set.analysisPython, '/opt/py/bin/python')
    assert.equal(unset.analysisPython, null)
  }
})

// ---- reports -----------------------------------------------------------------------------------------------------

test('checks: a range in seconds, and the review context on the render clock', () => {
  assert.deepEqual(checkRange(undefined, undefined), {})
  assert.deepEqual(checkRange(1, 3.5), { from: 1, to: 3.5 })
  assert.throws(() => checkRange(3, 1), /after/)
  assert.throws(() => checkRange(-1, undefined), /seconds/)
  const shifted = shiftContext({ title: 'T', words: [{ t: 2.5, end: 2.9, text: 'hi' }], layers: [{ name: 'Head', kind: 'text', text: 'Hello', start: 2, end: 4 }], clicks: [3] }, 2)
  assert.deepEqual(shifted, { title: 'T', words: [{ t: 0.5, end: 0.9, text: 'hi' }], layers: [{ name: 'Head', kind: 'text', text: 'Hello', start: 0, end: 2 }], clicks: [1] })
  assert.deepEqual(frameRange(180, 30), [0, 179])
  assert.deepEqual(frameRange(180, 30, 1, 2), [30, 60])
  assert.deepEqual(frameRange(180, 30, 10, 20), [179, 179])
})

test('checks: the motion and review answers keep file names, never this machine’s paths', () => {
  const raw = {
    summary: { alive: 0.4 },
    text: 'moves',
    moves: 3,
    handoffs: [{ start: 1, end: 1.2, kind: 'cut through empty', picture: 'handoff_01.00.png' }],
    pictures: { timeline: '/tmp/x/watch/timeline.png' },
    folder: '/tmp/x/watch',
    compare: { score: 0.5, issues: [], text: 'c' },
  }
  const m = motionResult(raw, 'job-1', 2, ['reference-a'], ['timeline.png'])
  assert.deepEqual(m.pictures, { timeline: 'timeline.png' })
  assert.equal(m.offsetSeconds, 2)
  assert.equal(m.handoffs[0]!.picture, 'handoff_01.00.png')
  assert.ok(!('folder' in m))
  const r = reviewResult({ profile: { scenes: 2 }, issues: [{ at: 0, end: 1, scene: 0, kind: 'static', severity: 3, text: 'x' }], text: 't', pictures: { scenes: 'scenes.png' }, scenes: 2, folder: '/tmp' }, 'job-2', 0, false, [])
  assert.equal(r.onScreenText, 'not-read')
  assert.match(r.note ?? '', /tesseract/)
  assert.equal(reviewResult({}, 'j', 0, true, []).note, undefined)
  assert.deepEqual(keptFiles(['analysis.npz', 'timeline.png', 'motion.json', 'motion.txt', 'scenes', '../x.png', 'move_01.20_onion.png']), ['motion.json', 'motion.txt', 'move_01.20_onion.png', 'timeline.png'])
})

// ---- the visual check's maths ------------------------------------------------------------------------------------

test('visual: WCAG contrast, colours, boxes and what a text needs', () => {
  assert.equal(Math.round(contrastRatio([0, 0, 0], [255, 255, 255]) * 10) / 10, 21)
  assert.equal(contrastRatio([10, 20, 30], [10, 20, 30]), 1)
  assert.equal(Math.round(contrastRatio([119, 119, 119], [255, 255, 255]) * 100) / 100, 4.48)
  assert.deepEqual(hexRgb('#ff8000cc'), [255, 128, 0])
  assert.equal(hexRgb('red'), null)
  assert.equal(contrastNeeded(0.06), 3)
  assert.equal(contrastNeeded(0.04), 4.5)
  const box = layerBox({ x: 0.5, y: 0.5, width: 0.5, height: 0.2 })
  assert.ok(Math.abs(box.x - 0.24) < 1e-9 && Math.abs(box.w - 0.52) < 1e-9 && Math.abs(box.h - 0.208) < 1e-9)
  const edge = layerBox({ x: 0.95, y: 0.05, width: 0.3, height: 0.2 })
  assert.ok(edge.x + edge.w <= 1 + 1e-9 && edge.y === 0)
  assert.equal(fullFrame({ kind: 'image', x: 0.5, y: 0.5, width: 1, height: 1 }), true)
  assert.equal(fullFrame({ kind: 'text', x: 0.5, y: 0.5, width: 1, height: 1 }), false)
  const fading = { startFrame: 30, endFrame: 60, enter: { preset: 'fade' as const, frames: 6 }, exit: { preset: 'none' as const, frames: 1 } }
  assert.deepEqual(lookTimes([fading], 3, 30, 0.5), [1.25, 1.75])
  assert.equal(settled(fading, 33), false, 'still fading in')
  assert.equal(settled(fading, 36), true)
  assert.equal(settled({ ...fading, enter: { preset: 'pop', frames: 10, ease: 'spring' } }, 45), false, 'a spring settles for 1.8 times its frames')
  assert.equal(settled({ ...fading, exit: { preset: 'fade', frames: 6 } }, 55), false, 'leaving')
})

test('visual: findings join into spans, worst kept (lowest for contrast and size), worst kinds first', () => {
  const box = { x: 0.1, y: 0.1, width: 0.2, height: 0.1 }
  const f = (t: number, kind: Finding['kind'], value: number, layerId = 'a'): Finding => ({ t, kind, layerId, name: layerId === 'a' ? 'Headline' : 'Kicker', value, box: { ...box, x: t / 10 } })
  const issues = mergeFindings([f(0.25, 'low-contrast', 2.5), f(0.75, 'low-contrast', 1.8), f(1.25, 'low-contrast', 2.2), f(3.25, 'low-contrast', 2.9), f(0.25, 'small-text', 20, 'b'), f(0.25, 'off-frame', 0.1)], 0.5)
  assert.deepEqual(issues.map((i) => [i.kind, i.from, i.to]), [['low-contrast', 0.25, 1.25], ['low-contrast', 3.25, 3.25], ['off-frame', 0.25, 0.25], ['small-text', 0.25, 0.25]])
  assert.equal(issues[0]!.worst, 1.8)
  assert.equal(issues[0]!.box.x, 0.075)
  assert.equal(issues[0]!.detail, 'contrast 1.8:1 against what is behind it (needs 4.5:1, or 3:1 for big text)')
  assert.equal(issueDetail('small-text', 19.6), '20 px tall at 1080p: too small on a phone')
})

/** A frame of one colour, with an optional rectangle of another. */
function frame(w: number, h: number, bg: number[], rect?: { x0: number; y0: number; x1: number; y1: number; c: number[] }): Rgb {
  const data = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inside = rect && x >= rect.x0 && x < rect.x1 && y >= rect.y0 && y < rect.y1
    data.set(inside ? rect.c : bg, (y * w + x) * 3)
  }
  return { w, h, data }
}

const textLayer = (patch: Partial<EditorLayer> & { style?: Record<string, unknown> }): EditorLayer =>
  ({ id: 'l1', kind: 'text', name: 'Headline', x: 0.5, y: 0.5, width: 0.5, height: 0.2, rotate: 0, opacity: 1, startFrame: 0, endFrame: 60, style: { text: 'Hi', size: 0.06, color: '#ffffff' }, enter: { preset: 'none', frames: 1 }, exit: { preset: 'none', frames: 1 }, automation: [], ...patch }) as unknown as EditorLayer

test('visual: a frame measured against its picture without the overlay', () => {
  const W = 100
  const H = 60
  const base = frame(W, H, [230, 230, 230])
  // Light grey letters on a near-white picture: low contrast, measured from the pixels.
  const faint = frame(W, H, [230, 230, 230], { x0: 35, y0: 25, x1: 65, y1: 35, c: [150, 150, 150] })
  const found = measureFrame(0.5, faint, base, [textLayer({})], null)
  assert.deepEqual(found.map((x) => x.kind), ['low-contrast'])
  assert.ok(found[0]!.value < 3)
  assert.deepEqual(found[0]!.box, { x: 0.35, y: 25 / 60, width: 0.3, height: 10 / 60 })
  // Faint letters that change the picture little anywhere are still measured, at their cores.
  const ghost = measureFrame(0.5, frame(W, H, [238, 240, 244], { x0: 35, y0: 25, x1: 65, y1: 35, c: [201, 205, 214] }), frame(W, H, [238, 240, 244]), [textLayer({})], null)
  assert.deepEqual(ghost.map((x) => x.kind), ['low-contrast'])
  // Black letters: fine. Tiny text says so; text running past the edge says so.
  assert.deepEqual(measureFrame(0.5, frame(W, H, [230, 230, 230], { x0: 35, y0: 25, x1: 65, y1: 35, c: [0, 0, 0] }), base, [textLayer({})], null), [])
  assert.deepEqual(measureFrame(0.5, frame(W, H, [230, 230, 230], { x0: 35, y0: 25, x1: 65, y1: 35, c: [0, 0, 0] }), base, [textLayer({ style: { text: 'Hi', size: 0.02, color: '#000000' } })], null).map((x) => x.kind), ['small-text'])
  const off = measureFrame(0.5, frame(W, H, [230, 230, 230], { x0: 80, y0: 25, x1: 100, y1: 35, c: [0, 0, 0] }), base, [textLayer({ x: 0.9 })], null)
  assert.deepEqual(off.map((x) => x.kind), ['off-frame'])
  // A label on its own panel: the contrast of its colours.
  assert.deepEqual(measureFrame(0.5, faint, base, [textLayer({ style: { text: 'Hi', size: 0.06, color: '#ffffff', background: '#ffff00' } })], null).map((x) => x.kind), ['low-contrast'])
  // Not on screen yet: nothing.
  assert.deepEqual(measureFrame(0.5, base, base, [textLayer({})], null), [])
  // With a person finder: an overlay on the face.
  const mask = new Uint8Array(W * H).fill(255)
  const onFace = measureFrame(0.5, faint, base, [textLayer({ kind: 'card' as EditorLayer['kind'] })], { mask, faces: [{ x: 0.3, y: 0.3, w: 0.4, h: 0.4 }] })
  assert.deepEqual(onFace.map((x) => x.kind), ['covers-face'])
  assert.equal(Math.round(changedShare(faint, base) * 100), 5)
})
