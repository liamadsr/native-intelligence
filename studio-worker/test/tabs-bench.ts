/**
 * How many Chrome tabs the Chrome path should draw with on this computer: a made-up desktop take at a large size (a
 * 3472×2266 60 fps screen recording with its pointer drawn, glass with click feedback as a recording comes, and a
 * camera bubble) drawn through renderThroughPipe (chrome-pipe.ts) with each tab count, encoded by the machine's own
 * encoder through STUDIO_FFMPEG. Prints, per tab count, frames a second, the peak memory and the CPU of this process
 * tree (Chrome, FFmpeg), sampled from `ps` every half second; and, apart, how fast FFmpeg alone takes the same JPEGs
 * (decode, convert, encode), the most any tab count could reach.
 *
 *   STUDIO_FFMPEG=… STUDIO_FFPROBE=… node --import tsx test/tabs-bench.ts [tabs,…] [seconds] [arrow|glass|none] [default|swangle|angle]
 *   (defaults: 3,6,9,12 · 6 · glass · this machine's GL; heavy: run it alone)
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { parseEditorProject, defaultCaptions, defaultPresentation } from '../src/engine.ts'
import { loadConfig } from '../src/config.ts'
import { Renderer, inputPropsFor, COMPOSITION_ID } from '../src/render.ts'
import { renderThroughPipe, pipeArgs } from '../src/chrome-pipe.ts'
import { encoderArgs, defaultProfile } from '../src/encoders.ts'
import type { EditorProject } from '../../web/src/lib/studio/engine/contracts.ts'
import { madeUpTrace } from './pointer-fixtures.ts'

const require = createRequire(import.meta.url)
const { neutralMotion, neutralMotionVisual } = require('../../web/src/lib/studio/engine/motion-contracts.ts') as typeof import('../../web/src/lib/studio/engine/motion-contracts.ts')
const FFMPEG = process.env.STUDIO_FFMPEG ?? 'ffmpeg'
const ff = (args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] })
const W = 3472, H = 2266, FPS = 60

async function cached(cache: string, file: string, ext: string) {
  const buf = await readFile(file)
  const sha256 = createHash('sha256').update(buf).digest('hex')
  await rename(file, join(cache, `${sha256}.${ext}`))
  return { file: `assets/${sha256}.${ext}`, sha256, bytes: buf.length }
}

/** The CPU seconds (per process) and the resident memory (bytes) of a process and everything under it, now. */
function tree(root: number): { cpu: Map<number, number>; rss: number } {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,time=,command='], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim().split('\n').map((l) => l.trim().split(/\s+/))
  const kids = new Map<number, number[]>()
  for (const [pid, ppid] of rows) kids.set(Number(ppid), [...(kids.get(Number(ppid)) ?? []), Number(pid)])
  // This process's tree, and every headless Chrome process (Chrome's helpers are not always under the one that started it).
  const all = new Set<number>(), stack = [root, ...rows.filter((r) => r.slice(4).join(' ').includes('chrome-headless-shell')).map((r) => Number(r[0]))]
  while (stack.length) { const p = stack.pop()!; if (all.has(p)) continue; all.add(p); stack.push(...(kids.get(p) ?? [])) }
  const cpu = new Map<number, number>()
  let rss = 0
  for (const [pid, , kb, time] of rows) {
    if (!all.has(Number(pid))) continue
    rss += Number(kb) * 1024
    const parts = time!.split(/[:-]/).map(Number)
    cpu.set(Number(pid), parts.length === 3 ? parts[0]! * 3600 + parts[1]! * 60 + parts[2]! : parts[0]! * 60 + parts[1]!)
  }
  return { cpu, rss }
}

async function main() {
  const tabsList = (process.argv[2] ?? '3,6,9,12').split(',').map(Number)
  const S = Number(process.argv[3] ?? 6), style = (process.argv[4] ?? 'glass') as 'glass' | 'arrow' | 'none'
  const dir = await mkdtemp(join(tmpdir(), 'studio-tabs-bench-'))
  const cache = join(dir, 'cache', 'assets'), media = join(dir, 'media')
  await mkdir(cache, { recursive: true }); await mkdir(media)
  // A made-up app window: static parts, a moving test card, the frame number (as test/fast-export-e2e.ts's screens).
  ff(['-f', 'lavfi', '-i', `color=c=0xf2f3f6:s=${W}x${H}:r=${FPS}:d=${S}`, '-f', 'lavfi', '-i', `testsrc2=s=${W / 2}x${H / 2}:r=${FPS}:d=${S}`,
    '-f', 'lavfi', '-i', `aevalsrc='0.2*sin(2*PI*(500+60*t)*t)':s=48000:d=${S}`, '-filter_complex',
    `[0:v]drawbox=x=0:y=0:w=${Math.round(W * 0.14)}:h=${H}:color=0x23232b:t=fill[bg];[bg][1:v]overlay=x=${Math.round(W * 0.4)}:y=${Math.round(H * 0.36)},format=yuv420p[v]`,
    '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', String(FPS), '-c:a', 'aac', '-b:a', '160k', join(media, 's.mp4')])
  ff(['-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=30:d=${S + 1}`, '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', '30', join(media, 'c.mp4')])
  const s = await cached(cache, join(media, 's.mp4'), 'mp4'), c = await cached(cache, join(media, 'c.mp4'), 'mp4')
  const frames = S * FPS
  const project = parseEditorProject({ schemaVersion: 4, id: 'tabs', title: 'Tabs', output: { width: W, height: H, fps: FPS },
    assets: [
      { id: 's', kind: 'video', name: 'Screen.mp4', ...s, width: W, height: H, sourceFps: FPS, sourceFrames: frames, durationSeconds: S, hasAudio: true, sourceCursorHidden: style !== 'none', trace: madeUpTrace(S, { width: W / 2, height: H / 2, scale: 2 }) },
      { id: 'c', kind: 'video', name: 'Camera.mp4', ...c, width: 1920, height: 1080, sourceFps: 30, sourceFrames: (S + 1) * 30, durationSeconds: S + 1, hasAudio: false, sourceCursorHidden: false },
    ],
    clips: [{ id: 'a', assetId: 's', trimStartSourceFrame: 0, trimEndSourceFrame: frames, audio: { muted: false, gain: 1 }, holdEndFrames: 0, zooms: [], motion: neutralMotion(),
      playbackRate: 1, dismissedActionIndices: [], view: { main: 'screen', bubble: true } }],
    presentation: structuredClone(defaultPresentation), cursor: style === 'none' ? { style: 'none', size: 18, clickFeedback: false } : { style, size: 18, clickFeedback: true },
    transcripts: [], captions: { ...defaultCaptions }, captionCorrections: {}, voiceoverDraft: { text: '', targetClipIds: [] }, audioTracks: [],
    presenterTrack: { id: 'p', assetId: 'c', audio: { muted: true, gain: 1 }, segments: [{ id: 'g', startFrame: 0, endFrame: frames, sourceStartFrame: 0,
      visual: { ...structuredClone(neutralMotionVisual), rect: { x: 0.74, y: 0.62, width: 0.2, height: 0.3 } }, tracks: [] }], sync: { screenAssetId: 's', offsetSeconds: 0 } },
  }) as EditorProject

  const loaded = loadConfig({ ...process.env, STUDIO_WORK_DIR: join(dir, 'work'), NODE_ENV: 'test', STUDIO_COMPOSITOR: 'off' }, () => 4)
  if ('problems' in loaded) throw new Error(loaded.problems.join('; '))
  const renderer = new Renderer(loaded, cache)
  const { serveUrl } = await renderer.bundle(() => {})
  const { selectComposition, renderFrames } = await import('@remotion/renderer')
  const inputProps = inputPropsFor(project)
  const base = await renderer.common(() => {}, project)
  // A GL backend to try instead of this machine's default (null: Chrome's own, the GPU on a Mac): swangle draws on the CPU.
  const gl = process.argv[5] ? (process.argv[5] === 'default' ? base.chromiumOptions.gl : process.argv[5]) : base.chromiumOptions.gl
  const common = { ...base, chromiumOptions: { ...base.chromiumOptions, gl: gl as typeof base.chromiumOptions.gl } }
  const comp = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps, ...common })
  const profile = defaultProfile(process.platform)
  const encoder = encoderArgs(profile, W, H, FPS)
  console.log(`[tabs-bench] ${JSON.stringify({ size: `${W}x${H}`, fps: FPS, frames, pointer: style, gl: common.chromiumOptions.gl, encoder: profile, ffmpeg: FFMPEG, cores: (await import('node:os')).availableParallelism() })}`)

  // FFmpeg alone on Chrome's own JPEGs of this video (the first 2 s, looped to the whole length): its ceiling.
  const jpegs = join(dir, 'jpegs')
  await renderFrames({ serveUrl, composition: comp, inputProps, ...common, frameRange: [0, Math.min(frames, 2 * FPS) - 1], imageFormat: 'jpeg', jpegQuality: 80, outputDir: jpegs,
    concurrency: 6, onStart: () => {}, onFrameUpdate: () => {} } as never)
  const list = (await readdir(jpegs)).filter((f) => f.endsWith('.jpeg') || f.endsWith('.jpg')).sort()
  const cat = join(dir, 'all.mjpeg')
  execFileSync('sh', ['-c', `cd '${jpegs}' && for i in $(seq ${Math.ceil(frames / list.length)}); do cat ${list.join(' ')}; done > '${cat}'`])
  const args = pipeArgs(FPS, encoder, join(dir, 'alone.mp4')).map((a) => (a === 'pipe:0' ? cat : a))
  const t0 = Date.now()
  const r = spawnSync(FFMPEG, [...args.slice(0, args.indexOf('-i') + 2), '-frames:v', String(frames), ...args.slice(args.indexOf('-i') + 2)], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`ffmpeg alone: ${r.stderr}`)
  console.log(`[tabs-bench] ${JSON.stringify({ ffmpegAlone: { frames, seconds: (Date.now() - t0) / 1000, framesPerSecond: +(frames / ((Date.now() - t0) / 1000)).toFixed(1) } })}`)

  for (const tabs of tabsList) {
    const scratch = join(dir, `scratch-${tabs}`)
    await mkdir(scratch, { recursive: true })
    // CPU per process as last seen (Chrome's processes are gone by the end), less what each had used before.
    const before = tree(process.pid).cpu, seen = new Map<number, number>()
    let peak = 0
    const sample = () => { const t = tree(process.pid); peak = Math.max(peak, t.rss); for (const [pid, c] of t.cpu) seen.set(pid, c - (before.get(pid) ?? 0)) }
    const timer = setInterval(sample, 500)
    const t = Date.now()
    await renderThroughPipe({ serveUrl, composition: comp, inputProps, common: { ...common, logLevel: 'error' }, concurrency: tabs, encoder, scratch, out: join(dir, `out-${tabs}.mp4`),
      signal: new AbortController().signal, progress: () => {}, frameDrawn: () => {} })
    const seconds = (Date.now() - t) / 1000
    clearInterval(timer)
    sample()
    const cpu = [...seen.values()].reduce((a, b) => a + b, 0)
    console.log(`[tabs-bench] ${JSON.stringify({ tabs, seconds, framesPerSecond: +(frames / seconds).toFixed(1), peakMemoryGB: +(peak / 2 ** 30).toFixed(2),
      cpuSeconds: +cpu.toFixed(1), coresBusy: +(cpu / seconds).toFixed(1) })}`)
    await rm(scratch, { recursive: true, force: true })
  }
  await rm(dir, { recursive: true, force: true })
  process.exit(0)
}

main().catch((err) => { console.error('[tabs-bench] FAILED:', err); process.exit(1) })
