/**
 * The ONE Seatbelt profile around a worker's whole agent process tree: the
 * ACP adapter, the person's CLI, every command it runs, and the stdio MCP
 * proxy. ACP has no standard way to turn an agent's own tools off, so the
 * agent works in the folder itself and this profile is the fence.
 *
 * Same style as ../../lib/seatbelt.ts: `(allow default)`, then take away, the
 * last matching rule winning:
 *   - network: outbound TCP to port 443 anywhere (its vendor's API; Seatbelt
 *     can't filter by host), any port on this Mac (TCP and UDP: local dev
 *     servers and databases, the MCP server), listening on local ports (which
 *     the language can't keep off the wildcard address: see the rule), DNS,
 *     and unix sockets in its own temp folder. Nothing else remote; the app's
 *     own ports (LOCAL_AGENT_CLOSED_PORTS) neither reachable nor bindable;
 *   - signals, and process details (pid info, arguments, environment), only
 *     for its own processes: the kernel shows a Node process's environment to
 *     any process of the same user, and another job's eve server holds
 *     secrets there;
 *   - writes: only its private home, its temp folder, the keychain folder,
 *     each shared login file (that file and the scratch names its save makes
 *     beside it, nothing else in its real folder), and the granted folder as
 *     the job's mode says. The folder's rules are seatbelt.ts's own:
 *       - read job: nothing in the folder is writable, and its secret files
 *         (`.env`, keys, credentials: isSecretFileName) can't be read or stat'ed;
 *       - edit job: only the worktree is writable; the repository's `.git` is
 *         readable and nothing under it writable, so the agent can't commit
 *         (the desktop commits when it sees `finish`);
 *   - names: a `.git`, an `.app` or a config the person's tools run on their
 *     own (AUTO_RUN_CONFIGS) can't be made at any depth of ANY writable place
 *     (the worktree, its home, its temp folder, the keychain folder): all are
 *     on one volume, so a folder built under an innocent name anywhere could
 *     otherwise be renamed into the worktree whole. Its own state folders
 *     whose names are among them (`.claude`, `.codex`) are made, empty, by the
 *     adapter before it starts (agent-home.ts), and their protected files
 *     (`settings.json`, `hooks/`, `config.toml`) stay unwritable;
 *   - pinned (no rename, replacement, removal or `chmod`; writing inside still
 *     works): the folder, its home and the folders made in it, its temp
 *     folder, the real keychain folder and the real folder of each login file.
 *     Without that a root could be moved aside, filled, and moved back;
 *   - reads: the real HOME, /Users, /Volumes, /private/var/folders and
 *     /private/tmp are denied, then re-opened for its home, its temp folder,
 *     the folder (and the repository's `.git` in an edit job), the read-only
 *     roots (agentReadRoots), the person's toolchains under HOME (the folder
 *     fence's own list, seatbelt.ts HOME_TOOLCHAIN_ALLOWLIST, with its deny on
 *     the credential files near their tops; read-only: toolchains.ts points
 *     the tools at them), the keychain folder and the login files. Where a
 *     HOME credential really lives (`readProtected`, from
 *     host-folder-sandbox.ts) stays unreadable even inside the folder;
 *   - login files: only a REGULAR file may be made at the file or a scratch
 *     name (no folder, link, or folder moved in), and no hard link may be made
 *     into or out of a login file's folder or the keychain folder (a second
 *     name would make every later launch refuse the file). The login folder
 *     itself can be opened (names only: Codex fsyncs it after a save);
 *   - the daemons that write or act on the agent's behalf: no Mach lookup but
 *     the few in ALLOWED_MACH_NAMES (the keychain, trustd, configd, directory
 *     lookups), no preference writes (`user-preference-write`: cfprefsd would
 *     write the person's real plist), no launchd jobs, no Apple events, and no
 *     exec of `open`, `osascript`, `launchctl` (which can restart an existing
 *     job), `shortcuts` or `automator`;
 *   - the fence marker: the desktop made `<fence dir>/<job id>` and
 *     `<fence dir>/<job id>.open`; this profile denies reading the first and
 *     allows reading the second, so the desktop can ask the kernel which of the
 *     person's processes this job's fence holds: denied the first and allowed
 *     the second is this job; denied both is another job's fence or an app's
 *     sandbox; allowed both is unfenced. Neither file nor the folder is
 *     writable, renamable or removable from inside.
 */
import { NAMES_AT_ANY_DEPTH, READ_DENIED_ROOTS, grantRefusal, homeToolchainRules, namesBelow, sbplString, secretFileRules, SeatbeltPathError, type LocalAgentMode } from '../../lib/seatbelt.js'

export interface AgentProfileInput {
  /** realpath of the person's HOME. */
  readonly home: string
  /** The agent's private home (its HOME): read and write. */
  readonly agentHome: string
  /** Folders made in its home (agent-home.ts `folders`): pinned. */
  readonly homeFolders?: readonly string[]
  /** The agent's temp folder (its TMPDIR): read and write, its unix sockets. */
  readonly agentTmp: string
  readonly mode: LocalAgentMode
  /** realpath of the granted folder (edit mode: the worktree). */
  readonly folder: string
  /** Edit mode: the repository's `.git`, read-only. */
  readonly extraRead?: string
  /** Read-only roots (agentReadRoots). */
  readonly readRoots: readonly string[]
  /** realpath of the Mac's keychain folder, when the agent's login is there: read and write. */
  readonly keychain?: string
  /** Shared login files: the realpath, its real folder, and the scratch names (`*` within a name) its save makes there. */
  readonly loginFiles: readonly { readonly file: string; readonly dir: string; readonly scratch: readonly string[] }[]
  /** LOCAL_AGENT_JOB_ID: names the fence marker. */
  readonly jobId: string
  /** The app's own local ports (LOCAL_AGENT_CLOSED_PORTS, less this job's MCP port): denied on loopback. */
  readonly closedPorts?: readonly number[]
  /** LOCAL_AGENT_FENCE_DIR: the desktop's folder holding `<job id>` and `<job id>.open`. */
  readonly fenceDir: string
  /** realpaths of HOME's toolchain folders that are symlinks elsewhere (host-folder-sandbox.ts toolchainRealpaths). */
  readonly toolchainRealpaths?: readonly string[]
  /** Where HOME's credentials really live (host-folder-sandbox.ts protectedPaths): never readable. */
  readonly readProtected?: readonly string[]
}

/**
 * The only Mach services the agent may look up: every other lookup is
 * refused, so no daemon that writes or acts for a client (LaunchServices,
 * Shortcuts, Siri, sharing, accounts, password dialogs, cloud sync, the
 * pasteboard, notifications, login items, TCC, the Dock) is reachable. Found
 * by running both agents and the basic tools from deny-all (curl, git and npm
 * over HTTPS, Python's urllib and Node's https need none: they carry their
 * own CA bundles and resolve names through mDNSResponder's socket).
 */
export const ALLOWED_MACH_NAMES = [
  'com.apple.SecurityServer', // the keychain (Claude Code's login)
  'com.apple.securityd.xpc',
  'com.apple.trustd', // TLS trust evaluation through the system
  'com.apple.trustd.agent',
  'com.apple.system.opendirectoryd.libinfo', // user and group names (whoami, git)
  'com.apple.system.opendirectoryd.membership',
  'com.apple.SystemConfiguration.configd', // network settings and proxies
  'com.apple.SystemConfiguration.DNSConfiguration',
] as const

function within(child: string, parent: string): boolean {
  return parent === '/' ? child.startsWith('/') : child === parent || child.startsWith(`${parent}/`)
}

const norm = (p: string) => p.replace(/\/+$/, '') || '/'
const regexLiteral = (p: string) => p.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&')

const JOB_ID = /^[A-Za-z0-9_-]{1,96}$/

/** The two marker files for this job: reading the first is denied in its profile, reading the second allowed. */
export function fenceMarkers(fenceDir: string, jobId: string): { denied: string; open: string } {
  if (!JOB_ID.test(jobId)) throw new SeatbeltPathError(`not a job id: ${JSON.stringify(jobId)}`)
  sbplString(fenceDir)
  return { denied: `${norm(fenceDir)}/${jobId}`, open: `${norm(fenceDir)}/${jobId}.open` }
}

/** A login file and its scratch names, as SBPL filters: the literal file, one anchored regex per scratch name. */
function loginFileRules(f: AgentProfileInput['loginFiles'][number], regularOnly = false): string {
  sbplString(f.dir)
  if (norm(f.file).slice(0, f.dir.length + 1) !== `${norm(f.dir)}/`) throw new SeatbeltPathError(`${f.file} is not in ${f.dir}`)
  const scratch = f.scratch.map((g) => {
    if (!/^[A-Za-z0-9._*-]+$/.test(g) || /^\.\.?$/.test(g)) throw new SeatbeltPathError(`bad scratch name: ${JSON.stringify(g)}`)
    return `(regex #"^${regexLiteral(norm(f.dir))}/${regexLiteral(g).replace(/\\\*/g, '[^/]*')}$")`
  })
  const names = [`(literal ${sbplString(f.file)})`, ...scratch]
  // A regular file and nothing else: no folder, link or moved-in tree at those names.
  return (regularOnly ? names.map((n) => `(require-all (vnode-type REGULAR-FILE) ${n})`) : names).join(' ')
}

export function buildAgentProfile(input: AgentProfileInput): string {
  if (input.mode !== 'read' && input.mode !== 'edit') throw new SeatbeltPathError(`unsupported mode: ${String(input.mode)}`)
  const refusal = grantRefusal(input.folder, input.home)
  if (refusal) throw new SeatbeltPathError(refusal)
  if (input.extraRead !== undefined && input.mode !== 'edit') throw new SeatbeltPathError('an extra read root is only allowed in edit mode')
  const home = norm(input.home)
  const folder = norm(input.folder)
  const keychain = input.keychain ? [norm(input.keychain)] : []
  // The agent's own places and every root it gets: none may be HOME or above it, nor overlap the folder.
  const own = [input.agentHome, input.agentTmp, ...keychain, ...input.loginFiles.map((f) => f.file)].map(norm)
  for (const p of [...own, ...input.loginFiles.map((f) => norm(f.dir)), ...input.readRoots.map(norm)]) {
    if (within(home, p)) throw new SeatbeltPathError(`${p} is HOME or holds it`)
  }
  for (const p of own) {
    if (within(p, folder) || within(folder, p)) throw new SeatbeltPathError(`${p} overlaps the granted folder`)
  }
  const sub = (p: string) => `(subpath ${sbplString(p)})`
  const edit = input.mode === 'edit'
  const tmp = sbplString(input.agentTmp)
  const closed = [...new Set(input.closedPorts ?? [])]
  if (closed.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) throw new SeatbeltPathError(`bad port in ${JSON.stringify(closed)}`)
  const marker = fenceMarkers(input.fenceDir, input.jobId)
  // The fence folder is the desktop's: never inside a place the agent writes.
  for (const p of [input.agentHome, input.agentTmp, ...keychain, ...(edit ? [folder] : [])]) {
    if (within(norm(input.fenceDir), norm(p))) throw new SeatbeltPathError(`the fence folder ${input.fenceDir} is inside ${p}`)
  }
  const login = input.loginFiles.map((f) => loginFileRules(f))
  const writable = [...[input.agentHome, input.agentTmp, ...keychain].map(sub), ...input.loginFiles.map((f) => loginFileRules(f, true))].join(' ')
  // No second name for a login file or a keychain file, from either end.
  const noLinks = [...input.loginFiles.map((f) => norm(f.dir)), ...keychain].map(sub).join(' ')
  // The names no writable place may hold, at any depth (a `.git` never in the worktree, nor built elsewhere).
  const writableRoots = [...(edit ? [folder] : []), input.agentHome, input.agentTmp, ...keychain]
  const neverWritten = [NAMES_AT_ANY_DEPTH.git, NAMES_AT_ANY_DEPTH.app, NAMES_AT_ANY_DEPTH.autoRun].flatMap((names) => writableRoots.map((root) => namesBelow(root, names))).join(' ')
  const pinned = [
    ...new Set([folder, input.agentHome, ...(input.homeFolders ?? []), input.agentTmp, ...keychain, ...input.loginFiles.map((f) => f.dir), input.fenceDir, marker.denied, marker.open].map(norm)),
  ]
  const readDenied = [sub(home), ...READ_DENIED_ROOTS.map((r) => `(subpath "${r}")`)].join(' ')
  const toolchains = homeToolchainRules(home, input.toolchainRealpaths ?? [])
  const reads = `${[input.agentHome, input.agentTmp, folder, ...(input.extraRead ? [input.extraRead] : []), ...input.readRoots].map(sub).join(' ')} ${toolchains.reads}`
  const keepOut = [home, ...own, ...input.readRoots.map(norm)].map((x) => x.toLowerCase())
  const readDenies = [
    ...new Set(
      (input.readProtected ?? [])
        .filter((rp) => typeof rp === 'string' && rp.startsWith('/'))
        .map(norm)
        .filter((rp) => !keepOut.some((x) => within(x, rp.toLowerCase()))),
    ),
  ]
  // The login folders themselves too (names only), for the fsync after a save.
  const shared = [...keychain.map(sub), ...login, ...[...new Set(input.loginFiles.map((f) => norm(f.dir)))].map((d) => `(literal ${sbplString(d)})`)].join(' ')
  const machAllowed = ALLOWED_MACH_NAMES.map((n) => `(global-name "${n}")`).join(' ')

  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(allow network-outbound (remote tcp "*:443"))',
    // Listening on a local port, TCP and UDP (the owner's decision: dev servers, test suites that start a server, local
    // databases). The narrowest form the language has; in a bind rule it also matches the wildcard address (0.0.0.0, ::),
    // and accepts are never checked against the peer, so a server bound to all addresses is reachable from the network
    // while the job runs (accepted by the owner).
    '(allow network-bind network-inbound (local ip "localhost:*"))',
    // Any port on this Mac, TCP and UDP (the owner's decision; the MCP server keeps its bearer). Seatbelt's `localhost`
    // is this machine's own addresses (127.0.0.1, ::1, its LAN address too), never another machine's.
    '(allow network-outbound (remote ip "localhost:*"))',
    // The app's own local servers at launch, closed again (no connecting, no binding: no squatting on the port): a
    // second line behind each one's own per-launch secret.
    ...(closed.length > 0
      ? [`(deny network-outbound network-bind network-inbound ${closed.map((p) => `(remote ip "localhost:${p}") (local ip "localhost:${p}")`).join(' ')})`]
      : []),
    '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
    // Its own sockets, in its own temp folder only (Claude Code keeps IPC sockets there).
    `(allow network-bind network-inbound network-outbound (local unix-socket (subpath ${tmp})) (remote unix-socket (subpath ${tmp})))`,
    '(deny signal)',
    '(allow signal (target same-sandbox))',
    // Another process's `kern.procargs2` is refused only when both `process-info*` and the sysctl are (seatbelt.ts).
    '(deny process-info*)',
    '(allow process-info* (target same-sandbox))',
    '(deny sysctl-read (sysctl-name-prefix "kern.procargs"))',
    '(deny job-creation)',
    '(deny file-write*)',
    `(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/fd/[0-9]+$") ${writable})`,
    // macOS bash 3.2 writes here-documents to /var/tmp/sh-thd-<n> whatever TMPDIR says (seatbelt.ts).
    '(allow file-write* (literal "/private/var/tmp") (require-all (vnode-type REGULAR-FILE) (regex #"^/private/var/tmp/sh-thd-[0-9]+$")))',
    ...(edit ? [`(allow file-write* ${sub(folder)})`] : []),
    `(deny file-write* ${neverWritten})`,
    ...(noLinks ? [`(deny file-link ${noLinks})`] : []),
    // Pinned last: the roots themselves, never their contents.
    `(deny file-write* ${pinned.map((p) => `(literal ${sbplString(p)})`).join(' ')})`,
    `(deny file-read-data ${readDenied})`,
    `(allow file-read-data ${reads})`,
    // A read job's secret files, contents and stat (an edit job's worktree is a fresh checkout of tracked files).
    ...secretFileRules(edit ? [] : [folder]),
    toolchains.credentialDeny,
    ...(readDenies.length > 0 ? [`(deny file-read-data ${readDenies.map(sub).join(' ')})`] : []),
    // Its login, last: shared on purpose, whatever a rule above says.
    ...(shared ? [`(allow file-read-data ${shared})`] : []),
    // The fence marker, after every read rule: denied the first, allowed the second, is how the desktop finds this job.
    `(deny file-read-data (literal ${sbplString(marker.denied)}))`,
    `(allow file-read-data (literal ${sbplString(marker.open)}))`,
    // xcrun's lookup cache (tool and SDK paths only): every Xcode shim (git, make, clang) is slow without it.
    '(allow file-read-data (regex #"^/private/var/folders/[^/]+/[^/]+/T/xcrun_db$"))',
    '(deny appleevent-send)',
    '(deny user-preference-write)',
    '(deny mach-lookup)',
    `(allow mach-lookup ${machAllowed})`,
    '(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/bin/launchctl") (literal "/usr/bin/shortcuts") (literal "/usr/bin/automator"))',
    '',
  ].join('\n')
}

/**
 * The read-only roots the agent needs: `extra` (the Node runtime and the
 * adapter install folders) wherever they are, and the CLI's install and the
 * tool PATH's dirs where the profile denies reads (under HOME, /Users,
 * /Volumes, /private/var/folders, /private/tmp). An install under a `node_modules` folder
 * (an npm global install) gets that whole `node_modules`, since a package's
 * platform binary can sit in a sibling package; a native binary gets its own
 * folder. A tool PATH dir that is a Node distribution's `bin` gets the whole
 * distribution (npm and npx point into its `lib`). Anything else is readable
 * already and is left out, and so is HOME itself. Roots inside another root
 * are dropped.
 */
export function agentReadRoots(o: { bin: string; toolPath: string; home: string; extra: readonly string[] }, realpath: (p: string) => string | null, exists: (p: string) => boolean): string[] {
  const roots = new Set<string>(o.extra.map(norm))
  const add = (p: string | null) => {
    if (p && !within(o.home, p) && [o.home, ...READ_DENIED_ROOTS].some((r) => within(p, r))) roots.add(p)
  }
  const nm = o.bin.indexOf('/node_modules/')
  add(nm === -1 ? o.bin.slice(0, o.bin.lastIndexOf('/')) || null : o.bin.slice(0, nm + '/node_modules'.length))
  for (const dir of o.toolPath.split(':')) {
    if (!dir.startsWith('/')) continue
    const real = realpath(dir)
    if (!real) continue
    const dist = real.endsWith('/bin') ? real.slice(0, -'/bin'.length) : null
    add(dist && exists(`${dist}/include/node`) ? dist : real)
  }
  return [...roots].filter((r) => ![...roots].some((o2) => o2 !== r && within(r, o2))).sort()
}
