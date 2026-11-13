/**
 * A take uploaded while it was recorded, imported: the app hands its track over as pieces of any length (a link per
 * piece, no sha256 yet), the worker joins them in order and conforms the recording. With `conform.fit` a screen take
 * whose frames came 45 a second or fewer is made 30 fps, a faster one 60; a take brought back after a crash
 * (`partial`), cut off mid-piece, still becomes a recording of what arrived. The recordings are made-up clips made
 * with FFmpeg's test sources; the app is a stub that serves the pieces.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppClient } from '../src/app-client.ts'
import { x264Args } from '../src/assets.ts'
import { AssetCache } from '../src/cache.ts'
import { EditorAssetSchema } from '../src/engine.ts'
import { runImport } from '../src/jobs/import.ts'
import type { JobContext } from '../src/jobs/context.ts'
import { fitRate, probe, run } from '../src/media.ts'
import type { BlobRead, ImportInput } from '../../web/src/lib/studio/server/job-contract.ts'

test('a recording is conformed fast, at a quality set by its CRF', () => {
  assert.deepEqual(x264Args(), ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26'])
})

test('the rate a fitted recording is conformed to: from its frames’ times', () => {
  const at = (fps: number, seconds: number) => Array.from({ length: Math.round(fps * seconds) }, (_, i) => i / fps)
  assert.equal(fitRate(at(60, 3), 60), 60)
  assert.equal(fitRate(at(46, 3), 60), 60)
  assert.equal(fitRate(at(44, 3), 60), 30)
  assert.equal(fitRate(at(30, 3), 60), 30)
  assert.equal(fitRate(at(60, 3), 30), 30, 'never above the most')
  assert.equal(fitRate([0], 60), 60, 'too few frames to tell')
  assert.equal(fitRate(at(60, 0.2), 60), 60, 'too short to tell')
})

/** Cut a file into pieces of uneven lengths, as a recorder's seconds come out. */
function cut(bytes: Buffer, sizes: number[]): Buffer[] {
  const out: Buffer[] = []
  let at = 0
  for (let i = 0; at < bytes.length; i++) {
    const size = sizes[i % sizes.length]!
    out.push(bytes.subarray(at, at + size))
    at += size
  }
  return out
}

/** A stub app that answers blobs/read with a link per piece and serves the pieces. */
function pieceApp(key: string, pieces: Buffer[]) {
  const total = pieces.reduce((n, p) => n + p.length, 0)
  const read: BlobRead = { key, bytes: total, contentType: 'video/mp4', sha256: null, parts: pieces.map((p, index) => ({ index, bytes: p.length, url: `http://storage.test/piece/${index}` })) }
  return async (url: string): Promise<Response> => {
    if (url.endsWith('/api/internal/studio/blobs/read')) return Response.json(read)
    const match = /\/piece\/(\d+)$/.exec(url)
    if (match) return new Response(new Uint8Array(pieces[Number(match[1])]!))
    return new Response('no', { status: 404 })
  }
}

async function importPieces(dir: string, pieces: Buffer[], input: Partial<ImportInput> & { name: string }) {
  const scratch = join(dir, 'scratch')
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  const cache = new AssetCache(join(dir, 'cache'), 1024 ** 3)
  await cache.init()
  const key = 'live/5a5a5a5a-1111-4222-8333-999999999999/screen'
  const app = new AppClient({ appUrl: 'http://app.test', secret: 'test-secret', workerId: 'w', fetch: pieceApp(key, pieces), retry: { attempts: 1 } })
  const logs: string[] = []
  const client = {
    readBlob: (job: string, k: string, dest: string, opts: object) => app.readBlob(job, k, dest, opts),
    writeBlob: async () => ({ bytes: 0 }),
  }
  const ctx = {
    job: { id: '00000000-0000-4000-8000-000000000001', kind: 'import', workspaceId: 'ws', videoId: null, attempts: 1, input: { uploadKey: key, sourceCursorHidden: false, ...input } },
    config: {}, client, cache, renderer: {}, scratch, signal: new AbortController().signal, progress: () => undefined, log: (line: string) => logs.push(line),
  } as unknown as JobContext<'import'>
  const { asset } = await runImport(ctx)
  return { asset, logs, cached: cache.pathOf(asset.file) }
}

/** A screen take with irregular frame times: `rate` fps with every `drop`-th frame missing, as WebKit writes it (fragmented MP4). */
async function screenTake(path: string, rate: number, drop: number, seconds = 3): Promise<void> {
  await run('ffmpeg', [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=${rate}:duration=${seconds}`,
    '-vf', `select='not(eq(mod(n\\,${drop})\\,1))'`, '-fps_mode', 'vfr',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-y', path,
  ])
}

test('a take sent in pieces is joined in order and conformed; at 45 fps or fewer it is made 30 fps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-live-'))
  try {
    const source = join(dir, 'screen.mp4')
    // 60 fps with every third frame missing: 40 frames a second on average.
    await screenTake(source, 60, 3)
    const pieces = cut(await readFile(source), [7000, 13_001, 2500])
    assert.ok(pieces.length > 3, 'several pieces')
    const { asset, logs, cached } = await importPieces(dir, pieces, { name: 'Screen recording.mp4', conform: { fps: 60, fit: true }, durationHint: 3 })
    assert.equal(asset.sourceFps, 30)
    assert.equal(asset.provenance?.normalizedCfrFps, 30)
    assert.ok(Math.abs((asset.durationSeconds ?? 0) - 3) < 0.1, `duration ${asset.durationSeconds}`)
    assert.ok(logs.some((l) => /constant 30 fps/.test(l)), logs.join(' | '))
    assert.ok(EditorAssetSchema.safeParse(asset).success)
    // The pieces had no sha256; the joined file's is remembered as the original's.
    assert.match(String(asset.provenance?.rawSha256), /^[a-f0-9]{64}$/)
    assert.equal((await probe(cached)).streams.find((s) => s.codec_type === 'video')?.codec_name, 'h264')
    // As close to the take as the old setting kept it: PSNR against the take on the same frame grid.
    const { stderr } = await run('ffmpeg', ['-nostdin', '-i', cached, '-i', source, '-lavfi', '[1]fps=30,format=yuv420p[r];[0][r]psnr', '-f', 'null', '-'])
    const psnr = Number(/average:([0-9.]+)/.exec(stderr)?.[1])
    assert.ok(psnr > 45, `PSNR ${psnr}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a fitted take recorded faster than 45 fps stays 60 fps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-live-'))
  try {
    const source = join(dir, 'screen.mp4')
    // 60 fps with every tenth frame missing: 54 a second.
    await screenTake(source, 60, 10, 2)
    const { asset } = await importPieces(dir, cut(await readFile(source), [9000]), { name: 'Screen recording.mp4', conform: { fps: 60, fit: true } })
    assert.equal(asset.sourceFps, 60)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a take brought back after a crash, cut off mid-piece, becomes a recording of what arrived', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-live-'))
  try {
    // Chromium's take: VP8 in WebM, written as it was recorded (no duration, no index), cut off part way.
    const source = join(dir, 'screen.webm')
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M', '-f', 'webm', '-live', '1', '-y', source])
    const whole = await readFile(source)
    const arrived = whole.subarray(0, Math.floor(whole.length * 0.6) + 333)
    const { asset, logs } = await importPieces(dir, cut(arrived, [5000, 3000]), { name: 'Screen recording.webm', conform: { fps: 60, fit: true }, partial: true, durationHint: 4 })
    assert.equal(asset.kind, 'video')
    assert.equal(asset.sourceFps, 30)
    assert.ok((asset.durationSeconds ?? 0) > 1.5 && (asset.durationSeconds ?? 0) < 3.5, `duration ${asset.durationSeconds}`)
    assert.ok(logs.some((l) => /stopped before it was finished/.test(l)), logs.join(' | '))
    assert.ok(EditorAssetSchema.safeParse(asset).success)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
