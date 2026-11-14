/**
 * The agent's private home: its HOME, `<job dir>/home` (0700), one per job
 * and never another job's, so nothing one job leaves there (settings, hooks,
 * a memory file) reaches the next. Resuming the same job reuses its own home,
 * so the session can be picked up. None of the person's own settings, hooks,
 * skills, plugins or MCP servers is read from there, and none can be written.
 *
 * The person's existing login is linked in, nothing more:
 *   - `login.keychain`: `<home>/Library/Keychains` → the Mac's keychain
 *     folder (the profile opens that real folder);
 *   - `login.files`: each single login file (`.codex/auth.json`) → the real
 *     file. Its folder in the private home is the agent's own; in the real
 *     folder only that file and its save's scratch names are writable.
 *
 * This runs OUTSIDE the fence, on paths the agent could write during an
 * earlier launch of the same job. So it repairs nothing and removes nothing
 * it reaches through them: every folder from the job dir down must be a real
 * folder at its own realpath (made here when missing), and at a login link's
 * name only a link may stand (one to another target is unlinked, never
 * followed). Anything else makes the launch fail with a sentence.
 *
 * Two repairs are made:
 *   - whatever stands where a login link should be (settleLoginLink) is
 *     FIRST renamed out of the agent's reach, into the job dir itself (the
 *     desktop's folder: only `<job dir>/home` is writable from inside the
 *     fence), and only THEN looked at. A rename moves the entry as it is at
 *     that instant, so a process of the agent's still alive and swapping a
 *     file and a link there can't make an unsandboxed check see one thing and
 *     a move carry another. A regular file of this user with one name and a
 *     sane size (an agent that saved its login beside the path it was given)
 *     then goes onto the real login file, so the person's own login never
 *     keeps a refresh token the agent already spent; a link is dropped; a
 *     folder is left in the job dir and reported; anything else is unlinked.
 *     The link is then put back. This runs at the next launch and in
 *     `acp.mjs --return-logins`, which the desktop runs after its sweep of
 *     the job's processes; never at the adapter's own teardown, when a
 *     process that left the tree may still be running;
 *   - a second name of the real login file that is one of its scratch names
 *     in the same folder (a hard link left there) is unlinked.
 */
import { randomBytes } from 'node:crypto'
import { closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeSync, type Stats } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { RegistryEntry } from './registry.js'

export class AgentHomeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentHomeError'
  }
}

export interface PreparedHome {
  /** `<job dir>/home`. */
  readonly home: string
  /** The private folders checked or made here (the home first): the profile pins each against rename and removal. */
  readonly folders: readonly string[]
  /** realpath of the Mac's keychain folder, when the agent's login is there. */
  readonly keychain?: string
  /** Each shared login file that exists: its realpath, its real folder, and its scratch names (globs within the folder). */
  readonly loginFiles: readonly LoginLink[]
}

/** A shared login file: its link in the private home (`at`), its realpath, its real folder and its scratch names. */
export interface LoginLink {
  readonly at: string
  readonly file: string
  readonly dir: string
  readonly scratch: readonly string[]
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

const unsafe = (p: string) => new AgentHomeError(`${p} was changed by an earlier run (it is not the folder this app made), so this job can't start safely. Start a new job.`)

/** `path` as a real folder at its own realpath: made (0700) when missing, never repaired. */
function ensureFolder(path: string): string {
  const st = lstatOrNull(path)
  if (!st) mkdirSync(path, { mode: 0o700 })
  else if (st.isSymbolicLink() || !st.isDirectory()) throw unsafe(path)
  if (realpathSync(path) !== path) throw unsafe(path)
  return path
}

/** The largest login file put back: a login is a few KB. */
const MAX_LOGIN_BYTES = 1024 * 1024

const lockedOut = (file: string, err: unknown) => {
  const code = (err as NodeJS.ErrnoException).code
  return new AgentHomeError(
    code === 'EPERM' || code === 'EACCES'
      ? `the agent's newer login could not be put onto ${file}: the file is locked or not writable (${code})`
      : `the agent's newer login could not be put onto ${file}: ${err instanceof Error ? err.message : String(err)}`,
  )
}

/**
 * Move a regular file (in the job dir, out of the agent's reach) onto `to`: a
 * rename on one volume; across volumes, an exclusive, no-follow copy to a new
 * name beside `to`, then a rename over it. The copy opens its source without
 * blocking and checks it is a regular file before reading (a FIFO must not
 * hang the desktop), and never leaves its temporary file (it holds the token).
 */
export function moveLoginFile(from: string, to: string, sameVolume: boolean) {
  try {
    if (sameVolume) return renameSync(from, to)
    const tmp = join(dirname(to), `.${basename(to)}.ni-${randomBytes(6).toString('hex')}`)
    const src = openSync(from, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    let made = false
    try {
      if (!fstatSync(src).isFile()) throw new AgentHomeError(`${from} is not a regular file`)
      const dst = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
      made = true
      try {
        const buf = new Uint8Array(64 * 1024)
        for (let n = readSync(src, buf); n > 0; n = readSync(src, buf)) writeSync(dst, buf, 0, n)
        fsyncSync(dst)
      } finally {
        closeSync(dst)
      }
      renameSync(tmp, to)
      made = false
    } finally {
      closeSync(src)
      if (made) rmSync(tmp, { force: true })
    }
    unlinkSync(from)
  } catch (err) {
    throw err instanceof AgentHomeError ? err : lockedOut(to, err)
  }
}

export type SettleOutcome = 'linked' | 'returned' | 'dropped'

/**
 * Make `at` a link to the real login `file` again (see the header): rename
 * what stands there into `jobDir`, look at it there, return a saved login onto
 * `file`, and relink. Throws a sentence when the link can't be put back.
 */
export function settleLoginLink(jobDir: string, at: string, file: string, log: (line: string) => void = () => {}): SettleOutcome {
  let outcome: SettleOutcome = 'linked'
  for (let attempt = 0; attempt < 3; attempt++) {
    const st = lstatOrNull(at)
    if (st?.isSymbolicLink() && readlinkSync(at) === file) return outcome
    if (st) {
      const moved = join(jobDir, `.adopt-${randomBytes(8).toString('hex')}`)
      try {
        renameSync(at, moved)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw unsafe(at)
      }
      const m = lstatOrNull(moved)
      if (m?.isSymbolicLink()) unlinkSync(moved)
      else if (m?.isFile() && m.uid === process.getuid?.() && m.nlink === 1 && m.size <= MAX_LOGIN_BYTES) {
        moveLoginFile(moved, file, m.dev === statSync(dirname(file)).dev)
        log(`[worker] put the login the agent saved beside ${at} onto the person's own`)
        outcome = 'returned'
      } else if (m?.isDirectory()) {
        log(`[worker] a folder stood where ${at} should be a link; it was moved to ${moved}`)
        outcome = outcome === 'returned' ? outcome : 'dropped'
      } else if (m) {
        unlinkSync(moved)
        outcome = outcome === 'returned' ? outcome : 'dropped'
      }
    }
    try {
      symlinkSync(file, at)
      return outcome
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // Something was put there meanwhile: look again.
    }
  }
  throw unsafe(at)
}

/**
 * `acp.mjs --return-logins`: settle every login link of `entry` in this job's
 * home, the job's processes being gone. The number of logins put back.
 */
export function returnLoginFiles(jobDir: string, realHome: string, entry: Pick<RegistryEntry, 'login'>, log: (line: string) => void): number {
  if (realpathSync(jobDir) !== jobDir) throw new AgentHomeError(`the job dir must be a realpath: ${jobDir}`)
  const home = join(jobDir, 'home')
  const existingFolder = (p: string) => {
    const st = lstatOrNull(p)
    if (!st) return false
    if (st.isSymbolicLink() || !st.isDirectory() || realpathSync(p) !== p) throw unsafe(p)
    return true
  }
  if (!existingFolder(home)) return 0
  let returned = 0
  for (const f of entry.login.files) {
    const parts = f.path.split('/')
    if (!parts.slice(0, -1).every((_, i) => existingFolder(join(home, ...parts.slice(0, i + 1))))) continue
    const real = lstatOrNull(join(realHome, f.path))
    if (!real?.isFile()) continue
    if (settleLoginLink(jobDir, join(home, f.path), realpathSync(join(realHome, f.path)), log) === 'returned') returned += 1
  }
  return returned
}

/** Unlink the second names of `file` that are its scratch names in its own folder; true when one name is left. */
function dropScratchNames(file: string, scratch: readonly string[]): boolean {
  const st = lstatSync(file)
  const dir = dirname(file)
  const globs = scratch.map((g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`))
  for (const name of readdirSync(dir)) {
    if (name === basename(file) || !globs.some((g) => g.test(name))) continue
    const other = lstatOrNull(join(dir, name))
    if (other && !other.isSymbolicLink() && other.ino === st.ino && other.dev === st.dev) unlinkSync(join(dir, name))
  }
  return lstatSync(file).nlink === 1
}

/** A link at `at` to `target`: kept when it is one, relinked when it points elsewhere, refused when anything else stands there. */
function ensureLink(at: string, target: string) {
  const st = lstatOrNull(at)
  if (st && !st.isSymbolicLink()) throw unsafe(at)
  if (st && readlinkSync(at) === target) return
  if (st) unlinkSync(at) // a link only: unlink never touches what it points at
  symlinkSync(target, at)
}

/** The real folder behind a HOME path: a folder (not a link to one), or null when the person has none. */
function realFolder(path: string): string | null {
  const st = lstatOrNull(path)
  if (!st) return null
  if (st.isSymbolicLink() || !st.isDirectory()) throw new AgentHomeError(`${path} is not a plain folder, so it can't be shared with the agent`)
  return realpathSync(path)
}

/**
 * Check or make `<jobDir>/home` and its links. `jobDir` is the job's own
 * folder (the desktop's, which the agent can't write); `realHome` the person's.
 */
export function prepareAgentHome(jobDir: string, realHome: string, entry: Pick<RegistryEntry, 'homeFolders' | 'login'>): PreparedHome {
  if (realpathSync(jobDir) !== jobDir) throw new AgentHomeError(`the job dir must be a realpath: ${jobDir}`)
  const home = ensureFolder(join(jobDir, 'home'))
  const folders = [home]
  for (const name of entry.homeFolders) folders.push(ensureFolder(join(home, name)))
  let keychain: string | undefined
  if (entry.login.keychain) {
    const real = realFolder(join(realHome, 'Library', 'Keychains'))
    if (!real) throw new AgentHomeError("this Mac's keychain folder is missing")
    folders.push(ensureFolder(join(home, 'Library')))
    ensureLink(join(home, 'Library', 'Keychains'), real)
    keychain = real
  }
  const loginFiles: LoginLink[] = []
  for (const f of entry.login.files) {
    const parts = f.path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const p = join(home, ...parts.slice(0, i))
      if (!folders.includes(p)) folders.push(ensureFolder(p))
    }
    const at = join(home, f.path)
    const real = join(realHome, f.path)
    const st = lstatOrNull(real)
    if (!st) {
      // Not signed in: a stale link goes (a link only); anything else there is the agent's own and stays.
      if (lstatOrNull(at)?.isSymbolicLink()) unlinkSync(at)
      continue
    }
    // A plain file with one name: a link or a hard link there could point the shared write at anything. A second name
    // that is one of its own scratch names (a hard link left in its folder) is dropped first.
    const notPlain = () => new AgentHomeError(`${real} is not a plain file, so it can't be shared with the agent`)
    if (!st.isFile()) throw notPlain()
    const file = realpathSync(real)
    if (st.nlink !== 1 && !dropScratchNames(file, f.scratch)) throw notPlain()
    settleLoginLink(jobDir, at, file)
    loginFiles.push({ at, file, dir: dirname(file), scratch: f.scratch })
  }
  return { home, folders, ...(keychain ? { keychain } : {}), loginFiles }
}
