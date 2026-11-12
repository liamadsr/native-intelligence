/**
 * The import job on real files. A plain video whose frame rate varies (a phone
 * video, a screen recording) is conformed to a constant 30 or 60 fps and the log
 * says so, where it used to be refused. A microphone take with no picture
 * becomes an audio asset whatever its name says: a browser's audio-only WebM (Opus, written as it was recorded, so it
 * does not say how long it is) and an audio-only MP4 (AAC) are both stored as
 * AAC in .m4a, measured, given a waveform, and valid for the engine. The test
 * files are made with FFmpeg's lavfi (a two-second tone); the import job runs
 * against a stub of the app that hands it the file and keeps what it stores.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aacCopyable, missingDuration } from '../src/assets.ts'
import { fileSha256 } from '../src/app-client.ts'
import { AssetCache } from '../src/cache.ts'
import { EditorAssetSchema } from '../src/engine.ts'
import { runImport } from '../src/jobs/import.ts'
import type { JobContext } from '../src/jobs/context.ts'
import { audioOnly, conformRate, pictureStream, probe, run, runBuffer, TIMING_REFUSALS, VARIABLE_RATE, type Probe } from '../src/media.ts'
import type { ImportInput } from '../../web/src/lib/studio/server/job-contract.ts'

const tone = ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2']

/** A browser's microphone take: Opus in WebM, streamed out (no duration, no index). */
async function browserWebm(path: string): Promise<void> {
  await writeFile(path, await runBuffer('ffmpeg', [...tone, '-c:a', 'libopus', '-f', 'webm', 'pipe:1']))
}

/** Safari's microphone take: AAC in MP4. */
async function aacMp4(path: string): Promise<void> {
  await run('ffmpeg', [...tone, '-c:a', 'aac', '-y', '-f', 'mp4', path])
}

/** A variable-rate H.264 MP4: `rate` fps for its first second, then `slower` fps for `rate` more frames. */
async function vfrMp4(path: string, rate: number, slower: number): Promise<void> {
  await run('ffmpeg', [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=${rate}:duration=2`,
    '-vf', `setpts='(if(lt(N,${rate}),N/${rate},1+(N-${rate})/${slower}))/TB'`, '-fps_mode', 'vfr',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-y', path,
  ])
}

/** Run the import job on a local file as if it had been uploaded under `name`. */
async function importFile(dir: string, source: string, input: Partial<ImportInput> & { name: string }) {
  const scratch = join(dir, 'scratch')
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  const cache = new AssetCache(join(dir, 'cache'), 1024 ** 3)
  await cache.init()
  const stored: { key: string; contentType: string; bytes: number }[] = []
  const logs: string[] = []
  const client = {
    readBlob: async (_job: string, _key: string, dest: string) => {
      await copyFile(source, dest)
      return { bytes: (await stat(dest)).size, sha256: await fileSha256(dest), contentType: 'application/octet-stream' }
    },
    writeBlob: async (_job: string, key: string, file: string, contentType: string) => {
      const bytes = (await stat(file)).size
      stored.push({ key, contentType, bytes })
      return { bytes }
    },
  }
  const ctx = {
    job: { id: 'job-1', kind: 'import', workspaceId: 'ws', videoId: null, attempts: 1, input: { uploadKey: 'uploads/u-1', ...input } },
    config: {},
    client,
    cache,
    renderer: {},
    scratch,
    signal: new AbortController().signal,
    progress: () => undefined,
    log: (line: string) => logs.push(line),
  } as unknown as JobContext<'import'>
  const { asset } = await runImport(ctx)
  return { asset, stored, logs, cached: cache.pathOf(asset.file) }
}

test('a container with sound and no picture is audio; cover art is not a picture', () => {
  const opus: Probe = { streams: [{ codec_type: 'audio', codec_name: 'opus' }], format: {} }
  assert.ok(audioOnly(opus))
  assert.ok(missingDuration(opus), 'a streamed WebM says nothing of its duration')
  const covered: Probe = { streams: [{ codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } }, { codec_type: 'audio', codec_name: 'aac' }], format: { duration: '2' } }
  assert.equal(pictureStream(covered), undefined)
  assert.ok(audioOnly(covered))
  const film: Probe = { streams: [{ codec_type: 'video', codec_name: 'vp9' }, { codec_type: 'audio', codec_name: 'opus' }], format: {} }
  assert.ok(!audioOnly(film))
  assert.ok(!audioOnly({ streams: [], format: {} }), 'no sound either: not audio')
  assert.ok(aacCopyable({ streams: [{ codec_type: 'audio', codec_name: 'aac' }], format: {} }, 'mp4'))
  assert.ok(!aacCopyable(opus, 'webm'))
  assert.ok(!aacCopyable({ streams: [{ codec_type: 'audio', codec_name: 'aac' }], format: {} }, 'mkv'))
})

test('a browser’s audio-only WebM imports as AAC audio in .m4a, with its duration and a waveform', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-audio-'))
  try {
    const source = join(dir, 'mic.webm')
    await browserWebm(source)
    assert.ok(missingDuration(await probe(source)), 'the test file is like a browser’s: no duration')
    const { asset, stored, logs, cached } = await importFile(dir, source, { name: 'Microphone.webm', sourceCursorHidden: false })
    assert.equal(asset.kind, 'audio')
    assert.equal(asset.name, 'Microphone.m4a')
    assert.match(asset.file, /^assets\/[a-f0-9]{64}\.m4a$/)
    assert.equal(asset.hasAudio, true)
    assert.ok(Math.abs((asset.durationSeconds ?? 0) - 2) < 0.15, `duration ${asset.durationSeconds}`)
    assert.equal(asset.width, undefined)
    assert.equal(asset.sourceFps, undefined)
    assert.ok((asset.waveform?.length ?? 0) > 100 && Math.max(...asset.waveform!) > 0.1, 'a waveform of the tone')
    assert.ok(EditorAssetSchema.safeParse(asset).success)
    assert.deepEqual(stored.map((s) => [s.key, s.contentType]), [[asset.file, 'audio/mp4']])
    assert.ok(logs.some((l) => /no picture: importing it as audio, encoded as AAC into an \.m4a/.test(l)), logs.join(' | '))
    const out = await probe(cached)
    assert.deepEqual(out.streams.map((s) => [s.codec_type, s.codec_name]), [['audio', 'aac']])
    assert.equal(asset.sha256, await fileSha256(cached))
    assert.ok(typeof asset.provenance?.rawSha256 === 'string', 'the original file is remembered')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an audio-only MP4 imports as audio in .m4a with its AAC copied', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-audio-'))
  try {
    const source = join(dir, 'mic.mp4')
    await aacMp4(source)
    const { asset, logs } = await importFile(dir, source, { name: 'Microphone take.mp4', sourceCursorHidden: false })
    assert.equal(asset.kind, 'audio')
    assert.equal(asset.name, 'Microphone take.m4a')
    assert.match(asset.file, /\.m4a$/)
    assert.ok(Math.abs((asset.durationSeconds ?? 0) - 2) < 0.15, `duration ${asset.durationSeconds}`)
    assert.ok((asset.waveform?.length ?? 0) > 0)
    assert.ok(EditorAssetSchema.safeParse(asset).success)
    assert.ok(logs.some((l) => /its AAC copied/.test(l)), logs.join(' | '))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a recording to conform must have a picture', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-audio-'))
  try {
    const source = join(dir, 'mic.webm')
    await browserWebm(source)
    await assert.rejects(importFile(dir, source, { name: 'Screen.webm', conform: { fps: 60 }, sourceCursorHidden: false }), /The recording has sound but no picture/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the rate a varying video is conformed to: 60 above an average of 45, else 30', () => {
  const at = (avg: string, extra: Partial<Probe['streams'][number]> = {}, format: Probe['format'] = {}): Probe => ({ streams: [{ codec_type: 'video', avg_frame_rate: avg, ...extra }], format })
  assert.equal(conformRate(at('30000/1001')), 30)
  assert.equal(conformRate(at('45/1')), 30)
  assert.equal(conformRate(at('2997/50')), 60)
  // No average: packets over the duration.
  assert.equal(conformRate(at('0/0', { nb_read_packets: '300' }, { duration: '5' })), 60)
  assert.equal(conformRate(at('0/0')), 30)
  assert.ok(TIMING_REFUSALS.includes(VARIABLE_RATE))
})

for (const [rate, slower, want] of [[30, 20, 30], [60, 50, 60]] as const) {
  test(`a variable-rate video (average under or over 45) imports conformed to a constant ${want} fps, the log saying so`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'studio-vfr-'))
    try {
      const source = join(dir, 'clip.mp4')
      await vfrMp4(source, rate, slower)
      const { asset, logs, cached } = await importFile(dir, source, { name: 'Phone clip.mov', sourceCursorHidden: false })
      assert.equal(asset.kind, 'video')
      assert.equal(asset.name, 'Phone clip.mp4')
      assert.match(asset.file, /\.mp4$/)
      assert.equal(asset.sourceFps, want)
      assert.equal(asset.provenance?.normalizedCfrFps, want)
      assert.ok(typeof asset.provenance?.rawSha256 === 'string')
      assert.ok(logs.includes(`This file's frame rate varied, so it was converted to a constant ${want} frames a second.`), logs.join(' | '))
      assert.ok(EditorAssetSchema.safeParse(asset).success)
      assert.equal((await probe(cached)).streams.find((s) => s.codec_type === 'video')?.codec_name, 'h264')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

test('a steady video is taken as it is, and a file that is not a video is still refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-vfr-'))
  try {
    const source = join(dir, 'steady.mp4')
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-y', source])
    const { asset, logs } = await importFile(dir, source, { name: 'Steady.mp4', sourceCursorHidden: false })
    assert.equal(asset.sourceFps, 30)
    assert.equal(asset.provenance, undefined, 'nothing converted')
    assert.ok(!logs.some((l) => /frame rate varied/.test(l)))
    const junk = join(dir, 'junk.mp4')
    await writeFile(junk, 'not a video at all')
    await assert.rejects(importFile(dir, junk, { name: 'Junk.mp4', sourceCursorHidden: false }))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
