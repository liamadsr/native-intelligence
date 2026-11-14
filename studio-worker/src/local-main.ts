/**
 * The local runner's command line (local.ts), as the desktop app starts it:
 *
 *   node runner.cjs --app <origin> --job <id> --out <file.mp4> --work <folder> [--no-upload] [--overwrite]
 *     [--ffmpeg <path> --ffprobe <path>] [--bundle <folder>] [--chrome <folder>] [--encoder videotoolbox|mf|x264]
 *
 * The token: STUDIO_LOCAL_TOKEN, else the first line of standard input. What happens comes out on standard output as
 * JSON lines (LocalEvent); the exit code is 0 when the video was made, 2 when cancelled, 1 otherwise. SIGTERM / SIGINT
 * (or, on Windows, the desktop app closing the job's Job Object) stops it; FFmpeg and Chrome go with it.
 */
import { createInterface } from 'node:readline'
import { parseArgs, runLocal, takeTokenFromEnv, type LocalEvent } from './local.ts'
import type { EncoderProfile } from './encoders.ts'
import { AppError } from './app-client.ts'

async function token(): Promise<string> {
  // Taken out of the environment at once: FFmpeg, ffprobe and Chrome inherit this process's environment.
  const fromEnv = takeTokenFromEnv(process.env)
  if (fromEnv) return fromEnv
  const rl = createInterface({ input: process.stdin })
  for await (const line of rl) { rl.close(); return line.trim() }
  return ''
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  let last: LocalEvent | null = null
  const emit = (e: LocalEvent) => { last = e; process.stdout.write(`${JSON.stringify(e)}\n`) }
  if ('problem' in args) { emit({ type: 'failed', error: String(args.problem), cancelled: false }); return 1 }
  if (args.probe === true) {
    // What this computer can encode with, for the desktop app to show (no job, no token): exit 0 when something works.
    const { localConfig } = await import('./local.ts')
    const { probeEncoder } = await import('./encoder-probe.ts')
    const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : undefined)
    try {
      const config = localConfig({ appUrl: 'http://127.0.0.1', workDir: s('work')!, ffmpeg: s('ffmpeg'), ffprobe: s('ffprobe'), encoder: s('encoder') as EncoderProfile | undefined })
      const r = await probeEncoder(config.fastEncoder, { width: Number(s('width') ?? 1920), height: Number(s('height') ?? 1080), fps: Number(s('fps') ?? 60) }, s('work')!)
      emit({ type: 'encoder', profile: r.profile, rung: r.rung, tried: r.tried })
      return r.rung ? 0 : 3
    } catch (err) {
      emit({ type: 'failed', error: String((err as Error)?.message ?? err).slice(0, 500), cancelled: false })
      return 1
    }
  }
  const t = await token()
  if (!t) { emit({ type: 'failed', error: 'no token', cancelled: false }); return 1 }
  const stop = new AbortController()
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => stop.abort(new Error('Stopped by the desktop app')))
  const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : undefined)
  try {
    await runLocal({ appUrl: s('app')!, token: t, jobId: s('job')!, destination: s('out')!, workDir: s('work')!, overwrite: args.overwrite === true, upload: args['no-upload'] !== true,
      ffmpeg: s('ffmpeg'), ffprobe: s('ffprobe'), bundleDir: s('bundle'), chrome: s('chrome'), encoder: s('encoder') as EncoderProfile | undefined, signal: stop.signal, emit })
    return 0
  } catch (err) {
    // Refused before the job was taken (a destination, a token): said here, the job untouched.
    // With the app's refusal code when the app refused (the take of a job another runner holds: NOT_HELD), for the desktop to match on.
    const code = err instanceof AppError ? err.code : err instanceof Error && err.cause instanceof AppError ? err.cause.code : null
    if ((last as LocalEvent | null)?.type !== 'failed') emit({ type: 'failed', error: String((err as Error)?.message ?? err).slice(0, 500), cancelled: false, ...(code ? { code } : {}) })
    const ended = last as LocalEvent | null
    return stop.signal.aborted || (ended?.type === 'failed' && ended.cancelled) ? 2 : 1
  }
}

main().then((code) => process.exit(code))
