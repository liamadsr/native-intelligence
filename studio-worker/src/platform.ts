/**
 * What differs between the machines the worker runs on: the Linux server (its container), a Mac, and Windows (the
 * desktop app's local runner). Each function takes the platform (default: this process's) so every branch is tested
 * here on any machine (test/platform.test.ts); what only a real Windows machine proves is said where it matters.
 */
import { spawn } from 'node:child_process'
import { lstat, rm, symlink, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

export type Platform = NodeJS.Platform

/** The FFmpeg and ffprobe the worker runs: STUDIO_FFMPEG / STUDIO_FFPROBE (absolute paths), else the names on PATH. */
const tools = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }

/** Set where FFmpeg and ffprobe are (config.ts reads them; the local runner passes the ones it carries). */
export function setTools(paths: { ffmpeg?: string | null; ffprobe?: string | null }): void {
  if (paths.ffmpeg) tools.ffmpeg = paths.ffmpeg
  if (paths.ffprobe) tools.ffprobe = paths.ffprobe
}

/** The program to start for a tool named `name`: FFmpeg's and ffprobe's configured paths, anything else as given. */
export function toolPath(name: string): string {
  return name === 'ffmpeg' || name === 'ffprobe' ? tools[name] : name
}

/** A program's name without its folder or a Windows `.exe` (what fenceInputs and the logs go by). Pure. */
export function toolName(file: string): string {
  return file.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '')
}

/**
 * Whether a child should get a process group of its own (`detached`). On POSIX that is how a cancel stops what it
 * started too (killTree). On Windows `detached` gives it a console of its own instead (a window, unless hidden) and
 * does not group anything: the tree is stopped by its pid (taskkill /T), and the desktop app's Job Object stops
 * whatever is left when the runner goes.
 */
export const ownGroup = (platform: Platform = process.platform) => platform !== 'win32'

/**
 * Windows' taskkill by its full path: a bare name is looked up in the current folder before PATH, so a taskkill.exe
 * left in the folder the runner started in would run instead. Pure.
 */
export function taskkillPath(env: NodeJS.ProcessEnv = process.env): string {
  return `${(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows').replace(/[\\/]+$/, '')}\\System32\\taskkill.exe`
}

/**
 * Stop a program and everything it started: on POSIX its process group (SIGTERM now, SIGKILL after `graceMs`); on
 * Windows `taskkill /PID <pid> /T` now and `/F` after `graceMs` only while the program has not exited (`exited`):
 * Windows hands a freed process id to the next program soon, and a late /F would stop that one. Nothing at all on
 * Windows once it has exited. (No signals there: Node's kill() ends the one process at once, its children go on.)
 * `exec` and `kill` are injected for the tests.
 */
export function killTree(pid: number | undefined, o: {
  graceMs?: number; platform?: Platform; exited?: () => boolean; env?: NodeJS.ProcessEnv
  exec?: (cmd: string, args: string[]) => void; kill?: (pid: number, signal: NodeJS.Signals) => void
} = {}): void {
  if (!pid) return
  const graceMs = o.graceMs ?? 3000, exited = o.exited ?? (() => false)
  const exec = o.exec ?? ((cmd, args) => { spawn(cmd, args, { stdio: 'ignore', windowsHide: true }).on('error', () => undefined) })
  const kill = o.kill ?? ((p, s) => process.kill(p, s))
  if ((o.platform ?? process.platform) === 'win32') {
    if (exited()) return
    const taskkill = taskkillPath(o.env)
    exec(taskkill, ['/PID', String(pid), '/T'])
    setTimeout(() => { if (!exited()) exec(taskkill, ['/PID', String(pid), '/T', '/F']) }, graceMs).unref()
    return
  }
  const send = (sig: NodeJS.Signals) => {
    try {
      kill(-pid, sig)
    } catch {
      // gone already
    }
  }
  send('SIGTERM')
  setTimeout(() => send('SIGKILL'), graceMs).unref()
}

/**
 * A folder made to appear at `link` (the asset cache inside a render bundle, a font folder). A symbolic link on POSIX;
 * a junction on Windows, which needs no administrator or developer mode (a directory symlink there does) and takes
 * an absolute target.
 */
export async function linkDir(target: string, link: string, platform: Platform = process.platform,
  make: (target: string, link: string, type: 'dir' | 'junction') => Promise<void> = symlink): Promise<void> {
  await make(platform === 'win32' ? resolve(target) : target, link, platform === 'win32' ? 'junction' : 'dir')
}

/**
 * Take a linked folder away (linkDir's), never what it points to: the link itself is unlinked (libuv removes a
 * Windows junction as the directory reparse point it is); anything else at that path is removed as usual.
 */
export async function unlinkDir(link: string): Promise<void> {
  const s = await lstat(link).catch(() => null)
  if (!s) return
  if (s.isSymbolicLink()) await unlink(link)
  else await rm(link, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

/**
 * Remove a file or folder that another process may still hold for a moment (Windows refuses to delete an open file:
 * EBUSY / EPERM; a virus scanner holds new files too): retried a few times before giving up, never thrown.
 */
export async function removeQuietly(path: string): Promise<boolean> {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    return true
  } catch {
    return false
  }
}

/**
 * A path as a line of FFmpeg's concat list: forward slashes (Windows takes them; a backslash is an escape there), in
 * single quotes, a quote inside written as '\''. Pure.
 */
export function concatLine(path: string): string {
  return `file '${path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`
}

/**
 * The longest path Windows tools take without long-path support (MAX_PATH, 260 with the drive and the end): FFmpeg
 * and Chrome open files through the usual Windows calls, so a work folder deep enough to pass it breaks them there
 * whatever Node can do. Null when `path` fits (or on POSIX), else why. Pure.
 */
export function pathProblem(path: string, platform: Platform = process.platform): string | null {
  if (platform !== 'win32') return null
  return path.length >= 248 ? `the path is ${path.length} characters long; Windows tools take fewer than 248 for a folder (${path.slice(0, 60)}…)` : null
}

/** The environment keys Windows programs need to start at all (besides PATH): the system folder, temp, the user's folders. */
export const WINDOWS_BASE_KEYS = ['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PATHEXT', 'COMSPEC', 'PROGRAMDATA'] as const

/** The names a program `name` may have on disk: `name.exe` (and the rest of PATHEXT) first on Windows. Pure. */
export function binaryNames(name: string, platform: Platform = process.platform, pathext = '.EXE;.CMD;.BAT'): string[] {
  if (platform !== 'win32' || /\.[a-z0-9]+$/i.test(name)) return [name]
  return [...pathext.split(';').filter(Boolean).map((ext) => name + ext.toLowerCase()), name]
}
