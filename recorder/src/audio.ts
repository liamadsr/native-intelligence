/**
 * A call's sound, kept (migration 650; deploy/README.md step 23, "Call audio
 * files"). Off unless RECORDER_AUDIO=on here and the app's start said
 * `audio` for the session (TEAM_CALL_AUDIO=on there).
 *
 *   - While the call is heard, every member's microphone (never a meeting
 *     guest's: their notice covers notes, not their voice kept) is mixed into
 *     one mono stream on the wall clock (./mixer.ts) and written to disk as
 *     raw 16 kHz PCM, a second behind the call: memory stays at the mixer's
 *     few seconds, whatever the call's length. Silence is never written (the
 *     file's holes read as zeros), so a long quiet stretch costs no disk.
 *   - A take is one file: from where the recorder began hearing the session
 *     (`offsetMs` on the session's clock) to where it stopped. A restart
 *     (SIGTERM, a deploy) leaves the take as it is; the next process, taking
 *     the session up again, goes on writing the same file at the call's own
 *     time, so the stretch it missed is silence and every later word is still
 *     where the transcript says. A take nobody takes up again within
 *     LEFTOVER_GRACE_MS of a start is finished as it stands. Leaving a call
 *     any other way (notes off, the call over, alone, the room lost, the
 *     bound) finishes the take; coming back to the same session later makes
 *     a new one.
 *   - A finished take is encoded once (ffmpeg: AAC in an MP4 file, 32 kbit/s
 *     mono, about 15 MB an hour; it plays in every browser and in the
 *     desktop and iPhone apps), then handed to the app through the feed: the
 *     app grants a one-time upload to the path it chose (the recorder holds
 *     no storage key), the file goes up, and the app is told. One take at a
 *     time, in the background, at a lower priority than the calls: nothing a
 *     call needs waits on it, and the notes never wait on the sound. An
 *     upload that fails is tried again with backoff, across restarts (the
 *     take's state is a small JSON file beside it), for MAX_TAKE_AGE_MS; the
 *     app's 'not_wanted' (the switch went off, the session is too old),
 *     'stored', 'too_large' or 'taken' drop the local copy at once.
 *   - It never fills the disk: no take starts with less than the minimum
 *     free, and a write that fails ends that take's sound (the call's notes
 *     go on).
 *
 * Logs carry ids, counts and sizes. Never a link, never a key.
 */
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, stat, statfs, writeFile, type FileHandle } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { setPriority } from 'node:os'
import { join } from 'node:path'
import { AppError, type AppClient, type FeedSession } from './app-client.ts'
import { backoffMs, sleep } from './backoff.ts'
import { Mixer } from './mixer.ts'

/** The stream: what LiveKit hands the recorder already (./call.ts SAMPLE_RATE). */
export const AUDIO_RATE = 16_000
/** How far behind the call the mix is written. */
export const MIX_LATENCY_MS = 1_000
/** What the mixer holds. */
export const MIX_WINDOW_MS = 4_000
/** How often the mix is written out. */
export const MIX_DRAIN_MS = 250
/** A take from before a restart that no call takes up again within this is finished as it stands. */
export const LEFTOVER_GRACE_MS = 3 * 60_000
/** How long a take is kept trying to reach the app. */
export const MAX_TAKE_AGE_MS = 3 * 24 * 60 * 60_000
/** A take shorter than this, or with no sound in it, is not kept. */
export const MIN_TAKE_MS = 1_000
export const AUDIO_CONTENT_TYPE = 'audio/mp4'

export interface AudioSettings {
  dir: string
  ffmpeg: string
  minFreeBytes: number
}

type TakeState = 'recording' | 'finished' | 'encoded'

export interface TakeMeta {
  take: string
  sessionId: string
  /** The session's clock (its startedAt, epoch ms). */
  sessionStartedAtMs: number
  /** Where the take's time zero is on the session's clock. */
  offsetMs: number
  state: TakeState
  /** Whether any sound was written. */
  voiced: boolean
  createdAt: number
  attempts: number
  /** Not tried again before this (epoch ms). */
  nextAt: number
  encodeFailures: number
  /** The take's length, once finished (the raw file's: the encoded one is the same). */
  durationMs?: number
}

/** A take's key on the feed: unique to this file, the same for every retry. Pure. */
export function takeKey(sessionId: string, nowMs: number): string {
  return `t-${sessionId.toLowerCase()}-${nowMs.toString(36)}`.slice(0, 80)
}

/** ffmpeg's arguments: raw 16 kHz mono PCM in, AAC in an MP4 file out, its index at the front (plays before it is all loaded). Pure. */
export function encodeArgs(pcmPath: string, outPath: string): string[] {
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', String(AUDIO_RATE), '-ac', '1', '-i', pcmPath, '-c:a', 'aac', '-b:a', '32k', '-movflags', '+faststart', '-f', 'mp4', outPath]
}

/**
 * Positional writes into one raw PCM file, one after another (never two at
 * once on the file). A write that fails marks it failed and stops the rest.
 */
class PcmFile {
  private readonly fh: FileHandle
  private chain: Promise<void> = Promise.resolve()
  failed: Error | null = null
  private onFail: (err: Error) => void

  private constructor(fh: FileHandle, onFail: (err: Error) => void) {
    this.fh = fh
    this.onFail = onFail
  }

  static async open(path: string, onFail: (err: Error) => void): Promise<{ file: PcmFile; samples: number }> {
    const fh = await open(path, 'a+').then(async (h) => {
      // 'a+' makes it if it is not there; positional writes need 'r+'.
      await h.close()
      return open(path, 'r+')
    })
    const { size } = await fh.stat()
    return { file: new PcmFile(fh, onFail), samples: Math.floor(size / 2) }
  }

  write(atSample: number, pcm: Int16Array): void {
    if (this.failed) return
    const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    this.chain = this.chain.then(async () => {
      if (this.failed) return
      try {
        await this.fh.write(buf, 0, buf.length, atSample * 2)
      } catch (err) {
        this.failed = err instanceof Error ? err : new Error(String(err))
        this.onFail(this.failed)
      }
    })
  }

  /** Every write done, the file exactly `samples` long (a hole at its end reads as silence), closed. */
  async close(samples: number): Promise<void> {
    await this.chain
    if (!this.failed) await this.fh.truncate(samples * 2).catch(() => undefined)
    await this.fh.close().catch(() => undefined)
  }
}

/** One call's take while it is being heard. */
export class CallAudio {
  readonly meta: TakeMeta
  private readonly keeper: AudioKeeper
  private readonly mixer: Mixer
  private readonly file: PcmFile
  private readonly timer: ReturnType<typeof setInterval>
  private ended: Promise<void> | null = null

  constructor(keeper: AudioKeeper, meta: TakeMeta, file: PcmFile, fromSample: number) {
    this.keeper = keeper
    this.meta = meta
    this.file = file
    this.mixer = new Mixer({
      sampleRate: AUDIO_RATE,
      originMs: meta.sessionStartedAtMs + meta.offsetMs,
      fromSample,
      latencyMs: MIX_LATENCY_MS,
      capacityMs: MIX_WINDOW_MS,
      write: (at, pcm) => this.file.write(at, pcm),
    })
    this.timer = setInterval(() => this.mixer.drain(Date.now()), MIX_DRAIN_MS)
  }

  get failed(): boolean {
    return this.file.failed !== null
  }

  /** One member's frame, its last sample heard at `endWallMs`. */
  push(trackSid: string, pcm: Int16Array, endWallMs: number): void {
    if (this.ended || this.file.failed) return
    this.mixer.push(trackSid, pcm, endWallMs)
  }

  /** A track ended. */
  forget(trackSid: string): void {
    this.mixer.forget(trackSid)
  }

  /**
   * The take stops here: 'pause' (a shutdown: the next process takes it up) or 'finish' (handed on
   * to be encoded and uploaded, in the background).
   */
  end(how: 'pause' | 'finish'): Promise<void> {
    this.ended ??= (async () => {
      clearInterval(this.timer)
      const samples = this.mixer.finish(Date.now())
      await this.file.close(samples)
      if (this.mixer.voiced) this.meta.voiced = true
      if (this.mixer.late > 0) console.info(`[recorder] session=${this.meta.sessionId} audio: ${Math.round(this.mixer.late / 16)} ms of late frames left out`)
      if (how === 'pause' && !this.file.failed) {
        await this.keeper.saveMeta(this.meta)
        this.keeper.released(this.meta.take)
        return
      }
      this.meta.state = 'finished'
      await this.keeper.saveMeta(this.meta)
      this.keeper.released(this.meta.take)
      this.keeper.enqueue(this.meta.take)
    })()
    return this.ended
  }
}

export interface UploadPort {
  /** PUT the file at `path` (`bytes` long) to `url`. Resolves with the HTTP status; throws when it could not be sent. */
  put(url: string, path: string, bytes: number, headers: Record<string, string>, signal: AbortSignal): Promise<number>
}

/** The upload over plain node:http(s): the file streamed from disk, its length declared (Storage refuses one too large before reading it). */
export const httpUpload: UploadPort = {
  put(url, path, bytes, headers, signal) {
    return new Promise((resolve, reject) => {
      const u = new URL(url)
      const send = u.protocol === 'https:' ? httpsRequest : httpRequest
      const req = send(u, { method: 'PUT', headers: { ...headers, 'content-length': String(bytes) }, signal }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
        res.on('error', reject)
      })
      // Silent for two minutes: given up (it is tried again).
      req.setTimeout(120_000, () => req.destroy(new Error('upload stalled')))
      req.on('error', reject)
      const body = createReadStream(path)
      body.on('error', (err) => req.destroy(err))
      body.pipe(req)
    })
  },
}

/**
 * Every take of this process: the calls' files being written, and the queue of finished ones on
 * their way to the app. One per process.
 */
export class AudioKeeper {
  private readonly settings: AudioSettings
  private readonly client: AppClient
  private readonly uploads: UploadPort
  private readonly retry: { baseMs: number; maxMs: number }
  private readonly leftoverGraceMs: number
  private readonly queue: string[] = []
  private readonly open = new Set<string>()
  private readonly leftovers = new Map<string, TakeMeta>()
  private readonly stopping = new AbortController()
  private wake: (() => void) | null = null
  private worker: Promise<void> | null = null
  private encoder: ReturnType<typeof spawn> | null = null
  /** For tests and the health answer. */
  readonly counts = { granted: 0, stored: 0, dropped: 0, failed: 0 }

  constructor(settings: AudioSettings, client: AppClient, opts: { uploads?: UploadPort; retry?: { baseMs: number; maxMs: number }; leftoverGraceMs?: number } = {}) {
    this.settings = settings
    this.client = client
    this.uploads = opts.uploads ?? httpUpload
    this.retry = opts.retry ?? { baseMs: 5_000, maxMs: 30 * 60_000 }
    this.leftoverGraceMs = opts.leftoverGraceMs ?? LEFTOVER_GRACE_MS
  }

  private pcmPath(take: string): string {
    return join(this.settings.dir, `${take}.pcm`)
  }
  private outPath(take: string): string {
    return join(this.settings.dir, `${take}.m4a`)
  }
  private metaPath(take: string): string {
    return join(this.settings.dir, `${take}.json`)
  }

  /** The folder made, ffmpeg found; then every take left from an earlier process is picked up. False: no audio in this process. */
  async start(): Promise<boolean> {
    try {
      await mkdir(this.settings.dir, { recursive: true })
      await new Promise<void>((resolve, reject) => {
        const p = spawn(this.settings.ffmpeg, ['-hide_banner', '-version'], { stdio: 'ignore' })
        p.on('error', reject)
        p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))))
      })
    } catch (err) {
      console.warn('[recorder] audio off: its folder or ffmpeg is not usable:', err instanceof Error ? err.message.slice(0, 160) : 'unknown')
      return false
    }
    const names = await readdir(this.settings.dir).catch(() => [] as string[])
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const meta = await this.readMeta(name.slice(0, -5))
      if (!meta) continue
      if (meta.state === 'recording') {
        this.leftovers.set(meta.sessionId, meta)
        setTimeout(() => void this.leftoverDue(meta.sessionId), this.leftoverGraceMs).unref()
      } else this.enqueue(meta.take)
    }
    console.info(`[recorder] audio on: ${this.queue.length} take(s) to hand on, ${this.leftovers.size} left mid-call`)
    this.worker = this.work()
    return true
  }

  private async readMeta(take: string): Promise<TakeMeta | null> {
    try {
      return JSON.parse(await readFile(this.metaPath(take), 'utf8')) as TakeMeta
    } catch {
      return null
    }
  }

  async saveMeta(meta: TakeMeta): Promise<void> {
    // Written whole, then renamed over the old one: a crash never leaves half a file.
    const tmp = `${this.metaPath(meta.take)}.tmp`
    await writeFile(tmp, JSON.stringify(meta))
    await rename(tmp, this.metaPath(meta.take))
  }

  /**
   * The take of a session the recorder starts (or takes up again) hearing: the one a restart left,
   * if there is one; else a new one. Null when the app keeps no sound of it, or the disk is short.
   */
  async openTake(session: FeedSession, nowMs: number = Date.now()): Promise<CallAudio | null> {
    if (!session.audio || this.stopping.signal.aborted) return null
    const sessionStartedAtMs = Date.parse(session.startedAt)
    const leftover = this.leftovers.get(session.id)
    let meta: TakeMeta
    if (leftover) {
      this.leftovers.delete(session.id)
      meta = leftover
    } else {
      try {
        const fs = await statfs(this.settings.dir)
        const free = Number(fs.bavail) * Number(fs.bsize)
        if (free < this.settings.minFreeBytes) {
          console.warn(`[recorder] session=${session.id} audio not kept: ${Math.round(free / 1048576)} MB free`)
          return null
        }
      } catch {
        return null
      }
      meta = {
        take: takeKey(session.id, nowMs),
        sessionId: session.id,
        sessionStartedAtMs,
        offsetMs: Math.max(0, nowMs - sessionStartedAtMs),
        state: 'recording',
        voiced: false,
        createdAt: nowMs,
        attempts: 0,
        nextAt: 0,
        encodeFailures: 0,
      }
    }
    try {
      const { file, samples } = await PcmFile.open(this.pcmPath(meta.take), (err) => console.warn(`[recorder] session=${session.id} audio write failed, its sound ends here:`, err.message.slice(0, 120)))
      await this.saveMeta(meta)
      this.open.add(meta.take)
      if (leftover) console.info(`[recorder] session=${session.id} audio: take taken up again at ${Math.round(samples / 16)} ms`)
      return new CallAudio(this, meta, file, samples)
    } catch (err) {
      console.warn(`[recorder] session=${session.id} audio not kept:`, err instanceof Error ? err.message.slice(0, 120) : 'unknown')
      return null
    }
  }

  released(take: string): void {
    this.open.delete(take)
  }

  /** A take left by an earlier process that no call took up: finished as it stands. */
  private async leftoverDue(sessionId: string): Promise<void> {
    const meta = this.leftovers.get(sessionId)
    if (!meta || this.stopping.signal.aborted) return
    this.leftovers.delete(sessionId)
    console.info(`[recorder] session=${sessionId} audio: a take from before the restart, not taken up again, finished as it stands`)
    meta.state = 'finished'
    await this.saveMeta(meta).catch(() => undefined)
    this.enqueue(meta.take)
  }

  /** Every leftover is finished now (a test, or a session the app says is over). */
  async finishLeftovers(): Promise<void> {
    for (const id of [...this.leftovers.keys()]) await this.leftoverDue(id)
  }

  enqueue(take: string): void {
    if (!this.queue.includes(take)) this.queue.push(take)
    this.wake?.()
  }

  /** Waiting to be handed on (the health answer). */
  get pending(): number {
    return this.queue.length
  }

  /** The take's files off the disk (the app has it, or never will). */
  private async removeLocal(take: string): Promise<void> {
    await Promise.all([rm(this.pcmPath(take), { force: true }), rm(this.outPath(take), { force: true }), rm(`${this.outPath(take)}.part`, { force: true }), rm(this.metaPath(take), { force: true })])
  }

  private async drop(take: string, why: string): Promise<void> {
    this.counts.dropped++
    console.info(`[recorder] take=${take} audio dropped: ${why}`)
    await this.removeLocal(take)
  }

  /** The queue, one take at a time, until the process stops. */
  private async work(): Promise<void> {
    while (!this.stopping.signal.aborted) {
      const now = Date.now()
      let meta: TakeMeta | null = null
      let soonest = 30_000
      for (const take of [...this.queue]) {
        const m = await this.readMeta(take)
        if (!m) {
          // Its state is gone (removed by hand): nothing left to hand on.
          this.queue.splice(this.queue.indexOf(take), 1)
          continue
        }
        if (m.nextAt <= now) {
          meta = m
          break
        }
        soonest = Math.min(soonest, m.nextAt - now)
      }
      if (!meta) {
        await new Promise<void>((resolve) => {
          this.wake = resolve
          void sleep(Math.max(250, soonest), this.stopping.signal).then(resolve)
        })
        this.wake = null
        continue
      }
      const current = meta
      try {
        const done = await this.step(current)
        if (done) this.queue.splice(this.queue.indexOf(current.take), 1)
      } catch (err) {
        if (this.stopping.signal.aborted) break
        this.counts.failed++
        current.attempts++
        current.nextAt = Date.now() + backoffMs(current.attempts, this.retry)
        const status = err instanceof AppError ? err.status || 'unreachable' : 'error'
        console.warn(`[recorder] take=${current.take} audio not handed on yet (${status}), attempt ${current.attempts}:`, err instanceof Error ? err.message.slice(0, 120) : 'unknown')
        await this.saveMeta(current).catch(() => undefined)
      }
    }
  }

  /** One step of one take: encode it, or upload it. True when the take is done with (kept or dropped). */
  private async step(meta: TakeMeta): Promise<boolean> {
    if (Date.now() - meta.createdAt > MAX_TAKE_AGE_MS) {
      await this.drop(meta.take, 'too old to hand on')
      return true
    }
    if (meta.state === 'finished') {
      const pcm = await stat(this.pcmPath(meta.take)).catch(() => null)
      const ms = pcm ? (pcm.size / 2 / AUDIO_RATE) * 1000 : 0
      if (!pcm || !meta.voiced || ms < MIN_TAKE_MS) {
        await this.drop(meta.take, pcm ? 'no sound in it' : 'its file is gone')
        return true
      }
      try {
        await this.encode(meta.take)
      } catch (err) {
        if (this.stopping.signal.aborted) throw err
        meta.encodeFailures++
        if (meta.encodeFailures >= 3) {
          await this.drop(meta.take, `it could not be encoded (${err instanceof Error ? err.message.slice(0, 80) : 'unknown'})`)
          return true
        }
        throw err
      }
      meta.state = 'encoded'
      meta.durationMs = Math.round(ms)
      await this.saveMeta(meta)
      await rm(this.pcmPath(meta.take), { force: true })
      return false
    }
    if (meta.state !== 'encoded') return true
    return this.upload(meta)
  }

  private async encode(take: string): Promise<void> {
    const tmp = `${this.outPath(take)}.part`
    await new Promise<void>((resolve, reject) => {
      const p = spawn(this.settings.ffmpeg, encodeArgs(this.pcmPath(take), tmp), { stdio: ['ignore', 'ignore', 'pipe'] })
      this.encoder = p
      // Below every call's own work: an encode runs when there is time for it.
      if (p.pid) {
        try {
          setPriority(p.pid, 10)
        } catch {
          // left at the recorder's own priority
        }
      }
      let err = ''
      p.stderr?.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-400)))
      p.on('error', reject)
      p.on('exit', (code, signal) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${signal ?? code}: ${err.trim().split('\n').pop() ?? ''}`))))
    }).finally(() => (this.encoder = null))
    await rename(tmp, this.outPath(take))
  }

  private async upload(meta: TakeMeta): Promise<boolean> {
    const out = this.outPath(meta.take)
    const file = await stat(out).catch(() => null)
    if (!file) {
      await this.drop(meta.take, 'its encoded file is gone')
      return true
    }
    const durationMs = meta.durationMs ?? 0
    const grant = await this.client.audioGrant(meta.sessionId, { take: meta.take, offsetMs: meta.offsetMs, durationMs, bytes: file.size, contentType: AUDIO_CONTENT_TYPE })
    if (grant.outcome !== 'granted' || !grant.upload) {
      await this.drop(meta.take, grant.outcome === 'stored' ? 'the app has it already' : `the app said ${grant.outcome}`)
      return true
    }
    this.counts.granted++
    const status = await this.uploads.put(grant.upload.url, out, file.size, grant.upload.headers, this.stopping.signal)
    if (status === 413) {
      await this.drop(meta.take, 'too large for Storage')
      return true
    }
    if (status < 200 || status >= 300) throw new AppError(`upload answered ${status}`, status, null)
    const stored = await this.client.audioStored(meta.sessionId, meta.take)
    if (stored.outcome === 'missing') throw new AppError('the app did not find the upload', 503, null)
    if (stored.outcome === 'stored') {
      this.counts.stored++
      console.info(`[recorder] take=${meta.take} session=${meta.sessionId} audio kept: ${Math.round(file.size / 1024)} KB, ${Math.round(durationMs / 1000)} s, until ${stored.expiresAt ?? '?'}`)
      await this.removeLocal(meta.take)
      return true
    }
    await this.drop(meta.take, `the app said ${stored.outcome}`)
    return true
  }

  /** A shutdown: the encode or upload under way is stopped (the next process does it again); takes stay on disk. */
  async stop(): Promise<void> {
    this.stopping.abort()
    this.wake?.()
    this.encoder?.kill('SIGKILL')
    await this.worker?.catch(() => undefined)
  }
}
