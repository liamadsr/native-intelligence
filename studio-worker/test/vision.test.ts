/**
 * The pure parts of the Vision jobs and the capability check off macOS: no
 * helper is built here (test/vision-e2e.ts builds and runs them on a Mac).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STUDIO_JOB_KINDS } from '../src/engine.ts'
import { cutoutName } from '../src/jobs/cutout.ts'
import { faceSample } from '../src/jobs/faces.ts'
import { cutoutSize, mergeArgs, streamsHaveAlpha } from '../src/vision/cutout.ts'
import { helperPath, jsonLines, swiftCompiler } from '../src/vision/native.ts'
import { probeVision, VISION_KINDS, withVision } from '../src/vision/probe.ts'
import { maskAt, personBox, readPgm } from '../src/vision/subject.ts'

test('off macOS nothing is built and neither capability is said', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vision-probe-'))
  try {
    assert.equal(await swiftCompiler('linux'), null)
    const found = await probeVision({ workDir: dir }, { platform: 'linux' })
    assert.deepEqual([...found.on], [])
    assert.match(found.reason ?? '', /only on a Mac/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the Vision kinds are asked for only while their capability holds; faces rides the provider slot too', () => {
  const all = [...STUDIO_JOB_KINDS]
  assert.deepEqual(VISION_KINDS, { cutout: 'cutouts', faces: 'faces' })
  const media = withVision('media', all, all, new Set())
  assert.ok(!media.includes('cutout') && !media.includes('faces'))
  assert.equal(media.length, all.length - 2)
  assert.deepEqual(withVision('media', all, all, new Set(['cutouts', 'faces'])), all)
  assert.deepEqual(withVision('provider', ['continuity'], all, new Set()), ['continuity'])
  assert.deepEqual(withVision('provider', ['continuity'], all, new Set(['faces'])), ['continuity', 'faces'])
  assert.deepEqual(withVision('provider', ['continuity'], ['export', 'continuity'], new Set(['faces'])), ['continuity'])
  assert.deepEqual(withVision('provider', ['continuity'], all, new Set(['cutouts'])), ['continuity'])
})

test('helper output is read line by line, across chunks, skipping what is not a JSON object', () => {
  const a = jsonLines('', '{"progress":0.5}\nnot json\n{"t":1,')
  assert.deepEqual(a.lines, [{ progress: 0.5 }])
  const b = jsonLines(a.rest, '"faces":[]}\n[1,2]\n')
  assert.deepEqual(b.lines, [{ t: 1, faces: [] }])
  assert.equal(b.rest, '')
  assert.equal(helperPath('/work', 'face-track'), join('/work', 'native', 'face-track', 'face-track'))
})

test('a face-track line becomes a sample: boxes rounded, roll and junk dropped, the done line skipped', () => {
  assert.deepEqual(faceSample({ t: 1.2, faces: [{ x: 0.41234, y: 0.2, w: 0.3, h: 0.4, confidence: 0.91, yaw: -0.2, roll: 0.1, pitch: 0.05 }, { x: 'no' }] }), {
    t: 1.2,
    faces: [{ x: 0.412, y: 0.2, w: 0.3, h: 0.4, confidence: 0.91, yaw: -0.2, pitch: 0.05 }],
  })
  assert.deepEqual(faceSample({ t: 0, faces: [] }), { t: 0, faces: [] })
  assert.equal(faceSample({ done: true, samples: 10 }), null)
  assert.equal(faceSample({ t: -1, faces: [] }), null)
})

test('the cut-out keeps the shape at up to 1920 px, merges the matte as alpha in VP9, and is named for its recording', () => {
  assert.deepEqual(cutoutSize(3840, 2160), { w: 1920, h: 1080 })
  assert.deepEqual(cutoutSize(1080, 1920), { w: 1080, h: 1920 })
  assert.deepEqual(cutoutSize(1281, 721), { w: 1282, h: 722 })
  const args = mergeArgs('in.mp4', 'matte.mov', 'out.webm', { w: 1280, h: 720 })
  assert.ok(args.join(' ').includes('[v][m]alphamerge,format=yuva420p[out]'))
  assert.deepEqual(args.slice(args.indexOf('-c:v'), args.indexOf('-c:v') + 4), ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p'])
  assert.ok(args.includes('-an'))
  assert.equal(args.at(-1), 'out.webm')
  assert.equal(cutoutName('Made-up take.mp4'), 'Made-up take — cut-out.webm')
  assert.equal(streamsHaveAlpha([{ codec_type: 'video', pix_fmt: 'yuv420p', tags: { alpha_mode: '1' } }]), true)
  assert.equal(streamsHaveAlpha([{ codec_type: 'video', pix_fmt: 'yuva420p' }]), true)
  assert.equal(streamsHaveAlpha([{ codec_type: 'video', pix_fmt: 'yuv420p' }]), false)
})

test('a person mask: read from PGM, boxed, and scaled to a frame', () => {
  // 4×2: the person in the two right-hand columns of the bottom row.
  const pgm = Buffer.concat([Buffer.from('P5\n4 2\n255\n'), Buffer.from([0, 0, 0, 0, 0, 0, 255, 200])])
  const mask = readPgm(pgm)!
  assert.deepEqual({ w: mask.w, h: mask.h }, { w: 4, h: 2 })
  assert.deepEqual(personBox(mask), { x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
  assert.equal(personBox({ w: 2, h: 1, data: new Uint8Array([0, 10]) }), null)
  assert.deepEqual([...maskAt(mask, 2, 1)], [0, 200])
  assert.equal(readPgm(Buffer.from('P6\n1 1\n255\nabc')), null)
})
