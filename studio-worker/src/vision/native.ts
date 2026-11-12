/**
 * macOS Vision for the Studio: three small Swift programs (../../native/) over
 * Apple's Vision framework, built with `swiftc` the first time they are needed
 * and run as child processes, each printing one JSON object a line.
 *
 *   subject-matte   a greyscale matte video of the person (or any main subject),
 *                   frame for frame with the recording (the cut-out job)
 *   face-track      face boxes a few times a second (the faces job)
 *   frame-subject   a person matte and face boxes of still frames
 *                   (facesAndPersonAt, ./subject.ts)
 *
 *   - macOS only. On any other system nothing is compiled, the capabilities are
 *     absent, and the worker never asks for `cutout` or `faces` jobs.
 *   - Built into the work folder (STUDIO_WORK_DIR/native/<helper>/) and built
 *     again only when the source changes: a receipt beside the binary holds the
 *     source's sha256. Nothing is downloaded, at build or at run time: Vision's
 *     models ship with macOS.
 *   - At start the worker builds all three in the background and runs each once
 *     on a tiny made-up clip (a flat grey square: no person, no face) as a
 *     self-test (./probe.ts). Only then does it say `cutouts` and `faces`.
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { killGroup, minimalEnv } from '../child.ts'
import { PACKAGE_DIR } from '../config.ts'
import { JobError } from '../jobs/context.ts'
import { findBinary, run } from '../media.ts'

/** The helpers and their sources under native/. */
export const HELPERS = {
  'subject-matte': 'subject-matte/SubjectMatte.swift',
  'face-track': 'face-track/FaceTrack.swift',
  'frame-subject': 'frame-subject/FrameSubject.swift',
} as const
export type Helper = keyof typeof HELPERS

/** The Swift sources. */
export const NATIVE_DIR = resolve(PACKAGE_DIR, 'native')

/** A build takes a minute or two on a busy machine; more is a stuck compiler. */
const BUILD_TIMEOUT_MS = 300_000

/**
 * The Swift compiler, when this machine can build the helpers at all: macOS,
 * and a `swiftc` that answers `--version` (macOS ships a stub that only offers
 * to install the command-line tools). Null otherwise.
 */
export async function swiftCompiler(platform: NodeJS.Platform = process.platform): Promise<string | null> {
  if (platform !== 'darwin') return null
  const swiftc = findBinary('swiftc')
  if (!swiftc) return null
  try {
    await run(swiftc, ['--version'], { timeout: 30_000 })
    return swiftc
  } catch {
    return null
  }
}

/** The sha256 of a helper's source. */
export async function sourceDigest(helper: Helper): Promise<string> {
  return createHash('sha256').update(await readFile(join(NATIVE_DIR, HELPERS[helper]))).digest('hex')
}

/** Where a helper's binary lives in the work folder. Pure. */
export const helperPath = (workDir: string, helper: Helper) => join(workDir, 'native', helper, helper)

const builds = new Map<string, Promise<string>>()

/**
 * A helper's binary, built when it is missing or its source changed since the
 * last build. One build at a time per helper; a failed build is tried again on
 * the next call.
 */
export function helperBinary(workDir: string, helper: Helper, swiftc: string): Promise<string> {
  const key = `${workDir}\0${helper}`
  const pending = builds.get(key)
  if (pending) return pending
  const build = buildHelper(workDir, helper, swiftc).finally(() => builds.delete(key))
  builds.set(key, build)
  return build
}

async function buildHelper(workDir: string, helper: Helper, swiftc: string): Promise<string> {
  const dir = join(workDir, 'native', helper)
  const binary = helperPath(workDir, helper)
  const receipt = join(dir, 'build-receipt.json')
  const digest = await sourceDigest(helper)
  try {
    const saved = JSON.parse(await readFile(receipt, 'utf8')) as { sourceDigest?: string }
    if (saved.sourceDigest === digest && (await stat(binary)).isFile()) return binary
  } catch {
    // build it
  }
  await mkdir(dir, { recursive: true })
  const staging = join(dir, `${helper}-${randomUUID()}`)
  console.info(`[studio-worker] building the ${helper} helper (swiftc)`)
  try {
    // No signing needed: the helpers only read and write files.
    await run(swiftc, ['-parse-as-library', '-O', '-swift-version', '5', '-module-cache-path', join(dir, 'modules'), '-o', staging, join(NATIVE_DIR, HELPERS[helper])], {
      timeout: BUILD_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    })
    await rename(staging, binary)
  } finally {
    await rm(staging, { force: true }).catch(() => undefined)
  }
  await writeFile(receipt, JSON.stringify({ sourceDigest: digest }) + '\n')
  return binary
}

/** Each JSON object line of a helper's output, as it comes; the rest of the text is kept for the next chunk. Pure. */
export function jsonLines(buffered: string, chunk: string): { lines: Record<string, unknown>[]; rest: string } {
  const parts = (buffered + chunk).split('\n')
  const rest = parts.pop() ?? ''
  const lines: Record<string, unknown>[] = []
  for (const part of parts) {
    const text = part.trim()
    if (!text.startsWith('{')) continue
    try {
      const value = JSON.parse(text) as unknown
      if (value && typeof value === 'object' && !Array.isArray(value)) lines.push(value as Record<string, unknown>)
    } catch {
      // not JSON: a warning of the compiler's runtime, skipped
    }
  }
  return { lines, rest }
}

/**
 * Run a helper, handing each JSON line it prints to `onLine`. It fails with the
 * helper's own sentence when it prints `{"error": …}` and exits non-zero; the
 * signal (a cancelled job) and the timeout stop it (SIGTERM to its process
 * group, SIGKILL after a grace period). It runs with a minimal environment.
 */
export function runHelper(
  binary: string,
  args: string[],
  onLine: (line: Record<string, unknown>) => void,
  opts: { signal?: AbortSignal; timeout?: number } = {},
): Promise<void> {
  return new Promise((done, fail) => {
    const name = binary.replace(/^.*\//, '')
    if (opts.signal?.aborted) return fail(new JobError(`${name} stopped: the job was cancelled`))
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: minimalEnv() })
    let rest = ''
    let stderr = ''
    let said = ''
    let killedBy: 'signal' | 'timeout' | null = null
    const kill = (why: 'signal' | 'timeout') => {
      if (killedBy) return
      killedBy = why
      killGroup(child.pid, 3000)
    }
    const onAbort = () => kill('signal')
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = opts.timeout ? setTimeout(() => kill('timeout'), opts.timeout) : null
    const take = (chunk: string) => {
      const out = jsonLines(rest, chunk)
      rest = out.rest
      for (const line of out.lines) {
        if (typeof line.error === 'string') said = line.error
        else onLine(line)
      }
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', take)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000)
    })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fail(new JobError(`${name} could not start: ${err.message}`))
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      take('\n')
      if (killedBy === 'signal') return fail(new JobError(`${name} stopped: the job was cancelled`))
      if (killedBy === 'timeout') return fail(new JobError(`${name} took too long and was stopped`))
      if (code === 0) return done()
      const why = said || stderr.trim().split('\n').slice(-3).join(' ') || `exit ${code}`
      fail(new JobError(`${name} failed: ${why.slice(0, 600)}`))
    })
  })
}
