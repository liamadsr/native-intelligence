/**
 * The "host folder" sandbox provider: eve's `/workspace` is a folder the
 * person granted on their Mac, and every command and file access runs under
 * the Seatbelt profile from ./seatbelt.ts (docs/plans/local-agents.md §1 and
 * §3; L0 contract §2 "lib/host-folder-sandbox.ts").
 *
 * The fence is the KERNEL's, not this file's. Every command of a job runs
 * inside ONE Seatbelt sandbox: a small Node runner started as
 * `/usr/bin/sandbox-exec -p <profile> <node> -e <RUNNER_SOURCE>`, which forks
 * each command (`/bin/bash -c <command>`, and the file methods' `/bin/cat`,
 * `/bin/mkdir -p` plus a write, `/bin/rm`) and relays its streams in frames.
 * A read of a sibling folder, a write in read mode or a network call fails in
 * the kernel even if a check here were wrong. One sandbox per job is what
 * lets the profile limit signals to `same-sandbox`: the job's commands can
 * stop each other (eve's background jobs, the model's `kill -- -<pgid>`) and
 * nothing outside it. It is also how a stop kills everything the job started:
 * the runner sends SIGKILL to -1 from inside the sandbox, which reaches every
 * process of that sandbox and only those, wherever `setsid`, `setpgid` or a
 * double fork moved them. The runner does the same when its stdin closes (the
 * eve server went away). A fence grant (the person allowed one more path,
 * C3 `kind: "fence"`) changes the profile, so later commands start in a new
 * runner; the old one keeps its running commands until the stop reaps both.
 * The checks here only make the failures clear and early:
 *   - path mapping. macOS `/` is read-only, so `/workspace` cannot exist. The
 *     file methods map `/workspace` (and relative paths) onto the folder and
 *     reject anything that resolves outside it after realpath. Commands get
 *     their `/workspace` tokens rewritten (rewriteCommandPaths) to the folder,
 *     or to a shell-safe symlink to it when the folder's path has spaces.
 *   - eve's bash tool keeps a long command's output under `/tmp/.eve/jobs/<id>`.
 *     Those tokens are rewritten to this session's scratch directory, so jobs
 *     never share the machine-wide /private/tmp/.eve (which the profile keeps
 *     unwritable) and a stop can find and kill them.
 *   - read mode: every write and remove in the folder fails with a clear
 *     error before any process starts. The scratch dir (TMPDIR, eve's
 *     staging dir) stays writable, for the file methods as for commands.
 *     Reading a secret file in the folder fails with a clear error too, as it
 *     does in a fence grant in both modes (seatbelt.ts isSecretFileName).
 *   - edit mode (L3): the folder is a linked git worktree the desktop made
 *     (`git worktree add`, outside the sandbox). Writes inside it are allowed
 *     except to a `.git` at any depth (its own link, a nested repository's)
 *     and the configs the person's tools run on their own, which the file
 *     methods refuse up front (the kernel refuses them too; those configs in
 *     the scratch dir as well). The repository's git
 *     directory is the one extra read-only root (`extraRead`); it must be
 *     named `.git` and must be the directory the worktree's `.git` file
 *     points into, so git can read objects and refs and nothing else is
 *     opened. Commits are not possible
 *     inside the sandbox (the index and objects are read-only): the desktop
 *     commits when the job finishes.
 *
 * Commands get a CLEAN environment built only from PATH (the toolchain PATH
 * the desktop resolved), HOME, TMPDIR (the scratch directory), LANG,
 * TERM=dumb, AI_AGENT=eve, GIT_CONFIG_GLOBAL=/dev/null +
 * GIT_CONFIG_NOSYSTEM=1, GIT_OPTIONAL_LOCKS=0 (so `git status` never tries
 * to refresh the index, which is read-only), XDG_CONFIG_HOME in the scratch
 * dir (~/.config is unreadable) and GOCACHE there too (Go's build cache under
 * ~/Library is unreadable and unwritable), plus the call's own env minus
 * secrets. Never the server's: no AI_GATEWAY_API_KEY, no LOCAL_AGENT_*.
 *
 * Each command runs detached in its own process group, which an abort kills
 * from here (an already-aborted signal starts nothing). eve's bash wrapper
 * moves a long command into a group of its own and manages it itself; those
 * are left alone until the sandbox stops, when the runner reaps everything.
 * Nothing is killed by a pid read from a file the job can write (eve's
 * `.eve/jobs/<id>/pid`): that would let a command name any of the person's
 * processes for this unsandboxed one to kill.
 */
import { spawn as spawnChild, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile as readHostFile, readlink, realpath, rm, stat, symlink } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { posix } from 'node:path'
import { Readable } from 'node:stream'
import type { SandboxProcess, SandboxRunOptions, SandboxSession, SandboxSpawnOptions } from 'eve/sandbox'
import {
  defineSandboxProvider,
  type SandboxProviderHandle,
  type SandboxProviderImplementation,
  type SandboxProviderSessionContext,
} from 'eve/sandbox/provider'
import { askPerson, type AskOptions, type PromptOutcome } from '../launcher/prompts.js'
import {
  EXTRA_READ_NAME,
  buildSeatbeltProfile,
  extraReadRefusal,
  fenceGrantRefusal,
  grantRefusal,
  isAutoRunConfig,
  isSecretFileName,
  TOOLCHAIN_ROOTS,
  toolPathReadRoots,
  type FenceAccess,
  type FenceGrant,
  type FenceGrantContext,
  type LocalAgentMode,
  type SeatbeltProfileInput,
} from './seatbelt.js'

export const WORKSPACE = '/workspace'

/** The launch environment as read here (process.env, or a plain object in tests). */
export type LaunchEnv = Readonly<Record<string, string | undefined>>
/** Where eve's bash tool parks a long command's output (eve 0.79.1 execution/sandbox/bash.js). */
export const EVE_JOBS_TMP = '/tmp/.eve'
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
/** read_file pulls a whole file into memory; this bounds one read. */
export const MAX_READ_BYTES = 64 * 1024 * 1024

export interface HostFolderOpenOptions {
  /** realpath of the granted folder (in edit mode, the worktree the desktop made). */
  readonly folder: string
  readonly mode: LocalAgentMode
  /** PATH for sandboxed commands. */
  readonly toolPath: string
  /** Edit mode only: realpath of the repository's `.git` directory, readable, never writable. */
  readonly extraRead?: string
}

/**
 * The minimal checkpointed state (contract §2). Everything else is derived
 * again on resume. `extraRead` is present only when the job has one, so a
 * read-mode state is exactly what L0 checkpointed.
 */
export interface HostFolderState {
  readonly folder: string
  readonly mode: LocalAgentMode
  readonly toolPath: string
  readonly extraRead?: string
  readonly version: 1
}

/** Everything one live session needs, resolved and checked. */
export interface HostFolderConfig {
  readonly folder: string
  readonly mode: LocalAgentMode
  readonly toolPath: string
  /** Edit mode: the repository's `.git` directory (read-only). */
  readonly extraRead?: string
  readonly home: string
  /** The session's scratch root (holds `tmp/` and the `workspace` alias). */
  readonly scratchRoot: string
  /** The sandbox's TMPDIR, the only writable place; holds `.eve/jobs`. */
  readonly scratch: string
  /** What `/workspace` becomes inside commands: the folder, or a shell-safe symlink to it. */
  readonly commandWorkspace: string
  readonly lang: string
  /** realpath of the Node binary the job's runner runs on (the server's own). */
  readonly node: string
  /** The profile's input without fence grants: a grant rebuilds the profile from it. */
  readonly profileInput: SeatbeltProfileInput
  /** The profile with no fence grants. */
  readonly profile: string
}

export class HostFolderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostFolderError'
  }
}

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────

/** True when `child` is `parent` or inside it (both absolute, normalized). */
export function isWithin(child: string, parent: string): boolean {
  if (parent === '/') return child.startsWith('/')
  return child === parent || child.startsWith(`${parent}/`)
}

/** A path bash reads as one word without quoting. */
export function isShellSafePath(path: string): boolean {
  return /^\/[A-Za-z0-9_./-]*$/.test(path)
}

/**
 * eve's own dot-directory under the workspace: it stages message attachments
 * and tool-result media there after every model step (eve 0.79.1
 * harness/attachment-staging.js, `/workspace/.eve/attachments`), through the
 * file methods, then keeps the host path resolvePath gives back. As the file
 * methods see it, it lives in the job's scratch dir (WORKSPACE_EVE_DIR),
 * never in the person's folder or worktree, in read mode too. Commands get
 * only the literal `/workspace/.eve` token rewritten (rewriteCommandPaths).
 */
export const WORKSPACE_EVE = '/workspace/.eve'
/** WORKSPACE_EVE's home inside the scratch dir. */
export const WORKSPACE_EVE_DIR = 'workspace-eve'

/**
 * Rewrite `/workspace/.eve`, `/workspace` and `/tmp/.eve` path tokens in a
 * command (`/workspace/.eve` first, in any letter case, onto the scratch dir).
 * Only that literal token: other spellings of the same dir
 * (`cd /workspace && ls .eve`, `/workspace/./.eve`, `/workspace//.eve`, the
 * folder's or the alias's own path) and an in-folder symlink to it reach the
 * folder's real `.eve`, which is inside the grant. The shell resolves `..`
 * after the rewrite, so `/workspace/.eve/../x` is the scratch dir's `x` here
 * but the folder's `x` to a file method (mapSandboxPath normalizes first).
 * A token starts anywhere not right after a path character (a letter, digit,
 * `_`, `.`, `~`, `/` or `$`), so after whitespace, a quote, `=`, `:`, `-`,
 * `(` and so on, and ends at `/`, whitespace, a quote, `;`, `)`, `&`, `|`,
 * `<`, `>`, `` ` ``, `:`, `}`, `,` or the end. So `/workspace-old`,
 * `foo/workspace`, `$HOME/workspace` and `/workspace/.evelyn` are left alone
 * (the last becomes the folder's `.evelyn`).
 */
export function rewriteCommandPaths(command: string, to: { workspace: string; eveTmp: string; workspaceEve?: string }): string {
  const tail = String.raw`(?=$|[/\s'";)&|<>\x60:},])`
  const head = String.raw`(?<![A-Za-z0-9_.~/$])`
  const withEve = to.workspaceEve === undefined ? command : command.replace(new RegExp(`${head}/workspace/\\.[Ee][Vv][Ee]${tail}`, 'g'), () => to.workspaceEve!)
  return withEve
    .replace(new RegExp(`${head}/workspace${tail}`, 'g'), () => to.workspace)
    .replace(new RegExp(`${head}/tmp/\\.eve${tail}`, 'g'), () => to.eveTmp)
}

/**
 * Lexically map a model-facing path onto the host: `/workspace/...` and
 * relative paths onto the folder, `/tmp/.eve/...` onto the scratch directory,
 * and eve's staging dir (`/workspace/.eve`, or the folder's or the alias's
 * own `.eve`, in any letter case: APFS) onto the scratch dir's
 * WORKSPACE_EVE_DIR, never the folder. The path is normalized first, so
 * `/workspace/./.eve` maps there too and `/workspace/.eve/../x` is the
 * folder's `x`. Host paths already inside the folder, the alias, the scratch
 * directory or a fence grant pass through. Anything else is outside the
 * grant. (Symlinks are checked after this, against realpath, without mapping
 * again: an in-folder symlink to `.eve` reaches the folder's real `.eve`.)
 */
export function mapSandboxPath(
  path: string,
  roots: { folder: string; scratch: string; commandWorkspace: string; grants?: readonly string[] },
): string {
  if (typeof path !== 'string' || path.length === 0) throw new HostFolderError('empty path')
  if (path.includes('\0')) throw new HostFolderError('path contains a NUL byte')
  const abs = posix.normalize(path.startsWith('/') ? path : `${WORKSPACE}/${path}`).replace(/(.)\/+$/, '$1')
  const swap = (from: string, to: string) => (abs === from ? to : `${to}${abs.slice(from.length)}`)
  for (const base of [WORKSPACE, roots.folder, roots.commandWorkspace]) {
    const eve = `${base}/.eve`
    if (abs.slice(0, eve.length).toLowerCase() === eve.toLowerCase() && (abs.length === eve.length || abs[eve.length] === '/')) {
      return `${roots.scratch}/${WORKSPACE_EVE_DIR}${abs.slice(eve.length)}`
    }
  }
  if (isWithin(abs, WORKSPACE)) return swap(WORKSPACE, roots.folder)
  if (isWithin(abs, EVE_JOBS_TMP)) return swap(EVE_JOBS_TMP, `${roots.scratch}/.eve`)
  if (roots.commandWorkspace !== roots.folder && isWithin(abs, roots.commandWorkspace)) {
    return swap(roots.commandWorkspace, roots.folder)
  }
  if (isWithin(abs, roots.folder) || isWithin(abs, roots.scratch)) return abs
  if (roots.grants?.some((g) => isWithin(abs, g))) return abs
  throw new HostFolderError(`${path} is outside the granted folder (/workspace)`)
}

const SECRET_ENV = /^(AI_GATEWAY_API_KEY|LOCAL_AGENT_.*|VERCEL_OIDC_TOKEN|DYLD_.*)$/

/** The environment a sandboxed command gets: built from scratch, never inherited. */
export function buildCommandEnv(
  cfg: Pick<HostFolderConfig, 'toolPath' | 'home' | 'scratch' | 'lang'>,
  extra?: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: cfg.toolPath,
    HOME: cfg.home,
    TMPDIR: cfg.scratch,
    LANG: cfg.lang,
    TERM: 'dumb',
    AI_AGENT: 'eve',
    // git config is unreadable under the profile (it can hold credentials); say so, so git doesn't warn.
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    // The index is read-only to commands (the repo's .git in edit mode, the whole folder in read mode):
    // never let `git status` / `git diff` try to take index.lock for an opportunistic refresh.
    GIT_OPTIONAL_LOCKS: '0',
    // ~/.config is read-denied, so git (its default ignore and attributes files) and other tools would
    // warn "unable to access" on every call. An empty config home of the job's own instead.
    XDG_CONFIG_HOME: posix.join(cfg.scratch, '.config'),
    // `go build` needs a writable build cache; its default under ~/Library is fenced.
    GOCACHE: posix.join(cfg.scratch, '.cache', 'go-build'),
  }
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (!SECRET_ENV.test(k) && typeof v === 'string') env[k] = v
  }
  return env
}

/**
 * Re-check the grant (invariant 3: the Mac re-checks): strictly inside HOME,
 * or outside every system and read-denied root (lib/seatbelt.ts grantRefusal).
 */
export function assertGrantableFolder(folder: string, home: string): void {
  const refusal = grantRefusal(folder, home)
  if (refusal) throw new HostFolderError(`${folder} cannot be granted: ${refusal}`)
}

// ── Options, state and resolution ────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/

function validateOptions(opts: Partial<HostFolderOpenOptions> | undefined): HostFolderOpenOptions {
  const folder = opts?.folder
  const toolPath = opts?.toolPath
  const mode = opts?.mode
  const extraRead = opts?.extraRead
  if (typeof folder !== 'string' || !folder.startsWith('/')) throw new HostFolderError('folder must be an absolute path')
  if (mode !== 'read' && mode !== 'edit') throw new HostFolderError(`mode must be "read" or "edit" (got ${JSON.stringify(mode)})`)
  if (typeof toolPath !== 'string' || toolPath.length === 0 || CONTROL_CHAR.test(toolPath)) {
    throw new HostFolderError('toolPath must be a non-empty PATH')
  }
  if (extraRead !== undefined) {
    if (mode !== 'edit') throw new HostFolderError('an extra read root is only allowed in edit mode')
    if (typeof extraRead !== 'string' || !extraRead.startsWith('/')) throw new HostFolderError('the extra read root must be an absolute path')
  }
  return extraRead === undefined ? { folder, mode, toolPath } : { folder, mode, toolPath, extraRead }
}

/**
 * The repository git directory a linked worktree points into: `<folder>/.git`
 * must be a regular file (never a symlink or a directory, so never the
 * person's own checkout) reading `gitdir: <path>`; the path's realpath is
 * returned. Read by this trusted process, not under the profile.
 */
export async function worktreeGitdir(folder: string): Promise<string> {
  const dotGit = posix.join(folder, '.git')
  let info
  try {
    info = await lstat(dotGit)
  } catch {
    throw new HostFolderError(`edit mode needs a git worktree: ${folder} has no .git`)
  }
  if (!info.isFile()) throw new HostFolderError(`edit mode needs a linked git worktree: ${dotGit} is not a file (is this the original checkout?)`)
  if (info.size > 4096) throw new HostFolderError(`${dotGit} is not a worktree link`)
  const m = /^gitdir: (.+?)\r?\n?$/.exec(await readHostFile(dotGit, 'utf8'))
  if (!m) throw new HostFolderError(`${dotGit} is not a worktree link`)
  const target = m[1].startsWith('/') ? m[1] : posix.join(folder, m[1])
  try {
    return await realpath(target)
  } catch {
    throw new HostFolderError(`the worktree's git directory no longer exists: ${target}`)
  }
}

/**
 * Check the edit-mode extra read root on disk: a realpath, a directory named
 * `.git`, grantable, apart from the folder, and the directory the worktree's
 * `.git` file points into (so the root is this worktree's repository and
 * nothing else).
 */
async function checkExtraRead(extraRead: string, folder: string, home: string): Promise<void> {
  let real: string
  try {
    real = await realpath(extraRead)
  } catch {
    throw new HostFolderError(`the extra read root no longer exists: ${extraRead}`)
  }
  if (real !== extraRead) throw new HostFolderError(`the extra read root must be a realpath (${extraRead} resolves to ${real})`)
  if (!(await stat(real)).isDirectory()) throw new HostFolderError(`the extra read root is not a directory: ${extraRead}`)
  const why = extraReadRefusal(real, folder, home)
  if (why) throw new HostFolderError(`${extraRead} cannot be read: ${why}`)
  const gitdir = await worktreeGitdir(folder)
  if (!isWithin(gitdir, real)) throw new HostFolderError(`the worktree belongs to another repository than ${extraRead}`)
}

/**
 * True when `hostPath` (a realpath inside `folder`) is a `.git` entry at any
 * depth (the folder's own, a nested repository's) or inside one, in any
 * letter case.
 */
export function isGitEntry(hostPath: string, folder: string): boolean {
  if (!isWithin(hostPath, folder) || hostPath === folder) return false
  return hostPath
    .slice(folder.length + 1)
    .split('/')
    .some((c) => c.toLowerCase() === EXTRA_READ_NAME)
}

/** A stable, filesystem-safe name for the session's scratch directory. */
export function scratchName(sessionId: string): string {
  return /^[A-Za-z0-9_-]{1,96}$/.test(sessionId)
    ? sessionId
    : createHash('sha256').update(sessionId).digest('hex').slice(0, 32)
}

export interface ResolveOptions {
  readonly sessionId: string
  /** Defaults to realpath(HOME). Tests pass a fake home. */
  readonly home?: string
  /** Defaults to realpath(os.tmpdir()). */
  readonly tmpRoot?: string
  readonly lang?: string
  /** The Node binary the runner runs on. Defaults to this process's (process.execPath). */
  readonly node?: string
  /** The launch environment (LOCAL_AGENT_DIR, SHELL). Defaults to process.env. */
  readonly env?: LaunchEnv
}

/** What the desktop runs as the person, outside the sandbox: git and gh on push, ssh under git. */
const PERSON_TOOLS = ['git', 'gh', 'ssh'] as const

/** Config below HOME's hidden dirs that steers git, ssh or a shell: where each really lives is protected too. */
const DEEP_CONFIG = ['.config/git/config', '.config/git/attributes', '.config/fish/config.fish'] as const

/** Hidden toolchain homes (seatbelt.ts HOME_TOOLCHAIN_ALLOWLIST): their real places stay readable. */
const READABLE_HIDDEN = new Set(['.nvm', '.cargo', '.rustup', '.bun', '.local', '.volta', '.pyenv'])

/** How deep git `[include]` and ssh `Include` chains are followed (ssh's own limit is 16). */
const MAX_INCLUDE_DEPTH = 16
/** The most files one ssh `Include` glob expands to. */
const MAX_INCLUDE_MATCHES = 256

/** Credential folders (relative to HOME) whose entries' real places are read-protected, one level deep. */
const CREDENTIAL_DIRS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.docker',
  '.kube',
  '.config/gh',
  '.config/git', // git credential-store's XDG file
  '.config/github-copilot',
  '.config/gcloud',
  '.config/stripe',
  '.codex',
  '.cargo',
  '.local/share', // app tokens (auth.json and the like) when ~/.local lives elsewhere
] as const
/** Toolchain content inside a credential folder: left readable (seatbelt.ts HOME_TOOLCHAIN_ALLOWLIST). */
const CREDENTIAL_DIR_TOOLCHAIN: Readonly<Record<string, readonly string[]>> = { '.cargo': ['bin', 'registry', 'git'] }

/**
 * Split ssh config arguments as OpenSSH's argv_split does: whitespace
 * separates; '…' and "…" quote, also starting mid-word; a backslash escapes a
 * quote, a backslash, or (outside quotes) a space; an argument starting with
 * `#` ends the line.
 */
export function sshArgs(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let started = false
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    const next = line[i + 1]
    if (c === '\\' && next !== undefined && (next === "'" || next === '"' || next === '\\' || (quote === null && /\s/.test(next)))) {
      cur += next
      started = true
      i++
      continue
    }
    if (quote !== null) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      started = true
      continue
    }
    if (/\s/.test(c)) {
      if (started) out.push(cur)
      cur = ''
      started = false
      continue
    }
    if (c === '#' && !started) break
    cur += c
    started = true
  }
  if (started) out.push(cur)
  return out
}

/**
 * The files an ssh config names: its `Include`s and the `IdentityFile` /
 * `CertificateFile` keys, as absolute paths (ssh's rules: `~` and `%d` are
 * HOME, `${HOME}` too, a relative path is in `~/.ssh`), with arguments split
 * as OpenSSH does (sshArgs). Read as text. A path that keeps another `%`
 * token or `${VAR}` keeps it: the caller protects the folder before it.
 * `~otheruser/...` is another person's HOME (unreadable anyway) and is left out.
 */
export function sshConfigPaths(text: string, home: string, user?: string): { includes: string[]; keys: string[] } {
  const includes: string[] = []
  const keys: string[] = []
  const resolve = (value: string): string | null => {
    let v = value.replace(/%%/g, '\u0000').replace(/%d/g, home).replace(/\$\{HOME\}/g, home).replace(/\u0000/g, '%%')
    if (v === '~' || (user !== undefined && v === `~${user}`)) v = home
    else if (v.startsWith('~/')) v = posix.join(home, v.slice(2))
    else if (user !== undefined && v.startsWith(`~${user}/`)) v = posix.join(home, v.slice(user.length + 2))
    else if (v.startsWith('~')) return null
    if (!v.startsWith('/')) v = posix.join(home, '.ssh', v)
    return posix.normalize(v)
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([^\s=]+)\s*(?:=\s*)?(.*)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const values = sshArgs(m[2])
    if (key === 'include') {
      for (const v of values) {
        const r = resolve(v)
        if (r) includes.push(r)
      }
    } else if ((key === 'identityfile' || key === 'certificatefile') && values[0] && values[0].toLowerCase() !== 'none') {
      const r = resolve(values[0])
      if (r) keys.push(r)
    }
  }
  return { includes, keys }
}

/** A shell glob component (`*`, `?`, `[a-z]`, `[!x]`) as an anchored regex. */
function globComponent(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2)
      if (end === -1) re += '\\['
      else {
        const body = glob.slice(i + 1, end)
        re += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`
        i = end
      }
    } else re += c.replace(/[.+^${}()|\\/]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/** realpaths of HOME's toolchain dirs that are symlinks to somewhere else (seatbelt.ts anchors the credential denies there too). */
export async function toolchainRealpaths(home: string): Promise<string[]> {
  const out: string[] = []
  for (const root of TOOLCHAIN_ROOTS) {
    const lex = posix.join(home, root)
    try {
      const real = await realpath(lex)
      if (real !== lex && !isWithin(home, real)) out.push(real)
    } catch {
      // not installed
    }
  }
  return out
}

/**
 * The `path` values of `[include]` and `[includeIf "…"]` sections in git
 * config text, as absolute paths: `~/` is HOME, a relative path is the
 * including file's folder (git's own rule). Read as text: nothing runs git as
 * the person.
 */
export function gitIncludePaths(text: string, file: string, home: string): string[] {
  const out: string[] = []
  let inInclude = false
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim()
    const section = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"(?:[^"\\]|\\.)*")?\s*\]/.exec(line)
    if (section) {
      inInclude = /^include(if)?$/i.test(section[1])
      line = line.slice(section[0].length).trim()
      if (!line) continue
    }
    if (!inInclude) continue
    const kv = /^path\s*=\s*(.*)$/i.exec(line)
    if (!kv) continue
    let value = kv[1].trim()
    const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(value)
    value = quoted ? quoted[1].replace(/\\(.)/g, '$1') : value.replace(/\s*[#;].*$/, '')
    if (!value) continue
    const abs = value.startsWith('~/') ? posix.join(home, value.slice(2)) : value.startsWith('/') ? value : posix.join(posix.dirname(file), value)
    out.push(posix.normalize(abs))
  }
  return out
}

/** What no fence grant may reach (seatbelt.ts FenceGrantContext). */
export interface ProtectedPaths {
  /** No write grant in or above: programs and config that run, or steer what runs, outside the sandbox. */
  readonly writeProtected: string[]
  /**
   * No grant at all in or above: where HOME's hidden credential and settings
   * entries really live, the entries of the credential folders, ssh identity
   * and certificate files.
   */
  readonly readProtected: string[]
}

/**
 * What a fence grant may never reach, computed on this Mac (nothing comes
 * from the job). Write-protected, with every dir above them (seatbelt.ts):
 *   - each absolute tool PATH entry; git, gh and ssh wherever the tool PATH
 *     finds them; the login shell and $SHELL; the Node runtime;
 *   - the agent's own code (LOCAL_AGENT_DIR, which the launcher and eve server
 *     run from), the `.app` bundle it sits in, and every `node_modules` on its
 *     module resolution path (a dev checkout's server loads `<repo>/node_modules`);
 *   - where HOME's hidden entries really live (`~/.zshrc -> ~/dotfiles/zshrc`:
 *     the file and its folder), and the same for the git, ssh and shell config
 *     below them;
 *   - every file the person's git config includes (`[include]`,
 *     `[includeIf]`, followed a few levels deep), and its folder.
 * Read-protected: where a hidden entry really lives when that is elsewhere
 * (`~/.ssh -> ~/Dropbox/ssh`), toolchain homes excepted; the same for each
 * entry of the credential folders (`.ssh`, `.aws`, `.gnupg`, `.docker`,
 * `.kube`, `.config/gh`, `.codex`, `.cargo`); and every `IdentityFile` and
 * `CertificateFile` that `~/.ssh/config` and its `Include`s name (a key path
 * with a `%` token: the folder before it). A folder is never added when it is
 * HOME or above HOME.
 * The lexical paths and their realpaths both: a symlink resolves elsewhere.
 */
export async function protectedPaths(o: { toolPath: string; env: LaunchEnv; home: string; node?: string; runtime?: string }): Promise<ProtectedPaths> {
  const write = new Set<string>()
  const read = new Set<string>()
  const lexical = (p: string) => posix.normalize(p).replace(/(.)\/+$/, '$1')
  const realOrNull = async (p: string): Promise<string | null> => {
    try {
      return await realpath(p)
    } catch {
      return null
    }
  }
  const add = async (p: string | null | undefined) => {
    if (!p || !p.startsWith('/') || p.includes('\0')) return
    write.add(lexical(p))
    const real = await realOrNull(p)
    if (real) write.add(real)
  }
  const home = (await realOrNull(o.home)) ?? lexical(o.home)
  /** HOME or a folder above it, in any letter case: never protected (it would refuse every grant). */
  const homeOrAbove = (p: string) => isWithin(home.toLowerCase(), p.toLowerCase())
  const addRead = (p: string | null) => {
    if (p && !homeOrAbove(p)) read.add(p)
  }
  /** A config entry that may live elsewhere: protect its real place, and that folder unless it is HOME or above. */
  const addConfig = async (p: string, readToo: boolean) => {
    const lex = lexical(p)
    write.add(lex)
    const real = await realOrNull(lex)
    const target = real ?? lex
    write.add(target)
    const folder = posix.dirname(target)
    if (!homeOrAbove(folder)) write.add(folder)
    if (readToo && real && real !== lex) addRead(real)
  }

  const dirs = o.toolPath.split(':').filter((e) => e.startsWith('/'))
  for (const dir of dirs) await add(dir)
  for (const name of PERSON_TOOLS) {
    for (const dir of dirs) {
      const bin = posix.join(dir, name)
      if (existsSync(bin)) await add(bin)
    }
  }
  let loginShell: string | null = null
  let loginUser: string | undefined
  try {
    const info = userInfo()
    loginShell = info.shell
    loginUser = info.username
  } catch {
    // no passwd entry: $SHELL below
  }
  await add(loginShell)
  await add(o.env.SHELL)
  await add(o.node)
  await add(o.runtime)

  const agentDir = o.env.LOCAL_AGENT_DIR
  if (agentDir?.startsWith('/')) {
    await add(agentDir)
    const realAgent = (await realOrNull(agentDir)) ?? lexical(agentDir)
    for (const p of [lexical(agentDir), realAgent]) {
      const app = /^.*?\.app(?=\/|$)/i.exec(p)
      if (app) await add(app[0])
    }
    for (let d = realAgent; ; d = posix.dirname(d)) {
      const modules = posix.join(d, 'node_modules')
      if (existsSync(modules)) await add(modules)
      if (d === '/') break
    }
  }

  let names: string[] = []
  try {
    names = await readdir(home)
  } catch {
    // no HOME listing: the deep config below still counts
  }
  for (const name of names) if (name.startsWith('.')) await addConfig(posix.join(home, name), !READABLE_HIDDEN.has(name))
  for (const rel of CREDENTIAL_DIRS) {
    const dir = posix.join(home, rel)
    const toolchain = CREDENTIAL_DIR_TOOLCHAIN[rel] ?? []
    if (toolchain.length === 0) await addConfig(dir, true)
    let entries: string[] = []
    try {
      entries = await readdir(dir)
    } catch {
      continue // not there
    }
    for (const name of entries) if (!toolchain.includes(name)) await addConfig(posix.join(dir, name), true)
  }
  for (const rel of DEEP_CONFIG) await addConfig(posix.join(home, rel), false)

  /**
   * An ssh key or certificate: never readable through a grant, wherever it
   * lives. A path that still holds a `%` token or `${VAR}`: the folder before
   * it, and that folder's real place.
   */
  const addKey = async (path: string) => {
    const parts = path.split('/')
    const token = parts.findIndex((c) => c.includes('%') || c.includes('${'))
    const target = token >= 0 ? parts.slice(0, token).join('/') || '/' : path
    addRead(target)
    addRead(await realOrNull(target))
  }
  /** ssh `Include` patterns: a glob (`*`, `?`, `[a-z]`) allowed in any component, folders too, as ssh allows. */
  const expandInclude = async (pattern: string): Promise<string[]> => {
    if (!/[*?[]/.test(pattern)) return [pattern]
    let paths = ['/']
    for (const part of pattern.split('/').filter(Boolean)) {
      const next: string[] = []
      for (const dir of paths) {
        if (!/[*?[]/.test(part)) {
          next.push(posix.join(dir, part))
          continue
        }
        const re = globComponent(part)
        try {
          for (const name of await readdir(dir)) if (re.test(name)) next.push(posix.join(dir, name))
        } catch {
          // not a folder, or unreadable
        }
      }
      paths = next.slice(0, MAX_INCLUDE_MATCHES)
    }
    return paths
  }
  const sshSeen = new Set<string>()
  const followSsh = async (file: string, depth: number): Promise<void> => {
    if (depth > MAX_INCLUDE_DEPTH || sshSeen.has(file)) return
    sshSeen.add(file)
    let text: string
    try {
      text = (await readHostFile(file, 'utf8')).slice(0, 1 << 20)
    } catch {
      return
    }
    const { includes, keys } = sshConfigPaths(text, home, loginUser)
    for (const key of keys) await addKey(key)
    for (const pattern of includes) {
      for (const included of await expandInclude(pattern)) {
        await addConfig(included, true)
        await followSsh(included, depth + 1)
      }
    }
  }
  await followSsh(posix.join(home, '.ssh', 'config'), 0)

  const seen = new Set<string>()
  const followIncludes = async (file: string, depth: number): Promise<void> => {
    if (depth > MAX_INCLUDE_DEPTH || seen.has(file)) return
    seen.add(file)
    let text: string
    try {
      text = (await readHostFile(file, 'utf8')).slice(0, 1 << 20)
    } catch {
      return
    }
    for (const target of gitIncludePaths(text, file, home)) {
      await addConfig(target, false)
      await followIncludes(target, depth + 1)
    }
  }
  for (const file of [posix.join(home, '.gitconfig'), posix.join(home, '.config', 'git', 'config')]) {
    await addConfig(file, false)
    await followIncludes(file, 0)
  }
  return { writeProtected: [...write], readProtected: [...read] }
}

/**
 * What the profile makes readable for the runner's Node: the distribution
 * dir it sits in (`<root>/bin/node`, `<root>/include/node`, a root named like
 * a Node install: `node`, `node-v24.1.0`, `v24.18.0`, `24.10.0`), so `npm`
 * and `npx` beside it work too; otherwise the binary alone. nvm's
 * `~/.nvm/versions/node/<v>`, the desktop's `<app data>/local-agent/runtime/<v>/node`
 * and Homebrew's Cellar dir all qualify.
 */
export async function nodeRuntimeRoot(nodePath: string): Promise<{ node: string; runtime: string }> {
  const node = await realpath(nodePath)
  const bin = posix.dirname(node)
  const root = posix.dirname(bin)
  const named = /^(node|node-v[\w.+-]+|v?\d+\.\d+\.\d+[\w.+-]*)$/.test(posix.basename(root))
  const runtime = posix.basename(bin) === 'bin' && named && existsSync(posix.join(root, 'include', 'node')) ? root : node
  return { node, runtime }
}

/** The realpaths of the tool PATH's entries that exist (toolPathReadRoots filters them). */
async function realToolPathEntries(toolPath: string): Promise<string[]> {
  const entries = await Promise.all(
    toolPath.split(':').map(async (e) => {
      if (!e.startsWith('/')) return null
      try {
        return await realpath(e)
      } catch {
        return null
      }
    }),
  )
  return entries.filter((e): e is string => e !== null)
}

/**
 * Check the grant and lay out the session's scratch directory:
 * `<tmp>/dial8-local-agent/<session>/{tmp, workspace -> folder}`. Idempotent,
 * so start and resume share it. Fails closed on anything unexpected.
 */
export async function resolveHostFolder(opts: HostFolderOpenOptions, ro: ResolveOptions): Promise<HostFolderConfig> {
  const { folder, mode, toolPath, extraRead } = validateOptions(opts)
  let real: string
  try {
    real = await realpath(folder)
  } catch {
    throw new HostFolderError(`the granted folder no longer exists: ${folder}`)
  }
  if (real !== folder) throw new HostFolderError(`the granted folder must be a realpath (${folder} resolves to ${real})`)
  if (!(await stat(real)).isDirectory()) throw new HostFolderError(`the granted folder is not a directory: ${folder}`)
  const home = await realpath(ro.home ?? process.env.HOME ?? homedir())
  assertGrantableFolder(real, home)
  // Edit mode is for a linked worktree only, with its repository's .git as the one extra read root.
  if (mode === 'edit' && extraRead === undefined) throw new HostFolderError('edit mode needs the repository git directory (LOCAL_AGENT_EXTRA_READ)')
  if (extraRead !== undefined) await checkExtraRead(extraRead, real, home)

  const tmpRoot = await realpath(ro.tmpRoot ?? tmpdir())
  const scratchRoot = posix.join(tmpRoot, 'dial8-local-agent', scratchName(ro.sessionId))
  const scratch = posix.join(scratchRoot, 'tmp')
  await mkdir(scratch, { recursive: true, mode: 0o700 })
  if (isWithin(scratch, real) || isWithin(real, scratchRoot)) throw new HostFolderError('the scratch directory overlaps the grant')

  let commandWorkspace = real
  if (!isShellSafePath(real)) {
    const alias = posix.join(scratchRoot, 'workspace')
    await ensureSymlink(alias, real)
    if (!isShellSafePath(alias)) throw new HostFolderError(`no shell-safe path for ${real}`)
    commandWorkspace = alias
  }
  const { node, runtime } = await nodeRuntimeRoot(ro.node ?? process.execPath)
  const toolRoots = toolPathReadRoots(await realToolPathEntries(toolPath), home)
  const { writeProtected, readProtected } = await protectedPaths({ toolPath, env: ro.env ?? process.env, home, node, runtime })
  const toolchainReal = await toolchainRealpaths(home)
  const profileInput: SeatbeltProfileInput = {
    mode,
    folder: real,
    home,
    scratch,
    sessionRoot: scratchRoot,
    ...(extraRead === undefined ? {} : { extraRead }),
    runtime,
    toolRoots,
    writeProtected,
    readProtected,
    ...(toolchainReal.length > 0 ? { toolchainRealpaths: toolchainReal } : {}),
  }
  return {
    folder: real,
    mode,
    toolPath,
    ...(extraRead === undefined ? {} : { extraRead }),
    home,
    scratchRoot,
    scratch,
    commandWorkspace,
    lang: ro.lang ?? 'en_US.UTF-8',
    node,
    profileInput,
    profile: buildSeatbeltProfile(profileInput),
  }
}

async function ensureSymlink(at: string, target: string): Promise<void> {
  try {
    if ((await lstat(at)).isSymbolicLink() && (await readlink(at)) === target) return
    await rm(at, { recursive: true, force: true })
  } catch {
    // missing: create it below
  }
  await symlink(target, at)
}

/** The nearest existing ancestor's realpath, with the missing tail re-attached. */
async function realpathNearest(path: string): Promise<string> {
  const missing: string[] = []
  let cur = path
  for (;;) {
    try {
      const real = await realpath(cur)
      return missing.length ? posix.join(real, ...missing.reverse()) : real
    } catch {
      if (cur === '/') return path
      missing.push(posix.basename(cur))
      cur = posix.dirname(cur)
    }
  }
}

// ── The job's fence grants ───────────────────────────────────────────────────

/**
 * The paths the person allowed for this job (C3 `kind: "fence"`). One eve
 * server runs one job, so they live in this process and apply to every
 * session in it; a relaunch (resume) starts with none and the agent asks
 * again. `version` moves on every change, and a session whose runner was
 * started under an older version starts a new one for its next command.
 */
const jobFence: { grants: FenceGrant[]; version: number } = { grants: [], version: 0 }

/** The fence grants this job has (newest last). */
export function jobFenceGrants(): readonly FenceGrant[] {
  return jobFence.grants
}

/**
 * Add a read grant the person allowed (fence grants are read-only, C3). A path
 * already covered changes nothing. The path is re-checked against each session
 * when its profile is built (a grant a session's layout refuses is left out of
 * that session).
 */
export function addJobFenceGrant(grant: FenceGrant): void {
  if ((grant.access as string) !== 'read') throw new HostFolderError('fence grants are read-only (C3)')
  if (jobFence.grants.some((g) => isWithin(grant.path, g.path))) return
  jobFence.grants = [...jobFence.grants, { path: grant.path, access: 'read' }]
  jobFence.version += 1
}

/** Forget every grant (tests; a job's grants otherwise end with its process). */
export function resetJobFenceGrants(): void {
  jobFence.grants = []
  jobFence.version += 1
}

function fenceContext(cfg: HostFolderConfig): FenceGrantContext {
  return {
    home: cfg.home,
    mode: cfg.mode,
    folder: cfg.folder,
    extraRead: cfg.extraRead,
    sessionRoot: cfg.scratchRoot,
    writeProtected: cfg.profileInput.writeProtected,
    readProtected: cfg.profileInput.readProtected,
  }
}

/** The job's grants this session's layout accepts. */
function grantsFor(cfg: HostFolderConfig): FenceGrant[] {
  return jobFence.grants.filter((g) => fenceGrantRefusal(g.path, g.access, fenceContext(cfg)) === null)
}

// ── The session ──────────────────────────────────────────────────────────────

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch {
    // already gone
  }
}

interface SpawnArgs {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string>
  readonly abortSignal?: AbortSignal
  readonly stdin?: Uint8Array
}

/** Live process groups, so a stop can kill them. */
type GroupSet = Set<number>

/** Starts one command under the profile. */
type Executor = (args: SpawnArgs) => Promise<SandboxProcess>

function signalNumber(sig: NodeJS.Signals | string): number {
  const n = (({ SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 }) as Record<string, number>)[sig]
  return n ?? 1
}

/**
 * Start `argv` in a sandbox of its own (`sandbox-exec` per call), detached in
 * its own process group. Only for one-off writes outside a session
 * (sandboxedWrite's default); a session runs every command in its runner.
 */
function directExecutor(profile: string, groups: GroupSet): Executor {
  return async (args) => {
    const signal = args.abortSignal
    if (signal?.aborted) throw abortReason(signal)
    const child = spawnChild(SANDBOX_EXEC, ['-p', profile, ...args.argv], {
      cwd: args.cwd,
      // A built-from-scratch env: cast because Next's global types make ProcessEnv require NODE_ENV (never set here).
      env: args.env as NodeJS.ProcessEnv,
      detached: true,
      stdio: [args.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    const pid = child.pid
    let aborted = false
    const kill = () => {
      if (pid !== undefined) killGroup(pid)
    }
    const onAbort = () => {
      aborted = true
      kill()
    }
    if (pid !== undefined) groups.add(pid)
    signal?.addEventListener('abort', onAbort, { once: true })
    const exited = new Promise<{ exitCode: number }>((resolve, reject) => {
      child.once('error', (err) => {
        signal?.removeEventListener('abort', onAbort)
        if (pid !== undefined) groups.delete(pid)
        reject(err)
      })
      child.once('exit', (code, sig) => {
        signal?.removeEventListener('abort', onAbort)
        if (pid !== undefined) groups.delete(pid)
        if (aborted && signal) reject(abortReason(signal))
        else resolve({ exitCode: code ?? (sig ? 128 + signalNumber(sig) : 1) })
      })
    })
    exited.catch(() => {}) // a caller that never waits must not leave an unhandled rejection
    if (args.stdin && child.stdin) {
      child.stdin.on('error', () => {})
      child.stdin.end(Buffer.from(args.stdin))
    }
    return {
      pid,
      stdout: Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr!) as unknown as ReadableStream<Uint8Array>,
      wait: () => exited,
      kill: async () => kill(),
    }
  }
}

// ── The job runner: one sandbox for every command of a job ──────────────────

/** Frames, host → runner: a 9-byte header (type, uint32 id, uint32 length), then the body. */
const H_SPAWN = 1
const H_STDIN = 2
const H_STDIN_END = 3
const H_REAP = 9
/** Frames, runner → host. */
const R_STARTED = 1
const R_OUT = 2
const R_ERR = 3
const R_OUT_END = 4
const R_ERR_END = 5
const R_EXIT = 6
const R_FAILED = 7
const HEADER = 9
/** stdin bytes go to the runner in frames of at most this size. */
const STDIN_CHUNK = 64 * 1024
/** How long a reap waits for the runner to go before it is killed from here. */
const REAP_GRACE_MS = 1500
/** A runner that has not started a command in this long is wedged (stopped, say): it is killed from here. */
const START_TIMEOUT_MS = 15_000

/**
 * The runner, run by `node -e` inside the sandbox (CommonJS, no file to read).
 * It forks each command detached (its own session and process group) with
 * pipes, and relays stdout, stderr and the exit in frames on its own stdout.
 * REAP, a closed stdin or a broken stdout: SIGKILL to -1, which from inside the
 * sandbox reaches exactly this sandbox's processes, the runner included.
 * SIGTERM, SIGINT and SIGHUP are ignored (`pkill node` must not end the job's
 * runner).
 *
 * The reaper covers the runner dying any other way (the launcher's teardown
 * SIGKILLs every process group below the eve server, `pkill -9 node` in a
 * job, a host-side kill of a wedged runner). It is a bash in the same
 * sandbox, double-forked at once (reparented to launchd, so outside the
 * server's process tree and every group the host kills), blocked reading a
 * socket on its fd 3 whose other end only the runner holds (fd 3, not stdin:
 * Node closes a child's stdin when that child exits, and bash gives a
 * background job /dev/null for stdin). When the runner is gone the read ends,
 * and the reaper sends SIGKILL to -1: every process of the sandbox, itself too.
 */
export const RUNNER_SOURCE = String.raw`'use strict'
const { spawn } = require('node:child_process')
const kids = new Map()
const out = process.stdout
function frame(type, id, body) {
  const b = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
  const h = Buffer.allocUnsafe(9)
  h[0] = type
  h.writeUInt32BE(id, 1)
  h.writeUInt32BE(b.length, 5)
  out.write(Buffer.concat([h, b]))
}
function reap() {
  try { process.kill(-1, 'SIGKILL') } catch {}
  process.exit(137)
}
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => {})
const reaper = spawn('/bin/bash', ['-c', '( while IFS= read -r _ <&3; do :; done; kill -9 -1 ) & exit 0'], { cwd: process.cwd(), env: { PATH: '/usr/bin:/bin' }, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] })
reaper.stdio[3].on('error', () => {})
reaper.stdio[3].unref()
reaper.unref()
out.on('error', reap)
process.stdin.on('error', reap)
process.stdin.on('end', reap)
let buf = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
  while (buf.length >= 9) {
    const len = buf.readUInt32BE(5)
    if (buf.length < 9 + len) break
    const type = buf[0]
    const id = buf.readUInt32BE(1)
    const body = buf.subarray(9, 9 + len)
    buf = buf.subarray(9 + len)
    try { handle(type, id, body) } catch (e) { frame(7, id, { message: String((e && e.message) || e) }) }
  }
})
function handle(type, id, body) {
  if (type === 9) return reap()
  if (type === 1) {
    const o = JSON.parse(new TextDecoder().decode(body))
    const child = spawn(o.argv[0], o.argv.slice(1), { cwd: o.cwd, env: o.env, detached: true, stdio: [o.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    kids.set(id, child)
    child.once('spawn', () => frame(1, id, { pid: child.pid }))
    child.once('error', (e) => { kids.delete(id); frame(7, id, { message: e.message, code: e.code }) })
    child.stdout.on('data', (d) => frame(2, id, d))
    child.stdout.once('end', () => frame(4, id))
    child.stderr.on('data', (d) => frame(3, id, d))
    child.stderr.once('end', () => frame(5, id))
    child.once('exit', (code, signal) => { kids.delete(id); frame(6, id, { code, signal }) })
    if (child.stdin) child.stdin.on('error', () => {})
    return
  }
  const child = kids.get(id)
  if (!child || !child.stdin) return
  if (type === 2) child.stdin.write(Buffer.from(body))
  else if (type === 3) child.stdin.end()
}
`

interface RunnerCall {
  readonly id: number
  pid?: number
  started: (pid: number) => void
  failed: (err: unknown) => void
  exited: (exit: { code: number | null; signal: string | null }) => void
  out: ReadableStreamDefaultController<Uint8Array> | null
  err: ReadableStreamDefaultController<Uint8Array> | null
  outOpen: boolean
  errOpen: boolean
  settled: boolean
  /** The caller gave up before the start (an abort): kill it the moment it starts. */
  abandoned: boolean
  startTimer?: ReturnType<typeof setTimeout>
}

/** One sandbox instance for a job's commands (one per fence-grant generation). */
export class JobRunner {
  private readonly child: ChildProcess
  private readonly calls = new Map<number, RunnerCall>()
  private nextId = 1
  private buf: Uint8Array = new Uint8Array(0)
  private stderrTail = ''
  alive = true
  readonly gone: Promise<void>

  constructor(profile: string, cfg: Pick<HostFolderConfig, 'node' | 'scratch' | 'home' | 'lang'>) {
    this.child = spawnChild(SANDBOX_EXEC, ['-p', profile, cfg.node, '-e', RUNNER_SOURCE], {
      cwd: cfg.scratch,
      env: { HOME: cfg.home, TMPDIR: cfg.scratch, LANG: cfg.lang, PATH: '/usr/bin:/bin' } as Record<string, string> as NodeJS.ProcessEnv,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdin!.on('error', () => {})
    this.child.stdout!.on('data', (chunk: Buffer) => this.onData(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)))
    this.child.stderr!.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-2000)
    })
    this.gone = new Promise<void>((resolve) => {
      const done = (why: string) => {
        if (!this.alive) return
        this.alive = false
        this.failAll(new HostFolderError(`the sandbox runner for this job ${why}${this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : ''}`))
        resolve()
      }
      this.child.once('error', (err) => done(`could not start (${err.message})`))
      this.child.once('exit', (code, sig) => done(`exited (${code ?? sig})`))
    })
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  /** Kill the runner from here (its reaper then kills the rest of its sandbox). */
  kill(): void {
    if (this.alive) this.child.kill('SIGKILL')
  }

  private send(type: number, id: number, body: Uint8Array = new Uint8Array(0)): void {
    if (!this.alive) return
    const frame = new Uint8Array(HEADER + body.byteLength)
    const view = new DataView(frame.buffer)
    frame[0] = type
    view.setUint32(1, id)
    view.setUint32(5, body.byteLength)
    frame.set(body, HEADER)
    this.child.stdin!.write(frame)
  }

  private onData(chunk: Uint8Array): void {
    if (this.buf.length > 0) {
      const merged = new Uint8Array(this.buf.length + chunk.length)
      merged.set(this.buf)
      merged.set(chunk, this.buf.length)
      this.buf = merged
    } else {
      this.buf = chunk
    }
    while (this.buf.length >= HEADER) {
      const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength)
      const len = view.getUint32(5)
      if (this.buf.length < HEADER + len) break
      const type = this.buf[0]
      const id = view.getUint32(1)
      const body = this.buf.subarray(HEADER, HEADER + len)
      this.buf = this.buf.subarray(HEADER + len)
      this.onFrame(type, id, body)
    }
  }

  private onFrame(type: number, id: number, body: Uint8Array): void {
    const call = this.calls.get(id)
    if (!call) return
    switch (type) {
      case R_STARTED:
        clearTimeout(call.startTimer)
        call.pid = (JSON.parse(new TextDecoder().decode(body)) as { pid: number }).pid
        if (call.abandoned) killGroup(call.pid)
        else call.started(call.pid)
        return
      case R_OUT:
        if (call.outOpen) call.out?.enqueue(body.slice())
        return
      case R_ERR:
        if (call.errOpen) call.err?.enqueue(body.slice())
        return
      case R_OUT_END:
        this.closeStream(call, 'out')
        return
      case R_ERR_END:
        this.closeStream(call, 'err')
        return
      case R_EXIT: {
        const exit = JSON.parse(new TextDecoder().decode(body)) as { code: number | null; signal: string | null }
        call.settled = true
        call.exited(exit)
        this.forgetIfDone(call)
        return
      }
      case R_FAILED: {
        clearTimeout(call.startTimer)
        const { message } = JSON.parse(new TextDecoder().decode(body)) as { message: string }
        call.settled = true
        // Before the start: the spawn fails. After it (rare): the command counts as failed.
        if (call.pid === undefined) call.failed(new HostFolderError(message))
        else call.exited({ code: 1, signal: null })
        this.closeStream(call, 'out')
        this.closeStream(call, 'err')
        return
      }
    }
  }

  private closeStream(call: RunnerCall, which: 'out' | 'err'): void {
    if (which === 'out' && call.outOpen) {
      call.outOpen = false
      call.out?.close()
    } else if (which === 'err' && call.errOpen) {
      call.errOpen = false
      call.err?.close()
    }
    this.forgetIfDone(call)
  }

  /** Drop a call once it has exited and both its streams have ended. */
  private forgetIfDone(call: RunnerCall): void {
    if (call.settled && !call.outOpen && !call.errOpen) this.calls.delete(call.id)
  }

  /**
   * The runner is gone. Calls not yet started fail. Started ones are killed
   * from here too (the reaper kills them from inside; this covers a reaper the
   * job killed first) and end as killed.
   */
  private failAll(err: Error): void {
    for (const call of [...this.calls.values()]) {
      clearTimeout(call.startTimer)
      if (call.pid !== undefined) killGroup(call.pid)
      if (!call.settled) {
        call.settled = true
        if (call.pid === undefined) call.failed(err)
        else call.exited({ code: null, signal: 'SIGKILL' })
      }
      this.closeStream(call, 'out')
      this.closeStream(call, 'err')
    }
    this.calls.clear()
  }

  /** Start one command in this sandbox; resolves once it runs (with its pid). */
  async spawn(args: SpawnArgs, groups: GroupSet): Promise<SandboxProcess> {
    const signal = args.abortSignal
    if (signal?.aborted) throw abortReason(signal)
    if (!this.alive) throw new HostFolderError('the sandbox runner for this job is gone')
    const id = this.nextId++
    let exitedFn!: (exit: { code: number | null; signal: string | null }) => void
    const exitP = new Promise<{ code: number | null; signal: string | null }>((res) => {
      exitedFn = res
    })
    const call: RunnerCall = {
      id,
      started: () => {},
      failed: () => {},
      exited: exitedFn,
      out: null,
      err: null,
      outOpen: true,
      errOpen: true,
      settled: false,
      abandoned: false,
    }
    const startedP = new Promise<number>((res, rej) => {
      call.started = res
      call.failed = rej
    })
    // A reader that stops reading (cancel) gets nothing more, and late output is dropped, never thrown.
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => void (call.out = c), cancel: () => void (call.outOpen = false) })
    const stderr = new ReadableStream<Uint8Array>({ start: (c) => void (call.err = c), cancel: () => void (call.errOpen = false) })
    this.calls.set(id, call)
    call.startTimer = setTimeout(() => this.kill(), START_TIMEOUT_MS)
    call.startTimer.unref?.()
    this.send(H_SPAWN, id, new TextEncoder().encode(JSON.stringify({ argv: args.argv, cwd: args.cwd, env: args.env, stdin: args.stdin !== undefined })))
    if (args.stdin) {
      for (let at = 0; at < args.stdin.byteLength; at += STDIN_CHUNK) this.send(H_STDIN, id, args.stdin.subarray(at, at + STDIN_CHUNK))
      this.send(H_STDIN_END, id)
    }

    let aborted = false
    let pid: number | undefined
    const kill = () => {
      if (pid !== undefined) killGroup(pid)
    }
    const onAbort = () => {
      aborted = true
      if (pid !== undefined) return kill()
      // Not started yet: give up now, and kill it the moment it starts.
      call.abandoned = true
      call.failed(abortReason(signal!))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      pid = await startedP
    } catch (e) {
      signal?.removeEventListener('abort', onAbort)
      throw e
    }
    groups.add(pid)
    const exited = exitP.then(({ code, signal: sig }) => {
      signal?.removeEventListener('abort', onAbort)
      groups.delete(pid!)
      if (aborted && signal) throw abortReason(signal)
      return { exitCode: code ?? (sig ? 128 + signalNumber(sig) : 1) }
    })
    exited.catch(() => {}) // a caller that never waits must not leave an unhandled rejection
    return { pid, stdout, stderr, wait: () => exited, kill: async () => kill() }
  }

  /** SIGKILL every process in this sandbox (from inside it), then make sure the runner is gone. */
  async reap(): Promise<void> {
    if (!this.alive) return
    this.send(H_REAP, 0)
    const gone = await Promise.race([this.gone.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), REAP_GRACE_MS).unref())])
    if (!gone) {
      this.kill() // wedged: its reaper kills the rest
      await this.gone
    }
  }
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk)
    size += chunk.byteLength
  }
  const out = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

async function runArgv(exec: Executor, args: SpawnArgs) {
  const proc = await exec(args)
  const [stdout, stderr, { exitCode }] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.wait()])
  return { exitCode, stdout, stderr: new TextDecoder().decode(stderr) }
}

/**
 * Write `bytes` to `hostPath` through the profile (`mkdir -p`, then `cat >`).
 * The session runs it in its runner after its own checks; tests call it
 * directly (a one-off sandbox) to show the kernel refuses the write as well.
 */
export async function sandboxedWrite(cfg: HostFolderConfig, hostPath: string, bytes: Uint8Array, signal?: AbortSignal, exec?: Executor): Promise<void> {
  const run = exec ?? directExecutor(cfg.profile, new Set())
  const env = buildCommandEnv(cfg)
  const dir = await runArgv(run, { argv: ['/bin/mkdir', '-p', '--', posix.dirname(hostPath)], cwd: cfg.folder, env, abortSignal: signal })
  if (dir.exitCode !== 0) throw new HostFolderError(`could not write ${hostPath}: ${dir.stderr.trim() || `exit ${dir.exitCode}`}`)
  const res = await runArgv(run, {
    argv: ['/bin/sh', '-c', 'exec /bin/cat > "$1"', 'sh', hostPath],
    cwd: cfg.folder,
    env,
    abortSignal: signal,
    stdin: bytes,
  })
  if (res.exitCode !== 0) throw new HostFolderError(`could not write ${hostPath}: ${res.stderr.trim() || `exit ${res.exitCode}`}`)
}

function validateLineRange(o: { startLine?: number; endLine?: number }): void {
  const { startLine: s, endLine: e } = o
  if (s !== undefined && (!Number.isInteger(s) || s < 1)) throw new Error('startLine must be a positive integer (1-based).')
  if (e !== undefined && (!Number.isInteger(e) || e < 1)) throw new Error('endLine must be a positive integer (1-based).')
  if (s !== undefined && e !== undefined && s > e) throw new Error('startLine must not be greater than endLine.')
}

/** 1-based inclusive line slice, keeping line endings (eve's public-surface semantics). */
export function sliceLines(text: string, startLine?: number, endLine?: number): string {
  if (startLine === undefined && endLine === undefined) return text
  const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? []
  const from = startLine ?? 1
  if (from > lines.length) return ''
  return lines.slice(from - 1, Math.min(endLine ?? lines.length, lines.length)).join('')
}

function decode(bytes: Uint8Array, encoding: string): string {
  if (encoding === 'utf-8' || encoding === 'utf8') return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(encoding as BufferEncoding)
}

function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/**
 * One eve session's sandbox processes: its runner, the runners of earlier
 * grant generations (still holding their running commands), and the command
 * groups it started. eve builds a new handle for a session on every workflow
 * step (`resume()` each time), so this lives here, by scratch root, and every
 * handle of the session shares it: a job started in one step can be stopped
 * from the next, and a stop reaps everything the session started.
 */
interface SessionSandbox {
  runner: JobRunner | null
  version: number
  readonly earlier: JobRunner[]
  readonly groups: GroupSet
}

const sessionSandboxes = new Map<string, SessionSandbox>()

function sessionSandboxFor(scratchRoot: string): SessionSandbox {
  let s = sessionSandboxes.get(scratchRoot)
  if (!s) {
    s = { runner: null, version: -1, earlier: [], groups: new Set() }
    sessionSandboxes.set(scratchRoot, s)
  }
  return s
}

/** SIGKILL every command group from here, then reap each runner from inside its sandbox. */
async function reapSessionSandbox(s: SessionSandbox): Promise<void> {
  for (const pgid of s.groups) killGroup(pgid)
  s.groups.clear()
  const all = [...s.earlier, ...(s.runner ? [s.runner] : [])]
  s.earlier.length = 0
  s.runner = null
  await Promise.all(all.map((r) => r.reap()))
}

/**
 * The 10-member session over one resolved grant, plus `killAll` for the
 * handle hooks (it reaps the whole session's sandbox, whichever handle calls it).
 */
export function createHostFolderSession(cfg: HostFolderConfig): { session: SandboxSession; killAll(): Promise<void> } {
  const shared = sessionSandboxFor(cfg.scratchRoot)
  const groups = shared.groups

  const currentRunner = (): JobRunner => {
    if (shared.runner?.alive && shared.version === jobFence.version) return shared.runner
    if (shared.runner?.alive) shared.earlier.push(shared.runner)
    const grants = grantsFor(cfg)
    shared.version = jobFence.version
    shared.runner = new JobRunner(grants.length === 0 ? cfg.profile : buildSeatbeltProfile({ ...cfg.profileInput, grants }), cfg)
    return shared.runner
  }
  const exec: Executor = (args) => currentRunner().spawn(args, groups)

  const roots = () => ({ folder: cfg.folder, scratch: cfg.scratch, commandWorkspace: cfg.commandWorkspace, grants: grantsFor(cfg).map((g) => g.path) })

  /** Map, realpath and re-check a path for access. */
  const resolveForAccess = async (path: string): Promise<string> => {
    const r = roots()
    const real = await realpathNearest(mapSandboxPath(path, r))
    if (!isWithin(real, cfg.folder) && !isWithin(real, cfg.scratch) && !r.grants.some((g) => isWithin(real, g))) {
      throw new HostFolderError(`${path} is outside the granted folder (/workspace)`)
    }
    return real
  }

  /**
   * A secret file in a read job's folder or a fence grant (seatbelt.ts
   * isSecretFileName): the kernel refuses it, this says why first. Not in an
   * edit job's worktree, a fresh checkout of tracked files.
   */
  const refuseSecret = (path: string, hostPath: string): void => {
    const roots = [...(cfg.mode === 'read' ? [cfg.folder] : []), ...grantsFor(cfg).map((g) => g.path)]
    if (roots.some((root) => hostPath !== root && isWithin(hostPath, root)) && isSecretFileName(posix.basename(hostPath))) {
      throw new HostFolderError(`${path} is a secret file (a .env file, a key or a credentials file): a job never reads those.`)
    }
  }

  const readBytes = async (path: string, signal?: AbortSignal): Promise<Uint8Array | null> => {
    const hostPath = await resolveForAccess(path)
    let info
    try {
      info = await stat(hostPath)
    } catch {
      return null
    }
    if (info.isDirectory()) throw new HostFolderError(`${path} is a directory`)
    // After the directory check: a folder with a secret's name (a Python venv named `.env`) is not one.
    refuseSecret(path, hostPath)
    if (info.size > MAX_READ_BYTES) throw new HostFolderError(`${path} is larger than ${MAX_READ_BYTES} bytes`)
    const res = await runArgv(exec, { argv: ['/bin/cat', '--', hostPath], cwd: cfg.folder, env: buildCommandEnv(cfg), abortSignal: signal })
    if (res.exitCode !== 0) throw new HostFolderError(`could not read ${path}: ${res.stderr.trim() || `exit ${res.exitCode}`}`)
    return res.stdout
  }

  const refuseWrite = (path: string): never => {
    throw new HostFolderError(`This folder was granted read-only: ${path} cannot be written or removed.`)
  }

  /**
   * Edit mode: a config the person's tools run on their own, in the worktree
   * or the scratch dir (seatbelt.ts: a folder built in the scratch dir could
   * be moved in whole).
   */
  const refuseAutoRun = (path: string, hostPath: string, root: string): void => {
    if (hostPath !== root && isAutoRunConfig(hostPath.slice(root.length + 1))) {
      throw new HostFolderError(
        `${path} holds commands the person's own tools run on their own (Claude Code settings, hooks and MCP servers, VS Code tasks, git hooks, npm and Yarn config): this job can't create, change, move or remove it. Describe the change in your finish summary instead.`,
      )
    }
  }

  /**
   * The host path to write or remove: the scratch dir in both modes (eve's
   * staging dir lives there, and staging must not throw in a read-only job);
   * in edit mode, also inside the worktree (never its `.git` entry, a nested
   * `.git` or an auto-run config; nor an auto-run config in the scratch dir).
   * Fence grants are read-only. The kernel refuses the same.
   */
  const resolveForWrite = async (path: string): Promise<string> => {
    const hostPath = await resolveForAccess(path)
    if (isWithin(hostPath, cfg.scratch)) {
      if (cfg.mode === 'edit') refuseAutoRun(path, hostPath, cfg.scratch)
      return hostPath
    }
    if (cfg.mode === 'read') refuseWrite(path)
    if (!isWithin(hostPath, cfg.folder)) {
      throw new HostFolderError(`${path} was allowed read-only for this job: it cannot be written or removed.`)
    }
    if (hostPath !== cfg.folder && hostPath.slice(cfg.folder.length + 1).split('/')[0].toLowerCase() === EXTRA_READ_NAME) {
      throw new HostFolderError(`${path} is the worktree's git link, which the app manages: it cannot be written or removed.`)
    }
    if (isGitEntry(hostPath, cfg.folder)) {
      throw new HostFolderError(`${path} is in a .git: no .git can be made or changed in the worktree (git outside the sandbox would run what one holds). The app commits when the job finishes.`)
    }
    refuseAutoRun(path, hostPath, cfg.folder)
    return hostPath
  }

  const write = async (path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> => {
    await sandboxedWrite(cfg, await resolveForWrite(path), bytes, signal, exec)
  }

  const commandArgs = async (opts: SandboxRunOptions | SandboxSpawnOptions): Promise<SpawnArgs> => {
    const cwd = opts.workingDirectory ? await resolveForAccess(opts.workingDirectory) : cfg.folder
    const command = rewriteCommandPaths(opts.command, { workspace: cfg.commandWorkspace, eveTmp: `${cfg.scratch}/.eve`, workspaceEve: `${cfg.scratch}/${WORKSPACE_EVE_DIR}` })
    return { argv: ['/bin/bash', '-c', command], cwd, env: buildCommandEnv(cfg, opts.env), abortSignal: opts.abortSignal }
  }

  const session: SandboxSession = {
    resolvePath: (path) => mapSandboxPath(path, roots()),
    async spawn(opts) {
      return await exec(await commandArgs(opts))
    },
    async run(opts) {
      const res = await runArgv(exec, await commandArgs(opts))
      return { exitCode: res.exitCode, stdout: new TextDecoder().decode(res.stdout), stderr: res.stderr }
    },
    async readFile(opts) {
      const bytes = await readBytes(opts.path, opts.abortSignal)
      return bytes === null ? null : bytesStream(bytes)
    },
    async readBinaryFile(opts) {
      return await readBytes(opts.path, opts.abortSignal)
    },
    async readTextFile(opts) {
      validateLineRange(opts)
      const bytes = await readBytes(opts.path, opts.abortSignal)
      return bytes === null ? null : sliceLines(decode(bytes, opts.encoding ?? 'utf-8'), opts.startLine, opts.endLine)
    },
    async writeFile(opts) {
      const hostPath = await resolveForWrite(opts.path) // before draining the stream
      await sandboxedWrite(cfg, hostPath, await collect(opts.content), opts.abortSignal, exec)
    },
    async writeBinaryFile(opts) {
      await write(opts.path, opts.content, opts.abortSignal)
    },
    async writeTextFile(opts) {
      const enc = opts.encoding ?? 'utf-8'
      await write(opts.path, enc === 'utf-8' || enc === 'utf8' ? new TextEncoder().encode(opts.content) : new Uint8Array(Buffer.from(opts.content, enc as BufferEncoding)), opts.abortSignal)
    },
    async removePath(opts) {
      const hostPath = await resolveForWrite(opts.path)
      const flags = [opts.recursive ? '-r' : '', opts.force ? '-f' : ''].filter(Boolean)
      const res = await runArgv(exec, { argv: ['/bin/rm', ...flags, '--', hostPath], cwd: cfg.folder, env: buildCommandEnv(cfg), abortSignal: opts.abortSignal })
      if (res.exitCode !== 0) throw new HostFolderError(`could not remove ${opts.path}: ${res.stderr.trim() || `exit ${res.exitCode}`}`)
    },
  }

  return {
    session,
    killAll: () => reapSessionSandbox(shared),
  }
}

// ── Asking for one more path (C3 kind "fence") ───────────────────────────────

export interface FenceRequest {
  /** An absolute host path (`~/...` is HOME), outside the job's folder. */
  readonly path: string
  /** `read`. A `write` request is refused before anyone is asked: fence grants are read-only (C3). */
  readonly access: FenceAccess
  /** Shown to the person; cut to 300 characters. */
  readonly reason?: string
}

export interface FenceResult {
  readonly granted: boolean
  /** The realpath that was (or would have been) granted. */
  readonly path: string
  /** One line for the agent: what happened and what it can do now. */
  readonly message: string
}

export interface FenceDeps {
  readonly ask?: (kind: 'fence', detail: { path: string; access: 'read'; reason?: string }, opts?: AskOptions) => Promise<PromptOutcome>
  readonly env?: LaunchEnv
  readonly home?: string
  readonly tmpRoot?: string
  readonly timeoutMs?: number
  /** The server's Node (write-protected with its runtime). Defaults to process.execPath. */
  readonly node?: string
}

/**
 * Ask the person for one more path this job may READ and, on yes, widen the
 * fence for every later command of the job (all its sessions in this
 * process). Fence grants are read-only (C3): a `write` request is refused
 * before anything is asked. The path is checked before anyone is asked
 * (fenceGrantRefusal: never credential stores or where their entries really
 * live, app data, the scratch dir...); a path already readable is granted
 * without a prompt. The answer is the desktop's native prompt
 * (launcher/prompts.ts). No answer in time, or no prompt channel, is a no,
 * and an answer after the timeout never acts. The grant ends with this eve
 * server.
 */
export async function requestFenceAccess(req: FenceRequest, deps: FenceDeps = {}): Promise<FenceResult> {
  const env = deps.env ?? process.env
  const ask = deps.ask ?? askPerson
  const folder = env.LOCAL_AGENT_FOLDER
  const mode = env.LOCAL_AGENT_MODE
  const extraRead = env.LOCAL_AGENT_EXTRA_READ || undefined
  const no = (path: string, message: string): FenceResult => ({ granted: false, path, message })
  if (!folder || (mode !== 'read' && mode !== 'edit')) return no(req.path, 'this job has no host folder to widen')
  if (req.access === 'write') return no(req.path, 'not asked: fence grants are read-only (C3): a job changes files only in its own folder')
  if (req.access !== 'read') return no(req.path, 'access must be "read"')
  const home = await realpath(deps.home ?? env.HOME ?? homedir())
  const raw = typeof req.path === 'string' && req.path.startsWith('~/') ? posix.join(home, req.path.slice(2)) : req.path
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.includes('\0')) return no(String(req.path), 'the path must be absolute (or start with ~/)')
  const abs = posix.normalize(raw)
  // The path, or a new entry in a folder that exists (as the desktop requires).
  let real: string
  try {
    real = await realpath(abs)
  } catch {
    try {
      real = posix.join(await realpath(posix.dirname(abs)), posix.basename(abs))
    } catch {
      return no(abs, 'neither the path nor the folder it would be in exists')
    }
  }
  const { node, runtime } = await nodeRuntimeRoot(deps.node ?? process.execPath)
  const ctx: FenceGrantContext = {
    home,
    mode,
    folder,
    extraRead,
    sessionRoot: posix.join(await realpath(deps.tmpRoot ?? tmpdir()), 'dial8-local-agent'),
    ...(await protectedPaths({ toolPath: env.LOCAL_AGENT_TOOL_PATH ?? '', env, home, node, runtime })),
  }
  const refusal = fenceGrantRefusal(real, req.access, ctx)
  if (refusal) return no(real, `not asked: ${refusal}`)
  const covered = jobFence.grants.some((g) => isWithin(real, g.path)) || isWithin(real, folder) || (extraRead !== undefined && isWithin(real, extraRead))
  if (covered) return { granted: true, path: real, message: `${real} is already readable in this job` }

  const reason = typeof req.reason === 'string' && req.reason.trim() ? req.reason.trim().slice(0, 300) : undefined
  const grant: FenceGrant = { path: real, access: 'read' }
  const outcome = await ask('fence', { path: real, access: 'read', ...(reason ? { reason } : {}) }, deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs })
  if (!outcome.allowed) {
    const why = { denied: 'the person said no', timeout: 'the person did not answer in time', unavailable: 'there is no one to ask on this Mac', invalid: 'the request could not be shown', allowed: '' }[outcome.reason]
    return no(real, `not allowed: ${why}`)
  }
  addJobFenceGrant(grant)
  return {
    granted: true,
    path: real,
    message: `allowed for this job: later commands can read ${real} (never change it)`,
  }
}

// ── The provider ─────────────────────────────────────────────────────────────

function handleFor(cfg: HostFolderConfig): SandboxProviderHandle {
  const { session, killAll } = createHostFolderSession(cfg)
  return {
    sandbox: session,
    onSandboxStop: killAll,
    onRuntimeShutdown: killAll,
    async onSandboxDelete() {
      await killAll()
      sessionSandboxes.delete(cfg.scratchRoot)
      await rm(cfg.scratchRoot, { recursive: true, force: true })
    },
  }
}

function assertState(state: Readonly<HostFolderState>): HostFolderState {
  if (!state || state.version !== 1) throw new HostFolderError('unknown host-folder sandbox state')
  return state
}

/**
 * A resumed session must still match the grant the desktop launched this job
 * with: if LOCAL_AGENT_FOLDER / LOCAL_AGENT_MODE / LOCAL_AGENT_EXTRA_READ are
 * set, they must equal the checkpointed state, or the resume fails closed.
 */
function assertMatchesLaunch(state: HostFolderState, env: LaunchEnv): void {
  if (env.LOCAL_AGENT_FOLDER !== undefined && env.LOCAL_AGENT_FOLDER !== state.folder) {
    throw new HostFolderError('this job was launched for a different folder than the session was started in')
  }
  if (env.LOCAL_AGENT_MODE !== undefined && env.LOCAL_AGENT_MODE !== state.mode) {
    throw new HostFolderError('this job was launched with a different mode than the session was started in')
  }
  // With a launch environment present, the extra read root must match too (unset = none).
  if (env.LOCAL_AGENT_FOLDER !== undefined && (env.LOCAL_AGENT_EXTRA_READ || undefined) !== state.extraRead) {
    throw new HostFolderError('this job was launched with a different repository git directory than the session was started in')
  }
}

/** The provider implementation; exported so tests drive start/resume without eve's runtime. */
export function hostFolderImplementation(
  deps: { home?: string; tmpRoot?: string; env?: LaunchEnv } = {},
): SandboxProviderImplementation<HostFolderOpenOptions, Record<string, never>, HostFolderState> {
  const env = () => deps.env ?? process.env
  const resolveOpts = (ctx: SandboxProviderSessionContext): ResolveOptions => ({
    sessionId: ctx.session.id,
    home: deps.home,
    tmpRoot: deps.tmpRoot,
    lang: env().LANG,
    env: env(),
  })
  return {
    async prepare() {
      return {}
    },
    async start(ctx, options) {
      const cfg = await resolveHostFolder(validateOptions(options), resolveOpts(ctx))
      const state: HostFolderState = {
        folder: cfg.folder,
        mode: cfg.mode,
        toolPath: cfg.toolPath,
        ...(cfg.extraRead === undefined ? {} : { extraRead: cfg.extraRead }),
        version: 1,
      }
      return { handle: handleFor(cfg), state }
    },
    async resume(ctx, _artifact, rawState) {
      const state = assertState(rawState)
      assertMatchesLaunch(state, env())
      // resolveHostFolder re-checks that the folder exists and its realpath is unchanged.
      return handleFor(await resolveHostFolder(state, resolveOpts(ctx)))
    },
    async onSessionEnd(ctx) {
      const tmpRoot = await realpath(deps.tmpRoot ?? tmpdir())
      const scratchRoot = posix.join(tmpRoot, 'dial8-local-agent', scratchName(ctx.session.id))
      // The session's runners reap their sandboxes. A session started by an
      // earlier server has none here: those reaped when their server went away.
      const shared = sessionSandboxes.get(scratchRoot)
      sessionSandboxes.delete(scratchRoot)
      if (shared) await reapSessionSandbox(shared)
      await rm(scratchRoot, { recursive: true, force: true })
    },
  }
}

export const HostFolderSandbox = defineSandboxProvider<undefined, HostFolderOpenOptions, Record<string, never>, HostFolderState>({
  // The older name on purpose: eve saves it in each job's session and refuses a
  // session whose provider has another name, and jobs outlive an app update.
  name: 'dial8-host-folder',
  stateProtocolVersion: 1,
  environment: () => hostFolderImplementation(),
})
