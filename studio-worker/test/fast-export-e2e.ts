/**
 * The FFmpeg export against Chrome's, frame for frame: made-up recordings (FFmpeg's test sources) imported by the real
 * worker against the fake app, then each made-up video exported twice by the real worker, once with
 * STUDIO_FAST_EXPORT=off (Chrome draws every frame, as before) and once on (fast-export.ts composes it), and compared:
 *
 * - which path ran (the job's log line);
 * - the frame count;
 * - every frame: the right source frame (the fast frame against Chrome's frame before, at and after it, inside the
 *   bubble and outside it: the same frame must score best, or tie when the pictures do not change), and its quality
 *   against Chrome's (PSNR and SSIM, outside the bubble and inside it, the worst frame reported);
 * - the sound: its offset against Chrome's (cross-correlation) and its level.
 *
 * The cases cover what fast-export.ts lets through (PROVEN there): 60 and 30 fps, a 2504×1438 screen and a 1366×766 one
 * (neither a multiple of 16), cuts at odd frames with their blend, a take starting mid-source, a 2x stretch, the bubble
 * in each corner, round and rounded, a 30 fps camera in a 60 fps video and a 60 fps one in a 30 fps video, a camera
 * whose offset falls between frames, two looks (the default; a gradient background with a shadow and a blur), the
 * recording's own sound with cut fades, and a microphone track.
 *
 *   STUDIO_CHROME=<a headless shell folder> node --import tsx test/fast-export-e2e.ts
 *
 * Renders: one heavy run at a time. STUDIO_FAST_E2E_KEEP=1 keeps the files; STUDIO_FAST_E2E_CASES=a,b runs some.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { FakeApp, type FakeJob } from './fake-app.ts'
import { parseEditorProject, defaultCaptions, defaultPresentation } from '../src/engine.ts'
import type { EditorAsset, EditorProject } from '../../web/src/lib/studio/engine/contracts.ts'

const require = createRequire(import.meta.url)
const { neutralMotion, neutralMotionVisual } = require('../../web/src/lib/studio/engine/motion-contracts.ts') as typeof import('../../web/src/lib/studio/engine/motion-contracts.ts')
const { scheduleProject } = require('../../web/src/lib/studio/engine/timeline.ts') as typeof import('../../web/src/lib/studio/engine/timeline.ts')

const ROOT = resolve(import.meta.dirname, '..')
const SECRET = 'fast-e2e-secret-not-real-0123456789abcdef'

/**
 * What the fast export must reach against Chrome on every frame. Outside the bubble 40 dB and SSIM 0.99: what is left
 * there is the two encodings (Chrome's export against itself at another x264 preset scores about 48 dB). Inside the
 * bubble 27 dB and SSIM 0.93: the camera here is a worst case on purpose (a test card with one-pixel checkerboards and
 * sensor noise, drawn up to five times smaller), which Chrome samples without filtering, so a tenth of a pixel moves
 * its aliasing; side by side the two show the same picture (the frame of the right camera frame scores 27–33 dB, the
 * neighbouring camera frame about 22). The sound: lined up to the sample, the same level within half a decibel.
 * The mask's edge on its own, the luma 2 px inside it and 0.5–2.5 px outside it: outside 30 dB, inside 23 dB, and the
 * same bubble drawn with its radius 2 px smaller (about 22-28 dB outside) or larger (about 19-22 inside) must fail
 * them. Circles are capped at half the side. (The mask itself against Chrome's on flat colours: test/mask-e2e.ts.)
 */
export const THRESHOLDS = { outsideDb: 40, outsideSsim: 0.99, bubbleDb: 27, bubbleSsim: 0.93, soundLagMs: 0.5, soundLevelDb: 0.5, mixLevelDb: 0.1, mixResidualDbfs: -90, mixWorstStep: 32, edgeInnerDb: 23, edgeOuterDb: 30 }

const ff = (args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] })
const TAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']
const TO709 = 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p'

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'studio-fast-e2e-'))
  const media = join(dir, 'media')
  await mkdir(media, { recursive: true })
  const workDir = resolve(process.env.STUDIO_E2E_WORK_DIR ?? join(tmpdir(), 'studio-worker-e2e-work'))
  const S = 6
  // Screens: a made-up app window (static parts, a moving test card, the frame number), RGB made BT.709 as recorders do.
  // Untagged (`tags` false): the same BT.709 pixels with no colour said, as a browser's take conformed by the worker arrives.
  const screen = (file: string, w: number, h: number, fps: number, sound: boolean, tags = true, soundDelay = 0) => ff([
    '-f', 'lavfi', '-i', `color=c=0xf2f3f6:s=${w}x${h}:r=${fps}:d=${S}`, '-f', 'lavfi', '-i', `testsrc2=s=${Math.round(w / 2)}x${Math.round(h / 2)}:r=${fps}:d=${S}`,
    ...(sound ? [...(soundDelay ? ['-itsoffset', String(soundDelay)] : []), '-f', 'lavfi', '-i', `aevalsrc='0.2*sin(2*PI*(500+60*t)*t)':s=48000:d=${S}`] : []),
    '-filter_complex', `[0:v]format=rgb24,drawbox=x=0:y=0:w=${Math.round(w * 0.14)}:h=${h}:color=0x23232b:t=fill,drawbox=x=${Math.round(w * 0.18)}:y=${Math.round(h * 0.1)}:w=${Math.round(w * 0.36)}:h=${Math.round(h * 0.04)}:color=0x5b3fd0:t=fill[bg];`
      + `[1:v]format=rgb24[p];[bg][p]overlay=x=${Math.round(w * 0.4)}:y=${Math.round(h * 0.36)}:format=rgb[o];[o]drawtext=text='%{n}':x=20:y=${h - 80}:fontsize=60:fontcolor=white:box=1:boxcolor=black,${TO709}[v]`,
    '-map', '[v]', ...(sound ? ['-map', '2:a', '-c:a', 'aac', '-b:a', '160k'] : []), ...(tags ? TAGS : []), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-g', String(fps), file])
  const camera = (file: string, w: number, h: number, fps: number, tags = true) => ff(['-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}:r=${fps}:d=${S + 1}`,
    '-vf', `format=rgb24,noise=alls=10:allf=t,drawtext=text='%{n}':x=${w * 0.4}:y=${h * 0.35}:fontsize=${Math.round(h / 4)}:fontcolor=white:box=1:boxcolor=black,${TO709}`,
    ...(tags ? TAGS : []), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-g', String(fps), file])
  const files = {
    screen60: join(media, 'screen60.mp4'), screen30: join(media, 'screen30.mp4'), cam30: join(media, 'cam30.mp4'), cam60: join(media, 'cam60.mp4'), mic: join(media, 'mic.m4a'),
    screen60u: join(media, 'screen60u.mp4'), screen30u: join(media, 'screen30u.mp4'), cam30u: join(media, 'cam30u.mp4'), screen60d: join(media, 'screen60d.mp4'),
  }
  screen(files.screen60u, 2504, 1438, 60, false, false)
  screen(files.screen30u, 1366, 766, 30, false, false)
  camera(files.cam30u, 1920, 1080, 30, false)
  // Its sound starts 0.3 s after its picture (kept as it came: on the grid, H.264 in MP4).
  screen(files.screen60d, 1280, 720, 60, true, true, 0.3)
  screen(files.screen60, 2504, 1438, 60, true)
  screen(files.screen30, 1366, 766, 30, false)
  camera(files.cam30, 1920, 1080, 30)
  camera(files.cam60, 1280, 720, 60)
  // A voice-like sound that never repeats, so a shift between two mixes shows.
  ff(['-f', 'lavfi', '-i', `aevalsrc='0.5*sin(2*PI*(180+40*sin(1.3*t)+25*t)*t)*(0.55+0.45*sin(2*PI*1.7*t))':s=48000:d=${S}`, '-c:a', 'aac', '-b:a', '160k', files.mic])

  const app = new FakeApp({ secret: SECRET, dir: join(dir, 'app'), partBytes: 8 * 1024 * 1024 })
  await app.start()
  for (const [key, file] of Object.entries(files)) await app.putBlob(`uploads/${key}`, file, 'application/octet-stream')
  const worker = (fast: boolean) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, NODE_ENV: 'production', STUDIO_APP_URL: app.url, STUDIO_WORKER_SECRET: SECRET, STUDIO_WORKER_ID: `fast-e2e-${fast}`, STUDIO_WORK_DIR: workDir,
      STUDIO_WORKER_POLL_MS: '200', STUDIO_HEALTH_PORT: '0', STUDIO_FAST_EXPORT: fast ? 'on' : 'off' } })
    if (process.env.STUDIO_FAST_E2E_KEEP) { child.stdout.pipe(process.stderr); child.stderr.pipe(process.stderr) } else { child.stdout.resume(); child.stderr.resume() }
    return child
  }
  const run = async (kind: 'import' | 'export', input: unknown) => {
    const job: FakeJob = app.queue(kind, input)
    await app.waitFor(job, 20 * 60_000)
    assert.equal(job.status, 'completed', `${kind}: ${job.error}`)
    return job
  }
  const results: Record<string, unknown>[] = []
  let failures = 0
  try {
    // ---- import --------------------------------------------------------------------------------------------------
    const importer = worker(false)
    const asset = async (key: keyof typeof files, name: string, conform?: 30 | 60) =>
      (await run('import', { uploadKey: `uploads/${key}`, name, ...(conform ? { conform: { fps: conform } } : {}) })).result as { asset: EditorAsset }
    const A = {
      screen60: (await asset('screen60', 'Screen.mp4', 60)).asset, screen30: (await asset('screen30', 'Screen.mp4', 30)).asset,
      cam30: (await asset('cam30', 'Camera.mp4', 30)).asset, cam60: (await asset('cam60', 'Camera.mp4', 60)).asset, mic: (await asset('mic', 'Microphone.m4a')).asset,
      screen60u: (await asset('screen60u', 'Screen.mp4', 60)).asset, screen30u: (await asset('screen30u', 'Screen.mp4', 30)).asset, cam30u: (await asset('cam30u', 'Camera.mp4', 30)).asset,
      screen60d: (await asset('screen60d', 'Screen.mp4', 60)).asset,
    }
    importer.kill('SIGTERM')
    await new Promise((r) => importer.once('exit', r))

    // ---- the cases -------------------------------------------------------------------------------------------------
    const cases = buildCases(A).filter((c) => !process.env.STUDIO_FAST_E2E_CASES || process.env.STUDIO_FAST_E2E_CASES.split(',').includes(c.name))
    const outputs: Record<string, { chrome: string; fast: string; fastLog: string[]; chromeLog: string[] }> = {}
    if (process.env.STUDIO_FAST_E2E_KEEP) for (const c of cases) await writeFile(join(dir, `${c.name}.project.json`), JSON.stringify(c.project))
    for (const fast of [false, true]) {
      const w = worker(fast)
      for (const c of cases) {
        const job = await run('export', { project: c.project, title: c.name })
        const file = await app.blobFile((job.result as { key: string }).key, join(dir, `${c.name}-${fast ? 'fast' : 'chrome'}.mp4`))
        outputs[c.name] ??= { chrome: '', fast: '', fastLog: [], chromeLog: [] }
        outputs[c.name]![fast ? 'fast' : 'chrome'] = file
        outputs[c.name]![fast ? 'fastLog' : 'chromeLog'] = job.logs
      }
      w.kill('SIGTERM')
      await new Promise((r) => w.once('exit', r))
    }

    // ---- the sound itself: FFmpeg's mix against Remotion's, sample for sample (in this process) ------------------------
    const soundRows = new Map<string, Record<string, unknown>>()
    {
      const { Renderer, inputPropsFor, COMPOSITION_ID, EXPORT_ENCODING, bt709WithSwscale } = await import('../src/render.ts')
      const { loadConfig } = await import('../src/config.ts')
      const { soundOnly } = await import('../src/fast-export.ts')
      const { composeSound, soundPlan, SAMPLE_RATE } = await import('../src/fast-sound.ts')
      const { soundLayers } = require('../../web/src/lib/studio/engine/sound-layers.ts') as typeof import('../../web/src/lib/studio/engine/sound-layers.ts')
      const { renderMedia, selectComposition } = await import('@remotion/renderer')
      // NODE_ENV as the other end-to-end scripts set it: in the image it is "production", where settings without the
      // worker's secret are refused, and this block only renders in this process (it talks to no app).
      const loaded = loadConfig({ ...process.env, STUDIO_WORK_DIR: workDir, NODE_ENV: 'test' }, () => 4)
      if ('problems' in loaded) throw new Error(`The worker's settings were refused: ${loaded.problems.join('; ')}`)
      const cfg = loaded
      const renderer = new Renderer(cfg, join(workDir, 'cache', 'assets'))
      const { serveUrl, release } = await renderer.bundle(() => {})
      const cache = (file: string) => join(workDir, 'cache', file)
      // With the lossless encoder (STUDIO_FAST_ENCODER=lossless) the fast export's frames are compared before any lossy
      // encoder: so are Chrome's, rendered here as PNG screenshots encoded at CRF 1 (the export's own colour conversion).
      if (process.env.STUDIO_FAST_ENCODER === 'lossless') for (const c of cases) {
        const common = await renderer.common(() => {}, c.project)
        const inputProps = inputPropsFor(c.project)
        const comp = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps, ...common })
        const out = join(dir, `${c.name}-chrome-png.mp4`)
        await renderMedia({ serveUrl, composition: comp, inputProps, ...common, ...EXPORT_ENCODING, crf: 1, imageFormat: 'png', ffmpegOverride: bt709WithSwscale, outputLocation: out })
        outputs[c.name]!.chrome = out
      }
      for (const c of cases) {
        const common = await renderer.common(() => {}, c.project)
        const inputProps = inputPropsFor(soundOnly(c.project))
        const comp = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps, ...common })
        const reference = join(dir, `${c.name}-remotion.wav`), mine = join(dir, `${c.name}-ffmpeg.wav`)
        await renderMedia({ serveUrl, composition: comp, inputProps, ...common, codec: 'wav', outputLocation: reference, concurrency: 1 })
        const probe = (file: string) => {
          const st = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels,start_time', '-of', 'json', cache(file)], { encoding: 'utf8' })).streams?.[0]
          return st ? { codec: st.codec_name, sampleRate: Number(st.sample_rate), channels: st.channels, startTime: Number(st.start_time) } : null
        }
        if (c.remotionSound) {
          const r = soundPlan(c.project, probe)
          soundRows.set(c.name, { how: 'reason' in r ? `the sound mixed by Remotion (${r.reason})` : 'mixed by FFmpeg' })
          continue
        }
        const how = await composeSound({ project: c.project, frames: comp.durationInFrames, fps: comp.fps, path: cache, out: mine, scratch: dir, probe,
          remotion: async (frameRange, out) => { await renderMedia({ serveUrl, composition: comp, inputProps, ...common, codec: 'wav', frameRange, outputLocation: out, concurrency: 1 }) },
          whole: async () => { throw new Error('the sound was not mixed by FFmpeg') } })
        const a = wav(reference), b = wav(mine), n = Math.min(a.length, b.length)
        let differing = 0, maxDiff = 0, ea = 0, eb = 0, er = 0
        for (let i = 0; i < n; i++) { const d = a[i]! - b[i]!; if (d) { differing++; maxDiff = Math.max(maxDiff, Math.abs(d)) } ea += a[i]! ** 2; eb += b[i]! ** 2; er += d * d }
        // Offset at every layer's start: the shift (±1 ms) that lines the 20 ms after it up best must be 0.
        const offsets = soundLayers(c.project).filter((l) => l.from < comp.durationInFrames).map((l) => {
          const at = Math.floor(l.from / comp.fps * SAMPLE_RATE) * 2, w = 1920
          const err = (k: number) => { let e = 0; for (let i = 0; i < w; i++) e += ((a[at + i] ?? 0) - (b[at + i + k * 2] ?? 0)) ** 2; return e }
          // Ties (a silent start: every shift fits) stay at 0; another shift counts only when it fits strictly better.
          let best = 0, bestErr = err(0)
          for (let k = -48; k <= 48; k++) { const e = err(k); if (e < bestErr) { bestErr = e; best = k } }
          return best
        })
        soundRows.set(c.name, { how, lengthRemotion: a.length / 2, lengthFfmpeg: b.length / 2, differingSamples: differing, maxDiff, offsets,
          levelDb: +(10 * Math.log10(eb / ea)).toFixed(4), residualDb: er ? +(10 * Math.log10(er / ea)).toFixed(1) : -Infinity,
          residualDbfs: er ? +(10 * Math.log10(er / n / 32768 ** 2)).toFixed(1) : -Infinity })
      }
      release()
    }

    // ---- compare ---------------------------------------------------------------------------------------------------
    for (const c of cases) {
      const o = outputs[c.name]!
      const row: Record<string, unknown> = { case: c.name }
      try {
        assert.ok(o.fastLog.some((l) => /with FFmpeg \(the fast export/.test(l)), `${c.name}: the fast export did not run: ${o.fastLog.filter((l) => /Chrome|fast export/.test(l)).join(' | ')}`)
        assert.ok(o.fastLog.some((l) => /^Composed in/.test(l)), `${c.name}: the fast export fell back: ${o.fastLog.filter((l) => /fast export|Chrome/.test(l)).join(' | ')}`)
        assert.ok(o.chromeLog.some((l) => /Rendering in Chrome: STUDIO_FAST_EXPORT is off/.test(l)))
        const frames = [count(o.chrome), count(o.fast)]
        row.frames = frames[0]
        assert.equal(frames[1], frames[0], `${c.name}: frame count`)
        const box = c.bubbleBox
        const outside = box ? excludeCrop(c.project.output.width, c.project.output.height, box) : 'null'
        const at = (off: number, crop: string) => perFrame(o.fast, o.chrome, off, crop)
        const out0 = at(0, outside), outM = at(-1, outside), outP = at(1, outside)
        const bub0 = box ? at(0, crop(box)) : null, bubM = box ? at(-1, crop(box)) : null, bubP = box ? at(1, crop(box)) : null
        // The right frame everywhere: no neighbour scores better (by more than 0.5 dB, for frames that do not change).
        for (let k = 1; k < out0.psnr.length - 1; k++) {
          const better = (cur: number[], m: number[], p: number[]) => Math.max(m[k] ?? -Infinity, p[k] ?? -Infinity) > cur[k]! + 0.5 && cur[k]! < 60
          if (better(out0.psnr, outM.psnr, outP.psnr)) throw new Error(`${c.name}: frame ${k} matches a neighbouring frame of Chrome's better (outside the bubble)`)
          if (bub0 && better(bub0.psnr, bubM!.psnr, bubP!.psnr)) throw new Error(`${c.name}: frame ${k}'s bubble matches a neighbouring frame of Chrome's better`)
        }
        const worst = (xs: number[]) => xs.reduce((m, x, i) => (x < m.v ? { v: x, frame: i } : m), { v: Infinity, frame: -1 })
        row.outsideDb = worst(out0.psnr); row.outsideSsim = worst(out0.ssim)
        if (bub0) { row.bubbleDb = worst(bub0.psnr.filter((_, i) => c.bubbleFrames!(i))); row.bubbleSsim = worst(bub0.ssim.filter((_, i) => c.bubbleFrames!(i))) }
        // The mask's edge on its own (2 px either side of it, the luma): a radius wrong by 2 px must fall below what the right one reaches.
        if (box) {
          const { fastExportPlan, segmentArgs, bubbleGeometry } = await import('../src/fast-export.ts')
          const plan = fastExportPlan(c.project) as Extract<ReturnType<typeof fastExportPlan>, { segments: unknown }>
          const seg = plan.segments.find((x) => x.bubble)!, b = seg.bubble!, g = bubbleGeometry(b)
          const frames = Array.from({ length: seg.frames }, (_, l) => seg.startFrame + l).filter((f) => f >= seg.startFrame + b.offset && c.bubbleFrames!(f))
          // Two bands: just inside the edge (the camera: a mask too small shows the screen there) and just outside it (the
          // screen: a mask too large shows the camera there). Each against Chrome's, the worst frame.
          const chromeY = lumaBox(o.chrome, g), fastY = lumaBox(o.fast, g), inner = edgeBand(g, b.square, b.radius, -2, 0), outer = edgeBand(g, b.square, b.radius, 0.5, 2.5)
          const bands = (y: Buffer, shift: number) => ({ inner: Math.min(...frames.map((f) => bandPsnr(y, chromeY, f - shift, f, inner, g.bw * g.bh))), outer: Math.min(...frames.map((f) => bandPsnr(y, chromeY, f - shift, f, outer, g.bw * g.bh))) })
          row.edgeDb = bands(fastY, 0)
          const wrong: Record<string, { inner: number; outer: number }> = {}
          for (const dr of process.env.STUDIO_FAST_E2E_SWEEP ? [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2].filter((d) => b.radius + d <= b.square.side / 2) : b.radius * 2 >= b.square.side - 1e-9 ? [-2] : [-2, 2]) {
            const out = join(dir, `${c.name}-radius${dr}.mp4`)
            execFileSync('ffmpeg', segmentArgs({ ...seg, blend: seg.blend, bubble: { ...b, radius: b.radius + dr } }, plan.fps, (f) => join(workDir, 'cache', f), out), { stdio: ['ignore', 'inherit', 'inherit'] })
            const y = lumaBox(out, g)
            wrong[`${dr > 0 ? '+' : ''}${dr}px`] = bands(y, seg.startFrame)
          }
          row.edgeWrongRadiusDb = wrong
        }
        const sound = soundCompare(o.chrome, o.fast)
        row.sound = sound
        const mix = soundRows.get(c.name)!
        row.mix = mix
        const expected = c.remotionSound ?? /the sound mixed by FFmpeg/
        assert.ok(o.fastLog.some((l) => expected.test(l)), `${c.name}: the export's sound was not as expected (${expected}): ${o.fastLog.filter((l) => /sound/.test(l)).join(' | ')}`)
        if (c.remotionSound) assert.match(String(mix.how), c.remotionSound)
        const bad = [
          (row.outsideDb as { v: number }).v < THRESHOLDS.outsideDb && 'outside PSNR',
          (row.outsideSsim as { v: number }).v < THRESHOLDS.outsideSsim && 'outside SSIM',
          bub0 && (row.bubbleDb as { v: number }).v < THRESHOLDS.bubbleDb && 'bubble PSNR',
          bub0 && (row.bubbleSsim as { v: number }).v < THRESHOLDS.bubbleSsim && 'bubble SSIM',
          bub0 && Math.min((row.edgeDb as { inner: number }).inner - THRESHOLDS.edgeInnerDb, (row.edgeDb as { outer: number }).outer - THRESHOLDS.edgeOuterDb) < 0 && 'mask edge PSNR',
          bub0 && Object.entries(row.edgeWrongRadiusDb as Record<string, { inner: number; outer: number }>).some(([k, v]) => /2px$/.test(k) && v.inner >= THRESHOLDS.edgeInnerDb && v.outer >= THRESHOLDS.edgeOuterDb) && 'a mask 2 px off would pass',
          Math.abs(sound.lagMs) > THRESHOLDS.soundLagMs && 'sound offset',
          Math.abs(sound.levelDb) > THRESHOLDS.soundLevelDb && 'sound level',
          !c.remotionSound && mix.lengthRemotion !== mix.lengthFfmpeg && 'mix length',
          !c.remotionSound && (mix.offsets as number[]).some((x) => x !== 0) && 'mix offset at a layer start',
          !c.remotionSound && Math.abs(mix.levelDb as number) > THRESHOLDS.mixLevelDb && 'mix level',
          !c.remotionSound && (mix.residualDbfs as number) > THRESHOLDS.mixResidualDbfs && 'mix residual',
          !c.remotionSound && (mix.maxDiff as number) > THRESHOLDS.mixWorstStep && 'mix sample difference',
        ].filter(Boolean)
        row.ok = bad.length === 0
        if (bad.length) { failures++; row.failed = bad }
      } catch (err) {
        failures++
        row.ok = false
        row.error = (err as Error).message
      }
      results.push(row)
      console.log(`[fast-e2e] ${JSON.stringify(row)}`)
    }
  } finally {
    await app.stop()
    if (!process.env.STUDIO_FAST_E2E_KEEP) await rm(dir, { recursive: true, force: true })
    else console.log(`[fast-e2e] kept ${dir}`)
  }
  console.log(failures ? `[fast-e2e] ${failures} case(s) FAILED` : `[fast-e2e] all ${results.length} cases match Chrome`)
  process.exit(failures ? 1 : 0)
}

// ---- the made-up videos ----------------------------------------------------------------------------------------------
/** `remotionSound`: the sound this case must leave to Remotion's mix (fast-sound.ts's reason), the picture still FFmpeg's. */
type Case = { name: string; project: EditorProject; bubbleBox?: { x: number; y: number; w: number; h: number }; bubbleFrames?: (frame: number) => boolean; remotionSound?: RegExp }

function buildCases(A: Record<'screen60' | 'screen30' | 'cam30' | 'cam60' | 'mic' | 'screen60u' | 'screen30u' | 'cam30u' | 'screen60d', EditorAsset>): Case[] {
  const make = (o: { name: string; screen: EditorAsset; camera: EditorAsset; clips: { from: number; to: number; rate?: number; muted?: boolean }[]; corner: 'tl' | 'tr' | 'bl' | 'br';
    style?: { shape: 'circle' | 'rounded'; radius: number }; offset: number; look?: 'default' | 'gradient' | 'solid'; mic?: boolean; noCamera?: boolean; micFades?: boolean }): Case => {
    const screen = o.clips.some((c) => (c.rate ?? 1) > 1)
      ? { ...o.screen, trace: { viewport: { width: o.screen.width!, height: o.screen.height!, scale: 1 }, cursor: [], actions: o.clips.filter((c) => (c.rate ?? 1) > 1).map((c) => ({ t: c.from / o.screen.sourceFps! * 1000, end: c.to / o.screen.sourceFps! * 1000, kind: 'type', label: 'Typing', box: null })) } }
      : o.screen
    const W = screen.width!, H = screen.height!, fps = screen.sourceFps!
    const side = Math.min(W * 0.22, H * 0.28), w = side / W, h = side / H
    const x = o.corner.endsWith('r') ? 1 - w - 0.04 : 0.04, y = o.corner.startsWith('b') ? 1 - h - 0.04 : 0.04
    const presentation = structuredClone(defaultPresentation)
    if (o.look === 'gradient') Object.assign(presentation, { background: { ...presentation.background, kind: 'gradient' }, blur: 12, shadow: { opacity: 0.5, blur: 60, distance: 20, angle: 90 } })
    if (o.look === 'solid') Object.assign(presentation, { background: { ...presentation.background, kind: 'solid', color: '#204060' } })
    let project = {
      schemaVersion: 4, id: `fast-${o.name}`, title: o.name, output: { width: W, height: H, fps }, assets: [screen, o.camera, ...(o.mic ? [A.mic] : [])],
      clips: o.clips.map((c, i) => ({ id: `clip-${i}`, assetId: screen.id, trimStartSourceFrame: c.from, trimEndSourceFrame: c.to, audio: { muted: !!c.muted || !screen.hasAudio || (c.rate ?? 1) > 1, gain: 1 },
        holdEndFrames: 0, zooms: [], motion: neutralMotion(), playbackRate: c.rate ?? 1, dismissedActionIndices: [], view: { main: 'screen', bubble: true } })),
      presentation, cursor: { style: 'none', size: 18, clickFeedback: false }, audioTracks: [], presenterTrack: null, transcripts: [], captions: { ...defaultCaptions },
      captionCorrections: {}, voiceoverDraft: { text: '', targetClipIds: [] },
    } as unknown as EditorProject
    const total = scheduleProject(project).reduce((n, s) => Math.max(n, s.startFrame + s.durationFrames), 0)
    const camFrames = Math.floor(o.camera.sourceFrames! / o.camera.sourceFps! * fps)
    project = { ...project, presenterTrack: { id: 'presenter', assetId: o.camera.id, audio: { muted: true, gain: 1 }, ...(o.style ? { style: o.style } : {}),
      segments: [{ id: 'presenter-segment', startFrame: 0, endFrame: Math.min(total, camFrames), sourceStartFrame: 0,
        visual: { ...structuredClone(neutralMotionVisual), rect: { x, y, width: w, height: h } }, tracks: [] }],
      sync: { screenAssetId: screen.id, offsetSeconds: o.offset } } } as EditorProject
    if (o.mic) {
      const segments = scheduleProject(project).filter((s) => s.clip.playbackRate === 1).map((s, i) => {
        const from = s.clip.trimStartSourceFrame / fps - 0.1, to = s.clip.trimEndSourceFrame / fps - 0.1, st = Math.max(0, from), en = Math.min(A.mic.durationSeconds!, to)
        return { id: `mic-${i}`, assetId: A.mic.id, startFrame: s.startFrame + Math.round((st - from) * fps), trimStartSeconds: Math.round(st * 1e6) / 1e6, trimEndSeconds: Math.round(en * 1e6) / 1e6, label: `sync:${screen.id}@0.1`, ...(o.micFades ? { fadeInSeconds: 0.3, fadeOutSeconds: 0.4 } : {}) }
      }).filter((s) => s.trimEndSeconds - s.trimStartSeconds > 0.05)
      project = { ...project, audioTracks: [{ id: 'mic', name: 'Microphone', role: 'voiceover', gain: 0.9, muted: false, segments }] } as EditorProject
    }
    if (o.noCamera) project = { ...project, presenterTrack: null, assets: project.assets.filter((a) => a.id !== o.camera.id) } as EditorProject
    project = parseEditorProject(project)
    if (o.noCamera) return { name: o.name, project }
    const box = { x: Math.floor(x * W), y: Math.floor(y * H), w: Math.ceil(side), h: Math.ceil(side) }
    // Frames with the bubble: those the camera covers (the sync offset can leave the first frames without it).
    const lead = Math.max(0, Math.ceil(o.offset * fps))
    return { name: o.name, project, bubbleBox: box, bubbleFrames: (f) => f >= lead }
  }
  const s60 = A.screen60, s30 = A.screen30
  return [
    make({ name: 'plain60', screen: s60, camera: A.cam30, clips: [{ from: 0, to: s60.sourceFrames! }], corner: 'br', offset: 0.25, mic: true }),
    make({ name: 'cuts60', screen: s60, camera: A.cam30, clips: [{ from: 7, to: 101 }, { from: 133, to: 197, rate: 2 }, { from: 211, to: 333 }], corner: 'tl',
      style: { shape: 'rounded', radius: 0.25 }, offset: 0.137, look: 'gradient', mic: true }),
    make({ name: 'odd30', screen: s30, camera: A.cam60, clips: [{ from: 0, to: s30.sourceFrames! }], corner: 'tr', offset: 0.05, look: 'solid', mic: true }),
    // No camera, the recording's own sound, a cut. Before media-video.tsx read a held frame through its own decoder, Chrome's
    // export showed source frame 132 where 179 was held under this cut's blend (fast-export.ts compared it and fell back).
    make({ name: 'nocamcut60', screen: s60, camera: A.cam30, clips: [{ from: 5, to: 180 }, { from: 213, to: 341 }], corner: 'br', offset: 0, noCamera: true }),
    make({ name: 'cuts30', screen: s30, camera: A.cam30, clips: [{ from: 3, to: 61 }, { from: 77, to: 150 }], corner: 'bl', style: { shape: 'rounded', radius: 0.1 }, offset: -0.2, mic: true, micFades: true }),
    // No colour said in the files (a browser's take, conformed): Chrome and FFmpeg must read them alike, at 60 and 30.
    make({ name: 'untagged60', screen: A.screen60u, camera: A.cam30u, clips: [{ from: 0, to: 250 }, { from: 271, to: 360 }], corner: 'br', offset: 0.1, mic: true }),
    make({ name: 'untagged30', screen: A.screen30u, camera: A.cam30u, clips: [{ from: 0, to: 180 }], corner: 'tl', style: { shape: 'rounded', radius: 0.2 }, offset: 0.05, mic: true }),
    // The recording's sound starts 0.3 s after its picture: not mixed here (Remotion places it by its time), the picture still is.
    { ...make({ name: 'delayed60', screen: A.screen60d, camera: A.cam30, clips: [{ from: 0, to: 300 }], corner: 'br', offset: 0, noCamera: true }), remotionSound: /the sound mixed by Remotion \(a sound starts at 0\.2\d* s in its file/ },
  ]
}

// ---- measuring -------------------------------------------------------------------------------------------------------
function count(file: string): number {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim())
}
const crop = (b: { x: number; y: number; w: number; h: number }) => `crop=${b.w}:${b.h}:${b.x}:${b.y}`
/** Everything but the bubble: the bubble's box painted black in both. */
const excludeCrop = (W: number, H: number, b: { x: number; y: number; w: number; h: number }) => `drawbox=x=${b.x - 4}:y=${b.y - 4}:w=${b.w + 8}:h=${b.h + 8}:color=black:t=fill`
/** PSNR and SSIM of every frame of `a` against `b` shifted by `off` frames (b's frame k+off against a's frame k). */
function perFrame(a: string, b: string, off: number, filter: string): { psnr: number[]; ssim: number[] } {
  const shift = off >= 0 ? `trim=start_frame=${off},setpts=PTS-STARTPTS,` : ''
  const lead = off < 0 ? `trim=start_frame=${-off},setpts=PTS-STARTPTS,` : ''
  const r = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-i', a, '-i', b, '-lavfi',
    `[0:v]${lead}${filter},split[a1][a2];[1:v]${shift}${filter},split[b1][b2];[a1][b1]psnr=stats_file=-;[a2][b2]ssim=stats_file=-`, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  const psnr: number[] = [], ssim: number[] = []
  for (const line of r.stdout.split('\n')) {
    const p = /psnr_avg:(\S+)/.exec(line), s = /All:([\d.]+)/.exec(line)
    if (p) psnr.push(p[1] === 'inf' ? 99 : Number(p[1]))
    if (s) ssim.push(Number(s[1]))
  }
  // With a negative shift a's frames start late: put them back at their own index.
  return off < 0 ? { psnr: [...Array(-off).fill(-Infinity), ...psnr], ssim: [...Array(-off).fill(0), ...ssim] } : { psnr, ssim }
}
/** The luma of the bubble's box, every frame, as one buffer (bw × bh bytes a frame). */
function lumaBox(file: string, g: { bx: number; by: number; bw: number; bh: number }): Buffer {
  return execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-vf', `crop=${g.bw}:${g.bh}:${g.bx}:${g.by},extractplanes=y`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 })
}
/** The pixels of the box whose centre is `from` to `to` px from the bubble's edge (a rounded square's signed distance: below 0 inside). */
function edgeBand(g: { bx: number; by: number; bw: number; bh: number }, q: { x: number; y: number; side: number }, r: number, from: number, to: number): number[] {
  const out: number[] = [], cx = q.x + q.side / 2, cy = q.y + q.side / 2, half = q.side / 2
  for (let j = 0; j < g.bh; j++) for (let i = 0; i < g.bw; i++) {
    const qx = Math.abs(g.bx + i + 0.5 - cx) - (half - r), qy = Math.abs(g.by + j + 0.5 - cy) - (half - r)
    const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
    if (d >= from && d <= to) out.push(j * g.bw + i)
  }
  return out
}
/** PSNR over `band` of frame `fa` of one luma box against frame `fb` of another (`n` bytes a frame). */
function bandPsnr(a: Buffer, b: Buffer, fa: number, fb: number, band: number[], n: number): number {
  let se = 0
  for (const k of band) { const d = (a[fa * n + k] ?? 0) - (b[fb * n + k] ?? 0); se += d * d }
  return se ? 10 * Math.log10((255 * 255 * band.length) / se) : 99
}
/** A 16-bit WAV's samples (interleaved). */
function wav(file: string): Int16Array {
  const buf = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-f', 's16le', '-acodec', 'pcm_s16le', '-'], { maxBuffer: 512 * 1024 * 1024 })
  return new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2)
}
function pcm(file: string): Float64Array {
  const out = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 512 * 1024 * 1024 })
  return Float64Array.from(new Float32Array(out.buffer, out.byteOffset, out.byteLength / 4))
}
/** The fast file's sound against Chrome's: the lag (ms) that lines them up best, and the level difference (dB). */
function soundCompare(chrome: string, fast: string): { lagMs: number; levelDb: number; residualDb: number } {
  const a = pcm(chrome), b = pcm(fast), n = Math.min(a.length, b.length), w = Math.min(96000, Math.floor(n / 2)), mid = Math.floor((n - w) / 2)
  let best = 0, bestDot = -Infinity
  for (let k = -960; k <= 960; k++) {
    let dot = 0
    for (let i = 0; i < w; i += 2) dot += a[mid + i]! * (b[mid + i + k] ?? 0)
    if (dot > bestDot) { bestDot = dot; best = k }
  }
  let ea = 0, eb = 0, er = 0
  for (let i = 0; i < w; i++) { const x = a[mid + i]!, y = b[mid + i + best] ?? 0; ea += x * x; eb += y * y; er += (x - y) ** 2 }
  return { lagMs: +(best / 48).toFixed(2), levelDb: +(10 * Math.log10(eb / ea)).toFixed(2), residualDb: +(10 * Math.log10(er / ea)).toFixed(1) }
}

main().catch((err) => {
  console.error('[fast-e2e] FAILED:', err)
  process.exit(1)
})
