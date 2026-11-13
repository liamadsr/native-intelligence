/**
 * Running a fast-export plan (fast-export.ts): the files checked first (codec, colour, shape, every frame used on its
 * file's frame grid), each clip composed by FFmpeg, the clips joined without re-encoding, the sound (fast-sound.ts, or
 * Remotion's own mix) joined to them, then checked before anyone sees it:
 * - the frame count is the composition's (the packets counted);
 * - at a few places in each clip (its two ends, after a blend, where the source changes most) the frames FFmpeg's graph
 *   had are the source frames the plan says, bit for bit (hashes from the graph against frames decoded alone);
 * - a few frames (the first with the bubble, one in a blend, the one where the recording changes most) drawn by Chrome
 *   itself are compared with the same frames of the file (CHECK_DB below).
 * Any error or a failed check throws (and stops the other branches); the export job then renders the whole video in
 * Chrome instead, after removing what this left in its scratch folder.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { probe, run } from './media.ts'
import { concatLine } from './platform.ts'
import { FAST_ENCODER, planFiles, segmentArgs, sourcesFit, stampsFit, bubbleGeometry, bubbleSampling, type FastPlan, type SegmentPlan } from './fast-export.ts'

/** The least a sampled frame may score against Chrome's drawing of it: the whole frame, and inside the bubble. */
export const CHECK_DB = { frame: 34, bubble: 25 }

export interface FastRun {
  plan: FastPlan
  /** A project file (assets/<sha>.<ext>) as a path on disk. */
  path: (file: string) => string
  scratch: string
  signal: AbortSignal
  log: (line: string) => void
  progress: (fraction: number) => void
  /** Remotion's mix of the video's sound, as a WAV at `out`. */
  sound: (out: string) => Promise<void>
  /** Chrome's drawing of these frames, as PNG files (frame → path). */
  stills: (frames: number[]) => Promise<Map<number, string>>
  /** Stops what Chrome is doing for this run (the picture failed: nothing it makes is needed). */
  abortChrome?: () => void
  /** The picture's encoder arguments (encoders.ts, encoderArgs; given, so the encoder stays out of the render version): the Chrome path's x264 unless said. */
  encoder?: string[]
  /** What a checked frame must score with that encoder (encoders.ts, checkFloor): CHECK_DB unless said. */
  checkDb?: { frame: number; bubble: number }
}

const timeout = (frames: number, fps: number) => Math.max(180_000, Math.ceil((frames / fps) * 20_000))

export async function composeFast(r: FastRun): Promise<string> {
  const { plan, scratch } = r
  // A failure anywhere stops the rest: FFmpeg's runs by this signal, Chrome's by r.abortChrome.
  const inner = new AbortController(), signal = AbortSignal.any([r.signal, inner.signal])
  const stop = (err: unknown) => { if (!inner.signal.aborted) { inner.abort(); r.abortChrome?.() } throw err }
  // What the files are made of must be what the plan assumes (codec, pixels, colour, shape, timing from 0), and every
  // frame the plan shows must sit on its file's frame grid (read only around the stretches used, not the whole file).
  const streams = await Promise.all(planFiles(plan).map(async (file) => {
    const v = (await probe(r.path(file), { signal })).streams.find((s) => s.codec_type === 'video') as Record<string, unknown> | undefined
    const side = (v?.side_data_list as { rotation?: number }[] | undefined)?.find((d) => d.rotation !== undefined)?.rotation
    const tagged = (v?.tags as { rotate?: string } | undefined)?.rotate
    return { file, codec: v?.codec_name as string | undefined, pixFmt: v?.pix_fmt as string | undefined, colorSpace: v?.color_space as string | undefined,
      colorRange: v?.color_range as string | undefined, colorPrimaries: v?.color_primaries as string | undefined, colorTransfer: v?.color_transfer as string | undefined,
      sar: v?.sample_aspect_ratio as string | undefined, rotation: Number(side ?? tagged ?? 0) % 360, startTime: v?.start_time === undefined ? 0 : Number(v.start_time) }
  }))
  const misfit = sourcesFit(streams)
  if (misfit) throw new Error(misfit)
  const packets = new Map<string, Map<number, { size: number; key: boolean }>>()
  for (const [file, ranges] of usedFrames(plan)) {
    const srcFps = ranges[0]!.srcFps
    // Overlapping stretches read once (ffprobe would list their packets twice).
    const spans = ranges.map((x) => [Math.max(0, x.first / srcFps - 1), x.last / srcFps + 1] as [number, number]).sort((a, b) => a[0] - b[0])
      .reduce<[number, number][]>((out, x) => { const last = out.at(-1); if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]); else out.push(x); return out }, [])
    const intervals = spans.map(([a, b]) => `${a.toFixed(3)}%${b.toFixed(3)}`).join(',')
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', intervals, '-show_entries', 'packet=pts_time,size,flags', '-of', 'csv=p=0', r.path(file)],
      { signal, maxBuffer: 64 * 1024 * 1024, timeout: timeout(plan.frames, plan.fps) })
    const rows = stdout.split('\n').filter(Boolean).map((l) => l.split(','))
    const stamps = rows.map((x) => Number(x[0]))
    for (const x of ranges) {
      const why = stampsFit(stamps, srcFps, x.first, x.last)
      if (why) throw new Error(`${file}: ${why}`)
    }
    packets.set(file, new Map(rows.map((x) => [Math.round(Number(x[0]) * srcFps), { size: Number(x[1]), key: (x[2] ?? '').includes('K') }])))
  }
  const change = (file: string, i: number) => { const p = packets.get(file)?.get(i); return p && !p.key ? p.size : 0 }

  // FFmpeg draws the picture while Chrome (one browser) works on what only it can give: the sound's checked windows,
  // then the frames the picture is checked against. Beside them, the source frames the picture must show at a few
  // places are hashed straight from the files, to compare with what FFmpeg's graph had there (hashFrames).
  const t0 = Date.now(), secs = (a: number, b: number) => ((b - a) / 1000).toFixed(1)
  const wav = join(scratch, 'fast-sound.wav'), frames = sampleFrames(plan, change)
  const times = { picture: 0, sound: 0, chromeFrames: 0 }
  const hashes = plan.segments.map((seg, i) => ({ ...hashFrames(seg, change), screenOut: join(scratch, `fast-${i}-screen.md5`), cameraOut: join(scratch, `fast-${i}-camera.md5`) }))
  const chrome = (async () => {
    const a = Date.now()
    await r.sound(wav)
    const b = Date.now()
    const stills = await r.stills(frames)
    times.sound = b - a
    times.chromeFrames = Date.now() - b
    return stills
  })().catch(stop)
  const references = Promise.all(plan.segments.map(async (seg, i) => ({
    screen: await sourceHashes(r.path(seg.screen.file), seg.screen.srcFps, hashes[i]!.screen.map((l) => seg.screen.map[l]!), null, signal),
    camera: seg.bubble ? await sourceHashes(r.path(seg.bubble.camera.file), seg.bubble.camera.srcFps, hashes[i]!.camera.map((l) => seg.bubble!.camera.map[l]!), bubbleSampling(bubbleGeometry(seg.bubble)), signal) : [],
  }))).catch(stop)
  const picture = (async () => {
    const parts: string[] = []
    let done = 0
    for (const [i, seg] of plan.segments.entries()) {
      const out = join(scratch, `fast-${i}.mp4`)
      await run('ffmpeg', segmentArgs(seg, plan.fps, r.path, out, seg.bubble ? hashes[i] : { ...hashes[i]!, camera: [] }, r.encoder ?? FAST_ENCODER),
        { timeout: timeout(seg.frames, plan.fps), maxBuffer: 4 * 1024 * 1024, signal })
      parts.push(out)
      done += seg.frames
      r.progress(0.7 * done / plan.frames)
    }
    const list = join(scratch, 'fast-parts.txt')
    await writeFile(list, parts.map(concatLine).join('\n') + '\n')
    const file = join(scratch, 'fast-picture.mp4')
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', file],
      { timeout: timeout(plan.frames, plan.fps), maxBuffer: 4 * 1024 * 1024, signal })
    times.picture = Date.now() - t0
    return file
  })().catch(stop)
  const [pictureFile, stills, refs] = await Promise.all([picture, chrome, references])
  // The source frames FFmpeg's graph actually had, at the sampled places, against the plan's: bit for bit.
  for (const [i, seg] of plan.segments.entries()) {
    const h = hashes[i]!
    const got = { screen: await readHashes(h.screenOut, h.screen.length), camera: seg.bubble ? await readHashes(h.cameraOut, h.camera.length) : [] }
    for (const kind of ['screen', 'camera'] as const) for (const [k, l] of h[kind].entries()) {
      const source = kind === 'screen' ? seg.screen.map[l] : seg.bubble!.camera.map[l]
      if (got[kind][k] !== refs[i]![kind][k]) throw new Error(`clip ${i + 1}'s ${kind} frame ${l} is not source frame ${source}`)
    }
  }
  const t1 = Date.now()
  r.progress(0.85)
  const output = join(scratch, 'video.fast.mp4')
  // AAC at Remotion's rate and bitrate (48 kHz, 320 kb/s), the picture copied.
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', pictureFile, '-i', wav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-movflags', '+faststart', output], { timeout: timeout(plan.frames, plan.fps), maxBuffer: 4 * 1024 * 1024, signal })
  const t2 = Date.now()
  await check(r, output, frames, stills)
  const checked = hashes.reduce((n, h) => n + h.screen.length + h.camera.length, 0)
  r.log(`Fast export: picture ${secs(0, times.picture)} s, alongside it the sound ${secs(0, times.sound)} s and Chrome's check frames ${secs(0, times.chromeFrames)} s; ${checked} source frames matched bit for bit; joining ${secs(t1, t2)} s, comparing ${secs(t2, Date.now())} s`)
  r.progress(1)
  return output
}

/**
 * Where to compare the frames FFmpeg's graph had with the source frames the plan says (output frames of the clip, and
 * of its camera stretch): the first and the last (the cut's two sides), the first after a blend, and the two where the
 * source changes most from the frame before (`change`: the frame's packet size, keyframes 0), so a frame early or late
 * would show. Pure.
 */
export function hashFrames(seg: SegmentPlan, change: (file: string, index: number) => number): { screen: number[]; camera: number[] } {
  const pick = (map: number[], file: string, must: number[]) => {
    const moves = map.map((i, l) => ({ l, size: l === 0 || map[l - 1] !== i ? change(file, i) : 0 })).filter((x) => x.size > 0).sort((a, b) => b.size - a.size || a.l - b.l)
    return [...new Set([...must, ...moves.slice(0, 2).map((x) => x.l)])].filter((l) => l >= 0 && l < map.length).sort((a, b) => a - b)
  }
  return {
    screen: pick(seg.screen.map, seg.screen.file, [0, seg.screen.map.length - 1, ...(seg.blend ? [seg.blend.frames] : [])]),
    camera: seg.bubble ? pick(seg.bubble.camera.map, seg.bubble.camera.file, [0, seg.bubble.camera.map.length - 1]) : [],
  }
}

/** MD5s of source frames (each decoded alone, from a seek), through `filters` when given, as framemd5 writes them. */
async function sourceHashes(file: string, srcFps: number, indices: number[], filters: string | null, signal: AbortSignal): Promise<string[]> {
  const out: string[] = []
  for (const i of indices) {
    const { stdout } = await run('ffmpeg', ['-nostdin', '-v', 'error', '-ss', (Math.max(0, i - 0.5) / srcFps).toFixed(6), '-i', file, '-map', '0:v:0', ...(filters ? ['-vf', filters] : []),
      '-frames:v', '1', '-f', 'framemd5', '-'], { signal })
    out.push(lastHashes(stdout)[0] ?? '')
  }
  return out
}
const lastHashes = (text: string) => text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').at(-1)!.trim())
async function readHashes(file: string, count: number): Promise<string[]> {
  if (!count) return []
  const hashes = lastHashes(await readFile(file, 'utf8'))
  if (hashes.length !== count) throw new Error(`the graph hashed ${hashes.length} frames, not ${count}`)
  return hashes
}

/** Per file, the stretches of source frames the plan shows (each clip's screen, a blend's held frame, the camera). Pure. */
export function usedFrames(plan: FastPlan): Map<string, { srcFps: number; first: number; last: number }[]> {
  const out = new Map<string, { srcFps: number; first: number; last: number }[]>()
  const add = (file: string, srcFps: number, first: number, last: number) => out.set(file, [...(out.get(file) ?? []), { srcFps, first, last }])
  for (const seg of plan.segments) {
    add(seg.screen.file, seg.screen.srcFps, seg.screen.map[0]!, seg.screen.map.at(-1)!)
    if (seg.blend) add(seg.blend.file, seg.blend.srcFps, seg.blend.index, seg.blend.index)
    if (seg.bubble) add(seg.bubble.camera.file, seg.bubble.camera.srcFps, seg.bubble.camera.map[0]!, seg.bubble.camera.map.at(-1)!)
  }
  return out
}

/**
 * The frames checked against Chrome: the first with the bubble, one in a blend, and the one where the recording changes
 * most from the frame before (`change`: the frame's packet size; with nothing known, one 80 % of the way through), so
 * a picture a frame early or late scores low there. Pure.
 */
export function sampleFrames(plan: FastPlan, change: (file: string, index: number) => number = () => 0): number[] {
  const out = new Set<number>()
  const withBubble = plan.segments.find((s) => s.bubble)
  if (withBubble) out.add(withBubble.startFrame + withBubble.bubble!.offset)
  const blended = plan.segments.find((s) => s.blend)
  if (blended) out.add(blended.startFrame + Math.floor(blended.blend!.frames / 2))
  let most = { frame: Math.min(plan.frames - 1, Math.floor(plan.frames * 0.8)), size: 0 }
  for (const seg of plan.segments) for (const [l, i] of seg.screen.map.entries()) {
    if (l < (seg.blend?.frames ?? 0) || (l > 0 && seg.screen.map[l - 1] === i)) continue
    const size = change(seg.screen.file, i)
    if (size > most.size) most = { frame: seg.startFrame + l, size }
  }
  out.add(most.frame)
  return [...out].sort((a, b) => a - b)
}

/** The file's frame count, and the sampled frames against Chrome's drawing of them. */
async function check(r: FastRun, file: string, frames: number[], stills: Map<number, string>): Promise<void> {
  const { plan, signal } = r
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file], { signal })
  const count = Number(stdout.trim())
  if (count !== plan.frames) throw new Error(`the file has ${count} frames, not ${plan.frames}`)
  for (const frame of frames) {
    const png = stills.get(frame)
    if (!png) throw new Error(`Chrome drew no frame ${frame}`)
    const seg = plan.segments.find((s) => frame >= s.startFrame && frame < s.startFrame + s.frames)!
    const g = seg.bubble ? bubbleGeometry(seg.bubble) : null
    const whole = await psnr(png, file, frame, plan.fps, null, signal)
    const bubble = g && frame >= seg.startFrame + seg.bubble!.offset ? await psnr(png, file, frame, plan.fps, g, signal) : Infinity
    r.log(`Fast export check, frame ${frame}: ${whole.toFixed(1)} dB${Number.isFinite(bubble) ? `, bubble ${bubble.toFixed(1)} dB` : ''} against Chrome`)
    const floor = r.checkDb ?? CHECK_DB
    if (!(whole >= floor.frame) || !(bubble >= floor.bubble)) throw new Error(`frame ${frame} is not Chrome's (${whole.toFixed(1)} dB, bubble ${bubble.toFixed(1)} dB)`)
  }
}

/** PSNR (dB, average over the planes) of a PNG still against one frame of a video, both as BT.709 YUV, optionally in a box. */
async function psnr(png: string, video: string, frame: number, fps: number, box: { bx: number; by: number; bw: number; bh: number } | null, signal: AbortSignal): Promise<number> {
  const crop = box ? `,crop=${box.bw}:${box.bh}:${box.bx}:${box.by}` : ''
  // The frame read from a seek half a frame before it (the decoder starts at the keyframe before), not decoded from the start.
  const { stderr } = await run('ffmpeg', ['-nostdin', '-hide_banner', '-i', png, '-ss', (Math.max(0, frame - 0.5) / fps).toFixed(6), '-i', video, '-lavfi',
    `[0:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p${crop}[a];[1:v]setpts=PTS-STARTPTS,format=yuv420p${crop}[b];[a][b]psnr`,
    '-frames:v', '1', '-f', 'null', '-'], { signal, maxBuffer: 4 * 1024 * 1024 })
  const m = /average:([\d.]+|inf)/.exec(stderr)
  return m ? (m[1] === 'inf' ? Infinity : Number(m[1])) : NaN
}

/**
 * The sound's frame ranges for `parts` renders at once: Remotion mixes a video's sound in one tab, about 18 ms a frame
 * on a Mac whatever the tab count, so the sound of a long video is rendered as consecutive stretches, each in its own
 * browser, and joined. Each stretch is its frames' samples exactly (48 kHz at 30 or 60 fps is a whole number of
 * samples a frame); Remotion writes one sample more at the end of each, which joinWavs leaves out. Joined, the sound
 * was the whole render's to the bit (a made-up 248-frame video in three stretches). Pure.
 */
export function soundRanges(frames: number, parts: number): [number, number][] {
  const k = Math.max(1, Math.min(parts, Math.floor(frames / 30)))
  const cuts = Array.from({ length: k + 1 }, (_, i) => Math.round((frames * i) / k))
  return cuts.slice(0, -1).map((from, i) => [from, cuts[i + 1]! - 1])
}

/** PCM WAV files joined: of each, its first `samples` sample frames (all of the same format). */
export async function joinWavs(parts: { file: string; samples: number }[], out: string): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises')
  let fmt: Buffer | null = null
  const datas: Buffer[] = []
  for (const part of parts) {
    const buf = await readFile(part.file)
    if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error(`${part.file} is not a WAV`)
    let at = 12, partFmt: Buffer | null = null, data: Buffer | null = null
    while (at + 8 <= buf.length) {
      const id = buf.toString('latin1', at, at + 4), size = buf.readUInt32LE(at + 4)
      const body = buf.subarray(at + 8, Math.min(buf.length, at + 8 + size))
      if (id === 'fmt ') partFmt = body
      if (id === 'data') data = body
      at += 8 + size + (size % 2)
    }
    if (!partFmt || !data || partFmt.readUInt16LE(0) !== 1) throw new Error(`${part.file} is not PCM`)
    if (fmt && !fmt.equals(partFmt)) throw new Error('the sound stretches differ in format')
    fmt = partFmt
    const blockAlign = partFmt.readUInt16LE(12), bytes = part.samples * blockAlign
    if (data.length < bytes) throw new Error(`${part.file} is ${data.length / blockAlign} samples, not ${part.samples}`)
    datas.push(data.subarray(0, bytes))
  }
  const data = Buffer.concat(datas), header = Buffer.alloc(12 + 8 + fmt!.length + 8)
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(header.length - 8 + data.length, 4); header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1'); header.writeUInt32LE(fmt!.length, 16); fmt!.copy(header, 20)
  header.write('data', 20 + fmt!.length, 'latin1'); header.writeUInt32LE(data.length, 24 + fmt!.length)
  await writeFile(out, Buffer.concat([header, data]))
}
