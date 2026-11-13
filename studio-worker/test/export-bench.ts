/**
 * Export speed, measured: a made-up video shaped like the first slow export in production (a 20.2 s 2504×1438 60 fps
 * screen recording, a 1080p 30 fps camera as the bubble, a microphone track), made here with FFmpeg, imported and
 * exported by the real worker against the fake app, once with each path:
 *
 *   node --import tsx test/export-bench.ts [plain|cuts] [chrome|fast|both]     (defaults: plain both)
 *
 * `cuts` keeps three stretches of the take, cut at odd frames, the middle one at 2x. Prints, per export, the path that
 * ran (the job's own log line), the job's wall time, its render or compose time, and the CPU seconds of the worker's
 * process tree (Chrome, FFmpeg) per frame, sampled from `ps` once a second. STUDIO_CHROME, STUDIO_RENDER_CONCURRENCY
 * and the rest pass through to the worker. Heavy: one at a time.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { FakeApp } from './fake-app.ts'
import { parseEditorProject, defaultCaptions, defaultPresentation } from '../src/engine.ts'
import type { EditorAsset, EditorProject } from '../../web/src/lib/studio/engine/contracts.ts'

const require = createRequire(import.meta.url)
const { neutralMotion, neutralMotionVisual } = require('../../web/src/lib/studio/engine/motion-contracts.ts') as typeof import('../../web/src/lib/studio/engine/motion-contracts.ts')
const { scheduleProject } = require('../../web/src/lib/studio/engine/timeline.ts') as typeof import('../../web/src/lib/studio/engine/timeline.ts')

const ROOT = resolve(import.meta.dirname, '..')
const SECRET = 'bench-secret-not-real-0123456789abcdef'
const SECONDS = 20.2
const variant = process.argv[2] === 'cuts' ? 'cuts' : 'plain'
const paths = process.argv[3] === 'chrome' ? [false] : process.argv[3] === 'fast' ? [true] : [false, true]
const ff = (args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] })
const TAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']
const TO709 = 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p'

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'studio-export-bench-'))
  const workDir = resolve(process.env.STUDIO_E2E_WORK_DIR ?? join(tmpdir(), 'studio-worker-e2e-work'))
  await mkdir(join(dir, 'media'), { recursive: true })
  const screen = join(dir, 'media/screen.mp4'), camera = join(dir, 'media/camera.mp4'), mic = join(dir, 'media/mic.m4a')
  ff(['-f', 'lavfi', '-i', `color=c=0xf2f3f6:s=2504x1438:r=60:d=${SECONDS}`, '-f', 'lavfi', '-i', `testsrc2=s=1200x700:r=60:d=${SECONDS}`, '-filter_complex',
    `[0:v]format=rgb24,drawbox=x=0:y=0:w=360:h=1438:color=0x23232b:t=fill,drawbox=x=440:y=160:w=900:h=60:color=0x5b3fd0:t=fill[bg];[1:v]format=rgb24[p];[bg][p]overlay=x=1000:y=520:format=rgb,`
      + `drawtext=text='%{n}':x=60:y=1300:fontsize=90:fontcolor=white:box=1:boxcolor=black,${TO709}[v]`, '-map', '[v]', ...TAGS, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-g', '60', screen])
  ff(['-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=30:d=${SECONDS}`, '-vf', `format=rgb24,noise=alls=10:allf=t,${TO709}`, ...TAGS, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-g', '30', camera])
  ff(['-f', 'lavfi', '-i', `aevalsrc='0.5*sin(2*PI*(180+40*sin(1.3*t)+25*t)*t)':s=48000:d=${SECONDS}`, '-c:a', 'aac', '-b:a', '160k', mic])

  const app = new FakeApp({ secret: SECRET, dir: join(dir, 'app'), partBytes: 32 * 1024 * 1024 })
  await app.start()
  for (const [k, f] of [['screen', screen], ['camera', camera], ['mic', mic]] as const) await app.putBlob(`uploads/${k}`, f, 'application/octet-stream')
  const start = (fast: boolean) => spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, NODE_ENV: 'production', STUDIO_APP_URL: app.url, STUDIO_WORKER_SECRET: SECRET, STUDIO_WORKER_ID: 'bench', STUDIO_WORK_DIR: workDir,
    STUDIO_WORKER_POLL_MS: '200', STUDIO_HEALTH_PORT: '0', STUDIO_FAST_EXPORT: fast ? 'on' : 'off' } })
  const job = async (kind: 'import' | 'export', input: unknown) => {
    const j = app.queue(kind, input)
    await app.waitFor(j, 3 * 3600_000)
    if (j.status !== 'completed') throw new Error(`${kind}: ${j.status} ${j.error}`)
    return j
  }
  try {
    let w = start(false); w.stdout.resume(); w.stderr.resume()
    const A = {
      screen: ((await job('import', { uploadKey: 'uploads/screen', name: 'Screen.mp4', conform: { fps: 60 } })).result as { asset: EditorAsset }).asset,
      camera: ((await job('import', { uploadKey: 'uploads/camera', name: 'Camera.mp4', conform: { fps: 30 } })).result as { asset: EditorAsset }).asset,
      mic: ((await job('import', { uploadKey: 'uploads/mic', name: 'Microphone.m4a' })).result as { asset: EditorAsset }).asset,
    }
    w.kill('SIGTERM'); await new Promise((r) => w.once('exit', r))
    const project = buildProject(A)
    for (const fast of paths) {
      w = start(fast); w.stdout.resume(); w.stderr.resume()
      const cpu = sampleCpu(w.pid!)
      const t0 = Date.now()
      const j = await job('export', { project, title: 'Bench' })
      const wall = (Date.now() - t0) / 1000
      await new Promise((r) => setTimeout(r, 1100))
      const cpuSec = cpu.stop()
      const frames = scheduleProject(project).reduce((n, s) => Math.max(n, s.startFrame + s.durationFrames), 0)
      const path = j.logs.find((l) => /^Composing .* with FFmpeg|^Rendering in Chrome|^The fast export did not hold/.test(l))
      const took = j.logs.find((l) => /^Composed in|^Rendered in/.test(l))
      console.log(`[bench] ${JSON.stringify({ variant, setting: fast ? 'STUDIO_FAST_EXPORT=on' : 'STUDIO_FAST_EXPORT=off', path, took, frames, jobSeconds: +wall.toFixed(1),
        framesPerSecond: +(frames / wall).toFixed(2), cpuSeconds: +cpuSec.toFixed(1), cpuPerFrame: +(cpuSec / frames).toFixed(3), stages: j.logs.filter((l) => /^Fast export|^Composed in|^Rendered in|^Decode check in|^Stored in|^Assets ready|^Bundled in/.test(l)) })}`)
      w.kill('SIGTERM'); await new Promise((r) => w.once('exit', r))
    }
  } finally {
    await app.stop()
    await rm(dir, { recursive: true, force: true })
  }
}

function buildProject(A: { screen: EditorAsset; camera: EditorAsset; mic: EditorAsset }): EditorProject {
  const fps = 60, W = A.screen.width!, H = A.screen.height!
  const clip = { id: 'clip', assetId: A.screen.id, trimStartSourceFrame: 0, trimEndSourceFrame: A.screen.sourceFrames!, audio: { muted: true, gain: 1 }, holdEndFrames: 0,
    zooms: [], motion: neutralMotion(), playbackRate: 1, dismissedActionIndices: [], view: { main: 'screen', bubble: true } }
  let screen = A.screen
  let clips = [clip]
  if (variant === 'cuts') {
    screen = { ...screen, trace: { viewport: { width: W, height: H, scale: 1 }, cursor: [], actions: [{ t: 480 / 60 * 1000, end: 735 / 60 * 1000, kind: 'type', label: 'Typing', box: null }] } }
    clips = [{ ...clip, id: 'a', trimStartSourceFrame: 7, trimEndSourceFrame: 363 }, { ...clip, id: 'b', trimStartSourceFrame: 487, trimEndSourceFrame: 729, playbackRate: 2 },
      { ...clip, id: 'c', trimStartSourceFrame: 845, trimEndSourceFrame: 1201 }]
  }
  const side = Math.min(W * 0.22, H * 0.28), w = side / W, h = side / H
  let project = { schemaVersion: 4, id: 'bench', title: 'Bench', output: { width: W, height: H, fps }, assets: [screen, A.camera, A.mic], clips,
    presentation: structuredClone(defaultPresentation), cursor: { style: 'none', size: 18, clickFeedback: false }, audioTracks: [], transcripts: [], captions: { ...defaultCaptions },
    captionCorrections: {}, voiceoverDraft: { text: '', targetClipIds: [] },
    presenterTrack: { id: 'presenter', assetId: A.camera.id, audio: { muted: true, gain: 1 }, segments: [{ id: 'seg', startFrame: 15, endFrame: 1212, sourceStartFrame: 0,
      visual: { ...structuredClone(neutralMotionVisual), rect: { x: 1 - w - 0.04, y: 1 - h - 0.04, width: w, height: h } }, tracks: [] }], sync: { screenAssetId: screen.id, offsetSeconds: 0.25 } },
  } as unknown as EditorProject
  const segments = scheduleProject(project).filter((s) => s.clip.playbackRate === 1).map((s, i) => {
    const from = s.clip.trimStartSourceFrame / fps - 0.1, to = s.clip.trimEndSourceFrame / fps - 0.1, st = Math.max(0, from), en = Math.min(A.mic.durationSeconds!, to)
    return { id: `m${i}`, assetId: A.mic.id, startFrame: s.startFrame + Math.round((st - from) * fps), trimStartSeconds: st, trimEndSeconds: en, label: `sync:${screen.id}@0.1` }
  })
  project = { ...project, audioTracks: [{ id: 'mic', name: 'Microphone', role: 'voiceover', gain: 1, muted: false, segments }] } as EditorProject
  return parseEditorProject(project)
}

/** CPU seconds of a process and everything under it, from `ps` once a second (a finished child's last reading kept). */
function sampleCpu(root: number) {
  const seen = new Map<number, number>()
  const parse = (t: string) => { const [a, b] = t.split('.'); let s = 0; for (const p of a!.split(/[:-]/).map(Number)) s = s * 60 + p; return s + Number(`0.${b ?? 0}`) }
  const tick = () => {
    try {
      const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time='], { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().split(/\s+/))
      const kids = new Map<number, number[]>()
      for (const [pid, ppid] of rows) kids.set(Number(ppid), [...(kids.get(Number(ppid)) ?? []), Number(pid)])
      const tree = new Set([root]), stack = [root]
      while (stack.length) for (const k of kids.get(stack.pop()!) ?? []) if (!tree.has(k)) { tree.add(k); stack.push(k) }
      for (const [pid, , time] of rows) if (tree.has(Number(pid))) seen.set(Number(pid), Math.max(seen.get(Number(pid)) ?? 0, parse(time!)))
    } catch { /* a process gone between ps and here */ }
  }
  tick()
  const base = [...seen.values()].reduce((a, b) => a + b, 0)
  const timer = setInterval(tick, 1000)
  return { stop: () => { clearInterval(timer); tick(); return [...seen.values()].reduce((a, b) => a + b, 0) - base } }
}

main().catch((err) => {
  console.error('[bench] FAILED:', err)
  process.exit(1)
})
