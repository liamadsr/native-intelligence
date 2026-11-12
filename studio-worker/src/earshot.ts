/**
 * earshot: the sound tool the worker may have (an outside, MIT-licensed
 * project, pinned to a reviewed commit; README.md, "Sound"). It lives in its
 * own folder with its own Python environment (STUDIO_EARSHOT_DIR, holding
 * `.venv`), and the worker talks to it only through the bridge
 * (python/earshot_bridge.py): one JSON request on stdin, one JSON answer on
 * stdout, run with earshot's own Python in isolated mode (-I), with a minimal
 * environment (no worker setting, no provider key) and in a process group of
 * its own, so a cancel stops the FFmpeg it started too.
 *
 * The `sound` capability holds while a cheap call (the kit presets) answers;
 * ./providers/capabilities.ts asks at start and every few minutes.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { StudioJobKind } from '../../web/src/lib/studio/server/job-contract.ts'
import { minimalEnv, runTool } from './child.ts'
import { PACKAGE_DIR } from './config.ts'

/** The bridge script, in this package. */
export const BRIDGE = resolve(PACKAGE_DIR, 'python', 'earshot_bridge.py')

/** earshot's own Python inside its folder. */
export const earshotPython = (dir: string) => join(dir, '.venv', 'bin', 'python')

/** Whether the folder looks like an installed earshot (its Python is there). Cheap; the real check is checkEarshot. */
export const earshotInstalled = (dir: string | null): dir is string => !!dir && existsSync(earshotPython(dir))

export class BridgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgeError'
  }
}

/**
 * The bridge's answer from what it printed: the last line of stdout is the JSON answer; a failure says why (its own
 * `error`, else the end of what it said on stderr). Pure.
 */
export function parseBridgeAnswer<T>(code: number | null, stdout: string, stderr: string): T {
  let parsed: (T & { error?: unknown }) | null = null
  const last = stdout.trim().split('\n').at(-1) ?? ''
  try {
    parsed = last ? JSON.parse(last) : null
  } catch {
    parsed = null
  }
  if (code === 0 && parsed && typeof parsed === 'object' && !('error' in parsed && parsed.error)) return parsed
  const own = parsed && typeof parsed === 'object' && typeof parsed.error === 'string' ? parsed.error : null
  const tail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 600)
  throw new BridgeError(`earshot: ${own ?? (tail || `the bridge stopped (exit ${code})`)}`.slice(0, 1000))
}

export type BridgeOptions = {
  signal?: AbortSignal
  /** Milliseconds before it is stopped (default 10 minutes: listening loads models). */
  timeout?: number
  /** Where it runs (scratch). */
  cwd?: string
  /** Another interpreter or script (tests). */
  python?: string
  script?: string
}

/** earshot's environment: the minimal one (FFmpeg found where Homebrew and Debian put it) and its thread count. Pure over `env`. */
export function earshotEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return minimalEnv({ EARSHOT_THREADS: env.EARSHOT_THREADS ?? '3', PYTHONDONTWRITEBYTECODE: '1' }, env)
}

/** One request to the bridge: JSON in, JSON out. The signal and the timeout stop it and whatever it started. */
export async function bridge<T>(dir: string, request: Record<string, unknown>, opts: BridgeOptions = {}): Promise<T> {
  const python = opts.python ?? earshotPython(dir)
  let r
  try {
    r = await runTool(python, ['-I', opts.script ?? BRIDGE], { cwd: opts.cwd ?? dir, env: earshotEnv(), signal: opts.signal, timeout: opts.timeout ?? 600_000, input: JSON.stringify(request) })
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    throw new BridgeError(err.code === 'ENOENT' ? `earshot's Python is not at ${python}` : `earshot: ${err.message}`)
  }
  if (r.stopped) throw new BridgeError(`earshot stopped: ${r.stopped === 'signal' ? 'the job was cancelled' : 'timed out'}`)
  return parseBridgeAnswer<T>(r.code, r.stdout, r.stderr)
}

/** True when the presets answer (the bridge, earshot's Python and its packages all work). Never throws. */
export async function checkEarshot(dir: string | null, opts: Pick<BridgeOptions, 'python' | 'script'> = {}): Promise<boolean> {
  if (!dir || (!opts.python && !earshotInstalled(dir))) return false
  try {
    const answer = await bridge<{ presets?: Record<string, unknown> }>(dir, { cmd: 'presets' }, { ...opts, timeout: 60_000 })
    return !!answer.presets && Object.keys(answer.presets).length > 0
  } catch {
    return false
  }
}

// ---- the capability, and which jobs each slot asks for ---------------------------------------------------------

/** Sound design's kinds: the bank is quick (the provider slot); the rest are audio work (the media slots). */
export const SOUND_KINDS: readonly StudioJobKind[] = ['sounds', 'sound-import', 'listen', 'sound-bank']
const QUICK_SOUND_KINDS: readonly StudioJobKind[] = ['sound-bank']

/** How often earshot is asked again whether it answers. */
export const EARSHOT_RECHECK_MS = 5 * 60_000

/**
 * The kinds a slot asks for once sound design is taken into account: none of its kinds without a working earshot;
 * with one, the bank in the provider slot and the rest in the media slots (as configured). Pure.
 */
export function soundKindsFor(slot: 'media' | 'provider', kinds: readonly StudioJobKind[], configured: readonly StudioJobKind[], usable: boolean): StudioJobKind[] {
  const rest = kinds.filter((k) => !SOUND_KINDS.includes(k))
  if (!usable) return rest
  const mine = SOUND_KINDS.filter((k) => (slot === 'provider') === QUICK_SOUND_KINDS.includes(k) && configured.includes(k))
  return [...rest, ...mine]
}

/** Whether earshot answers, checked at start and every few minutes (never on every poll). */
export class EarshotWatch {
  usable = false
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly dir: string | null,
    private readonly check: (dir: string | null) => Promise<boolean> = checkEarshot,
  ) {}

  /** The capability as the app is told. */
  capabilities(): string[] {
    return this.usable ? ['sound'] : []
  }

  async refresh(): Promise<void> {
    const before = this.usable
    this.usable = this.dir ? await this.check(this.dir) : false
    if (before !== this.usable || (!this.usable && this.dir && !this.timer))
      console.info(`[studio-worker] sound design ${this.usable ? 'on: earshot answers' : `off: earshot does not answer in ${this.dir}`}`)
  }

  async start(): Promise<void> {
    if (!this.dir) return
    await this.refresh()
    this.timer = setInterval(() => void this.refresh(), EARSHOT_RECHECK_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
