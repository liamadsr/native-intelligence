/**
 * The local runner (local.ts) end to end, against the fake app's local-export routes: a made-up recording with its
 * camera imported by the real worker, then exported by the runner in this process as the desktop app would run it
 * (its own work folder, this machine's encoder, the token in hand): the video lands at the destination whole, is
 * uploaded under the attempt's own key, and the job completes; a second job is cancelled from the app while it runs
 * and ends cancelled, with nothing at its destination.
 *
 *   STUDIO_CHROME=<a headless shell folder> node --import tsx test/local-e2e.ts      (renders: one heavy run at a time)
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { FakeApp } from './fake-app.ts'
import { parseEditorProject, defaultCaptions, defaultPresentation } from '../src/engine.ts'
import { runLocal, type LocalEvent } from '../src/local.ts'
import { engineRenderVersion } from '../src/render.ts'
import type { EditorAsset } from '../../web/src/lib/studio/engine/contracts.ts'

const require = createRequire(import.meta.url)
const { neutralMotion, neutralMotionVisual } = require('../../web/src/lib/studio/engine/motion-contracts.ts') as typeof import('../../web/src/lib/studio/engine/motion-contracts.ts')
const ROOT = resolve(import.meta.dirname, '..')
const SECRET = 'local-e2e-secret-not-real-0123456789abcdef'
const ff = (args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] })

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'studio-local-e2e-'))
  await mkdir(join(dir, 'media'), { recursive: true })
  const screen = join(dir, 'media/screen.mp4'), camera = join(dir, 'media/camera.mp4'), mic = join(dir, 'media/mic.m4a')
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=60:d=4', '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', '60', screen])
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=5', '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', '30', camera])
  ff(['-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*(200+30*t)*t)':s=48000:d=4", '-c:a', 'aac', '-b:a', '128k', mic])
  const app = new FakeApp({ secret: SECRET, dir: join(dir, 'app'), partBytes: 4 * 1024 * 1024 })
  await app.start()
  try {
    for (const [k, f] of [['screen', screen], ['camera', camera], ['mic', mic]] as const) await app.putBlob(`uploads/${k}`, f)
    const w = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, NODE_ENV: 'production',
      STUDIO_APP_URL: app.url, STUDIO_WORKER_SECRET: SECRET, STUDIO_WORKER_ID: 'local-e2e', STUDIO_WORK_DIR: join(dir, 'server-work'), STUDIO_WORKER_POLL_MS: '200', STUDIO_HEALTH_PORT: '0' } })
    const imported = async (key: string, name: string, conform?: 30 | 60) => {
      const j = app.queue('import', { uploadKey: `uploads/${key}`, name, ...(conform ? { conform: { fps: conform } } : {}) })
      await app.waitFor(j, 10 * 60_000)
      assert.equal(j.status, 'completed', `import ${key}: ${j.error}`)
      return (j.result as { asset: EditorAsset }).asset
    }
    const A = { screen: await imported('screen', 'Screen.mp4', 60), camera: await imported('camera', 'Camera.mp4', 30), mic: await imported('mic', 'Mic.m4a') }
    w.kill('SIGTERM')
    const project = parseEditorProject({ schemaVersion: 4, id: 'local', title: 'Local', output: { width: 1280, height: 720, fps: 60 }, assets: [A.screen, A.camera, A.mic],
      clips: [{ id: 'c', assetId: A.screen.id, trimStartSourceFrame: 0, trimEndSourceFrame: A.screen.sourceFrames, audio: { muted: true, gain: 1 }, holdEndFrames: 0, zooms: [],
        motion: neutralMotion(), playbackRate: 1, dismissedActionIndices: [], view: { main: 'screen', bubble: true } }],
      presentation: structuredClone(defaultPresentation), cursor: { style: 'none', size: 18, clickFeedback: false }, transcripts: [], captions: { ...defaultCaptions },
      captionCorrections: {}, voiceoverDraft: { text: '', targetClipIds: [] },
      audioTracks: [{ id: 'mic', name: 'Mic', role: 'voiceover', gain: 1, muted: false, segments: [{ id: 's', assetId: A.mic.id, startFrame: 0, trimStartSeconds: 0, trimEndSeconds: 3.9 }] }],
      presenterTrack: { id: 'p', assetId: A.camera.id, audio: { muted: true, gain: 1 }, segments: [{ id: 'g', startFrame: 0, endFrame: 240, sourceStartFrame: 0,
        visual: { ...structuredClone(neutralMotionVisual), rect: { x: 0.72, y: 0.62, width: 0.22, height: 0.33 } }, tracks: [] }], sync: { screenAssetId: A.screen.id, offsetSeconds: 0.1 } },
    })
    const input = { project, title: 'Local', renderVersion: engineRenderVersion() ?? 'unversioned', source: 'editor' }
    const workDir = join(dir, 'runner-work'), events: LocalEvent[] = []

    // ---- a whole export ---------------------------------------------------------------------------------------------
    const job = app.queue('local-export', input)
    const dest = join(dir, 'Local export.mp4')
    const t0 = Date.now()
    await runLocal({ appUrl: app.url, token: app.mintLocal(job), jobId: job.id, destination: dest, workDir, chrome: process.env.STUDIO_CHROME, emit: (e) => events.push(e) })
    const seconds = (Date.now() - t0) / 1000
    assert.equal(job.status, 'completed', job.error)
    assert.ok(existsSync(dest))
    const key = `exports/${job.id}/1/video.mp4`
    assert.equal((job.result as { key: string }).key, key)
    assert.ok(app.blobs.has(key))
    const logs = events.filter((e) => e.type === 'log').map((e) => (e as { line: string }).line)
    assert.ok(logs.some((l) => /with FFmpeg \(the fast export/.test(l)), logs.join(' | '))
    assert.ok(logs.some((l) => /^Composed in/.test(l)), logs.join(' | '))
    const frames = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', dest], { encoding: 'utf8' }).trim())
    assert.equal(frames, 240)
    console.log(`[local-e2e] export: ${seconds.toFixed(1)} s, ${logs.filter((l) => /^Fast export|^Composed|^Decode|^Stored/.test(l)).join(' | ')}`)

    // ---- a cancel from the app ---------------------------------------------------------------------------------------
    const job2 = app.queue('local-export', input)
    const dest2 = join(dir, 'Cancelled.mp4')
    const cancelling = setInterval(() => { if (job2.progress.length > 0) job2.cancelRequested = true }, 100)
    await assert.rejects(runLocal({ appUrl: app.url, token: app.mintLocal(job2), jobId: job2.id, destination: dest2, workDir, chrome: process.env.STUDIO_CHROME, emit: () => {} }))
    clearInterval(cancelling)
    assert.equal(job2.status, 'cancelled')
    assert.ok(!existsSync(dest2))
    console.log('[local-e2e] all passed')
  } finally {
    await app.stop()
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((err) => { console.error('[local-e2e] FAILED:', err); process.exit(1) })
