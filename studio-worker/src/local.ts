/**
 * The local runner: one export, worked on the person's own computer, started by the desktop app (macOS or Windows)
 * with the Node it carries. It takes ONE job by id with the token the editor minted for it (job-contract.ts, "the
 * person's own computer": `local-export`, the routes under /api/local-agent/studio-export/), and:
 *
 * - stages only the files the frozen project names (and its fonts) into a cache of its own, each checked against its
 *   sha256 (the export job's own staging, assets.ts);
 * - exports exactly as the server's worker does (jobs/export.ts: the fast export, or Chrome), with this machine's
 *   encoder for the fast export (encoders.ts: VideoToolbox on a Mac, Media Foundation on Windows) and the render
 *   bundle the app ships (STUDIO_BUNDLE_DIR);
 * - writes the video to the destination the desktop app names (never the page): beside it first, moved there whole;
 * - uploads it and completes the job when asked (`upload`, on by default), so the Studio has it too;
 * - says how far along it is to the app (the token is renewed by every answer, and a quiet computer loses the job after
 *   180 s, so it reports at least every 15 s) and to the desktop app (JSON lines, `emit`);
 * - stops when the person cancels (the app's answer), when the desktop app stops it (`signal`), or on an error, and
 *   tells the app (fail; a cancel ends the job cancelled).
 *
 * The token never comes on the command line (any process can read another's arguments): STUDIO_LOCAL_TOKEN, or the
 * first line of standard input (local-main.ts).
 */
import { mkdir, rename, stat, copyFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { AppClient, AppError } from './app-client.ts'
import { AssetCache } from './cache.ts'
import { loadConfig, type WorkerConfig } from './config.ts'
import { defaultProfile, type EncoderProfile } from './encoders.ts'
import { JobError, type JobContext } from './jobs/context.ts'
import { runExport } from './jobs/export.ts'
import { pathProblem, removeQuietly } from './platform.ts'
import { engineRenderVersion, Renderer } from './render.ts'
import type { ClaimedJob, ExportResult, LocalTaken } from '../../web/src/lib/studio/server/job-contract.ts'

/** What the desktop app is told, one JSON object a line. */
export type LocalEvent =
  | { type: 'taken'; jobId: string; attempt: number; title: string }
  | { type: 'progress'; progress: number }
  | { type: 'log'; line: string }
  | { type: 'done'; file: string; uploaded: boolean; result: ExportResult | null }
  | { type: 'failed'; error: string; cancelled: boolean }

export interface LocalRun {
  appUrl: string
  token: string
  /** The job the token is for (the desktop app knows it from the editor; `take` must answer the same). */
  jobId: string
  /** Where the video goes: an absolute path whose folder exists, chosen in the desktop app. */
  destination: string
  /** Replace a file already there. */
  overwrite?: boolean
  /** Upload the video and complete the job (default true). */
  upload?: boolean
  /** The runner's own folder (cache, bundles, scratch). */
  workDir: string
  cacheBytes?: number
  /** The tools and the bundle the app carries (absolute paths), and Chrome's headless shell. */
  ffmpeg?: string
  ffprobe?: string
  bundleDir?: string
  chrome?: string
  encoder?: EncoderProfile
  signal?: AbortSignal
  emit: (event: LocalEvent) => void
  fetch?: typeof fetch
}

/** How often the app hears from the runner at least (it re-queues a job quiet for 180 s). */
export const HEARTBEAT_MS = 15_000

/** The config a local export runs with: the server's defaults, this computer's tools and folders, no code scenes. Pure over its inputs. */
export function localConfig(o: Pick<LocalRun, 'appUrl' | 'workDir' | 'cacheBytes' | 'ffmpeg' | 'ffprobe' | 'bundleDir' | 'chrome' | 'encoder'>, platform: NodeJS.Platform = process.platform): WorkerConfig {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'production', STUDIO_APP_URL: new URL(o.appUrl).origin, STUDIO_WORK_DIR: o.workDir,
    // Never sent anywhere: the local routes take the job's token, not a worker secret.
    STUDIO_WORKER_SECRET: randomBytes(24).toString('hex'), STUDIO_WORKER_ID: 'local', STUDIO_WORKER_KINDS: 'export',
    STUDIO_CODE_SCENES: 'off', STUDIO_FAST_EXPORT: 'on', STUDIO_FAST_ENCODER: o.encoder ?? defaultProfile(platform),
    ...(o.cacheBytes ? { STUDIO_CACHE_BYTES: String(o.cacheBytes) } : {}),
    ...(o.ffmpeg ? { STUDIO_FFMPEG: o.ffmpeg } : {}), ...(o.ffprobe ? { STUDIO_FFPROBE: o.ffprobe } : {}),
    ...(o.bundleDir ? { STUDIO_BUNDLE_DIR: o.bundleDir } : {}), ...(o.chrome ? { STUDIO_CHROME: o.chrome } : {}),
  }
  const c = loadConfig(env, () => 4)
  if ('problems' in c) throw new JobError(`This computer's export is not set up: ${c.problems.join('; ')}`)
  return c
}

/** Why a destination cannot be written, or null. */
export function destinationProblem(path: string, exists: (p: string) => boolean = existsSync, overwrite = false): string | null {
  if (!isAbsolute(path)) return 'the destination is not an absolute path'
  if (!/\.mp4$/i.test(path)) return 'the destination is not an .mp4 file'
  if (!exists(dirname(path))) return 'the destination folder does not exist'
  if (!overwrite && exists(path)) return 'a file is already there'
  return pathProblem(path)
}

export async function runLocal(o: LocalRun): Promise<{ file: string; result: ExportResult | null }> {
  const why = destinationProblem(o.destination, existsSync, o.overwrite) ?? pathProblem(o.workDir)
  if (why) throw new JobError(why)
  const config = localConfig(o)
  const client = new AppClient({ appUrl: config.appUrl, secret: '', workerId: 'local', local: { token: o.token }, ...(o.fetch ? { fetch: o.fetch } : {}) })
  const taken: LocalTaken = await client.take()
  const { job } = taken
  if (job.id !== o.jobId || job.kind !== 'local-export') throw new JobError('The token is for another job')
  o.emit({ type: 'taken', jobId: job.id, attempt: job.attempts, title: job.input.title })

  const stop = new AbortController()
  const signal = o.signal ? AbortSignal.any([o.signal, stop.signal]) : stop.signal
  const scratch = join(config.workDir, 'jobs', `${job.id}-${job.attempts}`)
  let lastSent = 0, latest = 0, logs: string[] = [], sending: Promise<void> | null = null
  const send = (force = false) => {
    if (sending || (!force && Date.now() - lastSent < 2000)) return sending
    const lines = logs.splice(0)
    lastSent = Date.now()
    sending = client.progress(job.id, latest, lines.join('\n') || undefined)
      .then((r) => { if (r.cancelRequested && !stop.signal.aborted) stop.abort(new JobError('Cancelled')) })
      .catch((err) => { logs.unshift(...lines); if (err instanceof AppError && [401, 403, 409].includes(err.status)) stop.abort(new JobError(`The Studio took the job back (${err.message})`)) })
      .finally(() => { sending = null })
    return sending
  }
  const heartbeat = setInterval(() => void send(true), HEARTBEAT_MS)
  try {
    // The server checked the version when it queued the job; a desktop app updated since then is held to it again.
    const mine = engineRenderVersion()
    if (mine !== null && job.input.renderVersion !== mine) throw new JobError(`This app draws exports as version ${mine}, the Studio asked for ${job.input.renderVersion}: export it on the server`)
    await mkdir(scratch, { recursive: true })
    const cache = new AssetCache(join(config.workDir, 'cache', 'assets'), config.cacheBytes)
    await cache.init()
    let file = ''
    let uploaded = false
    // The export job's own client, but its one write goes to the destination first (and to the Studio when asked).
    const jobClient = Object.create(client) as AppClient
    jobClient.writeBlob = async (jobId, key, path, contentType, opts) => {
      const partial = `${o.destination}.${process.pid}.partial`
      await copyFile(path, partial)
      await rename(partial, o.destination).catch(async (err) => { await removeQuietly(partial); throw err })
      file = o.destination
      o.emit({ type: 'log', line: `Saved to ${basename(o.destination)}` })
      if (o.upload === false) return { bytes: (await stat(path)).size }
      const r = await client.writeBlob(jobId, key, path, contentType, opts)
      uploaded = true
      return r
    }
    const ctx: JobContext<'export'> = {
      job: { id: job.id, kind: 'export', workspaceId: job.workspaceId, videoId: job.videoId, input: job.input, attempts: job.attempts } as ClaimedJob<'export'>,
      config, client: jobClient, cache, renderer: new Renderer(config, cache.dir), scratch, signal,
      progress: (f) => { latest = Math.max(0, Math.min(1, f)); o.emit({ type: 'progress', progress: latest }); void send() },
      log: (line) => { logs.push(line); o.emit({ type: 'log', line }) },
    }
    const result = await runExport(ctx)
    await sending
    if (uploaded) await client.complete(job.id, result)
    o.emit({ type: 'done', file, uploaded, result: uploaded ? result : null })
    return { file, result: uploaded ? result : null }
  } catch (err) {
    const cancelled = signal.aborted
    const message = cancelled ? 'Cancelled' : err instanceof JobError ? err.message : `The export failed on this computer: ${String((err as Error)?.message ?? err).split('\n')[0]!.slice(0, 500)}`
    await sending
    await client.fail(job.id, message).catch(() => undefined)
    o.emit({ type: 'failed', error: message, cancelled })
    throw err instanceof JobError ? err : new JobError(message)
  } finally {
    clearInterval(heartbeat)
    await removeQuietly(scratch)
  }
}

/** The command line's options, or what is wrong with them. Pure. */
export function parseArgs(argv: string[]): Record<string, string | true> | { problem: string } {
  const out: Record<string, string | true> = {}
  const flags = new Set(['no-upload', 'overwrite'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) return { problem: `unexpected ${a}` }
    const name = a.slice(2)
    if (flags.has(name)) { out[name] = true; continue }
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) return { problem: `--${name} needs a value` }
    out[name] = v
    i++
  }
  for (const need of ['app', 'job', 'out', 'work']) if (typeof out[need] !== 'string') return { problem: `--${need} is required` }
  if ('token' in out) return { problem: 'the token never goes on the command line (STUDIO_LOCAL_TOKEN or standard input)' }
  return out
}
