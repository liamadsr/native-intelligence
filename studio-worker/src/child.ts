/**
 * Outside programs the worker starts (earshot's Python, the analysis Python, the generation tool, the Vision
 * helpers, the browsers): what they are given to run with, and how they are stopped.
 *
 *   - A minimal environment: PATH, HOME, TMPDIR and the locale, plus what each one names. Never the worker's own
 *     settings (STUDIO_*, its secret) or another provider's key.
 *   - Their own process group (detached), so a cancel or a time limit stops whatever they started too (FFmpeg under
 *     a Python script): SIGTERM to the group, then SIGKILL after a grace period.
 */
import { spawn } from 'node:child_process'
import { delimiter } from 'node:path'

/** What every outside program gets from the worker's environment, when set. */
const BASE_KEYS = ['HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'] as const

/**
 * A minimal environment: PATH (with the usual places Homebrew and Debian put tools), HOME, TMPDIR, the locale, and
 * `extra` (each value as given; undefined ones left out). Pure over `env`.
 */
export function minimalEnv(extra: Record<string, string | undefined> = {}, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const path = [...new Set([...(env.PATH ?? '').split(delimiter).filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])].join(delimiter)
  const out: NodeJS.ProcessEnv = { PATH: path }
  for (const key of BASE_KEYS) if (env[key]) out[key] = env[key]
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) out[key] = value
  return out
}

/** The variables of `env` whose names start with one of `prefixes` (a tool's own settings, e.g. FONTCONFIG_). Pure. */
export function pick(env: NodeJS.ProcessEnv, names: readonly string[], prefixes: readonly string[] = []): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) if (names.includes(key) || prefixes.some((p) => key.startsWith(p))) out[key] = value
  return out
}

export type ToolRun = { code: number | null; stdout: string; stderr: string; stopped: 'signal' | 'timeout' | null }

export type ToolOptions = {
  env: NodeJS.ProcessEnv
  cwd?: string
  signal?: AbortSignal
  /** Milliseconds before the group is stopped (none: no limit). */
  timeout?: number
  /** Written to its standard input, which is then closed (none: no input). */
  input?: string
  /** Each chunk of standard output as it comes (the whole output is answered too unless `keepStdout` is false). */
  onStdout?: (chunk: string) => void
  keepStdout?: boolean
  /** Between SIGTERM and SIGKILL. */
  graceMs?: number
  /** At most this much standard output is kept (the rest stops the run). */
  maxBuffer?: number
}

/** Stop a process group: SIGTERM now, SIGKILL after `graceMs` if it is still there. */
export function killGroup(pid: number | undefined, graceMs = 3000): void {
  if (!pid) return
  const send = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig)
    } catch {
      // gone already
    }
  }
  send('SIGTERM')
  setTimeout(() => send('SIGKILL'), graceMs).unref()
}

/**
 * Run a program in a process group of its own and collect what it said. Never rejects for a non-zero exit: the
 * caller reads `code`, `stopped` and `stderr`. Rejects only when it could not start (ENOENT and the like).
 */
export function runTool(cmd: string, args: string[], opts: ToolOptions): Promise<ToolRun> {
  return new Promise((done, fail) => {
    if (opts.signal?.aborted) return done({ code: null, stdout: '', stderr: '', stopped: 'signal' })
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let stopped: ToolRun['stopped'] = null
    const max = opts.maxBuffer ?? 64 * 1024 * 1024
    const stop = (why: 'signal' | 'timeout') => {
      if (stopped) return
      stopped = why
      killGroup(child.pid, opts.graceMs ?? 3000)
    }
    const onAbort = () => stop('signal')
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = opts.timeout ? setTimeout(() => stop('timeout'), opts.timeout) : null
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      opts.onStdout?.(chunk)
      if (opts.keepStdout === false) return
      stdout += chunk
      if (stdout.length > max) stop('timeout')
    })
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000)
    })
    const end = () => {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
    child.on('error', (err) => {
      end()
      fail(err)
    })
    child.on('close', (code) => {
      end()
      // Whatever it started and left behind goes with it.
      if (stopped) killGroup(child.pid, 0)
      done({ code, stdout, stderr, stopped })
    })
    if (opts.input !== undefined) {
      child.stdin!.on('error', () => undefined)
      child.stdin!.end(opts.input)
    }
  })
}
