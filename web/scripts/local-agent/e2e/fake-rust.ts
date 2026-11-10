/**
 * "Fake Rust": the desktop's `local_agent` module (desktop
 * src-tauri/src/local_agent/{mod,supervisor,config,git,ring,state}.rs) in
 * Node, for e2e-device.ts. It answers the same commands with the same JSON
 * shapes (serde camelCase) and runs the REAL launcher the way Rust does:
 *
 *   - spawn `<node> <agentDir>/launcher/launcher.ts`, cwd = the job dir
 *     (`<appData>/local-agent/jobs/<jobId>`, 0700), its own process group,
 *     an environment built from scratch (config.rs `launcher_env`): HOME,
 *     TMPDIR (`<realpath tmp>/dial8-local-agent/<jobId>`), LANG, PATH,
 *     LOCAL_AGENT_{JOB_ID,FOLDER,MODE,TOOL_PATH,DIR}, edit jobs'
 *     LOCAL_AGENT_EXTRA_READ, and either the relay pair
 *     (LOCAL_AGENT_MODEL_BASE_URL from the app's origin + the token) or, with
 *     no token, the dev env file;
 *   - a uuid `runId` per launcher process; the first line is `start`, or
 *     `resume` when the job (or the server, via `resume`) has a session;
 *   - a ring of the last 500 events per job, `seq` from 1, monotonic across
 *     the job's runs within this process's life (not persisted: a relaunch
 *     starts at 1, like the app);
 *   - stop: `{"type":"stop"}` then stdin EOF, SIGTERM the group at 5 s and
 *     SIGKILL at 7 s; after any exit, SIGKILL whatever is left of the group,
 *     then a `status` event with a `reason` (mod.rs `exit_outcome`);
 *   - edit jobs: `git worktree add -b dial8/<slug>-<jobShort> <root>/<jobId>
 *     <HEAD>` before the launch, and on the first turn boundary after a
 *     `finish`, `git add -A` + `git commit --allow-empty` with hooks off,
 *     then its own `branch` event with the next seq (git.rs);
 *   - state.json (grants, jobs, deviceId) persisted after every change; at
 *     load, a job left starting / running / waiting is `interrupted` (a
 *     parked one stays `waiting`);
 *   - parking (mod.rs, 0114464): a start or resume that finds the 3 slots
 *     taken parks the least recently active IDLE launcher, and one idle for
 *     10 min is parked too: stop + EOF, its own `cancelled` dropped, its exit
 *     `{status: waiting, reason: parked}`, `parked: true` in status;
 *   - the commit budget (git.rs, 82b533c) and the token rule (16 to 2048
 *     printable ASCII).
 *
 * Deviations, on purpose: the worktree root is a parameter (the e2e keeps it
 * inside its own temp folder instead of ~/.dial8/worktrees), the PATH is
 * config.rs's FALLBACK_PATH plus node's folder (no login-shell probe), git
 * runs config-free (GIT_CONFIG_GLOBAL=/dev/null, as the Rust tests' git_env
 * does) so the person's own git config can't change the run, and grants come
 * from `addGrant(path, mode)` (the native picker and its confirm stand-in).
 *
 * Dependency-free (node builtins only), so it also runs as its own process:
 * forked with E2E_FAKE_RUST_HOST=1 it serves the commands over the IPC
 * channel and sends `local-agent://event` payloads back, so the e2e can
 * SIGKILL it like an app crash.
 */
import { execFile, fork, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

// ── Shapes (serde camelCase, as Rust serializes them) ──────────────────────

export type GrantMode = 'read' | 'edit'
export type JobStatus = 'starting' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export interface Grant {
  id: string
  path: string
  label: string
  mode: GrantMode
  addedAt: string
  isGit: boolean
}

export interface Job {
  id: string
  grantId: string
  request: string
  sessionId?: string
  streamIndex?: number
  status: JobStatus
  createdAt: string
  endedAt?: string
  mode?: GrantMode
  runId?: string
  worktree?: string
  branch?: string
  gitDir?: string
  baseCommit?: string
  commit?: string
  /** Its idle launcher was parked: `waiting` with no process, resumable. */
  parked?: boolean
}

interface StateFile {
  version: number
  deviceId?: string
  grants: Grant[]
  jobs: Job[]
}

export interface Entry {
  seq: number
  runId?: string
  event: Record<string, unknown>
}

export interface EventPayload {
  jobId: string
  seq: number
  runId?: string
  event: Record<string, unknown>
}

export interface StartArgs {
  grantId: string
  request: string
  jobId?: string
  mode?: string
  modelToken?: string
  resume?: { eveSessionId: string; streamIndex: number }
}

export interface FakeRustConfig {
  /** `<app_data>`: state.json and the job dirs live in `<appData>/local-agent`. */
  appData: string
  /** Canonical HOME (the launcher's HOME and git's). */
  home: string
  /** Where edit jobs' worktrees go (Rust: ~/.dial8/worktrees). */
  worktreesRoot: string
  node: string
  agentDir: string
  /** The dev env file, passed as a path only (used when a job has no token). */
  envFile: string | null
  /** The app's API origin (Rust: tray::api_base_url()); the relay URL is built from it. */
  apiOrigin: string
  device: { name: string; appVersion: string }
  /** Test hooks: git config-free (the Rust tests' git_env). */
  gitEnv?: Record<string, string>
}

const STATE_VERSION = 1
const RING_CAP = 500
const MAX_RUNNING = 3
const MAX_TEXT_BYTES = 16 * 1024
const MAX_TOKEN_BYTES = 2 * 1024
/** The launcher's MODEL_TOKEN rule (mod.rs MIN_TOKEN_BYTES). */
const MIN_TOKEN_BYTES = 16
const IDLE_PARK_AFTER_MS = 10 * 60_000
const IDLE_CHECK_EVERY_MS = 30_000
const AWAIT_TURN_GRACE_MS = 120_000
const PARKED = 'parked'
const COMMIT_BUDGET = { maxFileBytes: 50 * 1024 * 1024, maxTotalBytes: 200 * 1024 * 1024, maxFiles: 20_000 }
const MAX_EVENT_BYTES = 64 * 1024
const MODEL_RELAY_PATH = '/api/local-agent/model'
const FALLBACK_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
const SAFE_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false']
const SUBJECT_MAX = 72
const DEFAULT_SUBJECT = "Changes from Native Intelligence's local agent"
const LOCK_FATAL = 'job already running'
const LOCK_ERROR =
  'this job is still running in another launcher (left over from an earlier run of the app); wait for it to finish, or end that process, then resume again'
const TIMING = { stopTermAfter: 5_000, stopKillAfter: 7_000, exitKillAfter: 2_600, exitGiveUpAfter: 2_900, resumeConfirmAfter: 20_000 }

/** mod.rs `check_token`. */
function tokenError(token: string): string | null {
  if (token.length < MIN_TOKEN_BYTES || token.length > MAX_TOKEN_BYTES || !/^[\x21-\x7e]+$/.test(token)) {
    return `modelToken must be ${MIN_TOKEN_BYTES} to ${MAX_TOKEN_BYTES} printable ASCII characters`
  }
  return null
}

const nowStamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const isActive = (s: JobStatus) => s === 'starting' || s === 'running' || s === 'waiting'
const FROM_LAUNCHER: ReadonlySet<string> = new Set(['starting', 'running', 'waiting', 'completed', 'failed', 'cancelled'])

function createPrivateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function canonicalOr(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** folder.rs `slug`. */
export function slug(label: string): string {
  let out = ''
  for (const ch of label) {
    const c = ch.toLowerCase()
    if (/^[a-z0-9]$/.test(c)) out += c
    else if (out && !out.endsWith('-')) out += '-'
    if (out.length >= 32) break
  }
  out = out.replace(/^-+|-+$/g, '')
  return out || 'job'
}

/** git.rs `branch_name`. */
export function branchName(label: string, jobId: string): string {
  const short = [...jobId].filter((c) => /[A-Za-z0-9]/.test(c)).slice(0, 8).join('').toLowerCase()
  return `dial8/${slug(label)}-${short}`
}

/** git.rs `commit_subject`. */
export function commitSubject(summary: string): string {
  const line = summary
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return DEFAULT_SUBJECT
  // eslint-disable-next-line no-control-regex
  const clean = line.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
  const chars = [...clean]
  if (chars.length <= SUBJECT_MAX) return clean
  return `${chars.slice(0, SUBJECT_MAX - 1).join('').trimEnd()}…`
}

/** git.rs `parse_numstat`. */
export function parseNumstat(out: string): { files: number; insertions: number; deletions: number } {
  const t = { files: 0, insertions: 0, deletions: 0 }
  for (const line of out.split('\n').filter((l) => l.trim())) {
    const [ins, del] = line.split('\t')
    t.files += 1
    t.insertions += Number.parseInt(ins, 10) || 0
    t.deletions += Number.parseInt(del, 10) || 0
  }
  return t
}

/** folder.rs `is_git_root`. */
export function isGitRoot(real: string): boolean {
  const dotGit = join(real, '.git')
  let meta
  try {
    meta = lstatSync(dotGit)
  } catch {
    return false
  }
  if (meta.isDirectory()) return existsSync(join(dotGit, 'HEAD'))
  if (meta.isFile() && meta.size < 4096) {
    try {
      return readFileSync(dotGit, 'utf8').startsWith('gitdir:')
    } catch {
      return false
    }
  }
  return false
}

export type StopKind = 'user' | 'app' | 'park'

/** git.rs `over_budget`. */
export function overBudget(changed: ReadonlyArray<[string, number]>): string | null {
  const b = COMMIT_BUDGET
  if (changed.length > b.maxFiles) return `${changed.length} changed files (the limit is ${b.maxFiles})`
  const big = changed.find(([, size]) => size > b.maxFileBytes)
  if (big) return `${big[0]} is ${Math.floor(big[1] / (1024 * 1024))} MB (the limit is ${b.maxFileBytes / (1024 * 1024)} MB a file)`
  const total = changed.reduce((n, [, size]) => n + size, 0)
  if (total > b.maxTotalBytes) return `the changes total ${Math.floor(total / (1024 * 1024))} MB (the limit is ${b.maxTotalBytes / (1024 * 1024)} MB)`
  return null
}

/** mod.rs `exit_outcome`. */
export function exitOutcome(
  current: JobStatus,
  stop: StopKind | null,
  info: { code: number | null; signal: string | null },
  fatal: string | null,
  hasSession: boolean,
): [JobStatus, string] {
  const describe = info.code !== null ? `exited with code ${info.code}` : info.signal ? `killed by signal ${info.signal}` : 'exited'
  if (stop === 'app') return ['interrupted', 'the app quit']
  if (stop === 'park') return hasSession ? ['waiting', PARKED] : ['failed', 'parked before it started a session']
  if (stop === 'user') return ['cancelled', info.code === 0 ? 'stopped' : `stopped (the launcher ${describe})`]
  if (fatal) return ['failed', fatal]
  if (isActive(current) && !hasSession) return ['failed', `the launcher ${describe} before it started a session`]
  if (isActive(current)) return ['interrupted', `the launcher ${describe}`]
  return [current, `the launcher ${describe}`]
}

// ── git (git.rs) ────────────────────────────────────────────────────────────

class Git {
  constructor(
    private readonly home: string,
    private readonly path: string,
    private readonly extraEnv: Record<string, string>,
  ) {}

  run(dir: string, args: string[]): Promise<string> {
    const what = args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? 'git'
    return new Promise((resolveRun, reject) => {
      execFile(
        'git',
        ['-C', dir, ...SAFE_CONFIG, ...args],
        {
          // Cast: Next's global types make ProcessEnv require NODE_ENV, which git never gets here.
          env: { HOME: this.home, PATH: this.path, LANG: 'en_US.UTF-8', GIT_TERMINAL_PROMPT: '0', ...this.extraEnv } as Record<string, string> as NodeJS.ProcessEnv,
          timeout: 120_000,
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
        },
        (err: Error | null, stdout: string, stderr: string) => {
          if (!err) return resolveRun(stdout)
          const e = String(stderr ?? '').trim()
          reject(new Error(e ? `git ${what} failed: ${e.slice(0, 600)}` : `git ${what} failed`))
        },
      )
    })
  }

  async repoGitDir(repo: string): Promise<string> {
    const real = realpathSync(repo)
    const top = (await this.run(real, ['rev-parse', '--show-toplevel'])).trim()
    if (realpathSync(resolve(real, top)) !== real) throw new Error(`${real} is not the root of its git repository`)
    const common = realpathSync(resolve(real, (await this.run(real, ['rev-parse', '--git-common-dir'])).trim()))
    if (basename(common) !== '.git' || !statSync(common).isDirectory()) {
      throw new Error(`edits need a regular git checkout; this one keeps its git data in ${common}`)
    }
    return common
  }

  async ensureWorktree(repo: string, gitDir: string, root: string, jobId: string, branch: string) {
    createPrivateDir(root)
    const realRoot = realpathSync(root)
    const dir = join(realRoot, jobId)
    if (existsSync(dir)) {
      checkWorktree(dir, gitDir)
      const b = (await this.run(dir, ['symbolic-ref', '--short', 'HEAD'])).trim()
      return { dir, branch: b, base: null as string | null }
    }
    let head: string
    try {
      head = (await this.run(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).trim()
    } catch {
      throw new Error('the repository has no commits yet; commit something first')
    }
    const exists = await this.run(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(
      () => true,
      () => false,
    )
    if (exists) {
      await this.run(repo, ['worktree', 'prune']).catch(() => '')
      await this.run(repo, ['worktree', 'add', '--quiet', dir, branch])
    } else {
      await this.run(repo, ['worktree', 'add', '--quiet', '-b', branch, dir, head])
    }
    checkWorktree(dir, gitDir)
    return { dir, branch, base: exists ? null : head }
  }

  /** git.rs `check_budget`: what `git add -A` would stage, sized from the file system. */
  async checkBudget(worktree: string) {
    const out = await this.run(worktree, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'])
    const changed: Array<[string, number]> = out
      .split('\0')
      .filter((r) => r.length > 3)
      .map((r) => r.slice(3))
      .map((path) => {
        let size = 0
        try {
          const m = lstatSync(join(worktree, path))
          size = m.isFile() ? m.size : 0
        } catch {
          // deleted
        }
        return [path, size] as [string, number]
      })
    const why = overBudget(changed)
    if (why) throw new Error(`the changes are too large to commit (${why}); nothing was committed, and they stay in ${worktree}`)
  }

  async commit(worktree: string, gitDir: string, base: string | null, summary: string) {
    checkWorktree(worktree, gitDir)
    await this.checkBudget(worktree)
    await this.run(worktree, ['add', '-A'])
    const subject = commitSubject(summary)
    const configured = (p: Promise<string>) => p.then((s) => s.trim().length > 0, () => false)
    const hasIdentity = (await configured(this.run(worktree, ['config', 'user.name']))) && (await configured(this.run(worktree, ['config', 'user.email'])))
    const args = hasIdentity ? [] : ['-c', 'user.name=Native Intelligence local agent', '-c', 'user.email=local-agent@dial8.ai']
    await this.run(worktree, [...args, 'commit', '--quiet', '--allow-empty', '-m', subject])
    const commit = (await this.run(worktree, ['rev-parse', 'HEAD'])).trim()
    const branch = (await this.run(worktree, ['symbolic-ref', '--short', 'HEAD'])).trim()
    const from = base ?? `${commit}~1`
    const stats = await this.run(worktree, ['diff', '--numstat', '--no-renames', '--no-ext-diff', '--no-textconv', from, commit]).then(
      parseNumstat,
      () => ({ files: 0, insertions: 0, deletions: 0 }),
    )
    return { branch, commit, filesChanged: stats.files, insertions: stats.insertions, deletions: stats.deletions, subject }
  }
}

function readLinkFile(file: string, base: string, prefix: string | null): string {
  const meta = lstatSync(file)
  if (!meta.isFile() || meta.size > 4096) throw new Error(`${file} is not a git link file`)
  const text = readFileSync(file, 'utf8').trim()
  let target = text
  if (prefix !== null) {
    if (!text.startsWith(prefix)) throw new Error(`${file} is not a git link file`)
    target = text.slice(prefix.length)
  }
  target = target.trim()
  return realpathSync(isAbsolute(target) ? target : join(base, target))
}

/** git.rs `check_worktree`. */
export function checkWorktree(dir: string, gitDir: string) {
  const gone = (why: string) => new Error(`this job's worktree is not usable (${why}); start a new job`)
  let d: string
  let g: string
  try {
    d = realpathSync(dir)
    g = realpathSync(gitDir)
  } catch (e) {
    throw gone(e instanceof Error ? e.message : String(e))
  }
  let admin: string
  try {
    admin = readLinkFile(join(d, '.git'), d, 'gitdir:')
  } catch (e) {
    throw gone(e instanceof Error ? e.message : String(e))
  }
  if (dirname(admin) !== join(g, 'worktrees')) throw gone(`it points at ${admin}`)
  let back: string
  try {
    back = readLinkFile(join(admin, 'gitdir'), admin, null)
  } catch (e) {
    throw gone(e instanceof Error ? e.message : String(e))
  }
  if (back !== join(d, '.git')) throw gone(`the repo lists it as ${back}`)
}

// ── The actor ───────────────────────────────────────────────────────────────

interface EditCtx {
  worktree: string
  gitDir: string
  base: string | null
}

interface Live {
  gen: number
  runId: string
  child: ChildProcess
  pid: number
  stop: StopKind | null
  stdinClosed: boolean
  /** The launcher last said anything, or was sent a message. */
  lastActive: number
  /** A message went to it and no status has come back yet. */
  awaitingTurnSince: number | null
  fatal: string | null
  resume: { reply: ((r: { ok: true; value: { jobId: string; runId: string } } | { ok: false; error: string }) => void) | null; prior: JobStatus } | null
  edit: EditCtx | null
  pendingCommit: string | null
  termTimer: NodeJS.Timeout | null
  killTimer: NodeJS.Timeout | null
}

export type Reply<T> = { ok: true; value: T } | { ok: false; error: string }

/** A line written to a launcher's stdin, as the e2e checks it (tokens redacted). */
export interface SentLine {
  jobId: string
  runId: string
  type: string
  text?: string
  policy?: string
  request?: string
  sessionId?: string
  streamIndex?: number
}

export class FakeRust {
  private state: StateFile
  private readonly live = new Map<string, Live>()
  private readonly preparing = new Map<string, { grantId: string; stopped: boolean }>()
  private readonly committing = new Set<string>()
  private readonly tokens = new Map<string, string>()
  private readonly rings = new Map<string, { items: Entry[]; next: number }>()
  private readonly evictedSeq = new Map<string, number>()
  private nextGen = 0
  private closing = false
  readonly sent: SentLine[] = []
  private readonly git: Git
  private readonly toolPath: string
  private readonly launcher: string

  constructor(
    private readonly cfg: FakeRustConfig,
    private readonly emit: (payload: EventPayload) => void,
    private readonly log: (line: string) => void,
  ) {
    const nodeDir = dirname(cfg.node)
    this.toolPath = FALLBACK_PATH.split(':').includes(nodeDir) ? FALLBACK_PATH : `${nodeDir}:${FALLBACK_PATH}`
    this.launcher = join(cfg.agentDir, 'launcher', 'launcher.ts')
    this.git = new Git(cfg.home, this.toolPath, cfg.gitEnv ?? {})
    this.state = this.load()
    // mod.rs's idle tick: park a launcher idle for 10 minutes.
    setInterval(() => {
      if (this.live.size > 0 && !this.closing) this.parkIdle()
    }, IDLE_CHECK_EVERY_MS).unref()
  }

  private get root() {
    return join(this.cfg.appData, 'local-agent')
  }
  private get stateFile() {
    return join(this.root, 'state.json')
  }
  private jobDir(id: string) {
    return join(this.root, 'jobs', id)
  }
  private jobTmp(id: string) {
    return join(canonicalOr(tmpdir()), 'dial8-local-agent', id)
  }

  private load(): StateFile {
    createPrivateDir(this.root)
    let s: StateFile = { version: STATE_VERSION, grants: [], jobs: [] }
    if (existsSync(this.stateFile)) s = JSON.parse(readFileSync(this.stateFile, 'utf8')) as StateFile
    let n = 0
    for (const job of s.jobs) {
      if (isActive(job.status) && !(job.parked && job.status === 'waiting')) {
        job.status = 'interrupted'
        job.endedAt = nowStamp()
        n++
      }
    }
    if (n > 0) this.log(`[local-agent] ${n} job(s) left running by the last run marked interrupted`)
    this.state = s
    this.save()
    return s
  }

  private save() {
    const tmp = `${this.stateFile}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    renameSync(tmp, this.stateFile)
  }

  private job(id: string) {
    return this.state.jobs.find((j) => j.id === id)
  }
  private grant(id: string) {
    return this.state.grants.find((g) => g.id === id)
  }

  // ── Commands ──

  device(): Reply<{ deviceId: string; name: string; platform: string; appVersion: string }> {
    if (!this.state.deviceId) {
      this.state.deviceId = randomUUID()
      this.log(`[local-agent] this Mac's device id is ${this.state.deviceId}`)
      this.save()
    }
    return { ok: true, value: { deviceId: this.state.deviceId, name: this.cfg.device.name, platform: 'macos', appVersion: this.cfg.device.appVersion } }
  }

  status(): Record<string, unknown> {
    const built = existsSync(join(this.cfg.agentDir, '.output', 'server', 'index.mjs'))
    return {
      available: true,
      node: this.cfg.node,
      agentDir: this.cfg.agentDir,
      built,
      grants: this.state.grants.map((g) => ({ ...g, isGit: isGitRoot(g.path) })),
      jobs: this.state.jobs.map((j) => {
        const live = this.live.get(j.id)
        const ring = this.rings.get(j.id)
        return {
          id: j.id,
          grantId: j.grantId,
          request: j.request,
          mode: j.mode ?? 'read',
          status: j.status,
          createdAt: j.createdAt,
          ...(j.endedAt ? { endedAt: j.endedAt } : {}),
          ...(j.sessionId ? { sessionId: j.sessionId } : {}),
          ...(j.streamIndex !== undefined ? { streamIndex: j.streamIndex } : {}),
          live: !!live,
          parked: !!j.parked && !live,
          lastSeq: ring ? ring.next - 1 : (this.evictedSeq.get(j.id) ?? 0),
          runId: live?.runId ?? j.runId,
          branch: j.branch,
          commit: j.commit,
        }
      }),
    }
  }

  /** The native picker + its "Allow changes" confirm, for a folder the e2e made. */
  addGrant(picked: string, mode: GrantMode): Reply<Grant> {
    const real = realpathSync(picked)
    const git = isGitRoot(real)
    const m: GrantMode = git ? mode : 'read'
    const existing = this.state.grants.find((g) => g.path === real)
    if (existing) {
      existing.mode = m
      existing.isGit = git
      this.save()
      return { ok: true, value: existing }
    }
    const grant: Grant = { id: randomUUID(), label: basename(real), path: real, mode: m, addedAt: nowStamp(), isGit: git }
    this.state.grants.push(grant)
    this.save()
    this.log(`[local-agent] granted ${grant.path} (${grant.mode}) as ${grant.id}`)
    return { ok: true, value: grant }
  }

  async start(args: StartArgs): Promise<Reply<{ jobId: string; runId: string }>> {
    // StartArgs::check
    if (args.jobId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(args.jobId)) {
      return { ok: false, error: 'jobId must be a lowercase uuid' }
    }
    let mode: GrantMode | null = null
    if (args.mode !== undefined) {
      if (args.mode !== 'read' && args.mode !== 'edit') return { ok: false, error: 'mode must be "read" or "edit"' }
      mode = args.mode
    }
    if (args.modelToken !== undefined) {
      const err = tokenError(args.modelToken)
      if (err) return { ok: false, error: err }
    }
    const textErr = checkText(args.request, 'request')
    if (textErr) return { ok: false, error: textErr }

    // plan_start
    const jobId = args.jobId ?? randomUUID()
    const existing = this.job(jobId)
    if (existing) {
      if (existing.grantId !== args.grantId) return { ok: false, error: 'this job runs in another folder' }
      if (mode && mode !== (existing.mode ?? 'read')) return { ok: false, error: `this job runs in ${existing.mode ?? 'read'} mode` }
    }
    const running = this.live.get(jobId)
    if (running) {
      if (running.stop) return { ok: false, error: 'this job is stopping; try again once it has stopped' }
      if (args.modelToken) {
        this.writeLine(jobId, running, { type: 'token', modelToken: args.modelToken })
        this.tokens.set(jobId, args.modelToken)
      }
      return { ok: true, value: { jobId, runId: running.runId } }
    }
    if (this.preparing.has(jobId)) return { ok: false, error: 'this job is already starting' }
    const cap = this.canLaunch()
    if (cap) return { ok: false, error: cap }
    const grant = this.grant(args.grantId)
    if (!grant) return { ok: false, error: 'unknown folder' }
    let folder: string
    try {
      folder = realpathSync(grant.path)
    } catch (e) {
      return { ok: false, error: `the folder is gone: ${e instanceof Error ? e.message : String(e)}` }
    }
    const jobMode: GrantMode = existing?.mode ?? mode ?? 'read'
    if (jobMode === 'edit' && grant.mode !== 'edit') {
      return { ok: false, error: 'this folder was shared read-only; pick it again and allow changes to edit it' }
    }
    let editPlan: { repo: string; branch: string } | null = null
    if (jobMode === 'edit') {
      if (!isGitRoot(folder)) return { ok: false, error: "edits need the folder to be a git repository's root" }
      editPlan = { repo: folder, branch: existing?.branch ?? branchName(grant.label, jobId) }
    }
    const room = this.makeRoom(jobId)
    if (room) return { ok: false, error: room }
    this.preparing.set(jobId, { grantId: grant.id, stopped: false })

    // prepare_edit (outside the actor in Rust)
    let prepared: { worktree: { dir: string; branch: string; base: string | null }; gitDir: string } | null = null
    let prepError: string | null = null
    if (editPlan) {
      try {
        const gitDir = await this.git.repoGitDir(editPlan.repo)
        const worktree = await this.git.ensureWorktree(editPlan.repo, gitDir, this.cfg.worktreesRoot, jobId, editPlan.branch)
        prepared = { worktree, gitDir }
      } catch (e) {
        prepError = e instanceof Error ? e.message : String(e)
      }
    }

    // launch_start
    const stopped = this.preparing.get(jobId)?.stopped ?? false
    this.preparing.delete(jobId)
    if (prepError) return { ok: false, error: prepError }
    if (stopped) return { ok: false, error: 'stopped before it started' }
    if (this.closing) return { ok: false, error: 'Native Intelligence is quitting' }
    let launchFolder = folder
    let edit: EditCtx | null = null
    if (jobMode === 'edit' && prepared) {
      launchFolder = realpathSync(prepared.worktree.dir)
      if (!launchFolder.startsWith(`${realpathSync(this.cfg.worktreesRoot)}/`)) return { ok: false, error: `${launchFolder} is not one of Native Intelligence's worktrees` }
    }
    const first =
      existing?.sessionId !== undefined
        ? { type: 'resume', sessionId: existing.sessionId, streamIndex: existing.streamIndex ?? 0 }
        : args.resume
          ? { type: 'resume', sessionId: args.resume.eveSessionId, streamIndex: args.resume.streamIndex }
          : { type: 'start', request: args.request }
    const isNew = !existing
    if (isNew) {
      const job: Job = { id: jobId, grantId: grant.id, request: args.request, status: 'starting', createdAt: nowStamp(), ...(jobMode === 'edit' ? { mode: 'edit' as const } : {}) }
      if (args.resume) {
        job.sessionId = args.resume.eveSessionId
        job.streamIndex = args.resume.streamIndex
      }
      this.state.jobs.push(job)
    }
    const job = this.job(jobId)!
    if (prepared) {
      job.worktree = launchFolder
      job.branch = prepared.worktree.branch
      job.gitDir = prepared.gitDir
      if (!job.baseCommit && prepared.worktree.base) job.baseCommit = prepared.worktree.base
      edit = { worktree: prepared.worktree.dir, gitDir: prepared.gitDir, base: job.baseCommit ?? null }
    }
    if (args.modelToken) this.tokens.set(jobId, args.modelToken)
    try {
      const runId = this.launch(jobId, launchFolder, jobMode, first, edit)
      job.status = 'starting'
      delete job.endedAt
      this.save()
      return { ok: true, value: { jobId, runId } }
    } catch (e) {
      if (isNew) this.state.jobs = this.state.jobs.filter((j) => j.id !== jobId)
      this.save()
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  resume(jobId: string, modelToken?: string | null): Promise<Reply<{ jobId: string; runId: string }>> {
    const job = this.job(jobId)
    if (!job) return Promise.resolve({ ok: false, error: 'unknown job' })
    if (this.live.has(jobId)) return Promise.resolve({ ok: false, error: 'this job is already running' })
    if (this.preparing.has(jobId)) return Promise.resolve({ ok: false, error: 'this job is already starting' })
    const cap = this.canLaunch()
    if (cap) return Promise.resolve({ ok: false, error: cap })
    if (!job.sessionId) return Promise.resolve({ ok: false, error: 'this job never started a session; start a new one' })
    const grant = this.grant(job.grantId)
    if (!grant) return Promise.resolve({ ok: false, error: 'its folder is no longer shared; add it again and start a new job' })
    let folder = realpathSync(grant.path)
    let edit: EditCtx | null = null
    if ((job.mode ?? 'read') === 'edit') {
      if (!job.worktree || !job.gitDir) return Promise.resolve({ ok: false, error: 'this edit job has no worktree; start a new one' })
      try {
        checkWorktree(job.worktree, job.gitDir)
      } catch (e) {
        return Promise.resolve({ ok: false, error: e instanceof Error ? e.message : String(e) })
      }
      folder = realpathSync(job.worktree)
      edit = { worktree: folder, gitDir: job.gitDir, base: job.baseCommit ?? null }
    }
    if (!existsSync(this.jobDir(jobId))) return Promise.resolve({ ok: false, error: "this job's data is gone" })
    const room = this.makeRoom(jobId)
    if (room) return Promise.resolve({ ok: false, error: room })
    if (modelToken) {
      const err = tokenError(modelToken)
      if (err) return Promise.resolve({ ok: false, error: err })
      this.tokens.set(jobId, modelToken)
    }
    const prior = job.status
    let runId: string
    try {
      runId = this.launch(jobId, folder, job.mode ?? 'read', { type: 'resume', sessionId: job.sessionId, streamIndex: job.streamIndex ?? 0 }, edit)
    } catch (e) {
      return Promise.resolve({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }
    job.status = 'starting'
    delete job.endedAt
    this.save()
    // await_resume: answer on the launcher's `session` line, a fatal, or after 20 s.
    return new Promise((resolveResume) => {
      const live = this.live.get(jobId)
      if (!live) return resolveResume({ ok: true, value: { jobId, runId } })
      const timer = setTimeout(() => this.confirmResume(jobId), TIMING.resumeConfirmAfter)
      live.resume = {
        prior,
        reply: (r) => {
          clearTimeout(timer)
          resolveResume(r)
        },
      }
    })
  }

  setModelToken(jobId: string, token: string): Reply<null> {
    const err = tokenError(token)
    if (err) return { ok: false, error: err }
    if (!this.job(jobId) && !this.preparing.has(jobId)) return { ok: false, error: 'unknown job' }
    const live = this.live.get(jobId)
    if (live && !live.stop) this.writeLine(jobId, live, { type: 'token', modelToken: token })
    this.tokens.set(jobId, token)
    return { ok: true, value: null }
  }

  send(jobId: string, text: string, policy: string): Reply<null> {
    if (policy !== 'steer' && policy !== 'queue') return { ok: false, error: 'policy must be "steer" or "queue"' }
    const live = this.live.get(jobId)
    if (!live) return { ok: false, error: this.job(jobId) ? "this job isn't running; resume it first" : 'unknown job' }
    if (live.stop) return { ok: false, error: 'this job is stopping' }
    const err = checkText(text, 'message')
    if (err) return { ok: false, error: err }
    if (!this.writeLine(jobId, live, { type: 'send', text, policy })) return { ok: false, error: "this job isn't running" }
    // A turn is coming: not idle, so never parked under the message.
    live.lastActive = Date.now()
    live.awaitingTurnSince = live.lastActive
    return { ok: true, value: null }
  }

  stop(jobId: string): Reply<null> {
    const p = this.preparing.get(jobId)
    if (p) {
      p.stopped = true
      return { ok: true, value: null }
    }
    if (!this.job(jobId)) return { ok: false, error: 'unknown job' }
    const live = this.live.get(jobId)
    if (live && !live.stop) {
      this.log(`[local-agent:${jobId}] stop requested`)
      live.stop = 'user'
      this.stopLine(jobId, live)
      live.termTimer = setTimeout(() => this.signalGroup(live.pid, 'SIGTERM'), TIMING.stopTermAfter)
      live.killTimer = setTimeout(() => this.signalGroup(live.pid, 'SIGKILL'), TIMING.stopKillAfter)
    }
    return { ok: true, value: null }
  }

  events(jobId: string, since: number): Reply<Entry[]> {
    if (!this.job(jobId)) return { ok: false, error: 'unknown job' }
    const ring = this.rings.get(jobId)
    return { ok: true, value: ring ? ring.items.filter((e) => e.seq > since).map((e) => ({ ...e })) : [] }
  }

  /** App exit (mod.rs `begin_shutdown`): stop every job, kill at 2.6 s, mark interrupted, save. */
  async shutdown(): Promise<void> {
    this.closing = true
    if (this.live.size === 0 && this.committing.size === 0) return
    this.log(`[local-agent] app quitting: stopping ${this.live.size} job(s), ${this.committing.size} commit(s) running`)
    for (const [id, live] of this.live) {
      if (!live.stop) live.stop = 'app'
      this.stopLine(id, live)
    }
    const deadline = Date.now() + TIMING.exitGiveUpAfter
    const killAt = setTimeout(() => {
      for (const live of this.live.values()) this.signalGroup(live.pid, 'SIGKILL')
    }, TIMING.exitKillAfter)
    while ((this.live.size > 0 || this.committing.size > 0) && Date.now() < deadline) await sleep(50)
    clearTimeout(killAt)
    for (const [id, live] of this.live) {
      const job = this.job(id)
      if (!job) continue
      if (live.stop === 'park' && job.sessionId) {
        job.status = 'waiting'
        job.parked = true
        continue
      }
      job.status = live.stop === 'user' ? 'cancelled' : 'interrupted'
      job.endedAt = nowStamp()
    }
    this.live.clear()
    this.save()
  }

  /** The pids of the launchers running now (for the e2e's leftover check). */
  livePids(): number[] {
    return [...this.live.values()].map((l) => l.pid)
  }

  // ── Internals ──

  private canLaunch(): string | null {
    if (this.closing) return 'Native Intelligence is quitting'
    return null
  }

  /** Launchers holding a slot: running ones (a parked one shutting down doesn't) and starts being prepared. */
  private slotsTaken(): number {
    return [...this.live.values()].filter((l) => l.stop !== 'park').length + this.preparing.size
  }

  /** When the job is idle (waiting, no turn open, no commit pending, not stopping or resuming), since when. */
  private idleSince(id: string, live: Live, now: number): number | null {
    const job = this.job(id)
    if (!job) return null
    const awaiting = live.awaitingTurnSince !== null && now - live.awaitingTurnSince < AWAIT_TURN_GRACE_MS
    const idle =
      job.status === 'waiting' && !!job.sessionId && !live.stop && !live.resume && live.pendingCommit === null && !this.committing.has(id) && !awaiting
    return idle ? live.lastActive : null
  }

  private idleJobs(now: number, except: string): Array<[string, number]> {
    const out: Array<[string, number]> = []
    for (const [id, live] of this.live) {
      if (id === except) continue
      const since = this.idleSince(id, live, now)
      if (since !== null) out.push([id, since])
    }
    return out
  }

  /** mod.rs `make_room`: a slot for `jobId`, freed by parking the least recently active idle job. Never a running one. */
  private makeRoom(jobId: string): string | null {
    if (this.slotsTaken() < MAX_RUNNING) return null
    const victim = this.idleJobs(Date.now(), jobId).sort((a, b) => a[1] - b[1])[0]?.[0]
    if (!victim) return `${MAX_RUNNING} local agents are already running; stop one first`
    this.park(victim, 'another local agent needs its slot')
    return null
  }

  /** Park every job idle for 10 minutes (checked every 30 s). */
  private parkIdle() {
    const now = Date.now()
    for (const [id, since] of this.idleJobs(now, '')) if (now - since >= IDLE_PARK_AFTER_MS) this.park(id, 'idle')
  }

  /** Stop an idle launcher, keeping its job `waiting` and resumable. */
  private park(jobId: string, why: string) {
    const live = this.live.get(jobId)
    if (!live || live.stop) return
    this.log(`[local-agent:${jobId}] parking (${why})`)
    live.stop = 'park'
    this.stopLine(jobId, live)
    live.termTimer = setTimeout(() => this.signalGroup(live.pid, 'SIGTERM'), TIMING.stopTermAfter)
    live.killTimer = setTimeout(() => this.signalGroup(live.pid, 'SIGKILL'), TIMING.stopKillAfter)
  }

  private launch(jobId: string, folder: string, mode: GrantMode, first: Record<string, unknown>, edit: EditCtx | null): string {
    const dir = this.jobDir(jobId)
    createPrivateDir(dir)
    const tmpPath = this.jobTmp(jobId)
    createPrivateDir(tmpPath)
    const tmp = canonicalOr(tmpPath)
    this.nextGen += 1
    const gen = this.nextGen
    const runId = randomUUID()
    const token = this.tokens.get(jobId)
    // config.rs launcher_env, from scratch.
    const env: Record<string, string> = {
      HOME: this.cfg.home,
      TMPDIR: tmp,
      LANG: 'en_US.UTF-8',
      PATH: this.toolPath,
      LOCAL_AGENT_JOB_ID: jobId,
      LOCAL_AGENT_FOLDER: folder,
      LOCAL_AGENT_MODE: mode,
      LOCAL_AGENT_TOOL_PATH: this.toolPath,
      LOCAL_AGENT_DIR: this.cfg.agentDir,
    }
    if (edit) env.LOCAL_AGENT_EXTRA_READ = edit.gitDir
    if (token) {
      env.LOCAL_AGENT_MODEL_BASE_URL = `${this.cfg.apiOrigin.replace(/\/+$/, '')}${MODEL_RELAY_PATH}`
      env.LOCAL_AGENT_MODEL_TOKEN = token
    } else if (this.cfg.envFile) {
      env.LOCAL_AGENT_DEV_ENV_FILE = this.cfg.envFile
    }
    // Cast: Next's global types make ProcessEnv require NODE_ENV, which the launcher never gets.
    const child = spawn(this.cfg.node, [this.launcher], { cwd: dir, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    if (!child.pid) throw new Error('could not start the launcher: no pid')
    const live: Live = {
      gen,
      runId,
      child,
      pid: child.pid,
      stop: null,
      stdinClosed: false,
      lastActive: Date.now(),
      awaitingTurnSince: null,
      fatal: null,
      resume: null,
      edit,
      pendingCommit: null,
      termTimer: null,
      killTimer: null,
    }
    child.stdin!.on('error', () => {})
    createInterface({ input: child.stderr! }).on('line', (l: string) => {
      if (l.trim()) this.log(`[local-agent:${jobId}] ${l.slice(0, 2000)}`)
    })
    const reader = createInterface({ input: child.stdout! })
    reader.on('line', (l: string) => this.onLine(jobId, gen, l))
    const stdoutClosed = new Promise<void>((r) => child.stdout!.once('close', () => r()))
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      // supervisor.rs `own`: kill what's left of the group, drain stdout (≤2 s), then report.
      this.signalGroup(live.pid, 'SIGKILL')
      void Promise.race([stdoutClosed, sleep(2_000)]).then(() => this.onExit(jobId, gen, { code, signal }))
    })
    this.log(`[local-agent:${jobId}] spawned ${this.cfg.node} ${this.launcher} (pid ${child.pid}, run ${gen})`)
    this.log(`[local-agent:${jobId}] run ${runId} (${mode}, ${token ? 'model relay' : 'dev model key'})`)
    this.live.set(jobId, live)
    const job = this.job(jobId)
    if (job) {
      job.runId = runId
      job.parked = false
    }
    this.ensureRing(jobId)
    this.writeLine(jobId, live, first)
    return runId
  }

  private writeLine(jobId: string, live: Live, msg: Record<string, unknown>): boolean {
    if (live.stdinClosed) return false
    const rec: SentLine = { jobId, runId: live.runId, type: String(msg.type) }
    if (typeof msg.text === 'string') rec.text = msg.text
    if (typeof msg.policy === 'string') rec.policy = msg.policy
    if (typeof msg.request === 'string') rec.request = msg.request
    if (typeof msg.sessionId === 'string') rec.sessionId = msg.sessionId
    if (typeof msg.streamIndex === 'number') rec.streamIndex = msg.streamIndex
    this.sent.push(rec)
    live.child.stdin!.write(`${JSON.stringify(msg)}\n`)
    return true
  }

  private stopLine(jobId: string, live: Live) {
    if (live.stdinClosed) return
    this.writeLine(jobId, live, { type: 'stop' })
    live.stdinClosed = true
    live.child.stdin!.end()
  }

  private signalGroup(pid: number, sig: NodeJS.Signals) {
    try {
      process.kill(-pid, sig)
    } catch {
      // ESRCH: nobody left
    }
  }

  private onLine(jobId: string, gen: number, raw: string) {
    const live = this.live.get(jobId)
    if (!live || live.gen !== gen || !raw.trim()) return
    live.lastActive = Date.now()
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw) as Record<string, unknown>
    } catch {
      this.log(`[local-agent:${jobId}] ignoring non-protocol stdout: ${raw.slice(0, 200)}`)
      return
    }
    switch (msg.type) {
      case 'ready':
        this.log(`[local-agent:${jobId}] ready on 127.0.0.1:${String(msg.port)} (eve ${String(msg.eveVersion ?? '?')})`)
        break
      case 'session': {
        const job = this.job(jobId)
        if (job && typeof msg.sessionId === 'string' && typeof msg.streamIndex === 'number') {
          job.sessionId = msg.sessionId
          job.streamIndex = msg.streamIndex
        }
        this.save()
        this.confirmResume(jobId)
        break
      }
      case 'cursor': {
        const job = this.job(jobId)
        if (job && typeof msg.streamIndex === 'number' && job.streamIndex !== msg.streamIndex) {
          job.streamIndex = msg.streamIndex
          this.save()
        }
        break
      }
      case 'fatal': {
        const message = String(msg.message ?? '')
        this.log(`[local-agent:${jobId}] fatal: ${message}`)
        const reply = live.resume?.reply
        if (reply && live.resume) {
          live.resume.reply = null
          reply({ ok: false, error: message.includes(LOCK_FATAL) ? LOCK_ERROR : `the job didn't resume: ${message}` })
        }
        live.fatal = message
        break
      }
      case 'event':
        if (msg.event && typeof msg.event === 'object' && !Array.isArray(msg.event)) this.onEvent(jobId, msg.event as Record<string, unknown>)
        break
      default:
        this.log(`[local-agent:${jobId}] ignoring launcher message ${JSON.stringify(msg.type)}`)
    }
  }

  private confirmResume(jobId: string) {
    const live = this.live.get(jobId)
    const reply = live?.resume?.reply
    if (live && reply) {
      live.resume = null
      reply({ ok: true, value: { jobId, runId: live.runId } })
    }
  }

  private onEvent(jobId: string, event: Record<string, unknown>) {
    const size = JSON.stringify(event).length
    if (size > MAX_EVENT_BYTES) {
      this.log(`[local-agent:${jobId}] dropped a ${size}-byte ${JSON.stringify(event.kind)} event`)
      return
    }
    const kind = typeof event.kind === 'string' ? event.kind : ''
    if (kind === 'status') {
      const l = this.live.get(jobId)
      if (l) {
        l.awaitingTurnSince = null
        // A parked launcher's own `cancelled` on the way out is not the job's: it stays waiting.
        if (l.stop === 'park') return
      }
    }
    let turnOver = false
    if (kind === 'status') {
      const status = typeof event.status === 'string' && FROM_LAUNCHER.has(event.status) ? (event.status as JobStatus) : null
      turnOver = status !== null && status !== 'starting' && status !== 'running'
      const job = this.job(jobId)
      if (status && job && job.status !== status) {
        job.status = status
        if (isActive(status)) delete job.endedAt
        else job.endedAt = nowStamp()
        this.save()
      }
    }
    const live = this.live.get(jobId)
    if (kind === 'finish' && live?.edit) live.pendingCommit = typeof event.summary === 'string' ? event.summary : ''
    this.pushEvent(jobId, event, live?.runId)
    if (turnOver) this.kickCommit(jobId)
  }

  private kickCommit(jobId: string) {
    const live = this.live.get(jobId)
    if (!live || live.pendingCommit === null || !live.edit) return
    const summary = live.pendingCommit
    live.pendingCommit = null
    this.spawnCommit(jobId, live.runId, live.edit, summary)
  }

  private spawnCommit(jobId: string, runId: string, edit: EditCtx, summary: string) {
    this.log(`[local-agent:${jobId}] committing in ${edit.worktree}`)
    this.committing.add(jobId)
    void this.git.commit(edit.worktree, edit.gitDir, edit.base, summary).then(
      (info) => this.onCommitted(jobId, runId, { ok: true, info }),
      (e: unknown) => this.onCommitted(jobId, runId, { ok: false, error: e instanceof Error ? e.message : String(e) }),
    )
  }

  private onCommitted(
    jobId: string,
    runId: string,
    r: { ok: true; info: { branch: string; commit: string; filesChanged: number; insertions: number; deletions: number } } | { ok: false; error: string },
  ) {
    this.committing.delete(jobId)
    let event: Record<string, unknown>
    if (r.ok) {
      this.log(`[local-agent:${jobId}] committed ${r.info.commit} on ${r.info.branch} (${r.info.filesChanged} files)`)
      const job = this.job(jobId)
      if (job) {
        job.commit = r.info.commit
        job.branch = r.info.branch
      }
      this.save()
      event = { kind: 'branch', branch: r.info.branch, commit: r.info.commit, filesChanged: r.info.filesChanged, insertions: r.info.insertions, deletions: r.info.deletions }
    } else {
      this.log(`[local-agent:${jobId}] commit failed: ${r.error}`)
      event = { kind: 'error', message: `the changes couldn't be committed: ${r.error}` }
    }
    this.pushEvent(jobId, event, runId)
  }

  private onExit(jobId: string, gen: number, info: { code: number | null; signal: string | null }) {
    const live = this.live.get(jobId)
    if (!live || live.gen !== gen) return
    this.live.delete(jobId)
    if (live.termTimer) clearTimeout(live.termTimer)
    if (live.killTimer) clearTimeout(live.killTimer)
    const job = this.job(jobId)
    const current = job?.status ?? 'failed'
    let [status, reason] = exitOutcome(current, live.stop, info, live.fatal, !!job?.sessionId)
    if (live.resume) {
      if (live.fatal?.includes(LOCK_FATAL)) {
        status = live.resume.prior
        reason = LOCK_ERROR
      }
      live.resume.reply?.({ ok: false, error: `the job didn't resume: ${reason}` })
      live.resume = null
    }
    const parked = live.stop === 'park' && status === 'waiting'
    if (job) {
      job.status = status
      job.parked = parked
      if (parked) delete job.endedAt
      else job.endedAt = nowStamp()
    }
    this.save()
    this.log(`[local-agent:${jobId}] run ${gen} ${info.code !== null ? `exited with code ${info.code}` : `killed by signal ${info.signal}`}`)
    this.pushEvent(jobId, { kind: 'status', status, reason }, live.runId)
    if (live.pendingCommit !== null && live.edit) this.spawnCommit(jobId, live.runId, live.edit, live.pendingCommit)
  }

  private ensureRing(jobId: string) {
    let ring = this.rings.get(jobId)
    if (!ring) {
      const first = (this.evictedSeq.get(jobId) ?? 0) + 1
      this.evictedSeq.delete(jobId)
      ring = { items: [], next: first }
      this.rings.set(jobId, ring)
    }
    return ring
  }

  private pushEvent(jobId: string, event: Record<string, unknown>, runId: string | undefined) {
    const ring = this.ensureRing(jobId)
    const entry: Entry = { seq: ring.next++, ...(runId ? { runId } : {}), event }
    if (ring.items.length === RING_CAP) ring.items.shift()
    ring.items.push(entry)
    this.emit({ jobId, seq: entry.seq, ...(runId ? { runId } : {}), event })
  }
}

function checkText(text: string, what: string): string | null {
  if (typeof text !== 'string' || !text.trim()) return `the ${what} is empty`
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) return `the ${what} is too long (over ${MAX_TEXT_BYTES / 1024} KB)`
  if (text.includes('\0')) return `the ${what} contains a NUL character`
  return null
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// ── As its own process (the e2e's "app") ────────────────────────────────────

/** The commands over IPC, by name, as Tauri would dispatch them. */
export type HostCommand =
  | { cmd: 'device' }
  | { cmd: 'status' }
  | { cmd: 'addGrant'; path: string; mode: GrantMode }
  | { cmd: 'start'; args: StartArgs }
  | { cmd: 'resume'; jobId: string; modelToken?: string | null }
  | { cmd: 'send'; jobId: string; text: string; policy: string }
  | { cmd: 'stop'; jobId: string }
  | { cmd: 'events'; jobId: string; sinceSeq: number }
  | { cmd: 'setModelToken'; jobId: string; modelToken: string }
  | { cmd: 'sent' }
  | { cmd: 'livePids' }
  | { cmd: 'shutdown' }

async function dispatch(rust: FakeRust, c: HostCommand): Promise<unknown> {
  switch (c.cmd) {
    case 'device':
      return rust.device()
    case 'status':
      return { ok: true, value: rust.status() }
    case 'addGrant':
      return rust.addGrant(c.path, c.mode)
    case 'start':
      return rust.start(c.args)
    case 'resume':
      return rust.resume(c.jobId, c.modelToken)
    case 'send':
      return rust.send(c.jobId, c.text, c.policy)
    case 'stop':
      return rust.stop(c.jobId)
    case 'events':
      return rust.events(c.jobId, c.sinceSeq)
    case 'setModelToken':
      return rust.setModelToken(c.jobId, c.modelToken)
    case 'sent':
      return { ok: true, value: rust.sent }
    case 'livePids':
      return { ok: true, value: rust.livePids() }
    case 'shutdown':
      await rust.shutdown()
      return { ok: true, value: null }
  }
}

function hostMain() {
  const cfg = JSON.parse(process.env.E2E_FAKE_RUST_CONFIG ?? '{}') as FakeRustConfig
  const send = (m: unknown) => {
    if (process.connected) process.send?.(m)
  }
  const rust = new FakeRust(
    cfg,
    (payload) => send({ type: 'event', payload }),
    (line) => process.stderr.write(`${line}\n`),
  )
  process.on('message', (m: { id: number; command: HostCommand }) => {
    void dispatch(rust, m.command).then(
      (result) => send({ type: 'reply', id: m.id, result }),
      (e: unknown) => send({ type: 'reply', id: m.id, result: { ok: false, error: e instanceof Error ? e.message : String(e) } }),
    )
  })
  // The parent went away without a shutdown: exit like a killed app (launchers get stdin EOF).
  process.on('disconnect', () => process.exit(0))
  send({ type: 'hello', pid: process.pid })
}

export interface FakeRustProcess {
  pid: number
  call<T>(command: HostCommand): Promise<Reply<T>>
  onEvent(cb: (payload: EventPayload) => void): () => void
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  kill(signal: NodeJS.Signals): void
}

/** Fork the fake Rust as its own process; its log lines go to `log`. */
export async function forkFakeRust(cfg: FakeRustConfig, log: (line: string) => void): Promise<FakeRustProcess> {
  const child = fork(fileURLToPath(import.meta.url), [], {
    env: { ...process.env, E2E_FAKE_RUST_HOST: '1', E2E_FAKE_RUST_CONFIG: JSON.stringify(cfg) } as NodeJS.ProcessEnv,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    serialization: 'json',
  })
  createInterface({ input: child.stderr! }).on('line', (l: string) => log(l))
  const listeners = new Set<(p: EventPayload) => void>()
  const waiting = new Map<number, (r: Reply<unknown>) => void>()
  let nextId = 0
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) =>
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      for (const w of waiting.values()) w({ ok: false, error: 'the app is gone' })
      waiting.clear()
      r({ code, signal })
    }),
  )
  const hello = new Promise<void>((resolveHello, reject) => {
    const t = setTimeout(() => reject(new Error('fake Rust did not start')), 30_000)
    child.on('message', (m: { type: string; id?: number; result?: Reply<unknown>; payload?: EventPayload }) => {
      if (m.type === 'hello') {
        clearTimeout(t)
        resolveHello()
      } else if (m.type === 'reply' && m.id !== undefined) {
        waiting.get(m.id)?.(m.result as Reply<unknown>)
        waiting.delete(m.id)
      } else if (m.type === 'event' && m.payload) {
        for (const l of listeners) l(m.payload)
      }
    })
  })
  await hello
  return {
    pid: child.pid!,
    call<T>(command: HostCommand) {
      if (!child.connected) return Promise.resolve({ ok: false, error: 'the app is gone' } as Reply<T>)
      const id = ++nextId
      return new Promise<Reply<T>>((resolveCall) => {
        waiting.set(id, resolveCall as (r: Reply<unknown>) => void)
        child.send({ id, command })
      })
    },
    onEvent(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    exited,
    kill: (signal) => child.kill(signal),
  }
}

if (process.env.E2E_FAKE_RUST_HOST === '1' && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  hostMain()
}
