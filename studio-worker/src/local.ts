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
import { homedir } from 'node:os'
import { AppClient, AppError } from './app-client.ts'
import { AssetCache } from './cache.ts'
import { loadConfig, type WorkerConfig } from './config.ts'
import { defaultProfile, type EncoderProfile } from './encoders.ts'
import { JobError, type JobContext } from './jobs/context.ts'
import { runExport } from './jobs/export.ts'
import { pathProblem, removeQuietly } from './platform.ts'
import { findBinary } from './media.ts'
import { probeEncoder, type ProbeResult } from './encoder-probe.ts'
import { engineRenderVersion, Renderer } from './render.ts'
import type { ClaimedJob, ExportResult, LocalTaken } from '../../web/src/lib/studio/server/job-contract.ts'

/** What the desktop app is told, one JSON object a line. */
export type LocalEvent =
  | { type: 'taken'; jobId: string; attempt: number; title: string }
  | { type: 'progress'; progress: number }
  | { type: 'log'; line: string }
  /** The video is at its destination, whole (the upload, if any, comes after). */
  | { type: 'saved'; file: string; bytes: number }
  | { type: 'done'; file: string; uploaded: boolean; result: ExportResult | null }
  /** `code`: the app's refusal code when the app refused (NOT_HELD, ENDED, UNAUTHORIZED…), for the desktop to match on. */
  | { type: 'failed'; error: string; cancelled: boolean; code?: string }
  | { type: 'encoder'; profile: string; rung: string | null; tried: ProbeResult['tried'] }

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
export function localConfig(o: Pick<LocalRun, 'appUrl' | 'workDir' | 'cacheBytes' | 'ffmpeg' | 'ffprobe' | 'bundleDir' | 'chrome' | 'encoder'>, platform: NodeJS.Platform = process.platform,
  find: (name: string) => string | null = (name) => findBinary(name)): WorkerConfig {
  // FFmpeg and ffprobe by absolute path only: on Windows a bare name is looked up in the current folder first, so the
  // desktop app names them (and starts the runner in its own work folder); elsewhere they are found on PATH once, here.
  const tool = (given: string | undefined, name: string) => {
    if (given) {
      if (!isAbsolute(given)) throw new JobError(`--${name} must be an absolute path`)
      return given
    }
    if (platform === 'win32') throw new JobError(`--${name} is required on Windows`)
    const found = find(name)
    if (!found || !isAbsolute(found)) throw new JobError(`${name} was not found`)
    return found
  }
  const ffmpeg = tool(o.ffmpeg, 'ffmpeg'), ffprobe = tool(o.ffprobe, 'ffprobe')
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'production', STUDIO_APP_URL: new URL(o.appUrl).origin, STUDIO_WORK_DIR: o.workDir,
    // Never sent anywhere: the local routes take the job's token, not a worker secret.
    STUDIO_WORKER_SECRET: randomBytes(24).toString('hex'), STUDIO_WORKER_ID: 'local', STUDIO_WORKER_KINDS: 'export',
    STUDIO_CODE_SCENES: 'off', STUDIO_FAST_EXPORT: 'on', STUDIO_FAST_ENCODER: o.encoder ?? defaultProfile(platform),
    // Remotion only draws here: the desktop app does not carry its compositor (a GPL FFmpeg build). chrome-pipe.ts.
    STUDIO_COMPOSITOR: 'off',
    ...(o.cacheBytes ? { STUDIO_CACHE_BYTES: String(o.cacheBytes) } : {}),
    STUDIO_FFMPEG: ffmpeg, STUDIO_FFPROBE: ffprobe,
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

/** STUDIO_LOCAL_TOKEN read once and deleted from `env` (no child inherits it); standard input is the preferred way in. */
export function takeTokenFromEnv(env: NodeJS.ProcessEnv): string | null {
  const t = env.STUDIO_LOCAL_TOKEN ?? null
  delete env.STUDIO_LOCAL_TOKEN
  return t
}

/**
 * The job a token names (its payload's `jid`), read without trusting it for anything else (the app checks the token):
 * so a token for another job is refused before it is used to take one. Null when it is not a local token. Pure.
 */
export function tokenJobId(token: string): string | null {
  const body = /^ls1\.([A-Za-z0-9_-]+)\./.exec(token)?.[1]
  if (!body) return null
  try {
    const jid = (JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { jid?: unknown }).jid
    return typeof jid === 'string' ? jid : null
  } catch {
    return null
  }
}

/**
 * Text that goes to the app (the job's log and its error, which every member of the workspace can read): the home
 * folder and the runner's work folder named, never spelt out, and no token. The full text stays in the runner's own
 * output (LocalEvent). Pure.
 */
export function forTheApp(text: string, o: { home: string; workDir: string; tokens: string[] }): string {
  let out = text
  for (const t of o.tokens) if (t) out = out.split(t).join('[token]')
  const variants = (p: string) => [...new Set([p, p.replace(/\\/g, '/'), p.replace(/\//g, '\\')])].filter((v) => v.length > 1).sort((a, b) => b.length - a.length)
  for (const v of variants(o.workDir)) out = out.split(v).join('<work folder>')
  for (const v of variants(o.home)) out = out.split(v).join('~')
  return out
}

export async function runLocal(o: LocalRun): Promise<{ file: string; result: ExportResult | null }> {
  const why = destinationProblem(o.destination, existsSync, o.overwrite) ?? pathProblem(o.workDir)
  if (why) throw new JobError(why)
  // Its job first, from the token itself: a token for another job is never used to take one.
  const named = tokenJobId(o.token)
  if (named !== null && named !== o.jobId) throw new JobError('The token is for another job')
  // Every build carries its render version; one without is refused, not trusted.
  const mine = engineRenderVersion()
  if (mine === null) throw new JobError('This app has no render version: export it on the server')
  const config = localConfig(o)
  const client = new AppClient({ appUrl: config.appUrl, secret: '', workerId: 'local', local: { token: o.token }, ...(o.fetch ? { fetch: o.fetch } : {}) })
  const scrub = (text: string) => forTheApp(text, { home: homedir(), workDir: config.workDir, tokens: [o.token, client.currentToken()] })
  const taken: LocalTaken = await client.take()
  const { job } = taken
  o.emit({ type: 'taken', jobId: job.id, attempt: job.attempts, title: job.input.title })

  const stop = new AbortController()
  const signal = o.signal ? AbortSignal.any([o.signal, stop.signal]) : stop.signal
  const scratch = join(config.workDir, 'jobs', `${job.id}-${job.attempts}`)
  let lastSent = 0, latest = 0, logs: string[] = [], sending: Promise<void> | null = null
  // At most one report a second, whatever asks (the app answers 429 TOO_FAST past that); every two seconds as it goes.
  const send = (force = false) => {
    if (sending || Date.now() - lastSent < (force ? 1100 : 2000)) return sending
    const lines = logs.splice(0)
    lastSent = Date.now()
    sending = client.progress(job.id, latest, scrub(lines.join('\n')) || undefined)
      .then((r) => { if (r.cancelRequested && !stop.signal.aborted) stop.abort(new JobError('Cancelled')) })
      .catch((err) => { logs.unshift(...lines); if (err instanceof AppError && [401, 403, 409].includes(err.status)) stop.abort(new JobError(`The Studio took the job back (${err.message})`, { cause: err })) })
      .finally(() => { sending = null })
    return sending
  }
  const heartbeat = setInterval(() => void send(true), HEARTBEAT_MS)
  // A copy on its way to the destination (removed on every way out).
  let partial: string | null = null
  try {
    if (job.id !== o.jobId || job.kind !== 'local-export') throw new JobError('The token is for another job')
    // The server checked the version when it queued the job; a desktop app updated since then is held to it again.
    if (job.input.renderVersion !== mine) throw new JobError(`This app draws exports as version ${mine}, the Studio asked for ${job.input.renderVersion}: export it on the server`)
    await mkdir(scratch, { recursive: true })
    // Which encoder settings make a right file on this computer, at this video's size and rate (encoder-probe.ts).
    const out = job.input.project.output
    const probe = await probeEncoder(config.fastEncoder, { width: out.width, height: out.height, fps: out.fps }, scratch, signal)
    o.emit({ type: 'encoder', profile: probe.profile, rung: probe.rung, tried: probe.tried })
    if (!probe.rung) throw new JobError(`This computer cannot encode the video (${probe.tried.map((t) => `${t.rung}: ${t.why}`).join('; ')}): export it on the server`)
    config.encoderRung = probe.rung
    const cache = new AssetCache(join(config.workDir, 'cache', 'assets'), config.cacheBytes)
    await cache.init()
    let file = ''
    let uploaded = false
    // The export job's own client, but its one write goes to the destination first (and to the Studio when asked).
    const jobClient = Object.create(client) as AppClient
    jobClient.writeBlob = async (jobId, key, path, contentType, opts) => {
      const bytes = (await stat(path)).size
      partial = `${o.destination}.${process.pid}.partial`
      await copyFile(path, partial)
      // Stopped while copying (the person, the desktop app): nothing is left at the destination.
      if (signal.aborted) throw new JobError('Cancelled')
      await rename(partial, o.destination)
      partial = null
      file = o.destination
      o.emit({ type: 'saved', file, bytes })
      o.emit({ type: 'log', line: `Saved to ${basename(o.destination)}` })
      if (o.upload === false) return { bytes }
      try {
        const r = await client.writeBlob(jobId, key, path, contentType, opts)
        uploaded = true
        return r
      } catch (err) {
        // The video is where the person asked for it: an upload that fails does not fail the export. It is finished as
        // kept on this computer (a partly stored upload is left uncommitted, for the Studio's sweep). Not when the
        // Studio took the job back (401, 403, 409) or the person cancelled: then it ends as before.
        if (signal.aborted || (err instanceof AppError && [401, 403, 409].includes(err.status))) throw err
        const line = `The upload did not go through (${String((err as Error)?.message ?? err).split('\n')[0]!.slice(0, 200)}): the video is kept on this computer only`
        logs.push(line)
        o.emit({ type: 'log', line })
        return { bytes }
      }
    }
    const ctx: JobContext<'export'> = {
      job: { id: job.id, kind: 'export', workspaceId: job.workspaceId, videoId: job.videoId, input: job.input, attempts: job.attempts } as ClaimedJob<'export'>,
      config, client: jobClient, cache, renderer: new Renderer(config, cache.dir), scratch, signal,
      progress: (f) => { latest = Math.max(0, Math.min(1, f)); o.emit({ type: 'progress', progress: latest }); void send() },
      log: (line) => { logs.push(line); o.emit({ type: 'log', line }) },
    }
    const result = await runExport(ctx)
    await sending
    // Uploaded: the Studio has it under its key. Not: the facts, kept on this computer (the contract's LocalKeptResult).
    if (uploaded) await client.complete(job.id, result)
    else { const { key: _key, ...facts } = result; await client.complete(job.id, { kept: 'computer', ...facts }) }
    o.emit({ type: 'done', file, uploaded, result: uploaded ? result : null })
    return { file, result: uploaded ? result : null }
  } catch (err) {
    // Cancelled: by the person (the app's answer), by the desktop app, or the Studio took the job back (moved it to the
    // server, the person left): 401, 403 or 409 from any call. The desktop app exits 2 for these.
    const cancelled = signal.aborted || (err instanceof AppError && [401, 403, 409].includes(err.status))
    const message = cancelled ? 'Cancelled' : err instanceof JobError ? err.message : `The export failed on this computer: ${String((err as Error)?.message ?? err).split('\n')[0]!.slice(0, 500)}`
    await sending
    await client.fail(job.id, scrub(message)).catch(() => undefined)
    // The refusal that ended it: the error itself, or the progress answer that stopped the run (its abort reason's cause).
    const refusal = [err, (signal.reason as { cause?: unknown } | undefined)?.cause].find((e): e is AppError => e instanceof AppError && !!e.code)
    o.emit({ type: 'failed', error: message, cancelled, ...(refusal?.code ? { code: refusal.code } : {}) })
    throw err instanceof JobError ? err : new JobError(message)
  } finally {
    clearInterval(heartbeat)
    if (partial) await removeQuietly(partial)
    await removeQuietly(scratch)
  }
}

/** The command line's options, or what is wrong with them. Pure. */
export function parseArgs(argv: string[]): Record<string, string | true> | { problem: string } {
  const out: Record<string, string | true> = {}
  const flags = new Set(['no-upload', 'overwrite', 'probe'])
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
  // --probe: only which encoder settings work here (the desktop app's status), no job.
  for (const need of out.probe ? ['work'] : ['app', 'job', 'out', 'work']) if (typeof out[need] !== 'string') return { problem: `--${need} is required` }
  if ('token' in out) return { problem: 'the token never goes on the command line (STUDIO_LOCAL_TOKEN or standard input)' }
  return out
}
