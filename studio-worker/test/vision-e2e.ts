/**
 * End to end for the Vision jobs (macOS only): the real Swift helpers, built
 * here with swiftc, the worker's own runner and app client against the fake
 * app (./fake-app.ts), real FFmpeg. Made-up media only.
 *
 *   1. The start-up self-test (../src/vision/probe.ts) builds the three helpers
 *      and says `cutouts` and `faces`.
 *   2. cutout: a two-second 1280×720 clip is imported as an asset, cut out
 *      (subject mode by default: any main object), and the stored WebM is
 *      checked: VP9 with an alpha channel (decoded as yuva420p), frame for
 *      frame with the clip, a valid library asset, and alpha that is not empty.
 *   3. faces: the same clip's face track (samples every 0.2 s, well-formed).
 *
 *   node --import tsx test/vision-e2e.ts
 *
 * The default clip is FFmpeg's own: a bright disc drifting over a flat colour,
 * so no face is in it. STUDIO_VISION_CLIP=<a video> runs it on another made-up
 * clip (one with a drawn face shows the face track's boxes; never a photo or
 * video of a real person). STUDIO_VISION_MODE=person|subject picks the mode.
 * STUDIO_E2E_KEEP=1 keeps the folder for a look.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CutoutResult, FacesResult } from '../../web/src/lib/studio/server/job-contract.ts'
import { AppClient, fileSha256 } from '../src/app-client.ts'
import { buildAsset, inspectFile } from '../src/assets.ts'
import { AssetCache } from '../src/cache.ts'
import { loadConfig, type WorkerConfig } from '../src/config.ts'
import { EditorAssetSchema } from '../src/engine.ts'
import { runCutout } from '../src/jobs/cutout.ts'
import { runFaces } from '../src/jobs/faces.ts'
import type { Renderer } from '../src/render.ts'
import { JobRun, type Handlers } from '../src/runner.ts'
import { probeVision } from '../src/vision/probe.ts'
import { FakeApp } from './fake-app.ts'

if (process.platform !== 'darwin') {
  console.log('[vision-e2e] skipped: macOS Vision runs only on a Mac')
  process.exit(0)
}
const SECRET = 'vision-e2e-secret-not-real-0123456789'
const mode = process.env.STUDIO_VISION_MODE === 'person' ? 'person' : 'subject'
const dir = await mkdtemp(join(tmpdir(), 'studio-vision-e2e-'))
const ffprobeJson = (args: string[]) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', ...args, '-of', 'json'], { encoding: 'utf8' }))

try {
  const loaded = loadConfig({ STUDIO_WORK_DIR: join(dir, 'work'), STUDIO_WORKER_SECRET: SECRET })
  if ('problems' in loaded) throw new Error(loaded.problems.join('; '))
  const app = new FakeApp({ secret: SECRET, dir: join(dir, 'app'), partBytes: 256 * 1024 })
  const config: WorkerConfig = { ...loaded, appUrl: await app.start() }

  // 1. The self-test.
  let t = Date.now()
  const found = await probeVision(config)
  console.log(`[vision-e2e] probe: ${[...found.on].join(', ') || 'nothing'}${found.reason ? ` (${found.reason})` : ''} in ${((Date.now() - t) / 1000).toFixed(1)} s`)
  assert.deepEqual([...found.on].sort(), ['cutouts', 'faces'])

  // The clip, imported as the editor would (measured, named by its sha256).
  const clip = join(dir, 'clip.mp4')
  if (process.env.STUDIO_VISION_CLIP) await copyFile(process.env.STUDIO_VISION_CLIP, clip)
  else
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x406a99:s=1280x720:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=0xf2b33d:s=360x360:r=30:d=2',
      '-filter_complex', "[1:v]format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(hypot(X-180,Y-180),170),255,0)'[disc];[0:v][disc]overlay=x='300+300*t':y=180:shortest=1,format=yuv420p[v]",
      '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-movflags', '+faststart', clip])
  const { measured } = await inspectFile(clip, 'Made-up take.mp4')
  const asset = buildAsset(measured, { sha256: await fileSha256(clip), bytes: (await stat(clip)).size }, { name: 'Made-up take.mp4' })
  await app.putBlob(asset.file, clip, 'video/mp4')

  const client = new AppClient({ appUrl: config.appUrl, secret: SECRET, workerId: 'vision-e2e', capabilities: () => [...found.on] })
  const cache = new AssetCache(join(config.workDir, 'cache', 'assets'), config.cacheBytes)
  await cache.init()
  const handlers = { cutout: runCutout, faces: runFaces } as unknown as Handlers
  const runJob = async (kind: 'cutout' | 'faces', input: unknown) => {
    const queued = app.queue(kind, input)
    const claimed = await client.claim([kind])
    assert.ok(claimed, `the ${kind} job was claimed`)
    const outcome = await new JobRun(claimed, { config, client, cache, renderer: {} as Renderer, handlers }).run()
    const job = await app.waitFor(queued, 5000)
    assert.equal(outcome, 'completed', `${kind}: ${job.error ?? ''}\n${job.logs.join('\n')}`)
    return job
  }

  // 2. A real cut-out.
  t = Date.now()
  const cut = await runJob('cutout', { assets: [asset], mode })
  const result = cut.result as CutoutResult
  console.log(`[vision-e2e] cutout in ${((Date.now() - t) / 1000).toFixed(1)} s; log:\n  ${cut.logs.join('\n  ')}`)
  assert.equal(result.cutouts.length, 1)
  const made = result.cutouts[0]!
  assert.equal(made.assetId, asset.id)
  assert.equal(made.mode, mode)
  assert.equal(made.cutoutAssetId, made.asset.id)
  EditorAssetSchema.parse(made.asset)
  assert.match(made.asset.file, /^assets\/[a-f0-9]{64}\.webm$/)
  assert.ok(Math.abs((made.asset.sourceFrames ?? 0) - (asset.sourceFrames ?? 0)) <= 1, `frames ${made.asset.sourceFrames} vs ${asset.sourceFrames}`)
  assert.ok(app.blobs.has(made.asset.file), 'the cut-out is stored')
  const webm = await app.blobFile(made.asset.file, join(dir, 'cutout.webm'))
  const plain = ffprobeJson(['-show_entries', 'stream=codec_name,width,height,pix_fmt:stream_tags', webm]).streams[0]
  // ffprobe reads VP9 with FFmpeg's own decoder, which drops the alpha side stream (yuv420p, tagged alpha_mode 1);
  // libvpx's decoder, as a browser's, reads the alpha: its stream line says yuva420p.
  const opened = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-c:v', 'libvpx-vp9', '-i', webm, '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8' }).stderr
  const decoded = /Video: vp9 \(libvpx-vp9\)[^,]*, (\w+)/.exec(opened)?.[1]
  console.log(`[vision-e2e] cut-out: ${plain.codec_name} ${plain.width}×${plain.height} ${plain.pix_fmt}, tags ${JSON.stringify(plain.tags)}, decoded with libvpx-vp9 as ${decoded}, ${made.asset.sourceFrames} frames, ${made.asset.bytes} bytes`)
  assert.equal(plain.codec_name, 'vp9')
  assert.equal(plain.tags?.alpha_mode, '1')
  assert.equal(decoded, 'yuva420p')
  // How much of the picture the alpha keeps (0 = all transparent).
  const stats = spawnSync('ffmpeg', ['-nostdin', '-c:v', 'libvpx-vp9', '-i', webm, '-vf', 'alphaextract,signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-'], { encoding: 'utf8' })
  const averages = [...stats.stderr.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]))
  const alpha = averages.reduce((a, b) => a + b, 0) / Math.max(1, averages.length) / 255
  console.log(`[vision-e2e] alpha kept: ${(alpha * 100).toFixed(1)}% of the picture on average over ${averages.length} frames`)
  if (mode === 'subject' && !process.env.STUDIO_VISION_CLIP) assert.ok(alpha > 0.01, 'the subject cut-out keeps something')

  // 3. Faces.
  t = Date.now()
  const faces = await runJob('faces', { assets: [asset] })
  const tracks = (faces.result as FacesResult).tracks
  assert.equal(tracks.length, 1)
  assert.equal(tracks[0]!.sha256, asset.sha256)
  assert.ok(tracks[0]!.samples.length >= 9, `samples: ${tracks[0]!.samples.length}`)
  for (const s of tracks[0]!.samples) assert.ok(Number.isFinite(s.t) && Array.isArray(s.faces))
  const withFace = tracks[0]!.samples.filter((s) => s.faces.length)
  console.log(`[vision-e2e] faces in ${((Date.now() - t) / 1000).toFixed(1)} s: ${tracks[0]!.samples.length} samples, a face in ${withFace.length}${withFace.length ? `: ${JSON.stringify(withFace.slice(0, 3))}` : ''}`)
  await app.stop()
  console.log('[vision-e2e] passed')
} finally {
  if (process.env.STUDIO_E2E_KEEP) console.log(`[vision-e2e] kept ${dir}`)
  else await rm(dir, { recursive: true, force: true })
}
