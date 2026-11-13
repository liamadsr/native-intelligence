/**
 * A lossy encoder profile (encoders.ts) against the lossless one, on the fast export's own clips. The frames are proven
 * before the encoder (test/fast-export-e2e.ts with STUDIO_FAST_ENCODER=lossless), so a lossy encoder is held only to
 * what an encoder can get wrong:
 *
 * - the clips encoded apart join without re-encoding (the same parameter sets in every part) and the joined file
 *   decodes whole (`-xerror`);
 * - the frame count and every frame's time are the lossless file's, and so is the duration;
 * - its colour labels, in the MP4 and in the H.264 stream itself (VUI, as a player that ignores the MP4 reads them);
 * - its quality against the lossless file: the worst frame's PSNR and SSIM at least FLOOR;
 * - its bitrate at most CEILING_BITS_PER_PIXEL.
 *
 *   node --import tsx test/encoder-check.ts <width> <height> <fps> <lossless parts…> -- <lossy parts…>
 *
 * Prints one JSON line with every number and whether each check holds (exit 1 if one does not).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { concatLine } from '../src/platform.ts'

/** What a lossy profile must reach against the lossless file (proposed from VideoToolbox on a Mac, the report's numbers). */
export const FLOOR = { psnr: 44, ssim: 0.99 }
/** At most this many bits a pixel a frame (x264 CRF 18 makes about 0.02 on a screen recording; 10× that is a broken rate control). */
export const CEILING_BITS_PER_PIXEL = 0.2

const ff = (args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 }).toString()
const probe = (args: string[]) => execFileSync('ffprobe', ['-v', 'error', ...args], { encoding: 'utf8', maxBuffer: 1 << 28 })
/** What FFmpeg wrote to standard error (trace_headers' report). */
const stderrOf = (args: string[]) => spawnSync('ffmpeg', ['-nostdin', ...args], { encoding: 'utf8', maxBuffer: 1 << 30 }).stderr

/** The parts joined as the fast export joins them (concat, `-c copy`). */
async function joined(parts: string[], out: string): Promise<void> {
  await writeFile(`${out}.txt`, parts.map(concatLine).join('\n') + '\n')
  ff(['-f', 'concat', '-safe', '0', '-i', `${out}.txt`, '-c', 'copy', '-movflags', '+faststart', out])
}

export async function checkProfile(width: number, height: number, fps: number, losslessParts: string[], lossyParts: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'encoder-check-'))
  const lossless = join(dir, 'lossless.mp4'), lossy = join(dir, 'lossy.mp4')
  const extradata = lossyParts.map((p) => /extradata_hash=(\S+)/.exec(probe(['-select_streams', 'v:0', '-show_data_hash', 'MD5', '-show_entries', 'stream=extradata_hash', '-of', 'default=nw=1', p]))?.[1] ?? '')
  await joined(losslessParts, lossless)
  await joined(lossyParts, lossy)
  let decodes = true
  try { ff(['-xerror', '-i', lossy, '-f', 'null', '-']) } catch { decodes = false }
  const stamps = (f: string) => probe(['-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', f]).split('\n').filter(Boolean).map(Number).sort((a, b) => a - b)
  const [a, b] = [stamps(lossless), stamps(lossy)]
  const duration = (f: string) => Number(probe(['-show_entries', 'format=duration', '-of', 'csv=p=0', f]).trim())
  const stream = JSON.parse(probe(['-select_streams', 'v:0', '-show_entries', 'stream=color_space,color_primaries,color_transfer,color_range,profile,pix_fmt,sample_aspect_ratio', '-of', 'json', lossy])).streams[0]
  const trace = stderrOf(['-v', 'trace', '-i', lossy, '-map', '0:v:0', '-c', 'copy', '-bsf:v', 'trace_headers', '-frames:v', '1', '-f', 'null', '-'])
  const vui = (name: string) => Number(new RegExp(`${name}\\s+\\S+\\s+=\\s+(\\d+)`).exec(trace)?.[1] ?? NaN)
  const psnrLines = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', lossy, '-i', lossless, '-lavfi', '[0:v][1:v]psnr=stats_file=-', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  const ssimLines = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', lossy, '-i', lossless, '-lavfi', '[0:v][1:v]ssim=stats_file=-', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  const psnr = psnrLines.split('\n').map((l) => /psnr_avg:(\S+)/.exec(l)?.[1]).filter((x): x is string => !!x).map((x) => (x === 'inf' ? 99 : Number(x)))
  const ssim = ssimLines.split('\n').map((l) => /All:([\d.]+)/.exec(l)?.[1]).filter((x): x is string => !!x).map(Number)
  const bytes = (await stat(lossy)).size, seconds = a.length / fps
  const r = {
    parts: lossyParts.length, sameParameters: extradata.every((h) => h && h === extradata[0]), decodes,
    frames: b.length, framesLossless: a.length, sameTimes: a.length === b.length && a.every((t, i) => Math.abs(t - b[i]!) < 1e-4),
    duration: duration(lossy), durationLossless: duration(lossless), stream,
    vui: { primaries: vui('colour_primaries'), transfer: vui('transfer_characteristics'), matrix: vui('matrix_coefficients'), fullRange: vui('video_full_range_flag') },
    worstPsnr: +Math.min(...psnr).toFixed(2), meanPsnr: +(psnr.reduce((x, y) => x + y, 0) / psnr.length).toFixed(2), worstSsim: +Math.min(...ssim).toFixed(4),
    megabytes: +(bytes / 1e6).toFixed(2), mbitPerSecond: +((bytes * 8) / seconds / 1e6).toFixed(1), bitsPerPixel: +((bytes * 8) / (seconds * width * height * fps)).toFixed(4),
  }
  const failed = [
    !r.sameParameters && 'parameter sets differ between parts', !r.decodes && 'does not decode', r.frames !== r.framesLossless && 'frame count', !r.sameTimes && 'frame times',
    Math.abs(r.duration - r.durationLossless) > 1 / fps && 'duration',
    (stream.color_space !== 'bt709' || stream.color_primaries !== 'bt709' || stream.color_transfer !== 'iec61966-2-1' || stream.color_range !== 'tv') && 'MP4 colour labels',
    (r.vui.primaries !== 1 || r.vui.transfer !== 13 || r.vui.matrix !== 1 || r.vui.fullRange !== 0) && 'H.264 VUI colour',
    r.worstPsnr < FLOOR.psnr && 'PSNR floor', r.worstSsim < FLOOR.ssim && 'SSIM floor', r.bitsPerPixel > CEILING_BITS_PER_PIXEL && 'bitrate ceiling',
  ].filter(Boolean)
  return { ...r, ok: failed.length === 0, failed }
}

if (process.argv[1]?.endsWith('encoder-check.ts')) {
  const [w, h, f, ...rest] = process.argv.slice(2)
  const cut = rest.indexOf('--')
  checkProfile(Number(w), Number(h), Number(f), rest.slice(0, cut), rest.slice(cut + 1))
    .then((r) => { console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1) })
    .catch((err) => { console.error(err); process.exit(1) })
}
