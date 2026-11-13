/**
 * A take prepared while it records (src/jobs/live-import.ts), against a stub app that hands its pieces out as they
 * "arrive": the conformed file is byte for byte the one an import after Stop makes from the joined pieces (the same
 * conform, the same threads), for uneven pieces, for a take stopped early, for a piece listed before it is readable,
 * and for a job handed out again that picks up from its local copy. A take thrown away ends the job; a slot that is not
 * a live slot never takes such a job. Made-up clips from FFmpeg's test sources.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { conformArgs, conformVideo } from '../src/assets.ts'
import { AssetCache } from '../src/cache.ts'
import { EditorAssetSchema } from '../src/engine.ts'
import { liveLimits, LocalCopy, localCopyDir, prefixRate, runLiveImport, tidyLocalCopies, LOCAL_COPY_KEEP_MS } from '../src/jobs/live-import.ts'
import { runImport } from '../src/jobs/import.ts'
import { TAKEN_BACK } from '../src/runner.ts'
import type { JobContext } from '../src/jobs/context.ts'
import { fitRate, run, videoStamps } from '../src/media.ts'
import { kindsFor } from '../src/providers/capabilities.ts'
import type { LiveImportInput, LivePieces, StudioJobKind } from '../../web/src/lib/studio/server/job-contract.ts'

const THREADS = 2
const md5 = async (path: string) => createHash('md5').update(await readFile(path)).digest('hex')

/** Cut a file into pieces of uneven lengths. */
function cut(bytes: Buffer, sizes: number[]): Buffer[] {
  const out: Buffer[] = []
  for (let at = 0, i = 0; at < bytes.length; i++) {
    out.push(bytes.subarray(at, at + sizes[i % sizes.length]!))
    at += sizes[i % sizes.length]!
  }
  return out
}

type Arrival = { listed: number; sealed?: { count: number; complete: boolean }; state?: LivePieces['state']; quietMs?: number; then?: () => void | Promise<void> }

/**
 * A stub app: each `livePieces` call answers the next arrival (how many pieces are listed, sealed or not), the last one
 * for good; a check (a job resuming from its copy) is answered with the declared lengths and is not a round. A piece in
 * `unreadableOnce` fails its first download (listed before storage has it).
 */
function stubApp(pieces: Buffer[], arrivals: Arrival[], unreadableOnce = new Set<number>()) {
  let round = 0
  const asked: number[] = []
  const checks: number[] = []
  const failed = new Set<number>()
  return {
    asked,
    checks,
    client: {
      async livePieces(_job: string, after: number, check = false): Promise<LivePieces> {
        if (check) {
          checks.push(after)
          return { pieces: [], declared: pieces.length, lengths: pieces.slice(0, after).map((p) => p.length), sealed: null, state: 'recording', quietMs: 0 }
        }
        asked.push(after)
        const now = arrivals[Math.min(round++, arrivals.length - 1)]!
        await now.then?.()
        const indexes = Array.from({ length: Math.max(0, Math.min(now.listed, pieces.length) - after) }, (_, i) => after + i)
        return { pieces: indexes.map((index) => ({ index, bytes: pieces[index]!.length, url: `piece:${index}` })), declared: Math.min(now.listed, pieces.length), sealed: now.sealed ?? null, state: now.state ?? 'recording', quietMs: now.quietMs ?? 0 }
      },
      async downloadPiece(url: string, bytes: number): Promise<Buffer> {
        const index = Number(url.split(':')[1])
        if (unreadableOnce.has(index) && !failed.has(index)) {
          failed.add(index)
          throw new Error('not stored yet')
        }
        assert.equal(pieces[index]!.length, bytes)
        return pieces[index]!
      },
      async writeBlob() {
        return { bytes: 0 }
      },
    },
  }
}

async function liveJob(dir: string, app: ReturnType<typeof stubApp>, opts: { jobId?: string; fps?: 30 | 60; conform?: LiveImportInput['conform']; signal?: AbortSignal } = {}) {
  const scratch = join(dir, 'scratch')
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  const cache = new AssetCache(join(dir, 'cache'), 1024 ** 3)
  await cache.init()
  const logs: string[] = []
  const ctx = {
    job: { id: opts.jobId ?? '00000000-0000-4000-8000-0000000000aa', kind: 'live-import', workspaceId: 'ws', videoId: null, attempts: 1, input: { uploadKey: 'live/5a5a5a5a-1111-4222-8333-999999999999/screen', name: 'Screen recording.webm', conform: opts.conform ?? { fps: opts.fps ?? 60 }, sourceCursorHidden: false, provenance: { take: '5a5a5a5a-1111-4222-8333-999999999999', role: 'screen' } } },
    config: { workDir: join(dir, 'work'), liveThreads: THREADS },
    client: app.client,
    cache,
    renderer: {},
    scratch,
    signal: opts.signal ?? new AbortController().signal,
    progress: () => undefined,
    log: (line: string) => logs.push(line),
  } as unknown as JobContext<'live-import'>
  const { asset } = await runLiveImport(ctx)
  return { asset, logs, file: cache.pathOf(asset.file) }
}

/** What an import after Stop makes of the same bytes: the joined pieces conformed with the same arguments and threads. */
async function ordinary(dir: string, bytes: Buffer, fps: 30 | 60, name: string): Promise<string> {
  const joined = join(dir, name)
  await writeFile(joined, bytes)
  const out = join(dir, `${name}.conformed.mp4`)
  await conformVideo(joined, out, fps, { lenient: true, threads: THREADS })
  return out
}

/** A screen take: VFR H.264 in fragmented MP4 (as WebKit and Chromium record MP4), with sound. */
async function screenTake(path: string, seconds = 4): Promise<void> {
  await run('ffmpeg', [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=60:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=f=330:d=${seconds}`,
    '-vf', `select='not(eq(mod(n\\,5)\\,2))'`, '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '500000', '-y', path,
  ])
}

/** A camera take as Chromium writes WebM: VP8 and Opus, no duration, no index. */
async function webmTake(path: string, seconds = 4): Promise<void> {
  await run('ffmpeg', [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=f=440:d=${seconds}`,
    '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M', '-c:a', 'libopus', '-shortest', '-f', 'webm', '-live', '1', '-y', path,
  ])
}

test('only a live slot takes a live-import job', () => {
  const all = ['import', 'export', 'live-import', 'narration'] as StudioJobKind[]
  assert.deepEqual(kindsFor('live', all, new Set()), ['live-import'])
  assert.ok(!kindsFor('media', all, new Set()).includes('live-import'))
  assert.ok(!kindsFor('provider', all, new Set(['voiceover', 'generatedShots'])).includes('live-import'))
})

test('pieces arriving as the take records make the same file as the joined take conformed after Stop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-live-job-'))
  try {
    for (const [name, make, fps] of [['screen.mp4', screenTake, 60], ['camera.webm', webmTake, 30]] as const) {
      const source = join(dir, name)
      await make(source)
      const bytes = await readFile(source)
      const pieces = cut(bytes, [9000, 31_337, 4096, 77_777])
      assert.ok(pieces.length > 5, 'several uneven pieces')
      // Pieces come in a few at a time, piece 2 is listed before it can be read, then the track is sealed.
      const third = Math.floor(pieces.length / 3)
      const app = stubApp(pieces, [{ listed: 1 }, { listed: third }, { listed: third }, { listed: 2 * third }, { listed: pieces.length, sealed: { count: pieces.length, complete: true } }], new Set([2]))
      const { asset, file, logs } = await liveJob(dir, app, { fps })
      assert.equal(await md5(file), await md5(await ordinary(dir, bytes, fps, name)), `${name}: the same file`)
      assert.equal(asset.sourceFps, fps)
      assert.equal(asset.provenance?.live, true)
      assert.equal(asset.provenance?.rawBytes, bytes.length)
      assert.equal(asset.provenance?.rawSha256, createHash('sha256').update(bytes).digest('hex'))
      assert.ok(EditorAssetSchema.safeParse(asset).success)
      // Piece 2 failed its first read and was asked for again from there, never skipped.
      assert.ok(app.asked.includes(2), app.asked.join(','))
      assert.ok(logs.some((l) => /as it records/.test(l)))
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a take stopped early, cut off mid-piece, makes the same file as its joined pieces conformed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-live-job-'))
  try {
    const source = join(dir, 'screen.mp4')
    await screenTake(source, 5)
    const bytes = await readFile(source)
    // The window closed: what arrived ends part way into a fragment.
    const arrived = bytes.subarray(0, Math.floor(bytes.length * 0.55) + 123)
    const pieces = cut(arrived, [20_000, 13_000])
    const app = stubApp(pieces, [{ listed: 2 }, { listed: pieces.length, sealed: { count: pieces.length, complete: false } }])
    const { asset, file } = await liveJob(dir, app)
    assert.equal(await md5(file), await md5(await ordinary(dir, arrived, 60, 'arrived.mp4')))
    assert.equal(asset.provenance?.partial, true)
    assert.ok((asset.durationSeconds ?? 0) > 1 && (asset.durationSeconds ?? 0) < 4, `duration ${asset.durationSeconds}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a job handed out again picks up from its local copy, and downloads only what it lacks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-live-job-'))
  try {
    const source = join(dir, 'camera.webm')
    await webmTake(source)
    const bytes = await readFile(source)
    const pieces = cut(bytes, [15_000, 6_000])
    const jobId = '00000000-0000-4000-8000-0000000000bb'
    // The first attempt kept three pieces before its worker stopped.
    const copy = new LocalCopy(localCopyDir(join(dir, 'work')), jobId)
    await mkdir(localCopyDir(join(dir, 'work')), { recursive: true })
    for (const piece of pieces.slice(0, 3)) await copy.append(piece)
    // And a crash left some bytes past its last length: cut back.
    await writeFile(copy.data, Buffer.concat([...pieces.slice(0, 3), Buffer.from('half a piece')]))
    const app = stubApp(pieces, [{ listed: pieces.length, sealed: { count: pieces.length, complete: true } }])
    const { file, logs } = await liveJob(dir, app, { jobId, fps: 30 })
    assert.deepEqual(app.checks, [3], 'the copy checked against the declared lengths first')
    assert.equal(app.asked[0], 3, 'asks from the first piece it lacks')
    assert.ok(logs.some((l) => /3 pieces already here/.test(l)))
    assert.equal(await md5(file), await md5(await ordinary(dir, bytes, 30, 'camera.webm')))
    // Done: the local copy is gone.
    assert.deepEqual(await copy.pieces(), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a take thrown away ends the job, and its local copy goes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-live-job-'))
  try {
    const source = join(dir, 'camera.webm')
    await webmTake(source, 2)
    const pieces = cut(await readFile(source), [20_000])
    const app = stubApp(pieces, [{ listed: 1 }, { listed: 1, state: 'dropped' }])
    await assert.rejects(liveJob(dir, app, { fps: 30 }), /thrown away/)
    assert.deepEqual(await new LocalCopy(localCopyDir(join(dir, 'work')), '00000000-0000-4000-8000-0000000000aa').pieces(), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a take quiet past the limit and not sealed ends the job (it is prepared when brought back)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-live-job-'))
  try {
    const source = join(dir, 'camera.webm')
    await webmTake(source, 2)
    const pieces = cut(await readFile(source), [20_000])
    const app = stubApp(pieces, [{ listed: 1 }, { listed: 1, quietMs: 16 * 60_000 }])
    await assert.rejects(liveJob(dir, app, { fps: 30 }), /brought back/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('live slots are off unless set, and only when the worker takes live-import', async () => {
  const { loadConfig } = await import('../src/config.ts')
  const base = { NODE_ENV: 'development' }
  const off = loadConfig(base) as { liveSlots: number; liveThreads: number }
  assert.equal(off.liveSlots, 0)
  assert.equal(off.liveThreads, 2)
  assert.equal((loadConfig({ ...base, STUDIO_LIVE_SLOTS: '2', STUDIO_LIVE_THREADS: '3' }) as { liveSlots: number; liveThreads: number }).liveSlots, 2)
  assert.equal((loadConfig({ ...base, STUDIO_LIVE_SLOTS: '2', STUDIO_WORKER_KINDS: 'import,export' }) as { liveSlots: number }).liveSlots, 0)
})

// ---- the review's cases ------------------------------------------------------------------------------------------

/** Tests poll fast; each restores what it changed. */
async function withLimits<T>(limits: Partial<typeof liveLimits>, body: () => Promise<T>): Promise<T> {
  const before = { ...liveLimits }
  Object.assign(liveLimits, { pollMs: 5 }, limits)
  try {
    return await body()
  } finally {
    Object.assign(liveLimits, before)
  }
}

/** A seeded random number from 0 to 1 (the same take every run). */
function seeded(seed: number): () => number {
  let x = seed
  return () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
}

/**
 * A screen take as Chromium writes one: VP8 in WebM at a varying rate, every frame's time jittered (not on any grid)
 * and frames missing at random, with sound. `rates`: seconds at a rate, in order (60: a frame every 1/60 s give or take).
 */
async function jitteryScreen(dir: string, path: string, rates: [seconds: number, fps: 30 | 60][], seed = 7): Promise<void> {
  const random = seeded(seed)
  const lines: string[] = []
  let t = 0
  let n = 0
  for (const [seconds, fps] of rates) {
    const end = t + seconds
    while (t < end) {
      // Missing at random (about one in six), and off the grid by up to a third of a frame.
      if (random() > 0.16) lines.push(`${n}:${(t + (random() - 0.5) * (0.66 / fps)).toFixed(4)}`)
      t += 1 / fps
      n++
    }
  }
  // Frame n of the source shows at its own time: keep the chosen frames and stamp them.
  const times = lines.map((l) => l.split(':') as [string, string])
  const total = rates.reduce((a, [s]) => a + s, 0)
  const keep = join(dir, 'keep.txt')
  await writeFile(keep, times.map(([, at]) => `${at}`).join('\n'))
  const select = times.map(([i]) => `eq(n\\,${i})`).join('+')
  // Too long a select for one argument: write the filter to a script.
  const script = join(dir, 'filter.txt')
  const stamps = times.map(([, at]) => at)
  await writeFile(script, `[0:v]select='${select}',setpts='(${stamps.map((at, k) => `eq(N\\,${k})*${at}`).join('+')})/TB'[v]`)
  await run('ffmpeg', [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=60:duration=${total}`, '-f', 'lavfi', '-i', `sine=f=330:d=${total}`,
    '-filter_complex_script', script, '-map', '[v]', '-map', '1:a', '-fps_mode', 'vfr',
    '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M', '-c:a', 'libopus', '-f', 'webm', '-live', '1', '-y', path,
  ], { timeout: 300_000 })
}

/** What an ordinary import (src/jobs/import.ts, as it runs after Stop) makes of a joined take. */
async function ordinaryImport(dir: string, source: string, conform: LiveImportInput['conform']) {
  const scratch = join(dir, 'import-scratch')
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  const cache = new AssetCache(join(dir, 'import-cache'), 1024 ** 3)
  await cache.init()
  const ctx = {
    job: { id: '00000000-0000-4000-8000-0000000000cc', kind: 'import', workspaceId: 'ws', videoId: null, attempts: 1, input: { uploadKey: 'uploads/5a5a5a5a-1111-4222-8333-999999999999', name: 'Screen recording.webm', conform, sourceCursorHidden: false } },
    config: { workDir: join(dir, 'import-work') },
    client: {
      async readBlob(_job: string, _key: string, dest: string) {
        await copyFile(source, dest)
        return { bytes: (await stat(dest)).size, sha256: createHash('sha256').update(await readFile(dest)).digest('hex') }
      },
      async writeBlob() {
        return { bytes: 0 }
      },
    },
    cache,
    renderer: {},
    scratch,
    signal: new AbortController().signal,
    progress: () => undefined,
    log: () => undefined,
  } as unknown as JobContext<'import'>
  const { asset } = await runImport(ctx)
  return { asset, file: cache.pathOf(asset.file) }
}

/** What matters of a conformed file: its rate, frames, length, and the sound's length. */
async function measure(file: string) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,avg_frame_rate,nb_read_frames,duration', '-of', 'json', file])
  const streams = (JSON.parse(stdout) as { streams: { codec_type: string; avg_frame_rate: string; nb_read_frames?: string; duration?: string }[] }).streams
  const video = streams.find((x) => x.codec_type === 'video')!
  const audio = streams.find((x) => x.codec_type === 'audio')
  const [a, b] = video.avg_frame_rate.split('/').map(Number)
  return { fps: a! / b!, frames: Number(video.nb_read_frames), seconds: Number(video.duration), audioSeconds: Number(audio?.duration ?? 0) }
}

async function psnr(a: string, b: string): Promise<number> {
  const { stderr } = await run('ffmpeg', ['-nostdin', '-i', a, '-i', b, '-lavfi', '[0:v][1:v]psnr', '-f', 'null', '-'], { maxBuffer: 16 * 1024 * 1024 })
  const average = /PSNR .*average:([0-9.]+|inf)/.exec(stderr)?.[1]
  return average === 'inf' ? Infinity : Number(average)
}

test('the conform runs on the threads asked: decoder, filters and encoder', () => {
  const args = conformArgs('pipe:0', 'out.mp4', 60, { lenient: true, threads: 3 })
  const input = args.indexOf('-i')
  assert.deepEqual(args.slice(input - 4, input), ['-filter_threads', '3', '-threads', '3'], 'decoder and filter threads before the input')
  assert.equal(args[args.indexOf('-threads', input) + 1], '3', 'encoder threads after it')
  assert.ok(!conformArgs('in.webm', 'out.mp4', 30).includes('-threads'), 'none asked: FFmpeg picks')
})

test('the screen rate is decided from the frames that came, as the import decides it, and only once clear', () => {
  const random = seeded(3)
  const at = (fps: number, seconds: number, from = 0) => Array.from({ length: Math.round(fps * seconds) }, (_, i) => from + i / fps + (random() - 0.5) * (0.5 / fps)).sort((a, b) => a - b)
  // A clear 60 or a clear 30, once enough moved: the import's own answer.
  assert.equal(prefixRate(at(60, 2), 60, 60, false), 60)
  assert.equal(prefixRate(at(30, 3), 60, 60, false), 30)
  // Too little moved yet: wait.
  assert.equal(prefixRate(at(60, 0.5), 60, 60, false), null)
  // A still screen (a frame now and then): wait, until the seal says that is all there is (then fitRate's 30).
  const still = Array.from({ length: 40 }, (_, i) => i * 0.5)
  assert.equal(prefixRate(still, 60, 60, false), null)
  assert.equal(prefixRate(still, 60, 60, true), fitRate(still, 60, 60))
  // Near the line (about 45 a second): wait for more, unless a great deal has moved.
  const near = Array.from({ length: 200 }, (_, i) => i / 45)
  assert.equal(prefixRate(near, 60, 60, false), null)
  assert.equal(prefixRate(Array.from({ length: 2000 }, (_, i) => i / 45), 60, 60, false), fitRate(Array.from({ length: 2000 }, (_, i) => i / 45), 60, 60))
  // A recorder that asked for 30 (or a camera, at most 30): 30 at once.
  assert.equal(prefixRate([], 60, 30, false), 30)
  assert.equal(prefixRate([], 30, undefined, false), 30)
})

test('a jittery take through both real paths: the same rate, frames, length, picture and sound', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-live-job-'))
  try {
    const source = join(dir, 'screen.webm')
    // Scrolling at 60 throughout, with frames missing at random and every time off the grid.
    await jitteryScreen(dir, source, [[6, 60]])
    const bytes = await readFile(source)
    const stamps = await videoStamps(source)
    assert.ok(stamps.some((t, i) => i && Math.abs(t - stamps[i - 1]! - 1 / 60) > 0.002), 'the frame times are not on a grid')
    const pieces = cut(bytes, [70_000, 23_456, 51_000])
    const third = Math.floor(pieces.length / 3)
    const conform = { fps: 60 as const, fit: true, ceiling: 60 }
    const live = await withLimits({ rateEveryMs: 0 }, () => liveJob(dir, stubApp(pieces, [{ listed: third }, { listed: 2 * third }, { listed: pieces.length, sealed: { count: pieces.length, complete: true } }]), { conform }))
    const ordinary = await ordinaryImport(dir, source, conform)
    assert.ok(live.logs.some((l) => /can be told/.test(l)) && live.logs.some((l) => /60 fps/.test(l)), live.logs.join(' / '))
    const [a, b] = [await measure(live.file), await measure(ordinary.file)]
    assert.equal(a.fps, 60)
    assert.equal(a.fps, b.fps, 'the same rate')
    assert.equal(a.frames, b.frames, 'the same frames')
    assert.ok(Math.abs(a.seconds - b.seconds) <= 1 / 60 + 1e-6, `the same length: ${a.seconds} and ${b.seconds}`)
    assert.ok(Math.abs(a.audioSeconds - b.audioSeconds) < 0.03, `the same sound: ${a.audioSeconds} and ${b.audioSeconds}`)
    const db = await psnr(live.file, ordinary.file)
    assert.ok(db > 45, `the same picture: ${db} dB`)
    assert.equal(live.asset.sourceFps, ordinary.asset.sourceFps)
    assert.equal(live.asset.sourceFrames, ordinary.asset.sourceFrames)
    assert.equal(live.asset.provenance?.rawSha256, ordinary.asset.provenance?.rawSha256)
    assert.equal(live.asset.provenance?.rawBytes, bytes.length)
    assert.equal(live.asset.provenance?.rawPieces, pieces.length)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a recorder that reported 60 for a take that moved at 30 is conformed at 30, as the import would', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-live-job-'))
  try {
    const source = join(dir, 'screen.webm')
    await jitteryScreen(dir, source, [[5, 30]], 11)
    const pieces = cut(await readFile(source), [40_000])
    const conform = { fps: 60 as const, fit: true, ceiling: 60 }
    const live = await withLimits({ rateEveryMs: 0 }, () => liveJob(dir, stubApp(pieces, [{ listed: 2 }, { listed: pieces.length, sealed: { count: pieces.length, complete: true } }]), { conform }))
    const ordinary = await ordinaryImport(dir, source, conform)
    assert.equal(live.asset.sourceFps, 30)
    assert.equal(ordinary.asset.sourceFps, 30)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a rate decided early that the whole take disagrees with fails the job, so the import decides', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-live-job-'))
  try {
    const source = join(dir, 'screen.webm')
    // Three seconds of scrolling at 60, then twenty of a video playing at 30: the whole take's moving frames are mostly 30.
    await jitteryScreen(dir, source, [[3, 60], [20, 30]], 5)
    const bytes = await readFile(source)
    const conform = { fps: 60 as const, fit: true, ceiling: 60 }
    assert.equal(fitRate(await videoStamps(source), 60, 60), 30, 'the import conforms it at 30')
    const pieces = cut(bytes, [60_000])
    // The first round brings the first seconds only.
    const early = Math.max(2, Math.floor(pieces.length * 0.12))
    await withLimits({ rateEveryMs: 0 }, async () => {
      await assert.rejects(liveJob(dir, stubApp(pieces, [{ listed: early }, { listed: pieces.length, sealed: { count: pieces.length, complete: true } }]), { conform }), /frame rate \(30 fps\) is not the one it was prepared at while it recorded \(60\)/)
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('damage in the middle of a take sealed whole fails the job; the same take cut short is read past', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-live-job-'))
  try {
    const source = join(dir, 'camera.webm')
    await webmTake(source, 6)
    const bytes = Buffer.from(await readFile(source))
    bytes.fill(0xa5, Math.floor(bytes.length / 2), Math.floor(bytes.length / 2) + 3000)
    const pieces = cut(bytes, [50_000])
    await withLimits({}, async () => {
      await assert.rejects(liveJob(dir, stubApp(pieces, [{ listed: pieces.length, sealed: { count: pieces.length, complete: true } }]), { fps: 30 }), /could not be read while it recorded/)
      const partial = await liveJob(dir, stubApp(pieces, [{ listed: pieces.length, sealed: { count: pieces.length, complete: false } }]), { fps: 30 })
      assert.equal(partial.asset.provenance?.partial, true)
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a torn last line in the local copy is not a piece, and the copy picks up from the whole ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-live-job-'))
  try {
    const source = join(dir, 'camera.webm')
    await webmTake(source)
    const bytes = await readFile(source)
    const pieces = cut(bytes, [15_000, 6_000])
    const jobId = '00000000-0000-4000-8000-0000000000dd'
    const work = localCopyDir(join(dir, 'work'))
    await mkdir(work, { recursive: true })
    const copy = new LocalCopy(work, jobId)
    // Three pieces' bytes went down, and the crash came part way through writing the third length.
    await writeFile(copy.data, Buffer.concat(pieces.slice(0, 3)))
    await writeFile(copy.index, `${pieces[0]!.length}\n${pieces[1]!.length}\n${String(pieces[2]!.length).slice(0, 2)}`)
    assert.deepEqual(await copy.pieces(), [pieces[0]!.length, pieces[1]!.length])
    assert.equal(await readFile(copy.index, 'utf8'), `${pieces[0]!.length}\n${pieces[1]!.length}\n`, 'the index cut back to whole lines')
    const app = stubApp(pieces, [{ listed: pieces.length, sealed: { count: pieces.length, complete: true } }])
    const { file } = await withLimits({}, () => liveJob(dir, app, { jobId, fps: 30 }))
    assert.equal(app.asked[0], 2)
    assert.equal(await md5(file), await md5(await ordinary(dir, bytes, 30, 'camera.webm')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a local copy whose pieces are not the declared ones is dropped, and the job starts over', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-live-job-'))
  try {
    const source = join(dir, 'camera.webm')
    await webmTake(source)
    const bytes = await readFile(source)
    const pieces = cut(bytes, [15_000, 6_000])
    const jobId = '00000000-0000-4000-8000-0000000000ee'
    const work = localCopyDir(join(dir, 'work'))
    await mkdir(work, { recursive: true })
    const copy = new LocalCopy(work, jobId)
    // Left by another attempt, cut differently.
    for (const piece of cut(bytes, [10_000]).slice(0, 3)) await copy.append(piece)
    const app = stubApp(pieces, [{ listed: pieces.length, sealed: { count: pieces.length, complete: true } }])
    const { file, logs } = await withLimits({}, () => liveJob(dir, app, { jobId, fps: 30 }))
    assert.ok(logs.some((l) => /starting over/.test(l)), logs.join(' / '))
    assert.equal(app.asked[0], 0)
    assert.equal(await md5(file), await md5(await ordinary(dir, bytes, 30, 'camera.webm')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('FFmpeg dying mid-take fails the job at once, not at the next limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-live-job-'))
  try {
    const source = join(dir, 'camera.webm')
    await webmTake(source, 6)
    const pieces = cut(await readFile(source), [30_000])
    const jobId = '00000000-0000-4000-8000-0000000000f1'
    // The take goes on recording (never sealed); after a few rounds this job's FFmpeg is killed.
    let round = 0
    const kill = async () => {
      if (++round === 3) await run('pkill', ['-9', '-f', join(dir, 'scratch', 'conformed.mp4')]).catch(() => undefined)
    }
    const app = stubApp(pieces, [{ listed: 2, then: kill }, { listed: 3, then: kill }, { listed: 3, then: kill }, { listed: 3, then: kill }])
    const began = Date.now()
    await withLimits({ quietMs: 60_000, pollMs: 20 }, async () => {
      await assert.rejects(liveJob(dir, app, { jobId, fps: 30 }), /could not be prepared while it recorded/)
    })
    assert.ok(Date.now() - began < 10_000, `failed after ${Date.now() - began} ms`)
    assert.deepEqual(await new LocalCopy(localCopyDir(join(dir, 'work')), jobId).pieces(), [], 'its copy goes')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the copy is kept only for a job taken back; a worker stopping (SIGTERM) or a cancel clears it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-live-job-'))
  try {
    const source = join(dir, 'camera.webm')
    await webmTake(source, 4)
    const pieces = cut(await readFile(source), [30_000])
    const reasons = {
      'taken back': TAKEN_BACK,
      'the worker stopping': 'The studio worker was stopped (a restart or a deploy) before this job finished; try again.',
      'a cancel': 'Cancelled',
    }
    for (const [what, reason] of Object.entries(reasons)) {
      const jobId = `00000000-0000-4000-8000-00000000${String(Object.keys(reasons).indexOf(what)).padStart(4, '0')}`
      const stop = new AbortController()
      const app = stubApp(pieces, [{ listed: 2 }, { listed: 2, then: () => stop.abort(new Error(reason)) }, { listed: 2 }])
      await withLimits({ pollMs: 20 }, () => assert.rejects(liveJob(dir, app, { jobId, fps: 30, signal: stop.signal })))
      const left = await new LocalCopy(localCopyDir(join(dir, 'work')), jobId).pieces()
      assert.equal(left.length, what === 'taken back' ? 2 : 0, `${what}: ${left.length} pieces kept`)
    }
    // Copies left a day are tidied (at worker start, and when a live job starts).
    const work = localCopyDir(join(dir, 'work'))
    const old = new LocalCopy(work, '00000000-0000-4000-8000-000000000000')
    const day = new Date(Date.now() - LOCAL_COPY_KEEP_MS - 60_000)
    await utimes(old.data, day, day)
    await utimes(old.index, day, day)
    await tidyLocalCopies(work)
    assert.deepEqual(await old.pieces(), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a live job ends at its wall-clock ceiling, when the take goes quiet, and when FFmpeg does not finish in time', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-live-job-'))
  try {
    const source = join(dir, 'camera.webm')
    await webmTake(source, 3)
    const pieces = cut(await readFile(source), [30_000])
    // Still recording, pieces trickling: past the ceiling it ends.
    await withLimits({ maxMs: 150, pollMs: 20 }, () => assert.rejects(liveJob(dir, stubApp(pieces, [{ listed: 1 }, { listed: 1 }]), { fps: 30 }), /ran longer/))
    // No new piece for the quiet limit (the recorder cuts one every 4 s): it ends.
    await withLimits({ quietMs: 100, pollMs: 20 }, () => assert.rejects(liveJob(dir, stubApp(pieces, [{ listed: 1 }, { listed: 1 }]), { fps: 30 }), /brought back/))
    // FFmpeg not done in time after its input closed: killed, and the job ends.
    await withLimits({ endMs: 1 }, () => assert.rejects(liveJob(dir, stubApp(pieces, [{ listed: pieces.length, sealed: { count: pieces.length, complete: true } }]), { fps: 30 }), /too long to finish/))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

