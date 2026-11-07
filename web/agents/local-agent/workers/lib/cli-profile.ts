/**
 * The Seatbelt profile the worker CLI itself (`claude`, `codex`) runs under.
 *
 * Two fences, one job:
 *   - **The folder's fence** (../../lib/seatbelt.ts via host-folder-sandbox.ts)
 *     holds everything the agent DOES: every command, read and write, through
 *     the MCP tools (fence-tools.ts). No network at all.
 *   - **This profile** holds the CLI process. The CLI must reach its vendor
 *     (HTTPS) and read its own login, so it cannot sit in the folder's fence.
 *     With its built-in tools off it runs nothing on the model's behalf; this
 *     profile is what stops a CLI that grew a new built-in capability, or a
 *     bug in one, from reaching the rest of the Mac:
 *       - network: outbound TCP to port 443 (its vendor's API), the one
 *         loopback port of the fence's MCP server, DNS, and unix sockets in
 *         its own temp folder. Nothing else, so no other local server and no
 *         plain HTTP;
 *       - reads: file contents under /Users (HOME too), /Volumes,
 *         /private/var/folders and /private/tmp are denied, except the CLI's
 *         own working folder (an empty folder per job, so it finds no
 *         CLAUDE.md, AGENTS.md or project config of anyone's making), its temp
 *         folder and state (its login, sessions and config: `~/.claude`,
 *         `~/.codex`), its install and the tool PATH's dirs under HOME (node
 *         for the npm wrapper). System paths stay readable. **The granted
 *         folder is not readable to the CLI at all** (denied last, whatever
 *         else allows it): an instruction file there, a symlink or an
 *         `@import`, can't make the CLI pull its own login into the model;
 *         the folder is reached only through the fence's tools;
 *       - writes: only its temp folder and its state, and never the parts of
 *         its state that hold code or text it would run or load later
 *         (settings and every file they name, hooks, plugins, agents,
 *         commands, skills, memory, Codex's config, rules and `.env`, and any
 *         script by its extension), and no rename that would swap one in:
 *         the folders above them are pinned, and among other sessions'
 *         entries (`~/.claude/projects`) only the job's own is writable. Never
 *         the folder: edits go through the fence's tools;
 *       - process details (pid info, paths, open files, arguments and
 *         environment) of its own processes only, as in seatbelt.ts: the
 *         kernel shows a Node process's environment to any process of the
 *         same user, and with HTTPS open the CLI could send on what the eve
 *         server or launcher of another job, or the person's own programs
 *         (keys exported in their shell), hold there;
 *       - no launchd jobs (`job-creation`; Darwin 27 refuses them from any
 *         sandboxed process already, measured), no Apple events, no
 *         LaunchServices (`open`), no pasteboard, window server, microphone or
 *         camera lookups (the app holds the mic and screen permissions, and
 *         TCC attributes a child to the app). The keychain stays reachable:
 *         Claude Code keeps its login there;
 *       - no exec of `open` / `osascript`, nor of a file in the writable temp
 *         and state folders or a state file's siblings (an interpreter can still read a script there:
 *         this profile is the second fence, not the first).
 *
 * The rule order follows seatbelt.ts: `(allow default)`, then each deny
 * followed by the allowances that re-open what the CLI needs (the last
 * matching rule wins).
 */
import { READ_DENIED_ROOTS, sbplString } from '../../lib/seatbelt.js'

export interface CliProfileInput {
  /** realpath of HOME. */
  readonly home: string
  /** realpath of the granted folder (edit mode: the worktree). Unreadable and unwritable to the CLI. */
  readonly folder: string
  /** Edit mode: the repository's `.git`. Unreadable to the CLI too. */
  readonly extraRead?: string
  /** The CLI's working folder: empty, one per job (stable, so a resume finds its session). Read-only. */
  readonly cliCwd: string
  /** The CLI's own temp folder (its TMPDIR): read and write. */
  readonly cliTmp: string
  /** The CLI's state folders (login, sessions, config, caches): read and write. */
  readonly stateDirs: readonly string[]
  /** Files the CLI rewrites atomically next to themselves (`~/.claude.json`): the file and its `<file>.*` siblings, read and write. */
  readonly stateFiles: readonly string[]
  /** Read-only folders: the CLI's install and the tool PATH's dirs under HOME. */
  readonly readRoots: readonly string[]
  /** Parts of its state holding code or text it would run or load later: never writable (folders, then files; `*` matches within a name). */
  readonly protectedDirs: readonly string[]
  readonly protectedFiles: readonly string[]
  /** State folders where no script (by its extension) is ever writable, at any depth. */
  readonly protectedScriptsUnder: readonly string[]
  /**
   * State folders whose entries belong to other sessions of the person's own: only `own` is writable under `parent`
   * (Claude Code's `~/.claude/projects`, where this job's own project folder is the one it writes). Both are pinned
   * too, so they must exist before the CLI starts (foldersToMake).
   */
  readonly ownOnlyUnder?: readonly { readonly parent: string; readonly own: string }[]
  /** The fence's MCP server port on 127.0.0.1. */
  readonly mcpPort: number
}

/** Mach services the CLI may not look up (by exact name, then by prefix). The keychain is NOT among them. */
const DENIED_MACH_NAMES = ['com.apple.coreservices.launchservicesd', 'com.apple.audio.audiohald'] as const
const DENIED_MACH_PREFIXES = ['com.apple.pasteboard', 'com.apple.windowserver', 'com.apple.cmio'] as const

/** `path` as an SBPL regex fragment matching it literally. */
function regexLiteral(path: string): string {
  return path.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&')
}

/** A file, and the `<file>.*` siblings an atomic rewrite makes, as an SBPL regex; `*` matches within a name. */
function fileRule(path: string): string {
  sbplString(path) // rejects a quote, a control character or a relative path
  return `(regex #"^${regexLiteral(path.replace(/\/+$/, '')).replace(/\\\*/g, '[^/]*')}(\\.[^/]*)?$")`
}

/** What a script is called: written there, it would run the next time a setting or a hook names it. */
const SCRIPT_EXTENSIONS = ['sh', 'bash', 'zsh', 'fish', 'command', 'py', 'js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'rb', 'pl', 'php', 'lua'] as const

/** A folder and everything in it; `*` matches within a name (every project's `memory` under `~/.claude/projects`). */
function dirRule(path: string): string {
  if (!path.includes('*')) return `(subpath ${sbplString(path)})`
  sbplString(path)
  return `(regex #"^${regexLiteral(path.replace(/\/+$/, '')).replace(/\\\*/g, '[^/]*')}(/|$)")`
}

function scriptRule(dir: string): string {
  sbplString(dir)
  return `(regex #"^${regexLiteral(dir.replace(/\/+$/, ''))}/(.*/)?[^/]*\\.(${SCRIPT_EXTENSIONS.join('|')})(\\.[^/]*)?$")`
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`)
}

/**
 * The folders above `path` inside a state folder, that folder included: the
 * ones a rename could swap a protected path through. Seatbelt judges a rename
 * by its two paths, never by what the moved folder holds, so `mv s2 scripts`
 * would plant `scripts/statusline` and `mv ~/.claude <tmp>` would take every
 * rule with it. A path with a `*` stops above its first such name.
 */
function foldersAbove(path: string, roots: readonly string[]): string[] {
  const parts = path.replace(/\/+$/, '').split('/')
  const glob = parts.findIndex((p) => p.includes('*'))
  const chain = parts.slice(0, glob === -1 ? -1 : glob)
  const out: string[] = []
  for (let i = chain.length; i > 1; i--) {
    const dir = chain.slice(0, i).join('/')
    if (roots.some((r) => within(dir, r))) out.push(dir)
  }
  return out
}

/**
 * The folders pinned against a rename (creating, renaming, removing, `chmod`;
 * writing inside still works): each folder above a protected path inside its
 * state folder, the state folders holding scripts, the folders holding other
 * sessions' entries, and the job's own entry among them (so its protected
 * parts can't be swapped in either).
 */
function pinnedFolders(input: CliProfileInput): string[] {
  const ownOnly = input.ownOnlyUnder ?? []
  const installInState = input.readRoots.filter((r) => input.stateDirs.some((d) => within(r, d)))
  const above = [...input.protectedDirs, ...input.protectedFiles, ...installInState, ...ownOnly.map((o) => `${o.parent}/*`), ...input.protectedScriptsUnder.map((d) => `${d}/*`)].flatMap((p) =>
    foldersAbove(p, input.stateDirs),
  )
  return [...new Set([...above, ...ownOnly.map((o) => o.own)])].sort()
}

/**
 * What must exist before the CLI starts, since the profile won't let it make
 * them: the pinned state folders, the folders of other sessions' entries and
 * its own entry. Made by the adapter (run.ts), 0700. A pinned folder deeper
 * than that (one above a settings-named path) is left as it is: if it isn't
 * there, nothing it would hold is either.
 */
export function foldersToMake(input: CliProfileInput): string[] {
  const ownOnly = input.ownOnlyUnder ?? []
  const pinned = new Set(pinnedFolders(input))
  return [...new Set([...input.stateDirs.filter((d) => pinned.has(d)), ...ownOnly.flatMap((o) => [o.parent, o.own])])]
}

export function buildCliProfile(input: CliProfileInput): string {
  if (!Number.isInteger(input.mcpPort) || input.mcpPort < 1 || input.mcpPort > 65535) throw new Error(`bad MCP port: ${input.mcpPort}`)
  const sub = (p: string) => `(subpath ${sbplString(p)})`
  const rw = [sub(input.cliTmp), ...input.stateDirs.map(sub), ...input.stateFiles.map(fileRule)].join(' ')
  // Its own install, when it sits in a state folder, is re-allowed to run below: so it is never writable.
  const installInState = input.readRoots.filter((r) => input.stateDirs.some((d) => within(r, d)))
  const ownOnly = input.ownOnlyUnder ?? []
  // Never renamed, removed or swapped: each folder above a protected path (inside its state folder), the state
  // folders holding scripts, and the folders that hold other sessions' entries. Writing inside them still works.
  const pinned = pinnedFolders(input)
  const protectedState = [
    ...input.protectedDirs.map(dirRule),
    ...installInState.map(sub),
    ...input.protectedFiles.map(fileRule),
    ...input.protectedScriptsUnder.map(scriptRule),
    ...pinned.map((d) => `(literal ${sbplString(d)})`),
  ].join(' ')
  const readDenied = [sub(input.home), ...READ_DENIED_ROOTS.map((r) => `(subpath "${r}")`)].join(' ')
  const reads = [sub(input.cliCwd), ...input.readRoots.map(sub)].join(' ')
  const grant = [sub(input.folder), ...(input.extraRead ? [sub(input.extraRead)] : [])].join(' ')
  // Nothing in its writable folders runs, except its own install when it sits in one (an npm
  // `~/.claude/local` install): that is re-allowed after, and it is a protected (unwritable) folder.
  const noExec = [...[input.cliTmp, ...input.stateDirs].map(sub), ...input.stateFiles.map(fileRule)].join(' ')
  const machNames = DENIED_MACH_NAMES.map((n) => `(global-name "${n}")`).join(' ')
  const machPrefixes = DENIED_MACH_PREFIXES.map((n) => `(global-name-prefix "${n}")`).join(' ')

  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(allow network-outbound (remote tcp "*:443"))',
    `(allow network-outbound (remote ip "localhost:${input.mcpPort}"))`,
    '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
    // Its own sockets, in its own temp folder only (Claude Code keeps IPC sockets there).
    `(allow network-bind network-inbound network-outbound (local unix-socket (subpath ${sbplString(input.cliTmp)})) (remote unix-socket (subpath ${sbplString(input.cliTmp)})))`,
    // Process details, arguments and environment only of its own processes (seatbelt.ts: another's `kern.procargs2`
    // is refused only when both `process-info*` and the sysctl are).
    '(deny process-info*)',
    '(allow process-info* (target same-sandbox))',
    '(deny sysctl-read (sysctl-name-prefix "kern.procargs"))',
    '(deny file-write*)',
    `(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/fd/[0-9]+$") ${rw})`,
    // Other sessions' entries: only this job's own (its protected parts are denied again just below).
    ...ownOnly.flatMap((o) => [`(deny file-write* ${dirRule(`${o.parent}/*`)})`, `(allow file-write* ${dirRule(o.own)})`]),
    ...(protectedState ? [`(deny file-write* ${protectedState})`] : []),
    `(deny file-read-data ${readDenied})`,
    `(allow file-read-data ${reads} ${rw})`,
    // The grant, last: the CLI reaches it only through the fence's tools.
    `(deny file-read-data file-write* ${grant})`,
    '(deny job-creation)',
    '(deny appleevent-send)',
    `(deny mach-lookup ${machNames} ${machPrefixes})`,
    '(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript"))',
    `(deny process-exec* ${noExec})`,
    ...(installInState.length ? [`(allow process-exec* ${installInState.map(sub).join(' ')})`] : []),
    '',
  ].join('\n')
}

/**
 * The read-only roots a CLI needs from under HOME: its install and the tool
 * PATH's dirs (where `#!/usr/bin/env node` finds node). An install under a
 * `node_modules` folder (an npm global install) gets that whole
 * `node_modules`, since a package's platform binary can sit in a sibling or
 * nested package; a native binary gets its own folder. Anything outside
 * HOME is readable already and is left out.
 */
export function cliReadRoots(bin: string, toolPath: string, home: string, realpath: (p: string) => string | null): string[] {
  const roots = new Set<string>()
  const add = (p: string | null) => {
    if (p && within(p, home) && p !== home) roots.add(p)
  }
  const nm = bin.indexOf('/node_modules/')
  add(nm === -1 ? bin.slice(0, bin.lastIndexOf('/')) || null : bin.slice(0, nm + '/node_modules'.length))
  for (const dir of toolPath.split(':')) {
    if (dir.startsWith('/')) add(realpath(dir))
  }
  // Drop roots inside another root.
  return [...roots].filter((r) => ![...roots].some((o) => o !== r && within(r, o))).sort()
}
