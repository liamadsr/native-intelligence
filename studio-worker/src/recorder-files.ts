/**
 * A recording that is already what the import would make of it: the Mac app's recorder writes its picture tracks as
 * H.264 on an exact frame grid, in fragmented MP4 (desktop/src-tauri/sidecars/studio-recorder, Writers.swift), so
 * that nothing is left to do after Stop. The import does not take the computer's word for it: it reads the file with
 * ffprobe and keeps it only when everything the editor and the fast export rely on holds (readyProblem), else it
 * conforms it as any recording. The checks are the fast export's own (fast-export.ts sourcesFit and stampsFit, not
 * loosened) and the import's (assets.ts measure):
 *
 *   - an MP4 holding one picture, at most one sound, nothing else;
 *   - the picture H.264 in yuv420p, BT.709 or untagged colour, limited range or unsaid, square pixels, not turned,
 *     progressive, an even size, starting at 0;
 *   - at the rate the import would conform it to, said so (average and base rate), every frame counted, each frame i
 *     stored in time order at i / fps (within a quarter millisecond), its duration the frames' to half a frame;
 *   - opening on a key frame, a key frame at least every two seconds (seeking stays quick);
 *   - its sound, if any, AAC at 48 kHz, mono or stereo.
 *
 * A file that passes is copied, not encoded, into a plain MP4 with its index at the front (rewrap: a fragmented file
 * seeks slowly in a browser without an index), and the copy is checked again. Seconds instead of the conform's time.
 *
 * What the keep does not do is decode every frame (the conform did, by encoding them): that would bring back a wait
 * that grows with the take. Damage on the way is caught otherwise: the copy is read under `-xerror`, both ends are
 * decoded (assets.ts verifyDecodes), and the import refuses bytes whose hash is not the one the recorder computed as it
 * wrote the file (ImportInput.expectSha256). What remains is a computer that deliberately writes a file damaged in its
 * middle: it only breaks its own person's export, whose own decode reports it.
 */
/** The largest side kept as it is: what the Mac app's recorder writes as H.264. */
export const MAX_KEPT_SIDE = 4096
import { open } from 'node:fs/promises'
import { sourcesFit, stampsFit } from './fast-export.ts'
import { mediaTimeout, parseRate, pictureStream, run, type Probe, type ProbeStream } from './media.ts'

/** A stream as ffprobe describes it, with what these checks read. */
export interface FullStream extends ProbeStream {
  profile?: string
  pix_fmt?: string
  color_range?: string
  color_space?: string
  color_primaries?: string
  color_transfer?: string
  sample_aspect_ratio?: string
  field_order?: string
  start_time?: string
  sample_rate?: string
  channels?: number
  side_data_list?: { side_data_type?: string; rotation?: number }[]
}
export interface FullProbe extends Probe {
  streams: FullStream[]
}
/** A picture packet in file order: its time and whether it is a key frame. */
export interface Packet { t: number; key: boolean }

/** Why a recording is not kept as it is (null: it is). Pure. */
export function readyProblem(p: FullProbe, packets: Packet[], fps: 30 | 60): string | null {
  if (!/(^|,)mp4(,|$)/.test(p.format.format_name ?? '')) return 'it is not an MP4'
  const other = p.streams.find((s) => s.codec_type !== 'video' && s.codec_type !== 'audio')
  if (other) return `it holds a ${other.codec_type} stream`
  const videos = p.streams.filter((s) => s.codec_type === 'video')
  const audios = p.streams.filter((s) => s.codec_type === 'audio')
  const v = pictureStream(p) as FullStream | undefined
  if (!v || videos.length !== 1) return videos.length ? 'it has more than one picture' : 'it has no picture'
  if (audios.length > 1) return 'it has more than one sound'
  const rotation = v.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation
  const fit = sourcesFit([{
    file: 'its picture', codec: v.codec_name, pixFmt: v.pix_fmt, colorSpace: v.color_space, colorRange: v.color_range,
    colorPrimaries: v.color_primaries, colorTransfer: v.color_transfer, startTime: Number(v.start_time ?? Number.NaN),
    sar: v.sample_aspect_ratio, rotation,
  }])
  if (fit) return fit
  if (!(Number(v.start_time) === 0)) return 'its picture does not say it starts at 0'
  if (v.field_order && !['progressive', 'unknown'].includes(v.field_order)) return `its picture is ${v.field_order}, not progressive`
  const { width = 0, height = 0 } = v
  if (!(width > 0 && height > 0 && width % 2 === 0 && height % 2 === 0)) return `its size is ${width}x${height}`
  // What the recorder writes as H.264 (Writers.swift videoSettings); a larger picture is HEVC there, and is conformed.
  if (Math.max(width, height) > MAX_KEPT_SIDE) return `its picture is ${width}x${height}, larger than ${MAX_KEPT_SIDE} pixels a side`
  if (parseRate(v.avg_frame_rate) !== fps || parseRate(v.r_frame_rate) !== fps) return `it is not said to be ${fps} fps (${v.avg_frame_rate}, ${v.r_frame_rate})`
  const frames = Number(v.nb_read_packets)
  if (!Number.isInteger(frames) || frames < 1 || packets.length !== frames) return 'its frames could not all be counted'
  const timing = stampsFit(packets.map((x) => x.t), fps, 0, frames - 1)
  if (timing) return timing
  for (let i = 0; i < frames; i++) if (Math.abs(packets[i]!.t - i / fps) > 0.00025) return `its frames are not stored in time order (frame ${i})`
  const duration = Number(v.duration ?? p.format.duration)
  if (!(Math.abs(duration - frames / fps) <= 0.5 / fps)) return `it says it lasts ${duration} s for ${frames} frames at ${fps} fps`
  if (!packets[0]!.key) return 'it does not open on a key frame'
  let since = 0
  for (const x of packets) {
    since = x.key ? 0 : since + 1
    if (since >= 2 * fps) return 'its key frames are more than two seconds apart'
  }
  const a = audios[0]
  if (a && (a.codec_name !== 'aac' || a.sample_rate !== '48000' || ![1, 2].includes(a.channels ?? 0))) {
    return `its sound is ${a.codec_name} at ${a.sample_rate} Hz in ${a.channels} channels, not AAC at 48 kHz`
  }
  return null
}

/** ffprobe's picture packets (`pts_time,flags` lines, file order). Pure. */
export function parsePackets(text: string): Packet[] {
  return text.split('\n').filter((l) => l.trim()).map((line) => {
    const [t, flags] = line.split(',')
    return { t: Number.parseFloat(t!), key: (flags ?? '').startsWith('K') }
  })
}

/** Read a file as readyProblem needs it: two ffprobe passes (the streams with their packets counted, the picture's packets). */
export async function readyCheck(path: string, fps: 30 | 60, signal?: AbortSignal): Promise<string | null> {
  const [described, listed] = await Promise.all([
    run('ffprobe', ['-v', 'error', '-count_packets', '-show_streams', '-show_format', '-of', 'json', path], { timeout: 300_000, maxBuffer: 4 * 1024 * 1024, signal }),
    run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', path], { timeout: 300_000, maxBuffer: 256 * 1024 * 1024, signal }),
  ])
  let parsed: FullProbe
  try {
    const raw = JSON.parse(described.stdout) as Partial<FullProbe>
    parsed = { streams: Array.isArray(raw.streams) ? raw.streams : [], format: raw.format ?? {} }
  } catch {
    return 'ffprobe did not describe it'
  }
  return readyProblem(parsed, parsePackets(listed.stdout), fps)
}

/**
 * Whether an MP4-family file is fragmented (a `moof` box at its top level): read from its box headers, a few bytes
 * each. A file that cannot be read as boxes says false.
 */
export async function fragmented(path: string): Promise<boolean> {
  const handle = await open(path, 'r')
  try {
    const size = (await handle.stat()).size
    const header = Buffer.alloc(16)
    let at = 0
    for (let boxes = 0; at + 8 <= size && boxes < 100_000; boxes++) {
      const { bytesRead } = await handle.read(header, 0, 16, at)
      if (bytesRead < 8) return false
      let length = header.readUInt32BE(0)
      const type = header.toString('latin1', 4, 8)
      if (type === 'moof') return true
      if (length === 1) {
        if (bytesRead < 16) return false
        length = Number(header.readBigUInt64BE(8))
      } else if (length === 0) length = size - at
      if (length < 8) return false
      at += length
    }
    return false
  } finally {
    await handle.close()
  }
}

/**
 * The same streams in a plain MP4 (`.mp4`) or M4A, its index at the front: packets copied, nothing encoded. A reader
 * error stops it (`-xerror`): a damaged recording is conformed instead, which reads it as the import always has.
 */
export async function rewrap(input: string, out: string, opts: { seconds?: number; signal?: AbortSignal; audioOnly?: boolean } = {}): Promise<void> {
  const maps = opts.audioOnly ? ['-map', '0:a:0'] : ['-map', '0:v:0', '-map', '0:a:0?']
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-y', '-i', input, ...maps, '-c', 'copy', '-movflags', '+faststart', out], {
    timeout: mediaTimeout(opts.seconds ?? 600, 0.5),
    maxBuffer: 4 * 1024 * 1024,
    signal: opts.signal,
  })
}
