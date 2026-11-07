/**
 * Process plumbing for a worker: run the CLI under its profile, keep the tail
 * of its stderr for error messages, and kill what a job left behind.
 *
 * The CLI is NOT detached: it stays in the adapter's process group, which the
 * desktop kills on stop and quit. Fenced commands run detached in groups of
 * their own (host-folder-sandbox.ts), so a stop also walks the process table
 * below the adapter and kills those groups, like the launcher does below the
 * eve server.
 */
import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

/** The environment the CLI gets: built from scratch, like every other process the desktop starts. */
export function cliEnv(base: { home: string; path: string; lang: string; tmpdir: string; user?: string }, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    HOME: base.home,
    PATH: base.path,
    LANG: base.lang,
    TMPDIR: base.tmpdir,
    ...(base.user ? { USER: base.user, LOGNAME: base.user } : {}),
    TERM: 'dumb',
    NO_COLOR: '1',
    ...extra,
  }
}

export type CliChild = ChildProcessByStdio<Writable, Readable, Readable>

export interface CliSpawn {
  readonly profile: string
  readonly bin: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string>
}

/** Start the CLI under its Seatbelt profile, in this process's group. */
export function spawnCli(s: CliSpawn): CliChild {
  // A built-from-scratch env: cast because Next's global types make ProcessEnv require NODE_ENV (never set here).
  return spawn(SANDBOX_EXEC, ['-p', s.profile, s.bin, ...s.args], { cwd: s.cwd, env: s.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] })
}

/** The last `limit` characters a stream wrote, for an error message. */
export function tailBuffer(limit = 4000) {
  let text = ''
  return {
    push(chunk: string) {
      text = (text + chunk).slice(-limit)
    },
    get text() {
      return text.trim()
    },
  }
}

/** Run a short command (a version or help probe) to completion, bounded. */
export function runProbe(file: string, args: readonly string[], opts: { env: Record<string, string>; cwd: string; timeoutMs?: number }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, [...args], { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      if (stdout.length < 256 * 1024) stdout += d
    })
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      if (stderr.length < 64 * 1024) stderr += d
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 20_000)
    child.once('error', (err) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: stderr || err.message })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

/** Process groups (and pids) below `rootPid` in a `ps` table, never `ownPgid` (same rule as the launcher's). */
export function descendants(rows: readonly { pid: number; ppid: number; pgid: number }[], rootPid: number, ownPgid: number) {
  const kids = new Map<number, number[]>()
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid])
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const pids: number[] = []
  const queue = [...(kids.get(rootPid) ?? [])]
  while (queue.length) {
    const pid = queue.shift()!
    if (pids.includes(pid)) continue
    pids.push(pid)
    queue.push(...(kids.get(pid) ?? []))
  }
  const groups = [...new Set(pids.map((p) => byPid.get(p)!.pgid))].filter((g) => g !== ownPgid && g > 1)
  return { pids, groups }
}

function kill(target: number, signal: NodeJS.Signals) {
  try {
    process.kill(target, signal)
  } catch {
    // gone
  }
}

/**
 * Kill every process below this one (the CLI and whatever it left), and the
 * groups of fenced commands, but never this process's own group: the desktop
 * owns that, and this process still has a line to write.
 */
export function killBelow(rootPid: number = process.pid): void {
  try {
    const rows = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 1000 })
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number))
      .filter((r) => r.length === 3 && r.every(Number.isInteger))
      .map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }))
    const own = rows.find((r) => r.pid === process.pid)?.pgid ?? -1
    const { pids, groups } = descendants(rows, rootPid, own)
    for (const g of groups) kill(-g, 'SIGKILL')
    for (const p of pids) kill(p, 'SIGKILL')
  } catch {
    // ps unavailable: the fence's killAll and the desktop's group kill still apply
  }
}

/** Stop one child: SIGTERM, then SIGKILL after `graceMs`. Resolves when it has exited. */
export function stopChild(child: { exitCode: number | null; signalCode: NodeJS.Signals | null; kill(sig: NodeJS.Signals): boolean; once(ev: 'exit', fn: () => void): unknown }, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), graceMs)
    timer.unref?.()
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}
