/**
 * A review of a library video by itself (a reference), end to end: the real worker (a child process) against the
 * fake app (./fake-app.ts), with real FFmpeg and the analysis script, and no render. A made-up 12 s reference of
 * three visibly different scenes: a still dark frame, a moving test pattern, and a light card with a headline. The
 * review's scene list must hold three scenes cut at 4 s and 8 s; the app's blueprint is then built from it with the
 * engine's pure function (as blueprint.ts does) and printed, with the storyboard lines it makes at 24 s.
 *
 *   STUDIO_ANALYSIS_PYTHON=<a python with numpy and OpenCV> node --import tsx test/blueprint-e2e.ts
 */
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import type { EditorAsset } from '../../web/src/lib/studio/engine/contracts.ts'
import type { ReviewResult } from '../../web/src/lib/studio/server/check-contract.ts'
import { FakeApp } from './fake-app.ts'

const ROOT = resolve(import.meta.dirname, '..')
const SECRET = 'blueprint-e2e-secret-not-real-0123456789'
const require = createRequire(import.meta.url)
const lines = require('../../web/src/lib/studio/server/blueprint-lines.ts') as typeof import('../../web/src/lib/studio/server/blueprint-lines.ts')

/** A font FFmpeg's drawtext can use for the headline, or null (then the third scene is a plain light card). */
const FONT = ['/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'].find((f) => existsSync(f)) ?? null

/** The made-up reference: 4 s each of a dark still, a moving pattern and a light card, 30 fps, no sound. */
function makeReference(file: string, W: number, H: number) {
  const card = FONT ? `,drawtext=fontfile=${FONT}:text=Plan less:fontsize=96:fontcolor=0x14213d:x=(w-text_w)/2:y=(h-text_h)/2` : ''
  execFileSync('ffmpeg', [
    '-nostdin', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0x14213d:s=${W}x${H}:r=30:d=4`,
    '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=30:d=4`,
    '-f', 'lavfi', '-i', `color=c=0xf1faee:s=${W}x${H}:r=30:d=4`,
    '-filter_complex', `[2:v]format=yuv420p${card}[c];[0:v][1:v][c]concat=n=3:v=1:a=0,format=yuv420p[v]`,
    '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', file,
  ])
}

async function main() {
  if (!process.env.STUDIO_ANALYSIS_PYTHON) console.warn('[blueprint-e2e] STUDIO_ANALYSIS_PYTHON is unset: python3 on PATH must have numpy and OpenCV')
  const dir = await mkdtemp(join(tmpdir(), 'studio-blueprint-e2e-'))
  const workDir = await mkdtemp(join(tmpdir(), 'studio-blueprint-e2e-work-'))
  const app = new FakeApp({ secret: SECRET, dir: join(dir, 'app'), partBytes: 256 * 1024 })
  await app.start()

  const W = 1280
  const H = 720
  const file = join(dir, 'reference.mp4')
  makeReference(file, W, H)
  const bytes = await readFile(file)
  const sha = createHash('sha256').update(bytes).digest('hex')
  const asset: EditorAsset = { id: sha, name: 'Made-up reference.mp4', kind: 'video', file: `assets/${sha}.mp4`, sha256: sha, bytes: bytes.length, width: W, height: H, sourceFps: 30, sourceFrames: 360, durationSeconds: 12, hasAudio: false, sourceCursorHidden: false } as EditorAsset
  await app.putBlob(asset.file, file, 'video/mp4')

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production', STUDIO_APP_URL: app.url, STUDIO_WORKER_SECRET: SECRET, STUDIO_WORKER_ID: 'blueprint-e2e', STUDIO_WORK_DIR: workDir, STUDIO_WORKER_POLL_MS: '300', STUDIO_HEALTH_PORT: '0', STUDIO_WORKER_KINDS: 'review' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const forward = (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) console.log(`  [worker] ${line}`)
  }
  child.stdout.on('data', forward)
  child.stderr.on('data', forward)
  // A worker that stops early fails the run at once rather than after the wait.
  const exited = new Promise<never>((_, reject) => child.on('exit', (code) => reject(new Error(`The worker stopped (exit ${code})`))))
  exited.catch(() => undefined)

  try {
    const job = await Promise.race([app.waitFor(app.queue('review', { reference: { asset } }), 10 * 60_000), exited])
    assert.equal(job.status, 'completed', job.error)
    const r = job.result as ReviewResult
    console.log('\n==== scene list ====\n' + JSON.stringify(r.sceneList, null, 1))
    assert.deepEqual(r.reference, { assetId: sha, sha256: sha })
    assert.equal(r.sceneList?.length, 3, 'three scenes')
    const [a, b, c] = r.sceneList!
    const near = (t: number, want: number) => Math.abs(t - want) <= 0.25
    assert.ok(near(a!.start, 0) && near(a!.end, 4), `scene 1 runs 0 to 4 s (${a!.start} to ${a!.end})`)
    assert.ok(near(b!.start, 4) && near(b!.end, 8), `scene 2 runs 4 to 8 s (${b!.start} to ${b!.end})`)
    assert.ok(near(c!.start, 8) && near(c!.end, 12), `scene 3 runs 8 to 12 s (${c!.start} to ${c!.end})`)
    assert.ok(r.files.includes('scenes.png') && r.files.includes('review.json'), 'its pictures and report are stored')

    const blueprint = lines.buildBlueprint(sha, r, [])
    assert.ok(blueprint, 'a blueprint from the scene list')
    const planned = lines.blueprintLines(blueprint, lines.blueprintScenes(r.sceneList), { seconds: 24, lines: ['Your week, planned.'] })
    console.log('\n==== blueprint ====\n' + JSON.stringify({ seconds: blueprint.seconds, pace: blueprint.pace, style: blueprint.style, beats: blueprint.beats.map((x) => [x.kind, x.start, x.end, x.scene]) }, null, 1))
    console.log('\n==== storyboard lines at 24 s ====\n' + JSON.stringify(planned, null, 1))
    assert.equal(blueprint.beats.length, 3)
    assert.deepEqual(planned.map((l) => l.seconds), [8, 8, 8])
    console.log(`\n[blueprint-e2e] ok: ${r.sceneList!.map((s) => `${s.start}-${s.end} ${s.shot}${s.onScreen ? ` "${s.onScreen.join(' / ')}"` : ''}`).join(', ')}`)
  } finally {
    child.kill('SIGTERM')
    await app.stop()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
