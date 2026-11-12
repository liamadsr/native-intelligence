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
 *   STUDIO_WORKER_POLL_MS      how often it asks for work when idle (default 2000).
 *   STUDIO_WORK_DIR            scratch and the asset cache (default <tmp>/studio-worker).
 *   STUDIO_CACHE_BYTES         the asset cache's bound (default 5 GB).
 *   STUDIO_RENDER_CONCURRENCY  Chrome tabs per render (default 2).
 *   STUDIO_CHROME              a Chrome headless shell to use: the executable, or a
 *                              folder it is somewhere inside (default: Remotion's own).
 *   STUDIO_ENGINE_DIR          the engine's folder (default ../web/src/lib/studio/engine
 *                              from this package).
 *   STUDIO_HEALTH_PORT         the health answer, on 127.0.0.1 only (default 9092; 0 = none).
 *   STUDIO_SHUTDOWN_GRACE_MS   on SIGTERM, how long a running job may still take (default 25000).
 *   DEEPGRAM_API_KEY           Deepgram's key, for `transcribe` (that kind fails without it).
 *   DEEPGRAM_URL               Deepgram's prerecorded endpoint (a test's fake).
 *   ELEVENLABS_API_KEY         ElevenLabs' key, for narration (`voices`, `narration`): set, the worker
 *                              offers the `voiceover` capability; unset, it never asks for those jobs.
 *   ELEVENLABS_URL             ElevenLabs' API origin (default https://api.elevenlabs.io; a test's fake).
 *   STUDIO_HIGGSFIELD_BIN      the higgsfield command-line tool (default: `higgsfield` on PATH or in the
 *                              usual places). Generated shots (`shot-quote`, `shot`) are offered only while
 *                              it answers its account status, signed in (./providers/capabilities.ts).
 *   STUDIO_ANALYSIS_PYTHON     a Python with numpy and OpenCV, for the motion check and the video review
 *                              (python/motion_analysis.py). Unset, `python3` on PATH is tried; when neither
 *                              imports both, the worker offers neither check (./analysis.ts).
 *   STUDIO_EARSHOT_DIR         the folder of an installed earshot (with its `.venv`), for sound design
 *                              (`sounds`, `sound-import`, `listen`, `sound-bank`). Unset, or not answering,
 *                              the worker offers no `sound` capability (./earshot.ts).
 */
import { hostname, tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StudioJobKind } from '../../web/src/lib/studio/server/job-contract.ts'
import { STUDIO_JOB_KINDS } from './engine.ts'

export interface WorkerConfig {
  appUrl: string
  secret: string
  workerId: string
  kinds: StudioJobKind[]
  concurrency: number
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

/** The settings, or what is wrong with them (each a sentence). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig | { problems: string[] } {
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
  if (problems.length > 0) return { problems }
  const gb = 1024 ** 3
  return {
    appUrl: appUrl.replace(/\/+$/, ''),
    secret: secret!,
    workerId: (setting(env, 'STUDIO_WORKER_ID') ?? `${hostname()}-${process.pid}`).slice(0, 120),
    kinds: kinds as StudioJobKind[],
    concurrency: int(env, 'STUDIO_WORKER_CONCURRENCY', 1, 1, 8),
    pollMs: int(env, 'STUDIO_WORKER_POLL_MS', 2000, 200, 60_000),
    workDir: resolve(setting(env, 'STUDIO_WORK_DIR') ?? resolve(tmpdir(), 'studio-worker')),
    cacheBytes: Number(setting(env, 'STUDIO_CACHE_BYTES') ?? 5 * gb) > 0 ? Math.floor(Number(setting(env, 'STUDIO_CACHE_BYTES') ?? 5 * gb)) : 5 * gb,
    renderConcurrency: int(env, 'STUDIO_RENDER_CONCURRENCY', 2, 1, 16),
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
  }
}
