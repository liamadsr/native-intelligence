/**
 * Running a fast-export plan (fast-export.ts): each clip composed by FFmpeg, the clips joined without re-encoding,
 * the sound (Remotion's own mix, rendered alone) joined to them, then checked before anyone sees it:
 * - the frame count and the duration are the composition's;
 * - a few frames (the first with the bubble, the first of a blend, one late in the video) drawn by Chrome itself are
 *   compared with the same frames of the file (CHECK_DB below). About 2 s of Chrome on a Mac.
 * Any error or a failed check throws; the export job then renders the whole video in Chrome instead.
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { probe, run } from './media.ts'
import { planFiles, segmentArgs, sourcesFit, bubbleGeometry, type FastPlan } from './fast-export.ts'

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
}

const timeout = (frames: number, fps: number) => Math.max(180_000, Math.ceil((frames / fps) * 20_000))

export async function composeFast(r: FastRun): Promise<string> {
  const { plan, scratch, signal } = r
  // What the files are made of must be what the plan assumes (codec, pixels, colour, timing from 0).
  const streams = await Promise.all(planFiles(plan).map(async (file) => {
    const v = (await probe(r.path(file), { signal })).streams.find((s) => s.codec_type === 'video') as Record<string, unknown> | undefined
    return { file, codec: v?.codec_name as string | undefined, pixFmt: v?.pix_fmt as string | undefined, colorSpace: v?.color_space as string | undefined,
      colorRange: v?.color_range as string | undefined, startTime: v?.start_time === undefined ? 0 : Number(v.start_time) }
  }))
  const misfit = sourcesFit(streams)
  if (misfit) throw new Error(misfit)

  // FFmpeg draws the picture while Chrome (one browser) works on what only it can give: the sound's checked windows,
  // then the frames the picture is checked against. The two run side by side; the file is checked once both are done.
  const t0 = Date.now(), secs = (a: number, b: number) => ((b - a) / 1000).toFixed(1)
  const wav = join(scratch, 'fast-sound.wav'), frames = sampleFrames(plan)
  const times = { picture: 0, sound: 0, chromeFrames: 0 }
  const chrome = (async () => {
    const a = Date.now()
    await r.sound(wav)
    const b = Date.now()
    const stills = await r.stills(frames)
    times.sound = b - a
    times.chromeFrames = Date.now() - b
    return stills
  })()
  const picture = (async () => {
    const parts: string[] = []
    let done = 0
    for (const [i, seg] of plan.segments.entries()) {
      const out = join(scratch, `fast-${i}.mp4`)
      await run('ffmpeg', segmentArgs(seg, plan.fps, r.path, out), { timeout: timeout(seg.frames, plan.fps), maxBuffer: 4 * 1024 * 1024, signal })
      parts.push(out)
      done += seg.frames
      r.progress(0.7 * done / plan.frames)
    }
    const list = join(scratch, 'fast-parts.txt')
    await writeFile(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n')
    const file = join(scratch, 'fast-picture.mp4')
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', file],
      { timeout: timeout(plan.frames, plan.fps), maxBuffer: 4 * 1024 * 1024, signal })
    times.picture = Date.now() - t0
    return file
  })()
  const [p, c] = await Promise.allSettled([picture, chrome])
  if (p.status === 'rejected') throw p.reason
  if (c.status === 'rejected') throw c.reason
  const t1 = Date.now()
  r.progress(0.85)
  const output = join(scratch, 'video.fast.mp4')
  // AAC at Remotion's rate and bitrate (48 kHz, 320 kb/s), the picture copied.
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', p.value, '-i', wav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-movflags', '+faststart', output], { timeout: timeout(plan.frames, plan.fps), maxBuffer: 4 * 1024 * 1024, signal })
  const t2 = Date.now()
  await check(r, output, frames, c.value)
  r.log(`Fast export: picture ${secs(0, times.picture)} s, alongside it the sound ${secs(0, times.sound)} s and Chrome's check frames ${secs(0, times.chromeFrames)} s; joining ${secs(t1, t2)} s, comparing ${secs(t2, Date.now())} s`)
  r.progress(1)
  return output
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
    const whole = await psnr(png, file, frame, null, signal)
    const bubble = g && frame >= seg.startFrame + seg.bubble!.offset ? await psnr(png, file, frame, g, signal) : Infinity
    r.log(`Fast export check, frame ${frame}: ${whole.toFixed(1)} dB${Number.isFinite(bubble) ? `, bubble ${bubble.toFixed(1)} dB` : ''} against Chrome`)
    if (!(whole >= CHECK_DB.frame) || !(bubble >= CHECK_DB.bubble)) throw new Error(`frame ${frame} is not Chrome's (${whole.toFixed(1)} dB, bubble ${bubble.toFixed(1)} dB)`)
  }
}

/** The frames checked: the first with the bubble, the first of a blend, and one 80 % of the way through. Pure. */
export function sampleFrames(plan: FastPlan): number[] {
  const out = new Set<number>()
  const withBubble = plan.segments.find((s) => s.bubble)
  if (withBubble) out.add(withBubble.startFrame + withBubble.bubble!.offset)
  const blended = plan.segments.find((s) => s.blend)
  if (blended) out.add(blended.startFrame + Math.floor(blended.blend!.frames / 2))
  out.add(Math.min(plan.frames - 1, Math.floor(plan.frames * 0.8)))
  return [...out].sort((a, b) => a - b)
}

/** PSNR (dB, average over the planes) of a PNG still against one frame of a video, both as BT.709 YUV, optionally in a box. */
async function psnr(png: string, video: string, frame: number, box: { bx: number; by: number; bw: number; bh: number } | null, signal: AbortSignal): Promise<number> {
  const crop = box ? `,crop=${box.bw}:${box.bh}:${box.bx}:${box.by}` : ''
  const { stderr } = await run('ffmpeg', ['-nostdin', '-hide_banner', '-i', png, '-i', video, '-lavfi',
    `[0:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p${crop}[a];[1:v]select=eq(n\\,${frame}),setpts=PTS-STARTPTS,format=yuv420p${crop}[b];[a][b]psnr`,
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
