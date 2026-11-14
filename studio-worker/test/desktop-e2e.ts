/**
 * The desktop's build, end to end, with Remotion's compositor ABSENT: scripts/build-local-runner.ts builds what the
 * desktop app carries into a fresh folder (it leaves out @remotion/compositor-*, Remotion's GPL FFmpeg), and that
 * runner.cjs, run by plain Node from that folder (nothing above it to find another node_modules in), exports through
 * the fake app's local-export routes:
 *
 * - a recording with its camera bubble and a microphone: the fast export, its sound mixed by FFmpeg, its check windows
 *   and checked frames from Chrome;
 * - the same with a padded look: the Chrome path, renderFrames' frames through our FFmpeg, Remotion's own mix of the
 *   sound from renderFrames' layer files.
 *
 * It fails if any desktop code path reaches for the compositor (renderMedia, Remotion's FFmpeg or ffprobe, its frame
 * extractor): the package is not there, so that call throws and the job fails.
 *
 *   STUDIO_CHROME=<a headless shell folder> node --import tsx test/desktop-e2e.ts      (renders: one heavy run at a time)
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { FakeApp } from './fake-app.ts'
import { parseEditorProject, defaultCaptions, defaultPresentation } from '../src/engine.ts'
import { engineRenderVersion } from '../src/render.ts'
import { findBinary } from '../src/media.ts'

const require = createRequire(import.meta.url)
const { neutralMotion, neutralMotionVisual } = require('../../web/src/lib/studio/engine/motion-contracts.ts') as typeof import('../../web/src/lib/studio/engine/motion-contracts.ts')
const ROOT = resolve(import.meta.dirname, '..')
const ff = (args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] })

async function main() {
  const chrome = process.env.STUDIO_CHROME
  if (!chrome) throw new Error('set STUDIO_CHROME to a Chrome headless shell folder')
  const dir = await mkdtemp(join(tmpdir(), 'studio-desktop-e2e-'))
  const build = join(dir, 'desktop')
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/build-local-runner.ts', build], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] })
  const kept = readdirSync(join(build, 'runner', 'node_modules', '@remotion'))
  assert.ok(!kept.some((n) => n.startsWith('compositor')), `the build carries ${kept.join(', ')}`)

  const media = join(dir, 'media')
  await mkdir(media)
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=60:d=4', '-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*(500+60*t)*t)':s=48000:d=4", '-vf', 'format=yuv420p',
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', '60', '-c:a', 'aac', '-b:a', '160k', join(media, 's.mp4')])
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=5', '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', '30', join(media, 'c.mp4')])
  ff(['-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*(200+30*t)*t)':s=48000:d=4", '-c:a', 'aac', '-b:a', '128k', join(media, 'm.m4a')])
  // The same sound starting 0.3 s into its file: the FFmpeg mix refuses it, Remotion's whole mix is made without its FFmpeg.
  ff(['-itsoffset', '0.3', '-i', join(media, 'm.m4a'), '-c', 'copy', '-copyts', join(media, 'd.m4a')])
  const app = new FakeApp({ secret: 'desktop-e2e-not-a-worker', dir: join(dir, 'app'), partBytes: 4 * 1024 * 1024 })
  await app.start()
  try {
    const blob = async (name: string, ext: string) => {
      const sha256 = createHash('sha256').update(await readFile(join(media, name))).digest('hex'), file = `assets/${sha256}.${ext}`
      const meta = await app.putBlob(file, join(media, name))
      return { file, sha256, bytes: meta.bytes }
    }
    const s = await blob('s.mp4', 'mp4'), c = await blob('c.mp4', 'mp4'), m = await blob('m.m4a', 'm4a'), d = await blob('d.m4a', 'm4a')
    const assets = [
      { id: 's', kind: 'video', name: 's.mp4', ...s, width: 1280, height: 720, sourceFps: 60, sourceFrames: 240, durationSeconds: 4, hasAudio: true, sourceCursorHidden: false },
      { id: 'c', kind: 'video', name: 'c.mp4', ...c, width: 640, height: 360, sourceFps: 30, sourceFrames: 150, durationSeconds: 5, hasAudio: false, sourceCursorHidden: false },
      { id: 'm', kind: 'audio', name: 'm.m4a', ...m, durationSeconds: 4, hasAudio: true, sourceCursorHidden: false },
      { id: 'd', kind: 'audio', name: 'd.m4a', ...d, durationSeconds: 4.3, hasAudio: true, sourceCursorHidden: false },
    ]
    const project = (padding: number, micAsset = 'm') => parseEditorProject({ schemaVersion: 4, id: 'desk', title: 'Desk', output: { width: 1280, height: 720, fps: 60 }, assets,
      clips: [{ id: 'a', assetId: 's', trimStartSourceFrame: 0, trimEndSourceFrame: 120, audio: { muted: false, gain: 1 }, holdEndFrames: 0, zooms: [], motion: neutralMotion(), playbackRate: 1, dismissedActionIndices: [], view: { main: 'screen', bubble: true } },
        { id: 'b', assetId: 's', trimStartSourceFrame: 150, trimEndSourceFrame: 240, audio: { muted: false, gain: 1 }, holdEndFrames: 0, zooms: [], motion: neutralMotion(), playbackRate: 1, dismissedActionIndices: [], view: { main: 'screen', bubble: true } }],
      presentation: { ...structuredClone(defaultPresentation), padding }, cursor: { style: 'none', size: 18, clickFeedback: false }, transcripts: [], captions: { ...defaultCaptions },
      captionCorrections: {}, voiceoverDraft: { text: '', targetClipIds: [] },
      audioTracks: [{ id: 'mic', name: 'Mic', role: 'voiceover', gain: 0.8, muted: false, segments: [{ id: 'x', assetId: micAsset, startFrame: 10, trimStartSeconds: 0, trimEndSeconds: 3.2 }] }],
      presenterTrack: { id: 'p', assetId: 'c', audio: { muted: true, gain: 1 }, segments: [{ id: 'g', startFrame: 0, endFrame: 210, sourceStartFrame: 0,
        visual: { ...structuredClone(neutralMotionVisual), rect: { x: 0.72, y: 0.62, width: 0.22, height: 0.33 } }, tracks: [] }], sync: { screenAssetId: 's', offsetSeconds: 0.1 } },
    })
    const runner = join(build, 'runner')
    const runOne = async (name: string, padding: number, expect: RegExp, micAsset = 'm', upload = true) => {
      const job = app.queue('local-export', { project: project(padding, micAsset), title: name, renderVersion: engineRenderVersion() ?? 'unversioned', source: 'editor' })
      const out = join(dir, `${name}.mp4`)
      const t0 = Date.now()
      const child = spawn(process.execPath, [join(runner, 'runner.cjs'), '--app', app.url, '--job', job.id, '--out', out, '--work', join(dir, 'work'),
        '--ffmpeg', findBinary('ffmpeg')!, '--ffprobe', findBinary('ffprobe')!, '--bundle', join(build, 'render-bundle'), '--chrome', chrome, ...(upload ? [] : ['--no-upload'])],
        { cwd: runner, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR } })
      child.stdin.end(`${app.mintLocal(job)}\n`)
      let stdout = '', stderr = ''
      child.stdout.on('data', (d: Buffer) => { stdout += d })
      child.stderr.on('data', (d: Buffer) => { stderr += d })
      const code = await new Promise<number | null>((r) => child.on('close', r))
      const events = stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; line?: string; error?: string })
      const logs = events.filter((e) => e.type === 'log').map((e) => e.line!)
      const failed = events.find((e) => e.type === 'failed')
      assert.equal(code, 0, `${name}: exit ${code}: ${failed?.error ?? ''} ${stderr.slice(-800)}`)
      assert.ok(!/compositor/i.test(stdout + stderr) || /no Remotion compositor here/.test(stdout), `${name}: the compositor was asked for`)
      assert.equal(job.status, 'completed', `${name}: ${job.error}`)
      // Uploaded: under the attempt's own key. Not: the facts, kept on the computer, nothing stored.
      if (upload) assert.ok(app.blobs.has((job.result as { key: string }).key), `${name}: not stored`)
      else assert.equal((job.result as { kept?: string }).kept, 'computer', `${name}: ${JSON.stringify(job.result)}`)
      const encoder = events.find((e) => e.type === 'encoder') as { rung?: string } | undefined
      assert.ok(encoder?.rung, `${name}: no encoder probe`)
      assert.ok(existsSync(out))
      assert.ok(logs.some((l) => expect.test(l)), `${name}: ${logs.join(' | ')}`)
      const raw = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', out], { encoding: 'utf8' })
      assert.equal(Number(raw.trim()), 210, `${name}: frames (ffprobe said ${JSON.stringify(raw)}; ${JSON.stringify(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'compact', out], { encoding: 'utf8' }))})`)
      const colour = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_space,color_primaries,color_transfer,color_range:stream_side_data=side_data_type', '-of', 'compact=p=0', out], { encoding: 'utf8' }).trim()
      assert.equal(colour, 'color_range=tv|color_space=bt709|color_transfer=iec61966-2-1|color_primaries=bt709', `${name}: colour labels`)
      const audio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim()
      assert.equal(audio, 'aac,48000', `${name}: sound`)
      console.log(`[desktop-e2e] ${name}: ${((Date.now() - t0) / 1000).toFixed(1)} s; ${logs.filter((l) => /^Fast export:|^Encoding with|^Composed|^Rendered|^Decode/.test(l)).join(' | ')}`)
    }
    await runOne('fast', 0, /the sound mixed by FFmpeg/)
    await runOne('chrome', 24, /through our FFmpeg \(no Remotion compositor here\)/, 'm', false)
    await runOne('fast-delayed-sound', 0, /the sound mixed by Remotion \(a sound starts at 0\.\d+ s/, 'd')
    console.log('[desktop-e2e] all passed: both paths without the compositor')
  } finally {
    await app.stop()
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((err) => { console.error('[desktop-e2e] FAILED:', err); process.exit(1) })
