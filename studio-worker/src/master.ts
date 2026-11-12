/**
 * Mastering to a loudness target (web: -14 LUFS integrated, true peak at most
 * -1 dBTP): FFmpeg's EBU R128 loudnorm in two passes (measure, then a linear gain
 * where it fits, the limiter only where it must). The picture is copied as it is.
 */
import { copyFile } from 'node:fs/promises'
import { run } from './media.ts'

export type Master = { lufs: number; truePeak: number }

/**
 * loudnorm's target for a master, its numbers checked (a job's input names them: anything but a plain number in
 * range would be written into the filter graph). Pure.
 */
export function loudnessTarget(master: Master): string {
  const lufs = Number(master?.lufs), peak = Number(master?.truePeak)
  if (typeof master?.lufs !== 'number' || !Number.isFinite(lufs) || lufs < -70 || lufs > -5) throw new Error('The loudness target must be a number of LUFS between -70 and -5')
  if (typeof master?.truePeak !== 'number' || !Number.isFinite(peak) || peak < -9 || peak > 0) throw new Error('The true-peak target must be a number of dBTP between -9 and 0')
  return `I=${+lufs.toFixed(2)}:TP=${(peak - 0.5).toFixed(1)}:LRA=11`
}

/** loudnorm's second pass from its first pass's measurements, each checked to be a plain number. Pure. */
export function secondPass(target: string, m: ReturnType<typeof parseLoudnorm>): string {
  const num = (v: unknown) => {
    const t = String(v)
    if (!/^-?(\d+(\.\d+)?|inf)$/.test(t)) throw new Error(`loudnorm measured something that is not a number (${t.slice(0, 20)})`)
    return t
  }
  return `loudnorm=${target}:measured_I=${num(m.input_i)}:measured_TP=${num(m.input_tp)}:measured_LRA=${num(m.input_lra)}:measured_thresh=${num(m.input_thresh)}:offset=${num(m.target_offset)}:linear=true,aresample=48000`
}

/** The measurements loudnorm prints in its first pass (the last JSON object in what it says). Pure. */
export function parseLoudnorm(stderr: string): { input_i: string; input_tp: string; input_lra: string; input_thresh: string; target_offset: string } {
  const json = stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1)
  return JSON.parse(json)
}

/** The true peak (dBTP) an EBU R128 meter prints, or null for silence. Pure. */
export function parseTruePeak(stderr: string): number | null {
  const m = /True peak:\s*Peak:\s*(-?[\d.]+|-inf) dBFS/.exec(stderr)
  return m && m[1] !== '-inf' ? Number(m[1]) : null
}

export async function truePeak(file: string, signal?: AbortSignal): Promise<number | null> {
  const r = await run('ffmpeg', ['-nostdin', '-hide_banner', '-i', file, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { timeout: 600_000, maxBuffer: 32 * 1024 * 1024, signal })
  return parseTruePeak(r.stderr)
}

/** Master `input` (a video with sound) into `output`. Silence is copied as it is. */
export async function masterFile(input: string, output: string, master: Master, signal?: AbortSignal): Promise<{ before: number | null; after: number | null; truePeak?: number | null }> {
  // loudnorm lands up to ~0.3 dB over its true-peak target after resampling and encoding: aim 0.5 dB under it.
  const target = loudnessTarget(master)
  const probe = await run('ffmpeg', ['-nostdin', '-hide_banner', '-i', input, '-map', '0:a:0', '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-'], {
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
    signal,
  })
  const m = parseLoudnorm(probe.stderr)
  if (!Number.isFinite(Number(m.input_i)) || Number(m.input_i) < -70) {
    await copyFile(input, output)
    return { before: null, after: null }
  }
  const filter = secondPass(target, m)
  const encode = (extraDb: number) =>
    run(
      'ffmpeg',
      ['-nostdin', '-y', '-v', 'error', '-i', input, '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k',
        '-af', extraDb ? `${filter},volume=${extraDb.toFixed(2)}dB` : filter, '-movflags', '+faststart', output],
      { timeout: 600_000, maxBuffer: 4 * 1024 * 1024, signal },
    )
  await encode(0)
  // AAC overshoots on sharp transients (keys, ticks): measure the encoded file and pull it under the ceiling.
  let tp = await truePeak(output, signal)
  for (let pass = 0; tp !== null && tp > master.truePeak && pass < 2; pass++) {
    await encode(-(tp - master.truePeak + 0.2) * (pass + 1))
    tp = await truePeak(output, signal)
  }
  return { before: Number(m.input_i), after: master.lufs, truePeak: tp }
}
