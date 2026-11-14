/**
 * Process plumbing for a worker: run the agent under its profile, keep the
 * tail of its stderr for error messages, and kill what a job left behind.
 *
 * The agent is NOT detached: it stays in the adapter's process group, which
 * the desktop kills on stop and quit. Commands it runs may move into groups of
 * their own, so a stop also walks the process table below the adapter and
 * kills those groups, like the launcher does below the eve server.
 */
import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

/**
 * The environment the agent gets: built from scratch, like every other
 * process the desktop starts. `NO_BROWSER`: an agent never opens a sign-in
 * page (the person signs in in Terminal); `GIT_OPTIONAL_LOCKS=0`: `git status`
 * never tries to take a lock in the repository's read-only `.git`.
 */
export function agentEnv(base: { home: string; path: string; lang: string; tmpdir: string; user?: string }, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    HOME: base.home,
    PATH: base.path,
    LANG: base.lang,
    TMPDIR: base.tmpdir,
    ...(base.user ? { USER: base.user, LOGNAME: base.user } : {}),
    SHELL: '/bin/zsh',
    TERM: 'dumb',
    NO_COLOR: '1',
    NO_BROWSER: '1',
    GIT_OPTIONAL_LOCKS: '0',
    ...extra,
  }
}

export type AgentChild = ChildProcessByStdio<Writable, Readable, Readable>

/** Start `argv` under the Seatbelt `profile`, in this process's group. */
export function spawnSandboxed(profile: string, argv: readonly string[], opts: { cwd: string; env: Record<string, string> }): AgentChild {
  // A built-from-scratch env: cast because Next's global types make ProcessEnv require NODE_ENV (never set here).
  return spawn(SANDBOX_EXEC, ['-p', profile, ...argv], { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] })
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

/** Every process and process group below `rootPid` now (never this process's own group); empty when `ps` fails. */
export function processesBelow(rootPid: number = process.pid): { pids: number[]; groups: number[] } {
  try {
    const rows = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 1000 })
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number))
      .filter((r) => r.length === 3 && r.every(Number.isInteger))
      .map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }))
    const own = rows.find((r) => r.pid === process.pid)?.pgid ?? -1
    return descendants(rows, rootPid, own)
  } catch {
    // ps unavailable: the desktop's group kill still applies
    return { pids: [], groups: [] }
  }
}

/**
 * Kill every process below this one (the agent and whatever it left, in any
 * group), and `also` (a snapshot taken before the agent was stopped: once the
 * agent exits, its children belong to launchd and no walk from here finds
 * them), but never this process's own group: the desktop owns that, and this
 * process still has a line to write.
 */
export function killBelow(also: { pids: number[]; groups: number[] } = { pids: [], groups: [] }): void {
  const now = processesBelow()
  for (const g of new Set([...also.groups, ...now.groups])) kill(-g, 'SIGKILL')
  for (const p of new Set([...also.pids, ...now.pids])) kill(p, 'SIGKILL')
}
