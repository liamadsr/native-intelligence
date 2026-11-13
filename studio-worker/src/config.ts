/**
 * The worker's settings, from its environment (deploy/studio/.env through
 * compose.yaml, or the shell when run by hand). An empty value counts as unset.
 *
 *   STUDIO_APP_URL             where the app is (default http://localhost:3000, `next dev`).
 *   STUDIO_WORKER_SECRET       sent with every request to the app. Required in
 *                              production; `dev-studio-worker` otherwise.
 *   STUDIO_WORKER_ID           its name on the jobs it claims (default host-pid).
 *   STUDIO_WORKER_KINDS        the job kinds it takes, comma separated (default all).
 *   STUDIO_WORKER_CONCURRENCY  jobs at once (default 1).
 *   STUDIO_LIVE_SLOTS          slots that only prepare recordings while they record (`live-import`, one job per
 *                              video track; default 0: off). The media and provider slots never take those jobs.
 *   STUDIO_LIVE_THREADS        encoder threads each live job's FFmpeg uses, at a lower priority (default 2).
 *   STUDIO_WORKER_POLL_MS      how often it asks for work when idle (default 2000).
 *   STUDIO_WORK_DIR            scratch and the asset cache (default <tmp>/studio-worker).
 *   STUDIO_CACHE_BYTES         the asset cache's bound (default 5 GB).
 *   STUDIO_RENDER_CONCURRENCY  Chrome tabs per render (default: from the CPUs the worker is given,
 *                              renderTabs below).
 *   STUDIO_CHROME              a Chrome headless shell to use: the executable, or a
 *                              folder it is somewhere inside (default: Remotion's own).
 *   STUDIO_ENGINE_DIR          the engine's folder (default ../web/src/lib/studio/engine
 *                              from this package).
 *   STUDIO_HEALTH_PORT         the health answer, on 127.0.0.1 only (default 9092; 0 = none).
 *   STUDIO_SHUTDOWN_GRACE_MS   on SIGTERM, how long a running job may still take (default 25000).
 *   DEEPGRAM_API_KEY           Deepgram's key, for `transcribe` (that kind fails without it).
 *   DEEPGRAM_URL               Deepgram's prerecorded endpoint (a test's fake).
 *   ELEVENLABS_API_KEY         ElevenLabs' key, for narration (`voices`, `narration`) and the rest of the
 *                              voice provider (`voice-search`, `revoice`, `sound-effect`, `music`): set, the
 *                              worker offers the `voiceover` capability; unset, it never asks for those jobs.
 *   ELEVENLABS_URL             ElevenLabs' API origin, https only (default https://api.elevenlabs.io; a test's
 *                              fake on this machine may be http).
 *   STUDIO_HIGGSFIELD_BIN      the higgsfield command-line tool (default: `higgsfield` on PATH or in the
 *                              usual places). Generated shots (`shot-quote`, `shot`) are offered only while
 *                              it answers its account status, signed in (./providers/capabilities.ts).
 *   STUDIO_ANALYSIS_PYTHON     a Python with numpy and OpenCV, for the motion check and the video review
 *                              (python/motion_analysis.py). Unset, `python3` on PATH is tried; when neither
 *                              imports both, the worker offers neither check (./analysis.ts).
 *   STUDIO_EARSHOT_DIR         the folder of an installed earshot (with its `.venv`), for sound design
 *                              (`sounds`, `sound-import`, `listen`, `sound-bank`). Unset, or not answering,
 *                              the worker offers no `sound` capability (./earshot.ts).
 *   STUDIO_CODE_SCENES         whether renders run code scenes' code (in their locked frame, ./scenes.ts):
 *                              on/off (also 1/0, true/false). Default on outside production, off in production.
 *   STUDIO_FAST_EXPORT         on/off (default on): an export that is only a recording, its cuts and its camera bubble
 *                              is composed by FFmpeg instead of drawn in Chrome (./fast-export.ts); off, Chrome draws all.
 */
import { existsSync, readFileSync } from 'node:fs'
import { availableParallelism, hostname, tmpdir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { ENCODER_PROFILES, type EncoderProfile } from './encoders.ts'
import { setTools } from './platform.ts'
import { fileURLToPath } from 'node:url'
import type { StudioJobKind } from '../../web/src/lib/studio/server/job-contract.ts'
import { STUDIO_JOB_KINDS } from './engine.ts'

export interface WorkerConfig {
  appUrl: string
  secret: string
  workerId: string
  kinds: StudioJobKind[]
  concurrency: number
  /** Slots taking only `live-import` (a recording prepared while it records); 0: none. */
  liveSlots: number
  /** Encoder threads per live job's FFmpeg. */
  liveThreads: number
  pollMs: number
  workDir: string
  cacheBytes: number
  renderConcurrency: number
  chrome: string | null
  engineDir: string
  healthPort: number
  shutdownGraceMs: number
  deepgramKey: string | null
  deepgramUrl: string
  elevenLabsKey: string | null
  elevenLabsUrl: string
  higgsfieldBin: string | null
  analysisPython: string | null
  earshotDir: string | null
  /** Run code scenes in renders (STUDIO_CODE_SCENES). */
  codeScenes: boolean
  /** Compose plain exports with FFmpeg (STUDIO_FAST_EXPORT; fast-export.ts). */
  fastExport: boolean
  /** How the fast export encodes its picture (STUDIO_FAST_ENCODER; encoders.ts): x264 on the server. */
  fastEncoder: EncoderProfile
  /** FFmpeg and ffprobe to run (STUDIO_FFMPEG, STUDIO_FFPROBE: absolute paths), null for the ones on PATH. */
  ffmpeg: string | null
  ffprobe: string | null
  /** A render bundle built ahead (STUDIO_BUNDLE_DIR; bundle-dir.ts), null to bundle the engine here. */
  bundleDir: string | null
}

export const DEV_SECRET = 'dev-studio-worker'
export const DEEPGRAM_PRERECORDED_URL = 'https://api.deepgram.com/v1/listen'
export const ELEVENLABS_API_URL = 'https://api.elevenlabs.io'
/** This package's folder (studio-worker/), wherever it was started from. */
export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function setting(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name]?.trim()
  return v ? v : null
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(env[name]?.trim() ?? '', 10)
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback
}

/**
 * The CPUs a container's quota allows (cgroup v2 `cpu.max`, else v1's `cpu.cfs_quota_us` over `cpu.cfs_period_us`),
 * rounded up, or null when there is no quota (or no cgroup: macOS). Compose's `cpus: "4"` is such a quota: the
 * machine's cores all stay visible, so counting them would say 12 where 4 may be used.
 */
export function cgroupCpus(read: (path: string) => string | null = readOrNull): number | null {
  const v2 = read('/sys/fs/cgroup/cpu.max')?.trim().split(/\s+/)
  if (v2 && v2.length === 2) return v2[0] === 'max' ? null : quota(Number(v2[0]), Number(v2[1]))
  const q = read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us') ?? read('/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us')
  const p = read('/sys/fs/cgroup/cpu/cpu.cfs_period_us') ?? read('/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us')
  return q !== null && p !== null ? quota(Number(q.trim()), Number(p.trim())) : null
}
const quota = (q: number, p: number) => (Number.isFinite(q) && Number.isFinite(p) && q > 0 && p > 0 ? Math.max(1, Math.ceil(q / p - 1e-9)) : null)
function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** The CPUs this process may use: the cores it may run on, bounded by a container's quota. */
export function availableCpus(): number {
  const cores = availableParallelism()
  return Math.max(1, Math.min(cores, cgroupCpus() ?? cores))
}

/**
 * Chrome tabs per render for `cpus` CPUs: one fewer than the CPUs (the encoder and Chrome's own threads need the
 * rest), at least 1, at most 4. Measured on the export of a 20 s 2504×1438 60 fps recording with a camera bubble
 * (deploy/studio/README.md, "Export speed"): every tab past the first adds work per frame (each decoded frame is
 * handed to every tab), so beyond about 4 tabs a render gets slower however many cores there are. Pure.
 */
export function renderTabs(cpus: number): number {
  return Math.max(1, Math.min(4, Math.floor(cpus) - 1))
}

/** A switch setting: on/off, 1/0, true/false, yes/no (case aside); unset is `fallback`, anything else null. */
function onOff(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean | null {
  const v = setting(env, name)?.toLowerCase()
  if (v === undefined || v === null) return fallback
  if (['on', '1', 'true', 'yes'].includes(v)) return true
  if (['off', '0', 'false', 'no'].includes(v)) return false
  return null
}

/** The settings, or what is wrong with them (each a sentence). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cpus: () => number = availableCpus): WorkerConfig | { problems: string[] } {
  const problems: string[] = []
  const production = env.NODE_ENV === 'production'
  const appUrl = setting(env, 'STUDIO_APP_URL') ?? 'http://localhost:3000'
  if (!/^https?:\/\/[^/\s]+\/?$/.test(appUrl)) problems.push('STUDIO_APP_URL must be an origin like http://localhost:3000')
  const secret = setting(env, 'STUDIO_WORKER_SECRET') ?? (production ? null : DEV_SECRET)
  if (!secret) problems.push('STUDIO_WORKER_SECRET is required in production')
  else if (production && secret === DEV_SECRET) problems.push('STUDIO_WORKER_SECRET must not be the development secret in production')
  const kindsSetting = setting(env, 'STUDIO_WORKER_KINDS')
  const kinds = kindsSetting ? [...new Set(kindsSetting.split(',').map((k) => k.trim()).filter(Boolean))] : [...STUDIO_JOB_KINDS]
  const unknown = kinds.filter((k) => !(STUDIO_JOB_KINDS as readonly string[]).includes(k))
  if (unknown.length > 0) problems.push(`STUDIO_WORKER_KINDS names kinds that do not exist: ${unknown.join(', ')} (known: ${STUDIO_JOB_KINDS.join(', ')})`)
  if (kinds.length === 0) problems.push('STUDIO_WORKER_KINDS names no kind')
  const codeScenes = onOff(env, 'STUDIO_CODE_SCENES', !production)
  if (codeScenes === null) problems.push('STUDIO_CODE_SCENES must be on or off')
  const fastExport = onOff(env, 'STUDIO_FAST_EXPORT', true)
  if (fastExport === null) problems.push('STUDIO_FAST_EXPORT must be on or off')
  const fastEncoder = (setting(env, 'STUDIO_FAST_ENCODER') ?? 'x264') as EncoderProfile
  if (!ENCODER_PROFILES.includes(fastEncoder)) problems.push(`STUDIO_FAST_ENCODER must be one of ${ENCODER_PROFILES.join(', ')}`)
  const tool = (name: string) => {
    const v = setting(env, name)
    if (v && (!isAbsolute(v) || !existsSync(v))) problems.push(`${name} must be the absolute path of a file that exists`)
    return v ?? null
  }
  const ffmpeg = tool('STUDIO_FFMPEG'), ffprobe = tool('STUDIO_FFPROBE')
  const bundleDir = setting(env, 'STUDIO_BUNDLE_DIR') ? resolve(setting(env, 'STUDIO_BUNDLE_DIR')!) : null
  if (problems.length > 0) return { problems }
  // Every FFmpeg and ffprobe run of this process goes to these (media.ts, fast-sound.ts).
  if (ffmpeg || ffprobe) setTools({ ffmpeg, ffprobe })
  const gb = 1024 ** 3
  return {
    appUrl: appUrl.replace(/\/+$/, ''),
    secret: secret!,
    workerId: (setting(env, 'STUDIO_WORKER_ID') ?? `${hostname()}-${process.pid}`).slice(0, 120),
    kinds: kinds as StudioJobKind[],
    concurrency: int(env, 'STUDIO_WORKER_CONCURRENCY', 1, 1, 8),
    liveSlots: kinds.includes('live-import') ? int(env, 'STUDIO_LIVE_SLOTS', 0, 0, 8) : 0,
    liveThreads: int(env, 'STUDIO_LIVE_THREADS', 2, 1, 16),
    pollMs: int(env, 'STUDIO_WORKER_POLL_MS', 2000, 200, 60_000),
    workDir: resolve(setting(env, 'STUDIO_WORK_DIR') ?? resolve(tmpdir(), 'studio-worker')),
    cacheBytes: Number(setting(env, 'STUDIO_CACHE_BYTES') ?? 5 * gb) > 0 ? Math.floor(Number(setting(env, 'STUDIO_CACHE_BYTES') ?? 5 * gb)) : 5 * gb,
    renderConcurrency: int(env, 'STUDIO_RENDER_CONCURRENCY', 0, 1, 16) || renderTabs(cpus()),
    chrome: setting(env, 'STUDIO_CHROME'),
    engineDir: resolve(setting(env, 'STUDIO_ENGINE_DIR') ?? resolve(PACKAGE_DIR, '../web/src/lib/studio/engine')),
    healthPort: int(env, 'STUDIO_HEALTH_PORT', 9092, 0, 65535),
    shutdownGraceMs: int(env, 'STUDIO_SHUTDOWN_GRACE_MS', 25_000, 0, 600_000),
    deepgramKey: setting(env, 'DEEPGRAM_API_KEY'),
    deepgramUrl: setting(env, 'DEEPGRAM_URL') ?? DEEPGRAM_PRERECORDED_URL,
    elevenLabsKey: setting(env, 'ELEVENLABS_API_KEY'),
    elevenLabsUrl: (setting(env, 'ELEVENLABS_URL') ?? ELEVENLABS_API_URL).replace(/\/+$/, ''),
    higgsfieldBin: setting(env, 'STUDIO_HIGGSFIELD_BIN'),
    analysisPython: setting(env, 'STUDIO_ANALYSIS_PYTHON'),
    earshotDir: setting(env, 'STUDIO_EARSHOT_DIR') ? resolve(setting(env, 'STUDIO_EARSHOT_DIR')!) : null,
    codeScenes: codeScenes!,
    fastExport: fastExport!,
    fastEncoder, ffmpeg, ffprobe, bundleDir,
  }
}
