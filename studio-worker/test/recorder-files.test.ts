/**
 * A recording the Mac app's recorder wrote ready for the editor is kept by the import, its frames copied into a plain
 * MP4; one that fails any check is conformed as before. fixtures/recorder holds files written by the recorder's own
 * writers from made-up pictures and sound (desktop/src-tauri/sidecars/studio-recorder, WriterTests: run it with
 * STUDIO_RECORDER_OUT set to remake them): a 320x180 screen at 60 fps whose pictures came unevenly and stood still for
 * a second, tagged Display P3 on the way in; a 480x270 camera at 30 fps from pictures at about 24; a microphone. The
 * cases that must be conformed are made with FFmpeg, each breaking one rule. The checks themselves are tried one rule
 * at a time on a described file (readyProblem).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileSha256 } from '../src/app-client.ts'
import { AssetCache } from '../src/cache.ts'
import { EditorAssetSchema } from '../src/engine.ts'
import { runImport } from '../src/jobs/import.ts'
import type { JobContext } from '../src/jobs/context.ts'
import { probe, run, runBuffer, videoStamps } from '../src/media.ts'
import { fragmented, parsePackets, readyCheck, readyProblem, rewrap, type FullProbe, type Packet } from '../src/recorder-files.ts'
import type { ImportInput } from '../../web/src/lib/studio/server/job-contract.ts'

const fixture = (name: string) => join(import.meta.dirname, 'fixtures', 'recorder', name)

/** Run the import job on a local file as if it had been uploaded under `name` (as import-job.test.ts does). */
async function importFile(dir: string, source: string, input: Partial<ImportInput> & { name: string }) {
  const scratch = join(dir, 'scratch')
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  const cache = new AssetCache(join(dir, 'cache'), 1024 ** 3)
  await cache.init()
  const logs: string[] = []
  const client = {
    readBlob: async (_job: string, _key: string, dest: string) => {
      await copyFile(source, dest)
      return { bytes: (await stat(dest)).size, sha256: await fileSha256(dest), contentType: 'application/octet-stream' }
    },
    writeBlob: async (_job: string, _key: string, file: string) => ({ bytes: (await stat(file)).size }),
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
  return { asset, logs, cached: cache.pathOf(asset.file) }
}

async function withDir(body: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'studio-recorder-files-'))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---- the checks, one rule at a time ----------------------------------------------------------------------------

const good = (frames = 120, fps: 30 | 60 = 60): { p: FullProbe; packets: Packet[] } => ({
  p: {
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: String(frames / fps) },
    streams: [{
      codec_type: 'video', codec_name: 'h264', profile: 'High', pix_fmt: 'yuv420p', color_range: 'tv', color_space: 'bt709',
      color_primaries: 'bt709', color_transfer: 'bt709', sample_aspect_ratio: '1:1', field_order: 'progressive', start_time: '0.000000',
      width: 1280, height: 720, avg_frame_rate: `${fps}/1`, r_frame_rate: `${fps}/1`, nb_read_packets: String(frames), duration: (frames / fps).toFixed(6),
    }],
  },
  packets: Array.from({ length: frames }, (_, i) => ({ t: Number((i / fps).toFixed(6)), key: i % fps === 0 })),
})

test('a file holding everything the editor and the fast export rely on is ready; each broken rule says why', () => {
  const ok = good()
  assert.equal(readyProblem(ok.p, ok.packets, 60), null)
  assert.equal(readyProblem(good(90, 30).p, good(90, 30).packets, 30), null)
  // The same file judged at the other rate is not ready.
  assert.match(readyProblem(ok.p, ok.packets, 30) ?? '', /not said to be 30 fps/)
  const broken = (change: (f: ReturnType<typeof good>) => void) => {
    const f = good()
    change(f)
    return readyProblem(f.p, f.packets, 60) ?? ''
  }
  const v = (f: ReturnType<typeof good>) => f.p.streams[0]!
  assert.match(broken((f) => (f.p.format.format_name = 'matroska,webm')), /not an MP4/)
  assert.match(broken((f) => (v(f).codec_name = 'hevc')), /not H\.264/)
  assert.match(broken((f) => (v(f).pix_fmt = 'yuvj420p')), /yuvj420p/)
  assert.match(broken((f) => (v(f).color_range = 'pc')), /pc range/)
  assert.match(broken((f) => (v(f).color_primaries = 'smpte432')), /primaries/)
  assert.match(broken((f) => (v(f).color_transfer = 'iec61966-2-1')), /transfer/)
  assert.match(broken((f) => (v(f).sample_aspect_ratio = '4:3')), /not square/)
  assert.match(broken((f) => (v(f).side_data_list = [{ side_data_type: 'Display Matrix', rotation: -90 }])), /turned/)
  assert.match(broken((f) => (v(f).start_time = '0.016667')), /does not start at 0/)
  assert.match(broken((f) => (v(f).field_order = 'tt')), /not progressive/)
  assert.match(broken((f) => (v(f).width = 1279)), /size/)
  assert.match(broken((f) => (v(f).avg_frame_rate = '60000/1001')), /not said to be 60 fps/)
  assert.match(broken((f) => (v(f).nb_read_packets = '119')), /could not all be counted/)
  assert.match(broken((f) => f.packets.splice(50, 1, { t: 51 / 60, key: false })), /twice|missing/)
  assert.match(broken((f) => (f.packets[50]!.t += 0.001)), /off its place/)
  assert.match(broken((f) => ([f.packets[3], f.packets[4]] = [f.packets[4]!, f.packets[3]!])), /time order/)
  assert.match(broken((f) => (v(f).duration = '2.5')), /lasts 2\.5 s/)
  assert.match(broken((f) => (f.packets[0]!.key = false)), /key frame/)
  const sparse = good(300)
  sparse.packets.forEach((x, i) => (x.key = i === 0 || i === 119))
  assert.equal(readyProblem(sparse.p, sparse.packets, 60), 'its key frames are more than two seconds apart')
  sparse.packets[239]!.key = true
  assert.equal(readyProblem(sparse.p, sparse.packets, 60), null, 'a key frame within every two seconds is enough')
  assert.match(broken((f) => f.p.streams.push({ codec_type: 'data', codec_name: 'tmcd' })), /data stream/)
  assert.match(broken((f) => f.p.streams.push({ codec_type: 'video', codec_name: 'h264' })), /more than one picture/)
  assert.match(broken((f) => f.p.streams.push({ codec_type: 'audio', codec_name: 'aac', sample_rate: '44100', channels: 2 })), /44100 Hz/)
  assert.equal(broken((f) => f.p.streams.push({ codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 })), '')
  assert.deepEqual(parsePackets('0.000000,K__\n0.016667,___\n\n'), [{ t: 0, key: true }, { t: 0.016667, key: false }])
})

// ---- the recorder's own files -----------------------------------------------------------------------------------

test('the recorder’s screen is kept: its frames copied into a plain MP4, nothing encoded, every check passing again', async () => {
  await withDir(async (dir) => {
    const source = fixture('screen.mp4')
    assert.ok(await fragmented(source), 'the recorder writes in fragments')
    assert.equal(await readyCheck(source, 60), null)
    const { asset, logs, cached } = await importFile(dir, source, { name: 'Screen recording 14 Nov.mp4', conform: { fps: 60, fit: true }, sourceCursorHidden: true })
    assert.ok(logs.some((l) => /kept, its frames copied into a plain MP4, nothing encoded/.test(l)), logs.join(' | '))
    assert.ok(!logs.some((l) => /Conforming/.test(l)), logs.join(' | '))
    assert.ok(EditorAssetSchema.safeParse(asset).success)
    assert.equal(asset.kind, 'video')
    assert.equal(asset.sourceFps, 60)
    assert.equal(asset.width, 320)
    assert.equal(asset.height, 180)
    const frames = (await videoStamps(source)).length
    assert.equal(asset.sourceFrames, frames)
    assert.ok(Math.abs((asset.durationSeconds ?? 0) - frames / 60) < 0.5 / 60, `duration ${asset.durationSeconds}`)
    assert.equal(asset.provenance?.keptAtFps, 60)
    assert.equal(asset.provenance?.normalizedCfrFps, undefined, 'not conformed')
    assert.equal(asset.provenance?.rawSha256, await fileSha256(source))
    // The stored file: a plain MP4 (not fragmented), still ready, the same frames bit for bit.
    assert.ok(!(await fragmented(cached)))
    assert.equal(await readyCheck(cached, 60), null)
    const md5 = async (path: string) => (await run('ffmpeg', ['-nostdin', '-v', 'error', '-i', path, '-map', '0:v', '-f', 'framemd5', '-'])).stdout.split('\n').filter((l) => !l.startsWith('#'))
    assert.deepEqual(await md5(cached), await md5(source))
  })
})

test('the recorder’s camera is kept at 30 fps; its microphone is copied into a plain M4A', async () => {
  await withDir(async (dir) => {
    const camera = await importFile(dir, fixture('camera.mp4'), { name: 'Camera 14 Nov.mp4', conform: { fps: 30 }, sourceCursorHidden: false })
    assert.ok(camera.logs.some((l) => /kept, its frames copied/.test(l)), camera.logs.join(' | '))
    assert.equal(camera.asset.sourceFps, 30)
    assert.equal(camera.asset.width, 480)
    assert.equal(await readyCheck(camera.cached, 30), null)

    const source = fixture('microphone.m4a')
    assert.ok(await fragmented(source))
    const mic = await importFile(dir, source, { name: 'Microphone 14 Nov.m4a', sourceCursorHidden: false, provenance: { recorder: 'desktop', role: 'microphone' } })
    assert.ok(mic.logs.some((l) => /copied into a plain M4A, untouched/.test(l)), mic.logs.join(' | '))
    assert.equal(mic.asset.kind, 'audio')
    assert.match(mic.asset.file, /\.m4a$/)
    assert.ok(!(await fragmented(mic.cached)))
    const before = await probe(source)
    const after = await probe(mic.cached)
    assert.deepEqual(after.streams.map((s) => [s.codec_type, s.codec_name]), [['audio', 'aac']])
    assert.equal(Number(after.format.duration).toFixed(3), Number(before.format.duration).toFixed(3), 'the sound keeps its length (and its start: no edit list added)')
    assert.ok((mic.asset.waveform?.length ?? 0) > 100)
  })
})

// ---- what is conformed as before --------------------------------------------------------------------------------

/** A fragmented H.264 MP4 on the 60 fps grid, made by FFmpeg, with `extra` arguments breaking one rule. */
async function ffmpegTake(path: string, extra: string[] = [], vf = 'format=yuv420p'): Promise<void> {
  await run('ffmpeg', [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=60:duration=4', '-vf', vf,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-bf', '0',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    ...extra, '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-y', path,
  ])
}

test('a take any other recorder wrote the same way is kept too: the check reads the file, not who wrote it', async () => {
  await withDir(async (dir) => {
    const source = join(dir, 'take.mp4')
    await ffmpegTake(source)
    const { logs } = await importFile(dir, source, { name: 'Take.mp4', conform: { fps: 60, fit: true } })
    assert.ok(logs.some((l) => /kept, its frames copied/.test(l)), logs.join(' | '))
  })
})

test('a take that breaks a rule is conformed as before, and the log says which rule', async () => {
  const cases: [string, string[], string, RegExp][] = [
    ['full range', ['-color_range', 'pc'], 'format=yuvj420p', /not kept as it is: .*(yuvj420p|pc range)/],
    ['Display P3', ['-bsf:v', 'h264_metadata=colour_primaries=12:transfer_characteristics=13'], 'format=yuv420p', /not kept as it is: .*(primaries|transfer)/],
    ['a key frame every 3 s', ['-g', '180', '-sc_threshold', '0'], 'format=yuv420p', /not kept as it is: .*more than two seconds apart/],
    ['a dropped frame', ['-fps_mode', 'passthrough'], "select='not(eq(n\\,30))',format=yuv420p", /not kept as it is: .*(missing|lasts|counted|not said to be)/],
    ['frames off the grid', ['-fps_mode', 'vfr'], "settb=1/90000,setpts='(N/60+if(gte(N\\,30)\\,0.002\\,0))/TB',format=yuv420p", /not kept as it is: .*(off its place|not said to be)/],
  ]
  await withDir(async (dir) => {
    for (const [what, extra, vf, why] of cases) {
      const source = join(dir, 'take.mp4')
      await ffmpegTake(source, extra, vf)
      const { asset, logs } = await importFile(dir, source, { name: 'Take.mp4', conform: { fps: 60 } })
      assert.ok(logs.some((l) => why.test(l)), `${what}: ${logs.join(' | ')}`)
      assert.ok(logs.some((l) => /Conforming the recording to a constant 60 fps/.test(l)), `${what}: ${logs.join(' | ')}`)
      assert.equal(asset.provenance?.normalizedCfrFps, 60, what)
    }
  })
})

test('a take brought back after a crash is kept when it ends on a whole segment, conformed when it ends mid-segment', async () => {
  await withDir(async (dir) => {
    const source = fixture('screen.mp4')
    const index = (await readFile(source.replace(/screen\.mp4$/, 'screen.mp4.segments'), 'utf8').catch(() => null))
    // The recorder's own index: the end of its second media segment is a cut a crash can leave (whole segments only).
    const bytes = await readFile(source)
    const segments = (index ?? '').trim().split('\n').map((l) => l.split(' ').map(Number))
    const boundary = segments.length >= 3 ? segments[2]![1]! + segments[2]![2]! : 0
    assert.ok(boundary > 0 && boundary < bytes.length, 'the fixture has more than two media segments')
    const whole = join(dir, 'whole.mp4')
    await writeFile(whole, bytes.subarray(0, boundary))
    const kept = await importFile(dir, whole, { name: 'Screen.mp4', conform: { fps: 60, fit: true }, partial: true })
    assert.ok(kept.logs.some((l) => /kept, its frames copied/.test(l)), kept.logs.join(' | '))
    assert.equal(kept.asset.sourceFrames, 240, 'its first two 2 s segments at 60 fps')
    const torn = join(dir, 'torn.mp4')
    await writeFile(torn, bytes.subarray(0, boundary + Math.floor((segments[3]?.[2] ?? 20_000) / 2)))
    const conformed = await importFile(dir, torn, { name: 'Screen.mp4', conform: { fps: 60, fit: true }, partial: true })
    assert.ok(conformed.logs.some((l) => /not kept as it is/.test(l)), conformed.logs.join(' | '))
    assert.ok(conformed.logs.some((l) => /Conforming the recording .*read as far as it goes/.test(l)), conformed.logs.join(' | '))
  })
})

// ---- the browser's sound is not the Mac app's ---------------------------------------------------------------

/** A browser's microphone take named .m4a: fragmented MP4 with Opus (or AAC), written as it recorded. */
async function browserM4a(path: string, codec: 'libopus' | 'aac'): Promise<void> {
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', codec, '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '500000', '-y', path])
}

test('a browser’s fragmented .m4a (Opus, or AAC cut mid-frame) is imported as it is, as before; the Mac app’s AAC cut short falls back to it too', async () => {
  await withDir(async (dir) => {
    const opus = join(dir, 'opus.m4a')
    await browserM4a(opus, 'libopus')
    assert.ok(await fragmented(opus))
    for (const provenance of [undefined, { recorder: 'browser' }, { recorder: 'desktop' }]) {
      const { asset, logs } = await importFile(dir, opus, { name: 'Microphone.m4a', ...(provenance ? { provenance } : {}) })
      assert.equal(asset.kind, 'audio', JSON.stringify(provenance))
      assert.ok(!logs.some((l) => /copied into a plain M4A/.test(l)), logs.join(' | '))
    }
    const aac = join(dir, 'aac.m4a')
    await browserM4a(aac, 'aac')
    const whole = await readFile(aac)
    const cut = join(dir, 'cut.m4a')
    await writeFile(cut, whole.subarray(0, Math.floor(whole.length * 0.7)))
    const browser = await importFile(dir, cut, { name: 'Microphone.m4a', provenance: { recorder: 'browser' } })
    assert.equal(browser.asset.kind, 'audio')
    const mac = await importFile(dir, cut, { name: 'Microphone.m4a', provenance: { recorder: 'desktop' } })
    assert.equal(mac.asset.kind, 'audio')
    assert.ok(mac.logs.some((l) => /could not be copied into a plain M4A .*imported as it is/.test(l)), mac.logs.join(' | '))
  })
})

test('the recorder’s own hash refuses bytes that are not the recording, and never accepts anything else', async () => {
  await withDir(async (dir) => {
    const source = fixture('camera.mp4')
    const sha = await fileSha256(source)
    const ok = await importFile(dir, source, { name: 'Camera.mp4', conform: { fps: 30 }, expectSha256: sha })
    assert.equal(ok.asset.sourceFps, 30)
    await assert.rejects(importFile(dir, source, { name: 'Camera.mp4', conform: { fps: 30 }, expectSha256: 'f'.repeat(64) }), /not the one on your computer/)
  })
})

test('a picture larger than 4096 pixels a side is never kept as it is (the recorder writes those as HEVC)', () => {
  const big = good()
  big.p.streams[0]!.width = 5120
  big.p.streams[0]!.height = 2880
  assert.match(readyProblem(big.p, big.packets, 60) ?? '', /larger than 4096 pixels a side/)
  const edge = good()
  edge.p.streams[0]!.width = 4096
  edge.p.streams[0]!.height = 2560
  assert.equal(readyProblem(edge.p, edge.packets, 60), null)
})

test('the rewrap of a fragmented AAC file adds no edit list: the same samples at the same times, nothing moved by its priming', async () => {
  await withDir(async (dir) => {
    const source = join(dir, 'mic.m4a')
    await browserM4a(source, 'aac')
    const out = join(dir, 'rewrapped.m4a')
    await rewrap(source, out, { audioOnly: true, seconds: 10 })
    const startOf = async (path: string) => (await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=start_time', '-of', 'csv=p=0', path])).stdout.trim()
    assert.equal(await startOf(out), await startOf(source))
    // Decoded as a player decodes them (priming handled the same on both): sample for sample the same sound.
    const pcm = (path: string) => runBuffer('ffmpeg', ['-nostdin', '-v', 'error', '-i', path, '-map', '0:a', '-f', 's16le', '-ac', '1', '-'])
    const [a, b] = [await pcm(source), await pcm(out)]
    assert.ok(a.length > 0)
    assert.equal(b.length, a.length)
    assert.ok(Buffer.compare(a, b) === 0, 'the rewrapped file decodes to the same samples')
    // No edit list was written that would shift the sound on the timeline (an elst with a media time other than the
    // source's own would show as a different start above, and as a shifted decode).
    const boxes = await readFile(out)
    const elst = boxes.indexOf(Buffer.from('elst'))
    if (elst >= 0) {
      const version = boxes[elst + 4]!
      const mediaTime = version === 1 ? Number(boxes.readBigInt64BE(elst + 4 + 4 + 4 + 8)) : boxes.readInt32BE(elst + 4 + 4 + 4 + 4)
      const sourceBoxes = await readFile(source)
      const sourceElst = sourceBoxes.indexOf(Buffer.from('elst'))
      const sourceTime = sourceElst < 0 ? 0 : sourceBoxes[sourceElst + 4] === 1 ? Number(sourceBoxes.readBigInt64BE(sourceElst + 4 + 4 + 4 + 8)) : sourceBoxes.readInt32BE(sourceElst + 4 + 4 + 4 + 4)
      assert.equal(mediaTime, sourceTime, 'its media time is the source’s own')
    }
  })
})
