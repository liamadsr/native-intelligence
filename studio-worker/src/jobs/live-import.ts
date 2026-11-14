/**
 * live-import: a video track of a take prepared while it records. The app queues one per video track when the take
 * starts (web/src/lib/studio/server/live-takes.ts followLive); only a live slot takes it (STUDIO_LIVE_SLOTS).
 *
 * The job asks the app for the track's pieces as they arrive (live/pieces: only its own track, only pieces surely
 * stored), downloads each in order into a local copy, and feeds that copy, as it grows, into ONE FFmpeg that conforms
 * with the very arguments a strict import after Stop uses (assets.ts conformArgs, `-xerror`). The download never waits
 * for FFmpeg, so a job that falls behind still holds the whole take when the seal comes. Fed the same bytes, FFmpeg
 * writes the same file from a pipe as from the joined file (test/live-import-job.test.ts proves it, also for uneven
 * pieces, a take stopped early and a real browser take). It runs under a lower priority with STUDIO_LIVE_THREADS
 * threads, so an export beside it still gets the CPU.
 *
 *   - The screen's rate is the import's own rule (`conform.fit`, media.ts fitRate): until enough of the picture has
 *     moved to tell (prefixRate), pieces are only kept; then FFmpeg starts and is fed them from the copy.
 *   - A recorder that is quiet costs nothing: FFmpeg waits on its input, the job asks every `pollMs`.
 *   - A piece listed but not readable yet is asked for again on the next round, never skipped.
 *   - At the seal (Stop, or the take brought back after a crash) everything that decides who makes the asset is known
 *     and decided before FFmpeg is waited for; any no hands the take to the import at once (the job fails, the app
 *     queues the import): the whole take's rate by the import's rule differs from the one used, or its frame times
 *     cannot be read; the reader of the copy, reading it as the import does, stops short of its end; the container's
 *     reader met damage (a pipe resyncs otherwise than a file: the result might not be the import's); or what is left
 *     to conform would take this job longer than the import takes for the whole take (handOver).
 *   - Then the input closes, FFmpeg gets three times what its backlog should take (endTimeout), and the rest is an
 *     import's: measured, its start and end decoded, stored as a library asset. Where the strict flags stop (damage
 *     the import would refuse, or a take cut short mid-frame, which the lenient import reads past), the import decides.
 *   - Ends early, so the ordinary import takes over: the take thrown away (the app also cancels the job); no new piece
 *     for `quietMs` (the recorder cuts one every 4 s); running past `maxMs` (the longest take the Studio reads is two
 *     hours); FFmpeg ending before its input did.
 *   - Handed out again (taken back from this worker): it starts over from piece 0, from the local copy this worker
 *     kept (STUDIO_WORK_DIR/live, outside the job's scratch), once the app has confirmed the copy's pieces are the
 *     ones declared. Any other end clears the copy: a worker stopping fails its jobs, so they are not handed out
 *     again. Copies left behind are removed after LOCAL_COPY_KEEP_MS, at worker start and when a live job starts.
 *   - The live path always re-encodes; an import after Stop keeps an MP4 already on the frame grid byte for byte.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, open, readdir, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { buildAsset, conformArgs, inspectFile, publishAsset, verifyDecodes } from '../assets.ts'
import { fileSha256 } from '../app-client.ts'
import { sleep } from '../backoff.ts'
import { fenceInputs, fitRate, MOVING_GAP, run, videoStamps } from '../media.ts'
import { TAKEN_BACK } from '../runner.ts'
import { checkAborted, JobError, type JobHandler } from './context.ts'

/** The live job's limits (tests shorten them). */
export const liveLimits = {
  /** How often a quiet take is asked for new pieces. */
  pollMs: 1500,
  /** The slowest pace a take may keep: no new piece this long and not sealed, the job ends. */
  quietMs: 3 * 60_000,
  /** The most a live job may run: the longest take the Studio reads (two hours) and half an hour to spare. */
  maxMs: 150 * 60_000,
  /**
   * How long FFmpeg may take after its input closed: three times what its backlog should take at the speed it showed
   * while behind, at least `endMinMs`, at most `endMs` (a backlog larger than the import's whole take is handed over at
   * the seal instead, so this is a guard against a stuck FFmpeg, not a wait).
   */
  endMs: 15 * 60_000,
  endMinMs: 2 * 60_000,
  /** A piece listed by the app but unreadable this many rounds in a row ends the job. */
  unreadableRounds: 40,
  /** While the rate is not decided, the copy is measured again at most this often. */
  rateEveryMs: 5_000,
  /** The cores an import after Stop would have (the container's, as Node reads them). */
  cores: availableParallelism(),
}
/** Local copies older than this are left from jobs long ended: removed at worker start and when a live job starts. */
export const LOCAL_COPY_KEEP_MS = 24 * 3600_000

/** The fewest moving frame gaps a screen's rate is decided from before the seal. */
export const RATE_MIN_MOVING = 60
/** Decided at once only when the moving frames' median rate is this far from fitRate's line (45 fps). */
export const RATE_MARGIN_FPS = 7.5
/** Decided anyway once this many moving gaps came (half a minute of motion at 60). */
export const RATE_MAX_MOVING = 1800

/**
 * The rate a screen take is conformed at, judged from the frames that came so far; null: not yet. `sealed`: these are
 * all the frames, and the answer is fitRate's, the import's own. Before that it is fitRate's answer once at least
 * RATE_MIN_MOVING gaps moved and their median rate is RATE_MARGIN_FPS clear of the line (or RATE_MAX_MOVING moved):
 * a take whose motion changes character later can still land the other side, which the check after the seal catches.
 * Pure.
 */
export function prefixRate(stamps: number[], most: 30 | 60, ceiling: number | undefined, sealed: boolean): 30 | 60 | null {
  if (sealed || most === 30 || (ceiling !== undefined && Number.isFinite(ceiling) && ceiling <= 45)) return fitRate(stamps, most, ceiling)
  const moving: number[] = []
  for (let i = 1; i < stamps.length; i++) {
    const gap = stamps[i]! - stamps[i - 1]!
    if (gap > 0 && gap < MOVING_GAP) moving.push(gap)
  }
  if (moving.length < RATE_MIN_MOVING) return null
  moving.sort((a, b) => a - b)
  const rate = 1 / moving[Math.floor(moving.length / 2)]!
  if (Math.abs(rate - 45) < RATE_MARGIN_FPS && moving.length < RATE_MAX_MOVING) return null
  return fitRate(stamps, most, ceiling)
}

/** The local copy of a job's pieces: the bytes, and their lengths one a line (a crash between the two is cut back). */
export class LocalCopy {
  readonly data: string
  readonly index: string
  constructor(dir: string, jobId: string) {
    this.data = join(dir, `${jobId}.bin`)
    this.index = join(dir, `${jobId}.idx`)
  }

  /**
   * The pieces it holds, in order (the data cut back to them when a crash left more bytes than lengths). Only whole
   * lines count: a crash part way through writing a length leaves a line with no end, which is not a piece.
   */
  async pieces(): Promise<number[]> {
    const text = await readFile(this.index, 'utf8').catch(() => '')
    const lengths = text.slice(0, text.lastIndexOf('\n') + 1)
      .split('\n')
      .filter(Boolean)
      .map((line) => (/^[0-9]+$/.test(line) ? Number(line) : Number.NaN))
    const valid: number[] = []
    for (const n of lengths) if (Number.isSafeInteger(n) && n > 0) valid.push(n)
    else break
    const total = valid.reduce((a, b) => a + b, 0)
    const size = (await stat(this.data).catch(() => null))?.size ?? 0
    if (size < total) {
      // Fewer bytes than the lengths say: start over.
      await this.clear()
      return []
    }
    if (size > total) await truncate(this.data, total)
    // The index cut back too, so the next length is not written onto the end of a torn one.
    const whole = valid.map((n) => `${n}\n`).join('')
    if (text !== whole) await writeFile(this.index, whole)
    return valid
  }

  async append(bytes: Buffer): Promise<void> {
    await appendFile(this.data, bytes)
    await appendFile(this.index, `${bytes.length}\n`)
  }

  async clear(): Promise<void> {
    await rm(this.data, { force: true })
    await rm(this.index, { force: true })
  }
}

/** Remove local copies left by jobs long ended (at worker start, and when a live job starts). Never throws. */
export async function tidyLocalCopies(dir: string, now = Date.now()): Promise<void> {
  try {
    for (const name of await readdir(dir)) {
      const path = join(dir, name)
      const info = await stat(path).catch(() => null)
      if (info && now - info.mtimeMs > LOCAL_COPY_KEEP_MS) await rm(path, { force: true })
    }
  } catch {
    // Nothing to tidy.
  }
}

type Conform = ReturnType<typeof startConform>

/**
 * Whether an FFmpeg log line comes from the reader of a recording's container (MP4 or WebM, either version's prefix:
 * `[matroska,webm @ 0x…]`, `[in#0/mov,mp4,… @ 0x…]`), as against its decoders (`[h264 @ 0x…] mmco: unref short
 * failure`, which a decoder logs and recovers from, the same from a pipe as from a file). A reader that met damage
 * resyncs differently on a pipe than on a file it can seek in, so what follows may not be what the import reads. Pure.
 */
export function readerLine(line: string): boolean {
  return /^\[(?:in#\d+\/)?(?:matroska,webm|mov,mp4,m4a,3gp,3g2,mj2) @ /.test(line)
}

/**
 * One FFmpeg conforming from its standard input, at a lower priority, with the strict import's flags (`-xerror`): it
 * stops exactly where an import after Stop would refuse the take, and goes on past what that import reads past (an
 * error a decoder logs and recovers from). So its exit is the import's judgement, nothing stricter.
 */
function startConform(out: string, fps: 30 | 60, threads: number, signal: AbortSignal) {
  const args = fenceInputs('ffmpeg', conformArgs('pipe:0', out, fps, { threads }))
  const proc = spawn('nice', ['-n', '10', 'ffmpeg', ...args], { stdio: ['pipe', 'ignore', 'pipe'], signal })
  let stderr = ''
  let pending = ''
  // Damage the container's reader met (readerLine): from then on the file may not be the import's.
  let damage = 0
  proc.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    stderr = (stderr + text).slice(-4000)
    const lines = (pending + text).split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) if (readerLine(line)) damage++
  })
  // An input closed by FFmpeg (it failed) must not throw from a write: its exit says why.
  proc.stdin.on('error', () => undefined)
  let code: number | null | undefined
  const exited = new Promise<number | null>((resolve) => {
    proc.on('close', (c) => resolve((code = c)))
    proc.on('error', () => resolve((code = -1)))
  })
  const tail = () => stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 500)
  const failed = () => new JobError(`The recording could not be prepared while it recorded${tail() ? `: ${tail()}` : ''}; it is prepared the ordinary way.`)
  return {
    /** How many times the container's reader met damage it read past. */
    get damage() {
      return damage + (readerLine(pending) ? 1 : 0)
    },
    /** Throws when FFmpeg ended before its input did (it died, or stopped where the import would refuse the take). */
    check(): void {
      if (code !== undefined) throw failed()
    },
    async feed(bytes: Buffer): Promise<void> {
      this.check()
      if (!proc.stdin.write(bytes)) await Promise.race([once(proc.stdin, 'drain'), exited])
      this.check()
    },
    /** Close the input and wait for FFmpeg to finish the file, `timeoutMs` at most. */
    async end(timeoutMs: number): Promise<void> {
      this.check()
      proc.stdin.end()
      let timer: NodeJS.Timeout | undefined
      const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), timeoutMs)
      })
      const done = await Promise.race([exited, late])
      clearTimeout(timer)
      if (done === 'late') {
        proc.kill('SIGKILL')
        throw new JobError('The recording took too long to finish preparing; it is prepared the ordinary way.')
      }
      if (done !== 0) throw failed()
    },
    kill(): void {
      proc.kill('SIGKILL')
    },
  }
}

/**
 * How far into a file its container's reader gets: the end of the last packet it reads, of any stream (ffprobe, from
 * the file as the import reads it). A recording the reader gives up on part way (a box it cannot read) ends its
 * packets there; read from a pipe, the same take can end there quietly where the import, reading the file, refuses
 * it. So a take is handed over unless the reader gets to within READ_SLACK of its end.
 */
async function reach(path: string, signal?: AbortSignal): Promise<number> {
  const { stdout } = await run('ffprobe', ['-v', 'quiet', '-show_entries', 'packet=pos,size', '-of', 'csv=p=0', path], { timeout: 300_000, maxBuffer: 256 * 1024 * 1024, signal })
  let end = 0
  for (const line of stdout.split('\n')) {
    const [pos, size] = line.split(',').map(Number)
    if (Number.isFinite(pos) && Number.isFinite(size) && pos! >= 0 && size! > 0) end = Math.max(end, pos! + size!)
  }
  return end
}

/**
 * What may follow a container's last packet: an index or a few closing boxes (FFmpeg's own fragmented MP4 ends with
 * about 12 KB of index for 10 minutes; a browser's MP4 and WebM end with their last packet). Pure.
 */
export const readSlack = (bytes: number) => Math.max(256 * 1024, Math.ceil(bytes / 2000))

/** How the copy's frame times and reach are read (tests replace them). */
export const liveProbe = { stamps: videoStamps, reach }

/** The frame times of what the copy holds so far; null when they cannot be read (too little of it yet, or a failure). */
async function stampsOf(path: string, signal: AbortSignal): Promise<number[] | null> {
  try {
    return await liveProbe.stamps(path, signal)
  } catch {
    checkAborted(signal)
    return null
  }
}

/**
 * How many times faster an import after Stop conforms a take than a live job does, from the live job's threads and the
 * cores the worker has (an import's FFmpeg takes them all, at the normal priority). FFmpeg does not speed up in
 * proportion to its threads. Measured on a made-up 10-minute 2.5K screen take on an 18-core Mac (the live conform under
 * `nice`, against the import's): 1 thread 344 s, 2 threads 163 s, 8 threads 73 s against 54.7 s with the machine busy
 * (a load of 26 to 65), 4 threads 54.7 s against 26.7 s with it quiet: 6.3, 3.0, 1.34 and 2.05 times. The square
 * root of cores over threads gives 4.2, 3.0, 1.5 and 2.1: within an eighth from 2 threads up; one thread is slower
 * than that, and is given the power that fits it (0.64). So at the default of 2 threads on 18 cores a live job is
 * kept when at most a third behind at the seal (break-even 0.67 done), at 4 threads on 8 cores about 0.29. Pure.
 */
export function importSpeedup(threads: number, cores: number): number {
  const ratio = Math.max(1, cores) / Math.max(1, threads)
  return Math.max(1, ratio ** (threads <= 1 ? 0.64 : 0.5))
}

/**
 * Whether to hand a sealed take over to the import instead of finishing it here: when the share of the take not yet
 * conformed (`backlog` of `total` bytes) would take the live job longer than the whole take takes the import, that is
 * when backlog / total > 1 / speedup. Pure.
 */
export function handOver(backlog: number, total: number, speedup: number): boolean {
  return total > 0 && backlog / total > 1 / speedup
}

/**
 * How long FFmpeg may take to finish once its input closes: three times what `backlog` bytes take at the speed it
 * showed while behind (`bytesPerMs`), within endMinMs and endMs; unknown speed (it never fell behind): endMs. Pure.
 */
export function endTimeout(backlog: number, bytesPerMs: number): number {
  if (!(bytesPerMs > 0)) return liveLimits.endMs
  return Math.min(liveLimits.endMs, Math.max(liveLimits.endMinMs, (3 * backlog) / bytesPerMs))
}

/** The most bytes fed to FFmpeg at once. */
const FEED_CHUNK = 1024 * 1024

export const runLiveImport: JobHandler<'live-import'> = async (ctx) => {
  const startedAt = Date.now()
  const input = ctx.job.input
  const { fit, ceiling } = input.conform
  const most = input.conform.fps
  const dir = localCopyDir(ctx.config.workDir)
  await mkdir(dir, { recursive: true })
  await tidyLocalCopies(dir)
  const copy = new LocalCopy(dir, ctx.job.id)
  const out = join(ctx.scratch, 'conformed.mp4')
  const hash = createHash('sha256')
  // The rate: fixed by the app, or (`fit`) judged from the frames as they come.
  let fps: 30 | 60 | null = fit ? null : most
  let decidedEarly = false
  let conform: Conform | null = null
  // Pieces and bytes in the copy (downloaded), and bytes given to FFmpeg. The download never waits on FFmpeg: a job
  // that falls behind still has the whole take on disk when the seal comes.
  let pieces = 0
  let rawBytes = 0
  let fedBytes = 0
  // How fast FFmpeg takes bytes when it is the one holding things up (bytes and ms of feeds with more waiting).
  let busyBytes = 0
  let busyMs = 0
  let closing = false
  let finished = false
  let wake: (() => void) | null = null
  let feeding: Promise<void> | null = null
  let feedError: unknown = null
  let lastPieceAt = Date.now()
  let measuredAt = 0
  const nudge = () => {
    wake?.()
    wake = null
  }
  const failIfFeedFailed = () => {
    if (feedError) throw feedError
    ;(conform as Conform | null)?.check()
  }
  /** Feed FFmpeg from the copy, in order, as the copy grows; ends once `closing` and all is fed. */
  const feed = async (running: Conform) => {
    // Made if no piece has come yet ('a+': read anywhere, never written through this handle).
    const handle = await open(copy.data, 'a+')
    try {
      for (;;) {
        checkAborted(ctx.signal)
        if (fedBytes < rawBytes) {
          const n = Math.min(FEED_CHUNK, rawBytes - fedBytes)
          const buffer = Buffer.allocUnsafe(n)
          const { bytesRead } = await handle.read(buffer, 0, n, fedBytes)
          if (bytesRead <= 0) throw new JobError('The recording’s local copy could not be read; it is prepared the ordinary way.')
          const behind = rawBytes - fedBytes - bytesRead >= FEED_CHUNK
          const began = Date.now()
          await running.feed(buffer.subarray(0, bytesRead))
          if (behind) {
            busyBytes += bytesRead
            busyMs += Date.now() - began
          }
          fedBytes += bytesRead
          continue
        }
        if (closing) return
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    } finally {
      await handle.close()
    }
  }
  const start = (rate: 30 | 60) => {
    fps = rate
    const running = startConform(out, rate, ctx.config.liveThreads, ctx.signal)
    conform = running
    ctx.log(`Preparing the recording as it records, at a constant ${rate} fps (H.264/AAC)`)
    feeding = feed(running).catch((err) => {
      feedError = err
    })
  }
  try {
    // Handed out again on this worker: what it already downloaded is used once the app confirms it is what was declared.
    let held = await copy.pieces()
    if (held.length) {
      const check = await ctx.client.livePieces(ctx.job.id, held.length, true)
      const lengths = check.lengths ?? []
      if (lengths.length !== held.length || lengths.some((n, i) => n !== held[i])) {
        ctx.log('The pieces already here are not the ones the recording declares: starting over')
        await copy.clear()
        held = []
      } else {
        ctx.log(`Picking up from ${held.length} pieces already here`)
        rawBytes = held.reduce((a, b) => a + b, 0)
        for await (const chunk of createReadStream(copy.data, { start: 0, end: rawBytes - 1, highWaterMark: FEED_CHUNK })) hash.update(chunk as Buffer)
        pieces = held.length
      }
    }
    if (fps) start(fps)
    else ctx.log('Keeping the recording as it records until its frame rate can be told')
    let unreadable = 0
    let sealed: { count: number; complete: boolean } | null = null
    for (;;) {
      checkAborted(ctx.signal)
      failIfFeedFailed()
      if (Date.now() - startedAt > liveLimits.maxMs) throw new JobError('The recording ran longer than a take prepared while it records may; it is prepared the ordinary way.')
      const answer = await ctx.client.livePieces(ctx.job.id, pieces)
      if (answer.state === 'dropped') throw new JobError('The recording was thrown away.')
      let got = 0
      for (const piece of answer.pieces) {
        if (piece.index !== pieces) break
        let bytes: Buffer
        try {
          bytes = await ctx.client.downloadPiece(piece.url, piece.bytes, ctx.signal)
        } catch (err) {
          checkAborted(ctx.signal)
          // Listed, not readable yet (or a dropped connection): asked again next round, never skipped.
          void err
          break
        }
        await copy.append(bytes)
        hash.update(bytes)
        rawBytes += bytes.length
        pieces++
        got++
        nudge()
      }
      sealed = answer.sealed
      const all = !!sealed && pieces >= sealed.count
      if (all && pieces > sealed!.count) throw new JobError('The recording was saved shorter than what was prepared; it is prepared again from what was saved.')
      // Not decided yet: the copy is measured as it grows (every rateEveryMs at most).
      if (!fps && rawBytes && !all && got && Date.now() - measuredAt >= liveLimits.rateEveryMs) {
        measuredAt = Date.now()
        const stamps = await stampsOf(copy.data, ctx.signal)
        const rate = stamps ? prefixRate(stamps, most, ceiling, false) : null
        if (rate) {
          decidedEarly = true
          start(rate)
        }
      }
      if (all) break
      if (got) {
        unreadable = 0
        lastPieceAt = Date.now()
        ctx.progress(conform && answer.declared ? Math.min(0.9, (fedBytes / Math.max(1, rawBytes)) * (pieces / answer.declared)) : 0)
        continue
      }
      if (answer.pieces.length && ++unreadable >= liveLimits.unreadableRounds) throw new JobError('A piece of the recording could not be read; it is prepared the ordinary way.')
      if (!sealed && Math.max(Date.now() - lastPieceAt, answer.quietMs) > liveLimits.quietMs) throw new JobError('The recording stopped before it was finished; it is prepared when it is brought back.')
      await sleep(liveLimits.pollMs, ctx.signal)
    }
    // The seal: the whole take is in the copy. Everything that decides whether this job or the import makes the asset
    // is known now, so the import is handed the take at once, not after FFmpeg's backlog.
    const partial = !sealed!.complete
    failIfFeedFailed()
    let rate: 30 | 60 | null = fps
    // Read as the import reads it, from the file: how far its reader gets, and (when the rate is judged) its frame times.
    const [reached, stamps] = await Promise.all([
      liveProbe.reach(copy.data, ctx.signal).catch(() => {
        checkAborted(ctx.signal)
        return -1
      }),
      !fps || decidedEarly ? stampsOf(copy.data, ctx.signal) : Promise.resolve(null),
    ])
    if (reached < 0 || rawBytes - reached > readSlack(rawBytes)) throw new JobError('The recording could not be read to its end; it is prepared the ordinary way, from the saved file.')
    if (!fps || decidedEarly) {
      // The import's own rule on the whole take; frame times that cannot be read are not known: the import decides.
      if (!stamps) throw new JobError('The recording’s frame times could not be read while it recorded; it is prepared the ordinary way.')
      const whole = fitRate(stamps, most, ceiling)
      if (fps && whole !== fps) throw new JobError(`The recording's frame rate (${whole} fps) is not the one it was prepared at while it recorded (${fps}); it is prepared the ordinary way.`)
      rate = whole
    }
    // What is not conformed yet (all of it when FFmpeg has not started), against what the import would take for it all.
    const backlog = rawBytes - (conform ? fedBytes : 0)
    const speedup = importSpeedup(ctx.config.liveThreads, liveLimits.cores)
    if (handOver(backlog, rawBytes, speedup)) {
      throw new JobError(`The recording was ${Math.round((backlog / rawBytes) * 100)}% behind at the seal, longer to finish here than the ordinary import takes for all of it; it is prepared the ordinary way.`)
    }
    if (!conform) start(rate!)
    const running = conform as unknown as Conform
    const damaged = () => {
      if (running.damage) throw new JobError('Part of the recording was damaged; it is prepared the ordinary way, from the saved file.')
    }
    damaged()
    // FFmpeg's time for what is left, from how fast it took bytes when it was behind; unknown (it kept up): the cap.
    const endMs = endTimeout(rawBytes - fedBytes, busyMs > 0 ? busyBytes / busyMs : 0)
    closing = true
    nudge()
    await (feeding as Promise<void> | null)
    failIfFeedFailed()
    // A take cut short (`partial`) may end mid-frame: where the strict flags stop on it, the lenient import decides.
    await running.end(endMs)
    finished = true
    // Damage in the backlog shows only once FFmpeg has read it.
    damaged()
    ctx.progress(0.92)
    checkAborted(ctx.signal)
    const name = input.name.replace(/\.[^.]+$/, '') + '.mp4'
    // What is left after Stop: measure the file, decode its ends, name it by its hash, store it.
    const [inspected, sha256] = await Promise.all([inspectFile(out, name, ctx.signal), fileSha256(out)])
    const { measured, waveform } = inspected
    if (measured.kind !== 'video') throw new JobError('The recording has no picture.')
    await verifyDecodes(out, measured.durationSeconds ?? 0, ctx.signal)
    const bytes = (await stat(out)).size
    const asset = buildAsset(measured, { sha256, bytes }, {
      name,
      waveform,
      sourceCursorHidden: input.sourceCursorHidden,
      provenance: { ...(input.provenance ?? {}), rawSha256: hash.digest('hex'), rawBytes, rawPieces: pieces, normalizedCfrFps: fps, live: true, ...(partial ? { partial: true } : {}) },
    })
    ctx.log(`Storing ${asset.file} (${(bytes / 1024 / 1024).toFixed(1)} MB)`)
    await publishAsset(ctx, asset, out)
    ctx.progress(1)
    await copy.clear()
    return { asset }
  } catch (err) {
    if (!finished) (conform as Conform | null)?.kill()
    closing = true
    nudge()
    await (feeding as Promise<void> | null)?.catch(() => undefined)
    // Kept only for a job the app will hand out again: one taken back from this worker. A worker stopping (a deploy)
    // fails its jobs, a cancel ends one, any other end leaves it to the ordinary import: the copy goes.
    if (!(ctx.signal.aborted && (ctx.signal.reason as Error | undefined)?.message === TAKEN_BACK)) await copy.clear()
    throw err
  }
}

/** The local copies' folder under a work folder. */
export const localCopyDir = (workDir: string) => join(workDir, 'live')
