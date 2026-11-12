/**
 * The Studio worker: one process that does Studio's heavy media work for the app
 * (deploy/studio's `studio-worker` service; deploy/studio/README.md).
 *
 *   - Every STUDIO_WORKER_POLL_MS while it has a free slot it asks the app for a
 *     job of the kinds it takes (web/src/lib/studio/server/job-contract.ts).
 *     Nothing calls it: it publishes no port, holds no database or storage key,
 *     and reaches files only through the links the app signs for the job it holds.
 *   - One job at a time by default (STUDIO_WORKER_CONCURRENCY): a render takes
 *     the machine's cores as it is.
 *   - A running job reports progress at least every 10 s (./runner.ts); the
 *     answer may ask it to cancel, which kills its FFmpeg or stops its render.
 *   - SIGTERM (a deploy, a restart): it claims nothing more, lets the running job
 *     finish for STUDIO_SHUTDOWN_GRACE_MS, then stops it and fails it with a
 *     sentence saying why, so the app can offer it again; then it exits.
 *   - Health: GET http://127.0.0.1:<STUDIO_HEALTH_PORT>/ answers 200 while its loop
 *     runs (the compose health check), with counts and nothing else.
 */
import { createServer } from 'node:http'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { allowedKinds, analysisCapabilities, analysisState, detectAnalysis } from './analysis.ts'
import { AppClient, AppError } from './app-client.ts'
import { sleep } from './backoff.ts'
import { AssetCache } from './cache.ts'
import { loadConfig, type WorkerConfig } from './config.ts'
import { EarshotWatch, soundKindsFor } from './earshot.ts'
import { runLook, runMotion, runReview } from './jobs/checks.ts'
import { runCutout } from './jobs/cutout.ts'
import { runExport } from './jobs/export.ts'
import { runFaces } from './jobs/faces.ts'
import { runImport } from './jobs/import.ts'
import { runNarration, runVoices } from './jobs/narration.ts'
import { runMusic, runRevoice, runSoundEffect, runVoiceSearch } from './jobs/voice-media.ts'
import { runContinuity, runShot, runShotQuote } from './jobs/shot.ts'
import { runSlides } from './jobs/slides.ts'
import { runStills } from './jobs/stills.ts'
import { runAdsMotion } from './jobs/ads-motion.ts'
import { runAdsReel } from './jobs/ads-reel.ts'
import { runAdsStatic } from './jobs/ads-static.ts'
import { runListen, runSoundBank, runSoundImport, runSounds } from './jobs/sound.ts'
import { runSoundJudge, runSoundMake } from './jobs/sound-judge.ts'
import { runThumbnail } from './jobs/thumbnail.ts'
import { runTranscribe } from './jobs/transcribe.ts'
import { kindsFor, WorkerCapabilities } from './providers/capabilities.ts'
import { Renderer } from './render.ts'
import { JobRun, type Handlers } from './runner.ts'
import { probeVision, visionCapabilityList, visionState, withVision } from './vision/probe.ts'

export const handlers: Handlers = {
  import: runImport,
  export: runExport,
  stills: runStills,
  thumbnail: runThumbnail,
  transcribe: runTranscribe,
  slides: runSlides,
  voices: runVoices,
  narration: runNarration,
  'shot-quote': runShotQuote,
  shot: runShot,
  continuity: runContinuity,
  motion: runMotion,
  review: runReview,
  look: runLook,
  sounds: runSounds,
  'sound-import': runSoundImport,
  listen: runListen,
  'sound-bank': runSoundBank,
  'sound-judge': runSoundJudge,
  'sound-make': runSoundMake,
  cutout: runCutout,
  faces: runFaces,
  'ads-static': runAdsStatic,
  'ads-motion': runAdsMotion,
  'ads-reel': runAdsReel,
  'voice-search': runVoiceSearch,
  revoice: runRevoice,
  'sound-effect': runSoundEffect,
  music: runMusic,
}

const loaded = loadConfig()
if ('problems' in loaded) {
  for (const p of loaded.problems) console.error(`[studio-worker] not started: ${p}`)
  process.exit(1)
}
const config: WorkerConfig = loaded

await mkdir(config.workDir, { recursive: true })
// Scratch a killed process left behind.
await rm(join(config.workDir, 'jobs'), { recursive: true, force: true })
const cache = new AssetCache(join(config.workDir, 'cache', 'assets'), config.cacheBytes)
await cache.init()
await cache.trim()
// What it can do beyond media work (a provider key, the higgsfield tool signed in), told to the app with every
// claim and progress report; the provider kinds are asked for only while their capability holds.
const capabilities = new WorkerCapabilities(config)
await capabilities.start()
// The motion check and the review need a Python with numpy and OpenCV (./analysis.ts), found once now.
await detectAnalysis(config)
// Sound design needs earshot (STUDIO_EARSHOT_DIR, ./earshot.ts): asked now and every few minutes.
const earshot = new EarshotWatch(config.earshotDir)
await earshot.start()
// Cut-outs and face tracks need macOS Vision (./vision/probe.ts): on a Mac the Swift helpers are built (once, a minute
// or two) and self-tested in the background, and the capabilities are said once they pass. Elsewhere, never.
void probeVision(config).then((found) =>
  console.info(`[studio-worker] vision: ${[...found.on].join(', ') || 'off'}${found.reason ? ` (${found.reason})` : ''}`),
)
const client = new AppClient({ appUrl: config.appUrl, secret: config.secret, workerId: config.workerId, capabilities: () => [...capabilities.list(), ...analysisCapabilities(analysisState()), ...earshot.capabilities(), ...visionCapabilityList()] })
const renderer = new Renderer(config, cache.dir)
const running = new Set<JobRun>()
const shutdown = new AbortController()
let lastLoopAt = Date.now()
let lastAppOkAt = 0
let done = 0
let failed = 0

/** A slot: the media slots take media work; the provider slot takes provider calls and quick measurements. */
async function slot(index: number, which: 'media' | 'provider' = 'media'): Promise<void> {
  let wait = config.pollMs
  while (!shutdown.signal.aborted) {
    lastLoopAt = Date.now()
    const kinds = withVision(which, soundKindsFor(which, allowedKinds(kindsFor(which, config.kinds, capabilities.current()), analysisState()), config.kinds, earshot.usable), config.kinds, visionState().on)
    if (!kinds.length) {
      await sleep(config.pollMs, shutdown.signal)
      continue
    }
    let job = null
    try {
      job = await client.claim(kinds)
      lastAppOkAt = Date.now()
      wait = config.pollMs
    } catch (err) {
      const status = err instanceof AppError ? err.status : 0
      console.warn(
        `[studio-worker] slot ${index}: no work read (${status || 'unreachable'})${status === 401 || status === 403 ? ': STUDIO_WORKER_SECRET differs from the app’s' : status === 404 ? ': Studio is off in the app, or its routes are not there yet' : ''}`,
      )
      wait = Math.min(30_000, Math.max(wait * 2, 5000))
    }
    if (!job) {
      await sleep(wait, shutdown.signal)
      continue
    }
    if (shutdown.signal.aborted) {
      // Claimed as the stop came: hand it straight back.
      await client.fail(job.id, 'The studio worker was stopping when it took this job; try again.').catch(() => undefined)
      break
    }
    const run = new JobRun(job, { config, client, cache, renderer, handlers })
    running.add(run)
    try {
      const outcome = await run.run()
      if (outcome === 'completed') done++
      else failed++
    } finally {
      running.delete(run)
    }
  }
}

const health =
  config.healthPort > 0
    ? createServer((req, res) => {
        const alive = Date.now() - lastLoopAt < 60_000 || running.size > 0
        res.writeHead(alive ? 200 : 503, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            ok: alive,
            running: [...running].map((r) => ({ kind: r.job.kind, progress: Math.round(r.progressFraction * 100) / 100, seconds: Math.round((Date.now() - r.startedAt) / 1000) })),
            done,
            failed,
            appOkSecondsAgo: lastAppOkAt ? Math.round((Date.now() - lastAppOkAt) / 1000) : null,
          }),
        )
        void req
      })
    : null
health?.on('error', (err) => console.warn(`[studio-worker] health answer off: ${err.message}`))
health?.listen(config.healthPort, '127.0.0.1')

let slots: Promise<void>[] = []

async function stopAll(signal: string): Promise<void> {
  if (shutdown.signal.aborted) return
  console.info(`[studio-worker] ${signal}: taking no more jobs; ${running.size} running, ${Math.round(config.shutdownGraceMs / 1000)} s to finish`)
  shutdown.abort()
  capabilities.stop()
  earshot.stop()
  const finished = Promise.all(slots)
  const timer = setTimeout(() => {
    for (const run of running) run.stop('The studio worker was stopped (a restart or a deploy) before this job finished; try again.')
  }, config.shutdownGraceMs)
  await finished
  clearTimeout(timer)
  health?.close()
  process.exit(0)
}
process.on('SIGTERM', () => void stopAll('SIGTERM'))
process.on('SIGINT', () => void stopAll('SIGINT'))

console.info(
  `[studio-worker] started as ${config.workerId}: ${config.kinds.join(', ')}; ${config.concurrency} at a time; app at ${config.appUrl}; work in ${config.workDir}; can also: ${[...capabilities.list(), ...earshot.capabilities()].join(', ') || 'no paid providers'}`,
)
slots = Array.from({ length: config.concurrency }, (_, i) => slot(i))
// One more slot for provider calls and quick measurements, when this worker takes any.
if (kindsFor('provider', config.kinds, new Set(['voiceover', 'generatedShots'])).length || (config.earshotDir && config.kinds.includes('sound-bank'))) slots.push(slot(config.concurrency, 'provider'))
