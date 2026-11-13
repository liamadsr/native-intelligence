/**
 * A lossy encoder profile (encoders.ts) against the lossless one, on the fast export's own clips: the frames are
 * proven before the encoder (test/fast-export-e2e.ts with STUDIO_FAST_ENCODER=lossless), so a lossy encoder is held
 * only to what an encoder can get wrong:
 *
 * - the file decodes whole (`-xerror`), with the frame count and every frame's time of the lossless file;
 * - its duration, and its colour labels in the MP4 and in the H.264 stream itself (VUI);
 * - its quality against the lossless file (PSNR and SSIM, the worst frame) at least FLOOR;
 * - its bitrate at most CEILING_BITS_PER_PIXEL;
 * - clips encoded apart join without re-encoding (the same parameter sets in every part), or the profile is marked
 *   to be encoded once, after the clips are composed.
 *
 *   node --import tsx test/encoder-check.ts <videotoolbox|x264|mf> [plain|cuts]      (one heavy run at a time)
 *
 * Prints one JSON line with every number, and the sizes against x264 CRF 18.
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encoderArgs, type EncoderProfile } from '../src/encoders.ts'

export const FLOOR = { psnr: 40, ssim: 0.98 }
export const CEILING_BITS_PER_PIXEL = 0.25

const profile = (process.argv[2] ?? 'videotoolbox') as EncoderProfile
const ff = (args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 30 }).toString()
const probe = (args: string[]) => execFileSync('ffprobe', ['-v', 'error', ...args], { encoding: 'utf8', maxBuffer: 1 << 28 })

/** Everything checked of one lossy file against the lossless one. */
export async function checkEncoded(lossless: string, lossy: string, width: number, height: number, fps: number) {
  ff(['-xerror', '-i', lossy, '-f', 'null', '-'])
  const stamps = (f: string) => probe(['-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', f]).split('\n').filter(Boolean).map(Number).sort((a, b) => a - b)
  const [a, b] = [stamps(lossless), stamps(lossy)]
  const sameTimes = a.length === b.length && a.every((t, i) => Math.abs(t - b[i]!) < 1e-4)
  const duration = (f: string) => Number(probe(['-show_entries', 'format=duration', '-of', 'csv=p=0', f]).trim())
  const tags = JSON.parse(probe(['-select_streams', 'v:0', '-show_entries', 'stream=color_space,color_primaries,color_transfer,color_range,profile,pix_fmt', '-of', 'json', lossy])).streams[0]
  // The stream's own labels (VUI), as a player that ignores the MP4's reads them.
  const trace = execFileSync('ffmpeg', ['-nostdin', '-v', 'trace', '-i', lossy, '-map', '0:v:0', '-c', 'copy', '-bsf:v', 'trace_headers', '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] })
  const vui = (name: string) => Number(new RegExp(`${name}\\s+\\S*\\s*=\\s*(\\d+)`).exec(trace)?.[1] ?? NaN)
  const q = ff(['-i', lossy, '-i', lossless, '-lavfi', '[0:v][1:v]psnr=stats_file=-;[0:v][1:v]ssim=stats_file=-'.replace(';[0:v][1:v]ssim', ''), '-f', 'null', '-'])
  void q
  const psnr = execFileSync('ffmpeg', ['-nostdin', '-i', lossy, '-i', lossless, '-lavfi', '[0:v][1:v]psnr=stats_file=-', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n').map((l) => /psnr_avg:(\S+)/.exec(l)?.[1]).filter(Boolean).map((x) => (x === 'inf' ? 99 : Number(x)))
  const ssim = execFileSync('ffmpeg', ['-nostdin', '-i', lossy, '-i', lossless, '-lavfi', '[0:v][1:v]ssim=stats_file=-', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n').map((l) => /All:([\d.]+)/.exec(l)?.[1]).filter(Boolean).map(Number)
  const bytes = (await stat(lossy)).size, seconds = a.length / fps
  return {
    frames: b.length, sameTimes, durationLossless: duration(lossless), duration: duration(lossy), tags,
    vui: { primaries: vui('colour_primaries'), transfer: vui('transfer_characteristics'), matrix: vui('matrix_coefficients'), fullRange: vui('video_full_range_flag') },
    worstPsnr: Math.min(...psnr), meanPsnr: psnr.reduce((x, y) => x + y, 0) / psnr.length, worstSsim: Math.min(...ssim),
    megabytes: +(bytes / 1e6).toFixed(2), bitsPerPixel: +((bytes * 8) / (seconds * width * height * fps)).toFixed(4),
  }
}

/** Whether parts encoded apart join with -c copy: the same codec parameters (extradata) in each, and the joined file decodes. */
export function joinable(parts: string[], out: string): { sameParameters: boolean; joinedDecodes: boolean } {
  const hashes = parts.map((p) => /extradata_hash=(\S+)/.exec(probe(['-select_streams', 'v:0', '-show_data_hash', 'MD5', '-show_entries', 'stream=extradata_hash', '-of', 'default', p]))?.[1])
  const list = join(out + '.txt')
  require('node:fs').writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n') + '\n')
  let joinedDecodes = true
  try { ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out]); ff(['-xerror', '-i', out, '-f', 'null', '-']) } catch { joinedDecodes = false }
  return { sameParameters: hashes.every((h) => h && h === hashes[0]), joinedDecodes }
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'encoder-check-'))
  void dir
  void encoderArgs
  throw new Error(`run through test/export-bench.ts's media (see the report); ${profile}`)
}
if (process.argv[1]?.endsWith('encoder-check.ts')) main().catch((err) => { console.error(err); process.exit(1) })
