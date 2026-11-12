/**
 * A code scene in an export, end to end: the real worker (a child process) against the fake app (./fake-app.ts),
 * with real Remotion, Chrome and FFmpeg. A made-up 4 s blank-canvas video with one code layer from 0.5 s to 3.5 s:
 * a number that counts up and a bar that grows under it, compiled by the app's own compiler and stored as the app
 * stores it (`scenes/<id>.js`). The worker builds the frame runtime into its bundle, stages the scene's module, and
 * renders it in its locked frame. Then frames of the MP4 are read back: before the scene the canvas shows, during it
 * the scene's dark backdrop and its orange bar, and the bar is longer later than earlier.
 *
 *   STUDIO_CHROME=<a headless shell folder> node --import tsx test/scene-export-e2e.ts
 *
 * STUDIO_SCENE_OUT names the folder the frames and the MP4 are copied to (default a new temporary one).
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import type { EditorAsset } from '../../web/src/lib/studio/engine/contracts.ts'
import { defaultCaptions, defaultPresentation, parseEditorProject } from '../src/engine.ts'
import { FakeApp } from './fake-app.ts'

const ROOT = resolve(import.meta.dirname, '..')
const SECRET = 'scene-export-e2e-secret-not-real-0123'
const require = createRequire(import.meta.url)
const { createLayer } = require('../../web/src/lib/studio/engine/layers.ts') as typeof import('../../web/src/lib/studio/engine/layers.ts')
const { compileSceneSource } = require('../../web/src/lib/studio/server/scene-compile.ts') as typeof import('../../web/src/lib/studio/server/scene-compile.ts')

const COUNTER = `import { useTime, Counter, Reveal, spring, mix } from '@studio/kit';
import { AbsoluteFill } from 'remotion';
export default function StatCounter({ value = 1204, label = 'meetings remembered' }: { value?: number; label?: string }) {
  const { t, height } = useTime();
  const grow = spring(t, 0.3, { duration: 1.4, bounce: 0.12 });
  return <AbsoluteFill style={{ background: 'linear-gradient(180deg, #0e0f13, #08090c)' }}>
    <div style={{ position: 'absolute', left: 190, top: height / 2 - 300, color: '#f4f2ee', font: '800 260px sans-serif', letterSpacing: '-0.05em' }}><Counter value={value} at={0.2} duration={1.6} /></div>
    <Reveal at={0.5} style={{ position: 'absolute', left: 196, top: height / 2 + 10, color: '#a7a7b0', font: '500 52px sans-serif' }}>{label}</Reveal>
    <div style={{ position: 'absolute', left: 196, top: height / 2 + 120, width: mix(0, 1528, Math.min(grow, 1.04)), height: 40, borderRadius: 20, background: '#ff5a36' }} />
  </AbsoluteFill>;
}
`

/** One RGB pixel of a PNG frame, read with FFmpeg. */
function pixel(png: string, x: number, y: number): [number, number, number] {
  const raw = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', png, '-vf', `crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  return [raw[0]!, raw[1]!, raw[2]!]
}
const isOrange = ([r, g, b]: number[]) => r! > 200 && g! > 50 && g! < 140 && b! < 100
const isDark = ([r, g, b]: number[]) => r! < 40 && g! < 40 && b! < 40

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'studio-scene-export-e2e-'))
  const out = resolve(process.env.STUDIO_SCENE_OUT ?? join(dir, 'out'))
  await mkdir(out, { recursive: true })
  const workDir = resolve(process.env.STUDIO_E2E_WORK_DIR ?? join(tmpdir(), 'studio-worker-e2e-work'))
  const app = new FakeApp({ secret: SECRET, dir: join(dir, 'app'), partBytes: 256 * 1024 })
  await app.start()

  const W = 1280, H = 720, fps = 30, frames = 120
  const canvas = join(dir, 'canvas.mp4')
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0xeef0f4:s=${W}x${H}:r=${fps}:d=4`, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', canvas])
  const bytes = await readFile(canvas)
  const sha = createHash('sha256').update(bytes).digest('hex')
  const asset = { id: sha, name: 'Blank canvas.mp4', kind: 'video', file: `assets/${sha}.mp4`, sha256: sha, bytes: bytes.length, width: W, height: H, sourceFps: fps, sourceFrames: frames, durationSeconds: 4, hasAudio: false, sourceCursorHidden: false } as EditorAsset
  await app.putBlob(asset.file, canvas, 'video/mp4')

  // The scene, compiled and stored as the app stores it.
  const compiled = compileSceneSource(COUNTER, 'Stat counter')
  if ('error' in compiled) throw new Error(`the scene did not compile: ${compiled.error}`)
  const sceneId = createHash('sha256').update(COUNTER).digest('hex').slice(0, 16)
  const codeFile = join(dir, `${sceneId}.js`)
  await writeFile(codeFile, compiled.code)
  await app.putBlob(`scenes/${sceneId}.js`, codeFile, 'application/octet-stream')

  const layer = createLayer('code', 'scene-1', 15, 105, { name: 'Stat counter', style: { scene: { id: sceneId, name: 'Stat counter', props: { value: 1204, label: 'meetings remembered' } } } } as never, fps)
  const project = parseEditorProject({
    schemaVersion: 4, id: 'scene-export-e2e', title: 'Stat counter', output: { width: W, height: H, fps }, assets: [asset],
    clips: [{ id: 'clip-1', assetId: asset.id, trimStartSourceFrame: 0, trimEndSourceFrame: frames, audio: { muted: true, gain: 1 }, holdEndFrames: 0, zooms: [] }],
    presentation: structuredClone(defaultPresentation), cursor: { style: 'none', size: 24, clickFeedback: false }, audioTracks: [], presenterTrack: null, transcripts: [],
    captions: { ...defaultCaptions, enabled: false }, captionCorrections: {}, voiceoverDraft: { text: '', targetClipIds: [] }, layers: [layer],
  })

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production', STUDIO_CODE_SCENES: 'on', STUDIO_APP_URL: app.url, STUDIO_WORKER_SECRET: SECRET, STUDIO_WORKER_ID: 'scene-export-e2e', STUDIO_WORK_DIR: workDir, STUDIO_WORKER_POLL_MS: '300', STUDIO_HEALTH_PORT: '0', STUDIO_WORKER_KINDS: 'export,stills' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const forward = (chunk: Buffer) => { for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) console.log(`  [worker] ${line}`) }
  child.stdout.on('data', forward)
  child.stderr.on('data', forward)
  try {
    const started = Date.now()
    const job = await app.waitFor(app.queue('export', { project, title: 'Stat counter' }), 10 * 60_000)
    assert.equal(job.status, 'completed', job.error)
    console.log(`[scene-export-e2e] export: ${((Date.now() - started) / 1000).toFixed(1)} s; log:\n    ${job.logs.join('\n    ')}`)
    const mp4 = join(out, 'stat-counter.mp4')
    await app.blobFile((job.result as { key: string }).key, mp4)
    const shots: Record<string, string> = {}
    for (const t of [0.3, 1.0, 1.5, 3.2]) {
      const png = join(out, `export-${t}s.png`)
      execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-ss', String(t), '-i', mp4, '-frames:v', '1', png])
      shots[t] = png
    }
    // The bar runs along y = H/2 + 140/1.5 (the stage is 1920 wide, scaled to 1280): sample its row.
    const barY = Math.round((1080 / 2 + 140) * (W / 1920))
    const at = (t: number, x: number) => pixel(shots[t]!, x, barY)
    // 0.3 s: before the scene, the light canvas.
    assert.ok(at(0.3, 300).every((v) => v > 200), `the canvas shows before the scene: ${at(0.3, 300)}`)
    // 1.0 s (the scene's 0.5 s): its dark backdrop, the bar started.
    assert.ok(isDark(pixel(shots[1.0]!, 1200, 40)), `the scene's backdrop at 1.0 s: ${pixel(shots[1.0]!, 1200, 40)}`)
    // The bar's end moves right as it grows: find the last orange pixel on its row at each time.
    const reach = (t: number) => { let last = 0; for (let x = 140; x < W; x += 20) if (isOrange(at(t, x))) last = x; return last }
    const r1 = reach(1.0), r2 = reach(1.5), r3 = reach(3.2)
    console.log(`[scene-export-e2e] the bar reaches x=${r1} at 1.0 s, x=${r2} at 1.5 s, x=${r3} at 3.2 s`)
    assert.ok(r1 > 0 && r2 > r1 && r3 >= r2, 'the bar grows')
    for (const [t, png] of Object.entries(shots)) console.log(`[scene-export-e2e] frame at ${t} s: ${png}`)
    console.log(`[scene-export-e2e] the MP4: ${mp4}`)
    console.log('[scene-export-e2e] all checks passed')
  } finally {
    child.kill('SIGTERM')
    await app.stop()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
