/**
 * The e2e scripts' shared plumbing (e2e-dev.ts; e2e-device.ts keeps its own
 * copy, run and verified as it is): a redacted JSONL log, the step runner
 * (PASS / FAIL / SKIP / KNOWN-BUG, with timings), polling, the fixture folders
 * (a read folder and a git repo with a hook that must never run), and the
 * leftover-process check.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type Checks = Record<string, boolean>

export interface StepResult {
  step: string
  /** KNOWN-BUG: only checks a documented bug outside the script breaks failed. */
  result: 'PASS' | 'FAIL' | 'SKIP' | 'KNOWN-BUG'
  ms: number
  checks: Checks
  note?: string
}

export interface Harness {
  results: StepResult[]
  /** A value that must never reach the log (a token, a key). */
  secret(value: string | null | undefined): void
  redact(s: string): string
  record(phase: string, entry: Record<string, unknown>): void
  logLine(source: string): (line: string) => void
  /** Runs a step; answers whether it ran to the end (no exception or timeout), which later steps gate on. */
  step(name: string, fn: () => Promise<Checks>, opts?: { skipIf?: string | null }): Promise<boolean>
  summary(extra?: Record<string, unknown>): Record<string, unknown>
}

export function createHarness(opts: { logPath: string; home: string; knownBugs?: Record<string, string> }): Harness {
  const secrets: string[] = []
  const known = opts.knownBugs ?? {}
  const t0 = Date.now()
  const results: StepResult[] = []
  writeFileSync(opts.logPath, '')
  const redact = (s: string) => {
    let out = s.split(opts.home).join('~')
    for (const x of secrets) out = out.split(x).join('[redacted]')
    // Model tokens (la1.<payload>.<mac>) and chat-run tokens (<payload>.<sig>), whatever minted them.
    return out.replace(/la1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'la1.[redacted]').replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]+)?/g, '[jwt redacted]')
  }
  const record = (phase: string, entry: Record<string, unknown>) =>
    appendFileSync(opts.logPath, `${redact(JSON.stringify({ t: new Date().toISOString(), sinceStartMs: Date.now() - t0, phase, ...entry }))}\n`)
  return {
    results,
    secret(value) {
      if (value && value.length >= 8 && !secrets.includes(value)) secrets.push(value)
    },
    redact,
    record,
    logLine: (source) => (line) => record(source, { line }),
    async step(name, fn, o = {}) {
      if (o.skipIf) {
        results.push({ step: name, result: 'SKIP', ms: 0, checks: {}, note: o.skipIf })
        record('step', { step: name, result: 'SKIP', note: o.skipIf })
        console.log(`SKIP ${name}: ${o.skipIf}`)
        return false
      }
      const started = Date.now()
      let checks: Checks = {}
      let note: string | undefined
      try {
        checks = await fn()
      } catch (err) {
        note = err instanceof Error ? err.message : String(err)
      }
      const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)
      const ok = !note && failed.length === 0 && Object.keys(checks).length > 0
      const knownOnly = !note && failed.length > 0 && failed.every((k) => k in known)
      const result: StepResult['result'] = ok ? 'PASS' : knownOnly ? 'KNOWN-BUG' : 'FAIL'
      const detail = note ?? (failed.length ? `failed: ${failed.map((k) => (known[k] ? `${k} (${known[k].split(' ')[0]})` : k)).join(', ')}` : undefined)
      const r: StepResult = { step: name, result, ms: Date.now() - started, checks, ...(detail ? { note: detail } : {}) }
      results.push(r)
      record('step', { ...r })
      console.log(`${r.result} ${name} (${(r.ms / 1000).toFixed(1)} s)${r.note ? `: ${redact(r.note)}` : ''}`)
      return !note
    },
    summary(extra = {}) {
      const failed = results.filter((r) => r.result === 'FAIL').map((r) => r.step)
      const knownBug = results.filter((r) => r.result === 'KNOWN-BUG').map((r) => r.step)
      return {
        result: failed.length ? 'FAIL' : knownBug.length ? 'PASS (with known bugs)' : 'PASS',
        failed,
        known: knownBug,
        steps: results.map((r) => ({ step: r.step, result: r.result, s: Number((r.ms / 1000).toFixed(1)), ...(r.note ? { note: r.note } : {}) })),
        log: opts.logPath,
        ...extra,
      }
    },
  }
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function waitFor<T>(what: string, ms: number, probe: () => T | null | undefined | false | Promise<T | null | undefined | false>, every = 250): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const v = await probe()
    if (v) return v
    if (Date.now() > until) throw new Error(`timed out after ${Math.round(ms / 1000)} s waiting for ${what}`)
    await sleep(every)
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Processes still running from a run: the given pids, their descendants, and anything with `root` in its command. */
export function leftovers(pids: Iterable<number>, root: string, redact: (s: string) => string): string[] {
  let rows: Array<{ pid: number; ppid: number; cmd: string }> = []
  try {
    rows = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((l) => {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)
        return m ? { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] } : null
      })
      .filter((r): r is { pid: number; ppid: number; cmd: string } => r !== null)
  } catch {
    return []
  }
  const ours = new Set<number>([...pids].filter(alive))
  for (let grew = true; grew; ) {
    grew = false
    for (const r of rows) {
      if (ours.has(r.ppid) && !ours.has(r.pid)) {
        ours.add(r.pid)
        grew = true
      }
    }
  }
  return rows.filter((r) => ours.has(r.pid) || r.cmd.includes(root)).map((r) => `${r.pid} ${redact(r.cmd).slice(0, 120)}`)
}

export const FIXTURE_README = '# E2E fixture\n\nA tiny project for the local-agent e2e.\nIt has a README, a source file and some notes.\n'

export interface Fixtures {
  readFolder: string
  gitRepo: string
  hookMarker: string
  /** git outside the sandbox, deterministic: no global config, a fixed author. */
  hostGit(args: string[]): string
}

/** A read folder and a git repo (one commit, a pre-commit hook that must never run) under `root`. */
export function makeFixtures(root: string, home: string): Fixtures {
  const readFolder = join(root, 'e2e-read-folder')
  const gitRepo = join(root, 'ni-e2e-app')
  const hookMarker = join(root, 'hook-ran')
  const toolPath = [dirname(process.execPath), '/usr/bin', '/bin'].join(':')
  const hostGit = (gitArgs: string[]) =>
    execFileSync('git', ['-c', 'user.name=Native Intelligence e2e', '-c', 'user.email=e2e@dial8.invalid', '-c', 'init.defaultBranch=main', ...gitArgs], {
      encoding: 'utf8',
      // Cast: Next's global types make ProcessEnv require NODE_ENV, which git doesn't need.
      env: { PATH: toolPath, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } as Record<string, string> as NodeJS.ProcessEnv,
    })
  for (const dir of [readFolder, gitRepo]) {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'README.md'), FIXTURE_README)
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const answer = 42\n')
    writeFileSync(join(dir, 'notes.txt'), 'one\ntwo\nthree\n')
  }
  hostGit(['init', '-q', gitRepo])
  hostGit(['-C', gitRepo, 'add', '-A'])
  hostGit(['-C', gitRepo, 'commit', '-q', '-m', 'initial commit'])
  writeFileSync(join(gitRepo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch '${hookMarker}'\n`)
  chmodSync(join(gitRepo, '.git', 'hooks', 'pre-commit'), 0o755)
  return { readFolder, gitRepo, hookMarker, hostGit }
}
