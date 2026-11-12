/**
 * The measured checks end to end: the real worker (a child process) against the
 * fake app (./fake-app.ts), with real FFmpeg, Remotion, Chrome and the analysis
 * script. A made-up 6 s blank-canvas video: a headline that blurs in, and a
 * second, small and faint line that slides in two seconds later (so the visual
 * check has something to flag). Runs a motion check, a look and a review, then
 * prints each report and where its pictures were written, to look at.
 *
 *   STUDIO_ANALYSIS_PYTHON=<a python with numpy and OpenCV> \
 *   STUDIO_CHROME=<a headless shell folder> node --import tsx test/checks-e2e.ts
 *
 * STUDIO_CHECKS_OUT names the folder the pictures are copied to (default a new temporary one).
 */
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import type { EditorAsset } from '../../web/src/lib/studio/engine/contracts.ts'
import type { LookResult, MotionResult, ReviewResult } from '../../web/src/lib/studio/server/check-contract.ts'
import { defaultCaptions, defaultPresentation, parseEditorProject } from '../src/engine.ts'
import { FakeApp, type FakeJob } from './fake-app.ts'

const ROOT = resolve(import.meta.dirname, '..')
const SECRET = 'checks-e2e-secret-not-real-0123456789'
const require = createRequire(import.meta.url)
const { createLayer } = require('../../web/src/lib/studio/engine/layers.ts') as typeof import('../../web/src/lib/studio/engine/layers.ts')

async function main() {
  if (!process.env.STUDIO_ANALYSIS_PYTHON) console.warn('[checks-e2e] STUDIO_ANALYSIS_PYTHON is unset: python3 on PATH must have numpy and OpenCV')
  const dir = await mkdtemp(join(tmpdir(), 'studio-checks-e2e-'))
  const out = resolve(process.env.STUDIO_CHECKS_OUT ?? join(dir, 'pictures'))
  await mkdir(out, { recursive: true })
  const workDir = resolve(process.env.STUDIO_E2E_WORK_DIR ?? join(tmpdir(), 'studio-worker-e2e-work'))
  const app = new FakeApp({ secret: SECRET, dir: join(dir, 'app'), partBytes: 256 * 1024 })
  await app.start()

  // The canvas: a plain colour video, 6 s at 30 fps, as the app's blank canvas makes one.
  const W = 1280
  const H = 720
  const fps = 30
  const frames = 180
  const canvas = join(dir, 'canvas.mp4')
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0xeef0f4:s=${W}x${H}:r=${fps}:d=6`, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', canvas])
  const bytes = await readFile(canvas)
  const sha = createHash('sha256').update(bytes).digest('hex')
  const asset: EditorAsset = { id: sha, name: 'Blank canvas.mp4', kind: 'video', file: `assets/${sha}.mp4`, sha256: sha, bytes: bytes.length, width: W, height: H, sourceFps: fps, sourceFrames: frames, durationSeconds: 6, hasAudio: false, sourceCursorHidden: false } as EditorAsset
  await app.putBlob(asset.file, canvas, 'video/mp4')

  const headline = createLayer('text', 'headline', 9, frames, { name: 'Headline', y: 0.42, style: { text: 'Measured motion', font: 'display', size: 0.09, weight: 'black', color: '#15161a', align: 'center' }, enter: { preset: 'blur-in', frames: 18 } } as never, fps)
  const second = createLayer('text', 'second', 69, frames, { name: 'Second line', y: 0.6, height: 0.08, style: { text: 'arrives two seconds later', font: 'sans', size: 0.026, weight: 'medium', color: '#c9cdd6', align: 'center' }, enter: { preset: 'slide-left', frames: 15, ease: 'spring' } } as never, fps)
  const project = parseEditorProject({
    schemaVersion: 4,
    id: 'checks-e2e',
    title: 'Measured motion',
    output: { width: W, height: H, fps },
    assets: [asset],
    clips: [{ id: 'clip-1', assetId: asset.id, trimStartSourceFrame: 0, trimEndSourceFrame: frames, audio: { muted: true, gain: 1 }, holdEndFrames: 0, zooms: [] }],
    presentation: structuredClone(defaultPresentation),
    cursor: { style: 'none', size: 24, clickFeedback: false },
    audioTracks: [],
    presenterTrack: null,
    transcripts: [],
    captions: { ...defaultCaptions, enabled: false },
    captionCorrections: {},
    voiceoverDraft: { text: '', targetClipIds: [] },
    layers: [headline, second],
  })
  const context = {
    title: project.title,
    words: [],
    layers: [
      { name: 'Headline', kind: 'text', text: 'Measured motion', start: 0.3, end: 6 },
      { name: 'Second line', kind: 'text', text: 'arrives two seconds later', start: 2.3, end: 6 },
    ],
    clicks: [],
  }

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production', STUDIO_APP_URL: app.url, STUDIO_WORKER_SECRET: SECRET, STUDIO_WORKER_ID: 'checks-e2e', STUDIO_WORK_DIR: workDir, STUDIO_WORKER_POLL_MS: '300', STUDIO_HEALTH_PORT: '0', STUDIO_WORKER_KINDS: 'motion,review,look' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const forward = (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) console.log(`  [worker] ${line}`)
  }
  child.stdout.on('data', forward)
  child.stderr.on('data', forward)

  const fetchAll = async (job: FakeJob, files: string[]) => {
    for (const f of files) await app.blobFile(`checks/${job.id}/${f}`, join(out, `${job.kind}-${f}`))
  }
  try {
    const motion = await app.waitFor(app.queue('motion', { project, digest: 'digest-1' }), 10 * 60_000)
    assert.equal(motion.status, 'completed', motion.error)
    const m = motion.result as MotionResult
    await fetchAll(motion, m.files.filter((f) => f.endsWith('.png') || f.endsWith('.txt')))
    console.log('\n==== motion ====\n' + m.text + '\n\n' + (m.compare?.text ?? '(no comparison)'))
    assert.ok(m.files.includes('timeline.png'))
    assert.ok(m.moves >= 2, 'the blur-in and the slide are moves')

    const look = await app.waitFor(app.queue('look', { project, digest: 'digest-1' }), 10 * 60_000)
    assert.equal(look.status, 'completed', look.error)
    const l = look.result as LookResult
    await fetchAll(look, l.files)
    console.log('\n==== look ====\n' + JSON.stringify({ frames: l.times.length, issues: l.issues.map((i) => [i.kind, i.name, i.from, i.to, i.detail]), overlap: l.overlap }, null, 1))
    assert.ok(l.issues.some((i) => i.layerId === 'second' && i.kind === 'low-contrast'), 'the faint line has low contrast')
    assert.ok(l.issues.some((i) => i.layerId === 'second' && i.kind === 'small-text'), 'the faint line is small')
    assert.ok(!l.issues.some((i) => i.layerId === 'headline'), 'the headline reads')

    const review = await app.waitFor(app.queue('review', { project, digest: 'digest-1', context }), 10 * 60_000)
    assert.equal(review.status, 'completed', review.error)
    const r = review.result as ReviewResult
    await fetchAll(review, r.files.filter((f) => f.endsWith('.png') || f.endsWith('.txt')))
    console.log('\n==== review ====\n' + r.text + `\n(on-screen text: ${r.onScreenText})`)
    for (const f of await (await import('node:fs/promises')).readdir(out)) console.log(`[checks-e2e] ${join(out, f)} ${(await stat(join(out, f))).size} bytes`)
  } finally {
    child.kill('SIGTERM')
    await app.stop()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
