/**
 * Which encoder settings work on this computer, found by trying them (the local runner, before each export, and the
 * desktop app's status: `runner.cjs --probe`): a second of a made-up picture at the export's size and rate encoded at
 * each rung of the machine's ladder (encoders.ts) in turn, and the first whose file is right is used. "Right" is what
 * every export is then held to (exportFacts): it decodes whole, has every frame at its time, the duration, the colour
 * labels in the MP4 and in the stream itself (VUI), and, here only, a quality floor against the picture it was given.
 * A ladder with no working rung: this computer cannot export, and the Studio uses the server.
 *
 * The server cannot check what a computer sends (it reads only the start of the file; the facts are the runner's), so
 * exportFacts runs on every local export's file (jobs/export.ts), not only in tests.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { run } from './media.ts'
import { toolPath } from './platform.ts'
import { encoderArgs, RUNGS, type EncoderProfile, type EncoderRung } from './encoders.ts'

/** The worst frame of the probe (a busy test card) against the picture it was given. */
export const PROBE_FLOOR_DB = 32

/** What an export's file must be (beyond decoding whole, which the export checks itself). */
export interface ExportShape { frames: number; fps: number; width: number; height: number }

/**
 * Why an export's file is not what it must be, or null: its frame count, every frame's time (i / fps, within a
 * millisecond), its duration (within a frame), its size, and its colour labels in the MP4 and in the H.264 stream
 * (VUI: primaries 1, transfer 13, matrix 1, limited range).
 */
export async function exportFacts(file: string, want: ExportShape, signal?: AbortSignal): Promise<string | null> {
  const probe = async (args: string[]) => (await run('ffprobe', ['-v', 'error', ...args, file], { signal, maxBuffer: 64 * 1024 * 1024, timeout: 600_000 })).stdout
  const stamps = (await probe(['-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0'])).split('\n').map((l) => Number(/[-\d.]+/.exec(l)?.[0])).filter((t) => Number.isFinite(t)).sort((a, b) => a - b)
  if (stamps.length !== want.frames) return `the file has ${stamps.length} frames, not ${want.frames}`
  const off = stamps.findIndex((t, i) => Math.abs(t - i / want.fps) > 0.001)
  if (off >= 0) return `frame ${off} is at ${stamps[off]} s, not ${(off / want.fps).toFixed(4)}`
  const s = JSON.parse(await probe(['-select_streams', 'v:0', '-show_entries', 'stream=width,height,color_space,color_primaries,color_transfer,color_range:format=duration', '-of', 'json'])) as
    { streams: { width: number; height: number; color_space?: string; color_primaries?: string; color_transfer?: string; color_range?: string }[]; format: { duration?: string } }
  const v = s.streams[0]
  if (!v || v.width !== want.width || v.height !== want.height) return `the picture is ${v?.width}×${v?.height}, not ${want.width}×${want.height}`
  if (Math.abs(Number(s.format.duration) - want.frames / want.fps) > 1.5 / want.fps) return `the file lasts ${s.format.duration} s, not ${(want.frames / want.fps).toFixed(3)}`
  if (v.color_space !== 'bt709' || v.color_primaries !== 'bt709' || v.color_transfer !== 'iec61966-2-1' || v.color_range !== 'tv') {
    return `its colour is labelled ${v.color_space}/${v.color_primaries}/${v.color_transfer}/${v.color_range}, not bt709/bt709/iec61966-2-1/tv`
  }
  // The stream's own labels (what a player that ignores the MP4's reads): the first keyframe's sequence header.
  const trace = spawnSync(toolPath('ffmpeg'), ['-nostdin', '-v', 'trace', '-i', file, '-map', '0:v:0', '-c', 'copy', '-bsf:v', 'trace_headers', '-frames:v', '1', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }).stderr
  const vui = (name: string) => Number(new RegExp(`${name}\\s+\\S+\\s+=\\s+(\\d+)`).exec(trace)?.[1] ?? NaN)
  const got = [vui('colour_primaries'), vui('transfer_characteristics'), vui('matrix_coefficients'), vui('video_full_range_flag')]
  if (got.join() !== '1,13,1,0') return `the stream itself says colour ${got.join('/')}, not 1/13/1/0`
  return null
}

export interface ProbeResult {
  profile: EncoderProfile
  /** The rung used, or null: nothing works here (export on the server). */
  rung: EncoderRung | null
  tried: { rung: EncoderRung; ok: boolean; why?: string; seconds: number; worstDb?: number }[]
}

/** Each rung of `profile`'s ladder tried on a second of made-up picture at this size and rate, until one is right. */
export async function probeEncoder(profile: EncoderProfile, shape: { width: number; height: number; fps: number }, scratch: string, signal?: AbortSignal): Promise<ProbeResult> {
  const rungs: EncoderRung[] = profile === 'videotoolbox' || profile === 'mf' ? [...RUNGS] : ['quality']
  const tried: ProbeResult['tried'] = []
  const dir = join(scratch, 'encoder-probe')
  await mkdir(dir, { recursive: true })
  const frames = shape.fps, w = shape.width, h = shape.height
  // A busy test card made BT.709 as recorders make their pictures, labelled as the composed frames are.
  const source = `testsrc2=s=${w}x${h}:r=${shape.fps}:d=1,format=yuv420p,setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709:range=tv`
  try {
    for (const rung of rungs) {
      const out = join(dir, `${rung}.mp4`), t0 = Date.now()
      try {
        await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', source, '-frames:v', String(frames), ...encoderArgs(profile, w, h, shape.fps, rung),
          '-r', String(shape.fps), '-video_track_timescale', '90000', out], { signal, timeout: 60_000 })
        await run('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', out, '-f', 'null', '-'], { signal, timeout: 60_000 })
        const why = await exportFacts(out, { frames, fps: shape.fps, width: w, height: h }, signal)
        if (why) { tried.push({ rung, ok: false, why, seconds: (Date.now() - t0) / 1000 }); continue }
        const per = await run('ffmpeg', ['-nostdin', '-v', 'error', '-i', out, '-f', 'lavfi', '-i', source, '-lavfi', '[0:v][1:v]psnr=stats_file=-', '-f', 'null', '-'], { signal, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
        const db = per.stdout.split('\n').map((l) => /psnr_avg:(\S+)/.exec(l)?.[1]).filter((x): x is string => !!x).map((x) => (x === 'inf' ? 99 : Number(x)))
        const worst = Math.min(...db)
        if (!(worst >= PROBE_FLOOR_DB)) { tried.push({ rung, ok: false, why: `its worst frame is ${worst.toFixed(1)} dB (at least ${PROBE_FLOOR_DB})`, seconds: (Date.now() - t0) / 1000, worstDb: worst }); continue }
        tried.push({ rung, ok: true, seconds: (Date.now() - t0) / 1000, worstDb: +worst.toFixed(2) })
        return { profile, rung, tried }
      } catch (err) {
        if (signal?.aborted) throw err
        tried.push({ rung, ok: false, why: String((err as Error)?.message ?? err).split('\n')[0]!.slice(0, 300), seconds: (Date.now() - t0) / 1000 })
      }
    }
    return { profile, rung: null, tried }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
