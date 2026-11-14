/**
 * The export without Remotion's FFmpeg (chrome-pipe.ts, remotion-sound.ts) against renderMedia's, on made-up videos:
 *
 * - the sound: Remotion's mix made from renderFrames' own layer files, against renderMedia's WAV of the same frames,
 *   sample for sample (whole videos and a window in the middle): a recording's own sound under cuts with their fades,
 *   a microphone track, and twelve loud layers at once (Remotion merges ten at a time, each ten clipped);
 * - the Chrome path: renderFrames' frames through our FFmpeg against renderMedia's file, with the same x264 settings
 *   (the frame count, every frame's PSNR) and with the machine's own encoder (VideoToolbox on a Mac).
 *
 *   STUDIO_CHROME=<a headless shell folder> node --import tsx test/compositor-free-e2e.ts     (renders: one heavy run at a time)
 *
 * renderMedia needs Remotion's compositor, so this runs where it is installed (a developer's machine, the server
 * image); test/desktop-e2e.ts runs the desktop's build, where it is not.
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
import { Renderer, inputPropsFor, COMPOSITION_ID, EXPORT_ENCODING, bt709WithSwscale } from '../src/render.ts'
import { soundOnly } from '../src/fast-export.ts'
import { renderThroughPipe, soundFrames } from '../src/chrome-pipe.ts'
import { encoderArgs, defaultProfile } from '../src/encoders.ts'
import type { EditorProject } from '../../web/src/lib/studio/engine/contracts.ts'

const require = createRequire(import.meta.url)
const { neutralMotion, neutralMotionVisual } = require('../../web/src/lib/studio/engine/motion-contracts.ts') as typeof import('../../web/src/lib/studio/engine/motion-contracts.ts')
const ff = (args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] })
/**
 * The worst a frame of our pipe may score against renderMedia's: the same JPEGs and the same scaler, then two lossy
 * encodes of a busy test card (x264 in Remotion's FFmpeg build and in ours: about 41 dB apart; the machine's own
 * encoder: lower).
 */
export const PIPE_THRESHOLDS = { sameEncoderDb: 38, ownEncoderDb: 36 }

async function cached(cache: string, file: string, ext: string): Promise<{ file: string; sha256: string; bytes: number }> {
  const buf = await readFile(file)
  const sha256 = createHash('sha256').update(buf).digest('hex')
  await rename(file, join(cache, `${sha256}.${ext}`))
  return { file: `assets/${sha256}.${ext}`, sha256, bytes: buf.length }
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'studio-compositor-free-'))
  const cache = join(dir, 'cache', 'assets'), media = join(dir, 'media')
  await mkdir(cache, { recursive: true }); await mkdir(media)
  const S = 6
  ff(['-f', 'lavfi', '-i', `testsrc2=s=1280x720:r=60:d=${S}`, '-f', 'lavfi', '-i', `aevalsrc='0.3*sin(2*PI*(500+60*t)*t)':s=48000:d=${S}`,
    '-vf', 'format=yuv420p', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-g', '60', '-c:a', 'aac', '-b:a', '160k', join(media, 's.mp4')])
  ff(['-f', 'lavfi', '-i', `testsrc2=s=640x360:r=30:d=${S + 1}`, '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-g', '30', join(media, 'c.mp4')])
  ff(['-f', 'lavfi', '-i', `aevalsrc='0.9*sin(2*PI*(180+40*sin(1.3*t)+25*t)*t)':s=48000:d=${S}`, '-c:a', 'aac', '-b:a', '160k', join(media, 'm.m4a')])
  const s = await cached(cache, join(media, 's.mp4'), 'mp4'), c = await cached(cache, join(media, 'c.mp4'), 'mp4'), m = await cached(cache, join(media, 'm.m4a'), 'm4a')
  const assets = [
    { id: 's', kind: 'video', name: 's.mp4', ...s, width: 1280, height: 720, sourceFps: 60, sourceFrames: S * 60, durationSeconds: S, hasAudio: true, sourceCursorHidden: false },
    { id: 'c', kind: 'video', name: 'c.mp4', ...c, width: 640, height: 360, sourceFps: 30, sourceFrames: (S + 1) * 30, durationSeconds: S + 1, hasAudio: false, sourceCursorHidden: false },
    { id: 'm', kind: 'audio', name: 'm.m4a', ...m, durationSeconds: S, hasAudio: true, sourceCursorHidden: false },
  ]
  const clip = (id: string, from: number, to: number) => ({ id, assetId: 's', trimStartSourceFrame: from, trimEndSourceFrame: to, audio: { muted: false, gain: 1 }, holdEndFrames: 0, zooms: [],
    motion: neutralMotion(), playbackRate: 1, dismissedActionIndices: [], view: { main: 'screen', bubble: true } })
  const base = (over: Record<string, unknown>) => parseEditorProject({ schemaVersion: 4, id: 'cf', title: 'CF', output: { width: 1280, height: 720, fps: 60 }, assets,
    clips: [clip('a', 0, 150), clip('b', 190, 330)], presentation: structuredClone(defaultPresentation), cursor: { style: 'none', size: 18, clickFeedback: false }, transcripts: [],
    captions: { ...defaultCaptions }, captionCorrections: {}, voiceoverDraft: { text: '', targetClipIds: [] }, audioTracks: [],
    presenterTrack: { id: 'p', assetId: 'c', audio: { muted: true, gain: 1 }, segments: [{ id: 'g', startFrame: 0, endFrame: 290, sourceStartFrame: 0,
      visual: { ...structuredClone(neutralMotionVisual), rect: { x: 0.72, y: 0.62, width: 0.22, height: 0.33 } }, tracks: [] }], sync: { screenAssetId: 's', offsetSeconds: 0.1 } }, ...over }) as EditorProject
  const mic = (n: number, gain: number) => [{ id: 'mic', name: 'Mic', role: 'voiceover', gain, muted: false,
    segments: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, assetId: 'm', startFrame: 5 + i * 3, trimStartSeconds: 0.1 * i, trimEndSeconds: 0.1 * i + 3.5, fadeInSeconds: 0.2 })) }]
  const projects: [string, EditorProject][] = [
    ['cuts with their sound and a microphone', base({ audioTracks: mic(1, 0.9) })],
    ['twelve loud layers (merged ten at a time, clipped)', base({ clips: [clip('a', 0, 290)], audioTracks: mic(12, 1) })],
    ['a padded look (the Chrome path)', base({ presentation: { ...structuredClone(defaultPresentation), padding: 32 }, audioTracks: mic(1, 0.9) })],
  ]

  // NODE_ENV as the other end-to-end scripts set it: in the image it is "production", where settings without the
  // worker's secret are refused, and this script only renders in this process.
  const loaded = loadConfig({ ...process.env, STUDIO_WORK_DIR: join(dir, 'work'), NODE_ENV: 'test' }, () => 4)
  if ('problems' in loaded) throw new Error(`The worker's settings were refused: ${loaded.problems.join('; ')}`)
  const config = loaded
  const renderer = new Renderer(config, cache)
  const { serveUrl } = await renderer.bundle(() => {})
  const { renderMedia, selectComposition } = await import('@remotion/renderer')
  const pcm = (file: string) => { const b = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-f', 's16le', '-'], { maxBuffer: 1 << 30 }); return new Int16Array(b.buffer, b.byteOffset, b.length / 2) }
  const same = (a: Int16Array, b: Int16Array) => { let d = 0, max = 0; for (let i = 0; i < Math.max(a.length, b.length); i++) { const x = Math.abs((a[i] ?? 0) - (b[i] ?? 0)); if (x) { d++; max = Math.max(max, x) } } return { lengthA: a.length / 2, lengthB: b.length / 2, differing: d, maxDiff: max } }
  let failures = 0
  for (const [name, project] of projects) {
    const common = await renderer.common(() => {}, project)
    const row: Record<string, unknown> = { case: name }
    try {
      // ---- the sound ---------------------------------------------------------------------------------------------
      const props = inputPropsFor(soundOnly(project), 'placeholder')
      const comp = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps: props, ...common })
      for (const [label, range] of [['whole', [0, comp.durationInFrames - 1]], ['window', [97, 131]]] as const) {
        const theirs = join(dir, `theirs-${label}.wav`), ours = join(dir, `ours-${label}.wav`)
        await renderMedia({ serveUrl, composition: comp, inputProps: props, ...common, codec: 'wav', frameRange: [...range], outputLocation: theirs, concurrency: 1, logLevel: 'error' })
        await soundFrames({ serveUrl, composition: comp, inputProps: props, common: { ...common, logLevel: 'error' }, frameRange: [...range], out: ours })
        const r = same(pcm(theirs), pcm(ours))
        row[`sound ${label}`] = r
        assert.equal(r.lengthA, r.lengthB, `${name}, ${label}: length`)
        assert.equal(r.differing, 0, `${name}, ${label}: samples differ`)
      }
      // ---- the Chrome path's picture ------------------------------------------------------------------------------
      if (name.includes('Chrome path')) {
        const props2 = inputPropsFor(project, 'placeholder')
        const comp2 = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps: props2, ...common })
        const theirs = join(dir, 'theirs.mp4')
        let t = Date.now()
        await renderMedia({ serveUrl, composition: comp2, inputProps: props2, ...common, ...EXPORT_ENCODING, ffmpegOverride: bt709WithSwscale, outputLocation: theirs, concurrency: config.renderConcurrency, logLevel: 'error' })
        row.renderMediaSeconds = (Date.now() - t) / 1000
        // x264 only where this FFmpeg has it (the desktop's LGPL build does not, STUDIO_FFMPEG): then the pipe must fail at
        // once on it, not wait for FFmpeg's input to drain after FFmpeg has gone.
        const hasX264 = execFileSync(process.env.STUDIO_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).includes('libx264')
        if (!hasX264) {
          t = Date.now()
          const scratch = join(dir, 'scratch-missing')
          await mkdir(scratch, { recursive: true })
          const timer = new AbortController(), guard = setTimeout(() => timer.abort(), 120_000)
          await assert.rejects(renderThroughPipe({ serveUrl, composition: comp2, inputProps: props2, common: { ...common, logLevel: 'error' }, concurrency: config.renderConcurrency,
            encoder: encoderArgs('x264', comp2.width, comp2.height, comp2.fps), scratch, out: join(dir, 'ours-missing.mp4'), signal: timer.signal, progress: () => {}, frameDrawn: () => {} }),
            (err: Error) => /ffmpeg stopped before the picture was done|failed encoding/.test(err.message) && !timer.signal.aborted)
          clearTimeout(guard)
          row['pipe without the encoder'] = { failedInSeconds: (Date.now() - t) / 1000 }
        }
        for (const profile of [...(hasX264 ? ['x264' as const] : []), defaultProfile(process.platform)]) {
          const ours = join(dir, `ours-${profile}.mp4`), scratch = join(dir, `scratch-${profile}`)
          await mkdir(scratch, { recursive: true })
          t = Date.now()
          await renderThroughPipe({ serveUrl, composition: comp2, inputProps: props2, common: { ...common, logLevel: 'error' }, concurrency: config.renderConcurrency,
            encoder: encoderArgs(profile, comp2.width, comp2.height, comp2.fps), scratch, out: ours, signal: new AbortController().signal, progress: () => {}, frameDrawn: () => {} })
          const seconds = (Date.now() - t) / 1000
          const count = (f: string) => {
            const raw = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', f], { encoding: 'utf8' })
            const n = Number(/\d+/.exec(raw)?.[0])
            if (!Number.isFinite(n)) console.log(`[compositor-free] ffprobe said ${JSON.stringify(raw)} of ${f}`)
            return n
          }
          const psnr = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', ours, '-i', theirs, '-lavfi', '[0:v][1:v]psnr=stats_file=-', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 28 })
            .split('\n').map((l) => /psnr_avg:(\S+)/.exec(l)?.[1]).filter((x): x is string => !!x).map((x) => (x === 'inf' ? 99 : Number(x)))
          const soundOurs = pcm(ours), soundTheirs = pcm(theirs)
          row[`pipe ${profile}`] = { seconds, frames: count(ours), framesRenderMedia: count(theirs), worstDb: Math.min(...psnr), meanDb: +(psnr.reduce((a, b) => a + b, 0) / psnr.length).toFixed(2),
            soundSamples: soundOurs.length / 2, soundSamplesRenderMedia: soundTheirs.length / 2 }
          assert.equal(count(ours), count(theirs), `${name} ${profile}: frame count`)
          assert.ok(Math.min(...psnr) >= (profile === 'x264' ? PIPE_THRESHOLDS.sameEncoderDb : PIPE_THRESHOLDS.ownEncoderDb), `${name} ${profile}: worst frame ${Math.min(...psnr)} dB`)
        }
      }
      row.ok = true
    } catch (err) {
      failures++
      row.ok = false
      row.error = (err as Error).message
    }
    console.log(`[compositor-free] ${JSON.stringify(row)}`)
  }
  await rm(dir, { recursive: true, force: true })
  console.log(failures ? `[compositor-free] ${failures} case(s) FAILED` : '[compositor-free] all cases match renderMedia')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => { console.error('[compositor-free] FAILED:', err); process.exit(1) })
