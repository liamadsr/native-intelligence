/**
 * The analysis behind the measured checks: python/motion_analysis.py, run in a
 * Python that has numpy and OpenCV.
 *
 *   - Which Python: STUDIO_ANALYSIS_PYTHON when set, else `python3` on PATH. It
 *     is asked once, at start, to import both modules; when it can't, the
 *     worker offers neither `motionCheck` nor `review` and never asks for the
 *     `motion` and `review` jobs (the editor draws neither button).
 *   - On-screen text: the review reads it when a `tesseract` binary is on PATH
 *     (`STUDIO_ANALYSIS_TESSERACT` names another one); without it the review
 *     leaves on-screen text out and its report says so.
 *   - A run is the script with `-I` (isolated: no user site, no current folder
 *     on the path) and `--json`; its answer is the last line it prints. It runs
 *     with a minimal environment (../child.ts) in which OpenCV's FFmpeg may open
 *     local files and pipes only, in a process group of its own: the job's
 *     signal or its time limit stops it and the FFmpeg and tesseract it started.
 */
import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import type { StudioJobKind } from '../../web/src/lib/studio/server/job-contract.ts'
import { minimalEnv, runTool } from './child.ts'
import { PACKAGE_DIR, type WorkerConfig } from './config.ts'
import { JobError } from './jobs/context.ts'

/** The script and the reference films' measurements it compares against. */
export const ANALYSIS_SCRIPT = resolve(PACKAGE_DIR, 'python/motion_analysis.py')
export const REFERENCES_DIR = resolve(PACKAGE_DIR, 'python/references')

/** The job kinds that need the analysis, and the capability each one is offered as. */
export const ANALYSIS_KINDS: Partial<Record<StudioJobKind, 'motionCheck' | 'review'>> = { motion: 'motionCheck', review: 'review' }

/** What the start-up check found. */
export type AnalysisState = { python: string | null; tesseract: string | null; reason: string | null }

let state: AnalysisState = { python: null, tesseract: null, reason: 'not checked yet' }

/** What the worker found at start (the jobs read it). */
export const analysisState = (): AnalysisState => state

/** The capabilities told to the app: both checks when the analysis can run, none otherwise. Pure. */
export function analysisCapabilities(found: Pick<AnalysisState, 'python'>): string[] {
  return found.python ? ['motionCheck', 'review'] : []
}

/** The kinds a slot may ask for: the analysis kinds only while the analysis can run. Pure. */
export function allowedKinds(kinds: readonly StudioJobKind[], found: Pick<AnalysisState, 'python'>): StudioJobKind[] {
  return kinds.filter((k) => !ANALYSIS_KINDS[k] || !!found.python)
}

/** The script's answer: the last line that parses as a JSON object. Pure. */
export function lastJsonLine(text: string): Record<string, unknown> | null {
  const lines = text.trim().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line.startsWith('{')) continue
    try {
      const value = JSON.parse(line) as unknown
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
    } catch {
      // an earlier line, then
    }
  }
  return null
}

/** Ask a Python to import numpy and OpenCV. Answers its versions, or why not. */
export function probePython(python: string, timeoutMs = 30_000): Promise<{ ok: true; versions: string } | { ok: false; reason: string }> {
  return new Promise((done) => {
    execFile(python, ['-I', '-c', 'import cv2, numpy; print("OpenCV", cv2.__version__, "numpy", numpy.__version__)'], { timeout: timeoutMs, encoding: 'utf8', env: analysisEnv() }, (err, stdout, stderr) => {
      if (!err) return done({ ok: true, versions: stdout.trim() })
      const code = (err as NodeJS.ErrnoException).code
      const tail = String(stderr || '').trim().split('\n').at(-1) ?? ''
      done({ ok: false, reason: code === 'ENOENT' ? `${python} is not there` : tail || err.message })
    })
  })
}

/** An executable called `name` on PATH, or null. */
export async function onPath(name: string, path = process.env.PATH ?? ''): Promise<string | null> {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const file = join(dir, name)
    try {
      await access(file, constants.X_OK)
      return file
    } catch {
      // not here
    }
  }
  return null
}

/**
 * Find the analysis once, at start: the Python (set, or `python3`) and the text
 * reader. Logs one line either way. `probe` is replaceable for tests.
 */
export async function detectAnalysis(
  config: Pick<WorkerConfig, 'analysisPython'>,
  opts: { env?: NodeJS.ProcessEnv; probe?: typeof probePython } = {},
): Promise<AnalysisState> {
  const env = opts.env ?? process.env
  const probe = opts.probe ?? probePython
  const candidate = config.analysisPython ?? (await onPath('python3', env.PATH ?? ''))
  let found: AnalysisState
  if (!candidate) found = { python: null, tesseract: null, reason: 'no STUDIO_ANALYSIS_PYTHON and no python3 on PATH' }
  else {
    const answer = await probe(candidate)
    found = answer.ok ? { python: candidate, tesseract: null, reason: null } : { python: null, tesseract: null, reason: `${candidate} can't import numpy and OpenCV (${answer.reason})` }
    if (answer.ok) console.info(`[studio-worker] motion check and review on: ${candidate} (${answer.versions})`)
  }
  if (found.python) found.tesseract = env.STUDIO_ANALYSIS_TESSERACT?.trim() || (await onPath('tesseract', env.PATH ?? ''))
  if (!found.python) console.info(`[studio-worker] motion check and review off: ${found.reason}`)
  else if (!found.tesseract) console.info('[studio-worker] the review will not read on-screen text: no tesseract on PATH')
  state = found
  return found
}

/** Set what was found (tests). */
export function setAnalysisState(next: AnalysisState): void {
  state = next
}

/** The analysis script's environment: the minimal one, OpenCV's FFmpeg fenced to local files and pipes. Pure over `env`. */
export function analysisEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return minimalEnv({ OPENCV_FFMPEG_CAPTURE_OPTIONS: 'protocol_whitelist;file,pipe', PYTHONDONTWRITEBYTECODE: '1' }, env)
}

/**
 * Run the script with these arguments and answer its JSON. Fails with the
 * script's last words; a cancelled job (or the time limit) stops it and
 * everything it started.
 */
export async function runAnalysis(args: string[], opts: { signal: AbortSignal; timeoutMs: number; python?: string | null }): Promise<Record<string, unknown>> {
  const python = opts.python ?? state.python
  if (!python) throw new JobError(`The motion analysis can't run on this worker: ${state.reason ?? 'no Python with numpy and OpenCV'}`)
  const r = await runTool(python, ['-I', ANALYSIS_SCRIPT, ...args, '--json'], { env: analysisEnv(), signal: opts.signal, timeout: opts.timeoutMs })
  if (opts.signal.aborted || r.stopped === 'signal') throw new JobError('Cancelled')
  if (r.stopped === 'timeout') throw new JobError('The motion analysis took too long and was stopped')
  const answer = r.code === 0 ? lastJsonLine(r.stdout) : null
  if (answer) return answer
  const tail = r.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 600)
  throw new JobError(`The motion analysis failed${tail ? `: ${tail}` : ` (exit ${r.code})`}`)
}
