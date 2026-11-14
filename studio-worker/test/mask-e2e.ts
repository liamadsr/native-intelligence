/**
 * The bubble's mask against Chrome's, on flat colours: a white camera over a black recording, one still drawn by
 * Chrome (renderStill) for each shape, and the fast export's own mask (fast-export.ts, bubbleGeometry: the geq
 * expression its graph runs) made by FFmpeg for the same bubble. Over the corners and over the straight edges, the
 * coverage Chrome drew (its pixels over its white) against the mask's: the RMS of the difference must be at most
 * MASK_RMS, and the same bubble with its radius 2 px larger or smaller must exceed it (so either would be caught).
 *
 * With a textured camera the edge's PSNR depends as much on the camera's sampling as on the mask (the proof's edge
 * bands, which had suggested corners a pixel rounder); flat colours show the mask alone. Measured: Chrome snaps the
 * bubble's clip to whole pixels (each side to the nearest pixel edge, no partial pixels along them) and rounds its
 * corners with the radius as given; the mask does the same since (corners 0.010-0.020 RMS, sides exact; the mask on
 * the fractional square had 0.03-0.06). A radius 2 px off: 0.055-0.13.
 *
 *   STUDIO_CHROME=<a headless shell folder> node --import tsx test/mask-e2e.ts      (renders: one heavy run at a time)
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { parseEditorProject, defaultCaptions, defaultPresentation } from '../src/engine.ts'
import { loadConfig } from '../src/config.ts'
import { Renderer, inputPropsFor, COMPOSITION_ID } from '../src/render.ts'
import { bubbleGeometry, fastExportPlan, type BubblePlan, type FastPlan } from '../src/fast-export.ts'

const require = createRequire(import.meta.url)
const { neutralMotion, neutralMotionVisual } = require('../../web/src/lib/studio/engine/motion-contracts.ts') as typeof import('../../web/src/lib/studio/engine/motion-contracts.ts')
/** The most the mask's coverage may differ from Chrome's (RMS over the corners, and over the edges). */
export const MASK_RMS = 0.03

const ff = (args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 28 })

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'studio-mask-e2e-'))
  const cache = join(dir, 'cache')
  await mkdir(cache, { recursive: true })
  const lossless = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']
  ff(['-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=60:d=2', '-vf', 'format=yuv420p', ...lossless, join(dir, 'black.mp4')])
  ff(['-f', 'lavfi', '-i', 'color=c=white:s=640x360:r=30:d=3', '-vf', 'format=yuv420p', ...lossless, join(dir, 'white.mp4')])
  const asset = async (name: string, id: string, w: number, h: number, fps: number, n: number) => {
    const sha256 = createHash('sha256').update(await readFile(join(dir, name))).digest('hex')
    await rename(join(dir, name), join(cache, `${sha256}.mp4`))
    return { id, kind: 'video', name, file: `assets/${sha256}.mp4`, sha256, bytes: 1, width: w, height: h, sourceFps: fps, sourceFrames: n, durationSeconds: n / fps, hasAudio: false, sourceCursorHidden: false }
  }
  const screen = await asset('black.mp4', 's', 1280, 720, 60, 120), camera = await asset('white.mp4', 'c', 640, 360, 30, 90)
  // NODE_ENV as the other end-to-end scripts set it: in the image it is "production", where settings without the
  // worker's secret are refused, and this script only renders in this process.
  const loaded = loadConfig({ ...process.env, STUDIO_WORK_DIR: join(dir, 'work'), NODE_ENV: 'test' }, () => 4)
  if ('problems' in loaded) throw new Error(`The worker's settings were refused: ${loaded.problems.join('; ')}`)
  const config = loaded
  const renderer = new Renderer(config, cache)
  const { serveUrl } = await renderer.bundle(() => {})
  const { renderStill, selectComposition } = await import('@remotion/renderer')
  let failures = 0
  for (const [name, style, rect] of [
    ['circle', undefined, { x: 0.6137, y: 0.4419, width: 0.2231, height: 0.3967 }],
    ['rounded 0.25', { shape: 'rounded', radius: 0.25 }, { x: 0.6137, y: 0.4419, width: 0.2231, height: 0.3967 }],
    ['rounded 0.1, another place', { shape: 'rounded', radius: 0.1 }, { x: 0.0517, y: 0.0731, width: 0.1803, height: 0.3209 }],
  ] as const) {
    const row: Record<string, unknown> = { case: name }
    try {
      const project = parseEditorProject({ schemaVersion: 4, id: 'mask', title: 'Mask', output: { width: 1280, height: 720, fps: 60 }, assets: [screen, camera],
        clips: [{ id: 'a', assetId: 's', trimStartSourceFrame: 0, trimEndSourceFrame: 120, audio: { muted: true, gain: 1 }, holdEndFrames: 0, zooms: [], motion: neutralMotion(), playbackRate: 1, dismissedActionIndices: [], view: { main: 'screen', bubble: true } }],
        presentation: structuredClone(defaultPresentation), cursor: { style: 'none', size: 18, clickFeedback: false }, transcripts: [], captions: { ...defaultCaptions }, captionCorrections: {}, voiceoverDraft: { text: '', targetClipIds: [] },
        audioTracks: [],
        presenterTrack: { id: 'p', assetId: 'c', audio: { muted: true, gain: 1 }, ...(style ? { style } : {}), segments: [{ id: 'g', startFrame: 0, endFrame: 120, sourceStartFrame: 0,
          visual: { ...structuredClone(neutralMotionVisual), rect }, tracks: [] }], sync: { screenAssetId: 's', offsetSeconds: 0 } } })
      // A sound only so the fast export's gate draws the plan (it refuses a silent video).
      const plan = fastExportPlan({ ...project, audioTracks: [{ id: 't', name: 'T', role: 'voiceover', gain: 1, muted: false, segments: [{ id: 'x', assetId: 'c', startFrame: 0, trimStartSeconds: 0, trimEndSeconds: 1 }] }] } as typeof project)
      assert.ok(!('reason' in plan), 'reason' in plan ? plan.reason : '')
      const b = (plan as FastPlan).segments[0]!.bubble!, g = bubbleGeometry(b)
      const common = await renderer.common(() => {}, project)
      const inputProps = inputPropsFor(project, 'placeholder')
      const comp = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps, ...common })
      const png = join(dir, 'still.png')
      await renderStill({ serveUrl, composition: comp, inputProps, ...common, frame: 30, output: png, imageFormat: 'png' })
      const chrome = ff(['-i', png, '-vf', `crop=${g.bw}:${g.bh}:${g.bx}:${g.by},format=gray`, '-f', 'rawvideo', '-'])
      const white = Math.max(...chrome)
      // The fast export's own mask, as its graph makes it.
      const mask = (bubble: BubblePlan) => ff(['-f', 'lavfi', '-i', `color=c=black:s=${g.bw}x${g.bh}:r=1:d=1,format=gray,geq=lum='${bubbleGeometry(bubble).mask}'`, '-frames:v', '1', '-f', 'rawvideo', '-'])
      const cx = b.square.x + b.square.side / 2, cy = b.square.y + b.square.side / 2, half = b.square.side / 2
      const rms = (m: Buffer, where: 'corners' | 'edges') => {
        let e = 0, n = 0
        for (let j = 0; j < g.bh; j++) for (let i = 0; i < g.bw; i++) {
          const ax = Math.abs(g.bx + i + 0.5 - cx), ay = Math.abs(g.by + j + 0.5 - cy), inCorner = ax > half - b.radius - 3 && ay > half - b.radius - 3
          if ((where === 'corners') !== inCorner) continue
          // Edges: the band along each straight side (none on a circle), not the inside.
          if (where === 'edges' && Math.max(ax, ay) < half - 3) continue
          e += (chrome[j * g.bw + i]! / white - m[j * g.bw + i]! / 255) ** 2; n++
        }
        return +Math.sqrt(e / n).toFixed(4)
      }
      const right = mask(b)
      if (process.env.STUDIO_MASK_DUMP) { const { writeFileSync } = await import('node:fs'); writeFileSync(join(process.env.STUDIO_MASK_DUMP, `${name.replace(/\W+/g, '_')}.json`), JSON.stringify({ g, square: b.square, radius: b.radius, white, chrome: [...chrome] })) }
      row.radius = b.radius
      row.corners = rms(right, 'corners'); row.edges = rms(right, 'edges')
      const shapes = b.radius * 2 >= b.square.side - 1e-9 ? [-2] : [-2, 2]
      row.radiusOff = Object.fromEntries(shapes.map((d) => [`${d > 0 ? '+' : ''}${d}px`, rms(mask({ ...b, radius: b.radius + d }), 'corners')]))
      assert.ok((row.corners as number) <= MASK_RMS, `${name}: corners ${row.corners}`)
      if (!Number.isNaN(row.edges)) assert.ok((row.edges as number) <= MASK_RMS, `${name}: edges ${row.edges}`)
      for (const [k, v] of Object.entries(row.radiusOff as Record<string, number>)) assert.ok(v > MASK_RMS, `${name}: a radius ${k} off passes (${v})`)
      row.ok = true
    } catch (err) {
      failures++
      row.ok = false
      row.error = (err as Error).message
    }
    console.log(`[mask-e2e] ${JSON.stringify(row)}`)
  }
  await rm(dir, { recursive: true, force: true })
  console.log(failures ? `[mask-e2e] ${failures} case(s) FAILED` : '[mask-e2e] the mask is Chrome\'s, and 2 px off either way would show')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => { console.error('[mask-e2e] FAILED:', err); process.exit(1) })
