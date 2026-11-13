/**
 * live-import: a video track of a take prepared while it records. The app queues one per video track when the take
 * starts (web/src/lib/studio/server/live-takes.ts followLive); only a live slot takes it (STUDIO_LIVE_SLOTS).
 *
 * The job asks the app for the track's pieces as they arrive (live/pieces: only its own track, only pieces surely
 * stored), downloads each in order, keeps it in a local copy, and pipes it into ONE FFmpeg that conforms with the
 * very arguments an import after Stop uses (assets.ts conformArgs, the rate fixed at the start). Fed the same bytes,
 * FFmpeg writes the same file from a pipe as from the joined file (test/live-import-job.test.ts proves it, also for
 * uneven pieces and a take stopped early). It runs under a lower priority with STUDIO_LIVE_THREADS encoder threads,
 * so an export beside it still gets the CPU.
 *
 *   - The screen's rate is the import's own rule (`conform.fit`, media.ts fitRate): until enough of the picture has
 *     moved to tell (prefixRate), pieces are only kept; then FFmpeg starts and is fed them from the copy. After the
 *     seal the rule runs again on the whole take, as the import would: when the two disagree the job fails and the
 *     ordinary import takes over (never a wrong rate, at worst the time live would have saved).
 *   - A recorder that is quiet costs nothing: FFmpeg waits on its input, the job asks every `pollMs`.
 *   - A piece listed but not readable yet is asked for again on the next round, never skipped.
 *   - The track sealed (Stop, or the take brought back after a crash): the last pieces are fed, the input closed,
 *     and the rest is an import's: measured, its start and end decoded, stored as a library asset. A take sealed
 *     complete that FFmpeg reported damage in fails, so the strict ordinary import decides (a take cut short is read
 *     leniently by both).
 *   - Ends early, so the ordinary import takes over: the take thrown away (the app also cancels the job); no new piece
 *     for `quietMs` (the recorder cuts one every 4 s); running past `maxMs` (the longest take the Studio reads is two
 *     hours); FFmpeg ending before its input did; FFmpeg not done `endMs` after its input closed.
 *   - Handed out again (taken back from this worker): it starts over from piece 0, from the local copy this worker
 *     kept (STUDIO_WORK_DIR/live, outside the job's scratch), once the app has confirmed the copy's pieces are the
 *     ones declared. Any other end clears the copy: a worker stopping fails its jobs, so they are not handed out
 *     again. Copies left behind are removed after LOCAL_COPY_KEEP_MS, at worker start and when a live job starts.
 *   - The live path always re-encodes; an import after Stop keeps an MP4 already on the frame grid byte for byte.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { buildAsset, conformArgs, inspectFile, publishAsset, verifyDecodes } from '../assets.ts'
import { fileSha256 } from '../app-client.ts'
import { sleep } from '../backoff.ts'
import { fenceInputs, fitRate, MOVING_GAP, videoStamps } from '../media.ts'
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
  /** The most FFmpeg may take after its input closed (the backlog of a job that fell behind, then the file's end). */
  endMs: 15 * 60_000,
  /** A piece listed by the app but unreadable this many rounds in a row ends the job. */
  unreadableRounds: 40,
  /** While the rate is not decided, the copy is measured again at most this often. */
  rateEveryMs: 5_000,
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

/** One FFmpeg conforming from its standard input, at a lower priority. */
function startConform(out: string, fps: 30 | 60, threads: number, signal: AbortSignal) {
  const args = fenceInputs('ffmpeg', conformArgs('pipe:0', out, fps, { lenient: true, threads }))
  const proc = spawn('nice', ['-n', '10', 'ffmpeg', ...args], { stdio: ['pipe', 'ignore', 'pipe'], signal })
  let stderr = ''
  // At `-v error` every line FFmpeg writes is an error it read past (`-err_detect ignore_err`).
  let errors = 0
  proc.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    errors += text.split('\n').filter((line) => line.trim()).length
    stderr = (stderr + text).slice(-4000)
  })
  // An input closed by FFmpeg (it failed) must not throw from a write: its exit says why.
  proc.stdin.on('error', () => undefined)
  let code: number | null | undefined
  const exited = new Promise<number | null>((resolve) => {
    proc.on('close', (c) => resolve((code = c)))
    proc.on('error', () => resolve((code = -1)))
  })
  const tail = () => stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 500)
  const failed = () => new JobError(`The recording could not be prepared while it recorded${tail() ? `: ${tail()}` : ''}`)
  return {
    /** FFmpeg's error lines so far. */
    get errors() {
      return errors
    },
    /** Throws when FFmpeg ended before its input did (it died, or gave up on the bytes). */
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

/** Feed a file into the conform, in order, chunk by chunk. */
async function feedFile(path: string, total: number, feed: (bytes: Buffer) => Promise<void>, signal: AbortSignal): Promise<void> {
  if (!total) return
  for await (const chunk of createReadStream(path, { start: 0, end: total - 1, highWaterMark: 1024 * 1024 })) {
    checkAborted(signal)
    await feed(chunk as Buffer)
  }
}

/** The frame times of what the copy holds so far; none when it cannot be read yet (too little of it, say). */
async function stampsOf(path: string, signal: AbortSignal): Promise<number[]> {
  try {
    return await videoStamps(path, signal)
  } catch {
    checkAborted(signal)
    return []
  }
}

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
  let fed = 0
  let rawBytes = 0
  let finished = false
  let lastPieceAt = Date.now()
  let measuredAt = 0
  const start = async (rate: 30 | 60) => {
    fps = rate
    conform = startConform(out, rate, ctx.config.liveThreads, ctx.signal)
    ctx.log(`Preparing the recording as it records, at a constant ${rate} fps (H.264/AAC)`)
    // What the copy holds so far goes in first.
    await feedFile(copy.data, rawBytes, (bytes) => conform!.feed(bytes), ctx.signal)
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
        await feedFile(copy.data, rawBytes, async (bytes) => void hash.update(bytes), ctx.signal)
        fed = held.length
      }
    }
    if (fps) await start(fps)
    else ctx.log('Keeping the recording as it records until its frame rate can be told')
    let unreadable = 0
    let partial = false
    for (;;) {
      checkAborted(ctx.signal)
      ;(conform as Conform | null)?.check()
      if (Date.now() - startedAt > liveLimits.maxMs) throw new JobError('The recording ran longer than a take prepared while it records may; it is prepared the ordinary way.')
      const answer = await ctx.client.livePieces(ctx.job.id, fed)
      if (answer.state === 'dropped') throw new JobError('The recording was thrown away.')
      let got = 0
      for (const piece of answer.pieces) {
        if (piece.index !== fed) break
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
        if (conform) await (conform as Conform).feed(bytes)
        rawBytes += bytes.length
        fed++
        got++
      }
      const sealed = answer.sealed
      const all = !!sealed && fed >= sealed.count
      if (all && fed > sealed!.count) throw new JobError('The recording was saved shorter than what was prepared; it is prepared again from what was saved.')
      // Not decided yet: the copy is measured as it grows (every rateEveryMs at most), and at the seal whatever it holds.
      if (!fps && rawBytes && (all || (got && Date.now() - measuredAt >= liveLimits.rateEveryMs))) {
        measuredAt = Date.now()
        const rate = prefixRate(await stampsOf(copy.data, ctx.signal), most, ceiling, all)
        if (rate) {
          decidedEarly = !all
          await start(rate)
        }
      }
      if (all) {
        partial = !sealed!.complete
        break
      }
      if (got) {
        unreadable = 0
        lastPieceAt = Date.now()
        // The share of the declared pieces conformed: what the app weighs at Stop (recordings.ts LIVE_REUSE_SHARE).
        ctx.progress(conform && answer.declared ? Math.min(0.9, fed / answer.declared) : 0)
        continue
      }
      if (answer.pieces.length && ++unreadable >= liveLimits.unreadableRounds) throw new JobError('A piece of the recording could not be read; it is prepared the ordinary way.')
      if (!sealed && Math.max(Date.now() - lastPieceAt, answer.quietMs) > liveLimits.quietMs) throw new JobError('The recording stopped before it was finished; it is prepared when it is brought back.')
      await sleep(liveLimits.pollMs, ctx.signal)
    }
    if (!fps || !conform) throw new JobError('The recording has no picture.')
    const running = conform as Conform
    // The rate judged before the seal is checked on the whole take, as the import would judge it, while FFmpeg ends.
    const [, whole] = await Promise.all([
      running.end(liveLimits.endMs),
      decidedEarly ? stampsOf(copy.data, ctx.signal).then((stamps) => fitRate(stamps, most, ceiling)) : Promise.resolve(fps),
    ])
    finished = true
    if (whole !== fps) throw new JobError(`The recording's frame rate (${whole} fps) is not the one it was prepared at while it recorded (${fps}); it is prepared the ordinary way.`)
    // A take sealed whole is read strictly by the ordinary import: damage FFmpeg read past here is its to decide.
    if (!partial && running.errors) throw new JobError('Part of the recording could not be read while it recorded; it is prepared the ordinary way.')
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
      provenance: { ...(input.provenance ?? {}), rawSha256: hash.digest('hex'), rawBytes, rawPieces: fed, normalizedCfrFps: fps, live: true, ...(partial ? { partial: true } : {}) },
    })
    ctx.log(`Storing ${asset.file} (${(bytes / 1024 / 1024).toFixed(1)} MB)`)
    await publishAsset(ctx, asset, out)
    ctx.progress(1)
    await copy.clear()
    return { asset }
  } catch (err) {
    if (!finished) (conform as Conform | null)?.kill()
    // Kept only for a job the app will hand out again: one taken back from this worker. A worker stopping (a deploy)
    // fails its jobs, a cancel ends one, any other end leaves it to the ordinary import: the copy goes.
    if (!(ctx.signal.aborted && (ctx.signal.reason as Error | undefined)?.message === TAKEN_BACK)) await copy.clear()
    throw err
  }
}

/** The local copies' folder under a work folder. */
export const localCopyDir = (workDir: string) => join(workDir, 'live')
