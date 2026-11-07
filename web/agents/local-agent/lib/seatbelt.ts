/**
 * The macOS Seatbelt (SBPL) profile every local-agent command runs under
 * (docs/plans/local-agents.md §3; L0 contract §2 "lib/seatbelt.ts").
 *
 * Pure: it builds the profile text and nothing else, so the rules are unit
 * tested here and enforced by the kernel through `sandbox-exec -p` in
 * host-folder-sandbox.ts.
 *
 * Rule order matters. The profile starts from `(allow default)` and narrows,
 * and in SBPL the LAST matching rule wins (verified on macOS 27.0.1). So each
 * deny is followed by the exact allowances that re-open what a command needs:
 *   - no network at all (`network*` also covers unix sockets to local daemons);
 *   - no writes except /dev/null, /dev/tty, the std streams, bash's
 *     here-document files and the job's own
 *     scratch directory (eve's bash tool keeps background-job output there,
 *     under `<scratch>/.eve/jobs`; host-folder-sandbox.ts points eve's
 *     `/tmp/.eve` there, so the shared /private/tmp/.eve stays unwritable);
 *   - edit mode (L3) also allows writes inside the folder, which is then a
 *     linked git worktree the app made, EXCEPT a `.git` at any depth (its own
 *     `.git` file that points git at the repository, and any nested
 *     repository's: the app's git, outside the sandbox, would stage one as a
 *     submodule and later run git inside it, under that repository's own
 *     config), matched in any letter case because APFS is case-insensitive.
 *     The repository's own `.git` directory may be added as ONE extra
 *     read-only root (`extraRead`), so git can read objects and refs; nothing
 *     under it is writable, so `git commit` / `git add` fail and the app
 *     commits outside the sandbox when the job finishes. Reads of `.git` stay
 *     open: git in the job reads the worktree's link and the repository. The
 *     scratch dir keeps `.git` writable (test suites `git init` in TMPDIR), so
 *     a repository built there can still be moved into the worktree whole (a
 *     rule on a name sees only the moved folder's own name): the desktop
 *     closes that route, refusing to commit a worktree that holds a nested
 *     `.git` at any depth and never staging a gitlink (local_agent/git.rs);
 *   - no reads of file CONTENTS anywhere, then re-allowed: the system paths
 *     toolchains need (SYSTEM_READ_ROOTS: /usr, /bin, /sbin, /System/Library,
 *     the cryptexes, /opt, /nix, /dev, Xcode, the system language runtimes
 *     under /Library, the timezone and xcode-select links, /etc/localtime and
 *     /etc/ssl; not the rest of /etc, /Library, /Applications or /private/var),
 *     the tool PATH's own bin dirs outside HOME (an app's whole bundle for one
 *     under /Applications), the Node runtime the server runs on, the granted
 *     folder, the session's own directory (scratch TMPDIR and the workspace
 *     alias), the paths the person allowed for this job in a fence prompt, and
 *     a toolchain allowlist under HOME (nvm, cargo bin + registry, rustup
 *     toolchains + settings.toml, bun bin, ~/.local/bin, volta, ~/go/bin +
 *     ~/go/pkg/mod, pyenv). Nothing that holds credentials: no git config
 *     (commands run with GIT_CONFIG_GLOBAL=/dev/null), no ~/.local/share, no
 *     cargo config, and a final deny on `credentials*` and `npmrc` files under
 *     the toolchain dirs. Metadata (stat) stays readable, except a secret
 *     file's (below). One file in the
 *     per-user temp dir is readable too: xcrun's lookup cache (`.../T/xcrun_db`,
 *     tool and SDK paths only). Every Xcode shim in /usr/bin (git, make, clang,
 *     python3) runs through xcrun, which ignores TMPDIR; without its cache each
 *     call re-resolves the developer dir (measured ~2 s on a busy Mac, 20 ms
 *     with the cache). It stays unwritable: a command must not plant lookups
 *     that the app's own git (outside the sandbox) would follow;
 *   - signals only to the job's own processes (`same-sandbox`): the provider
 *     runs every command of a job inside ONE sandbox (its runner), so a job's
 *     commands can stop each other (eve's background jobs) and nothing else,
 *     not the desktop app nor any of the person's processes. Same instance is
 *     also how a stop kills everything the job started, `setsid` and
 *     double-forks included (host-folder-sandbox.ts);
 *   - process details the same way: pid info, paths, open files, and the
 *     arguments and environment (`kern.procargs2`) of the job's own processes
 *     only; no pid list. The launcher and the eve server above the job are
 *     Node processes whose environment holds the session's secrets (the model
 *     token, the server's own secrets), and the kernel shows a Node process's
 *     environment to any process of the same user. It lets that sysctl
 *     through when EITHER `process-info*` or `sysctl-read` allows it
 *     (measured on 27.0.1), so both are denied and `same-sandbox` re-opens
 *     the job's own. (`ps` is setuid, which a sandboxed process can't exec);
 *   - no launchd job creation (`launchctl submit` / `bootstrap`; launchd
 *     already refuses sandboxed callers, this says so in the profile);
 *   - fence grants (C3 `kind: "fence"`, allowed by the person for this job
 *     only): one more path, readable, never writable (C3: fence grants are
 *     read-only);
 *   - edit mode: no `.app` bundle written anywhere in the worktree (a program
 *     the person could open outside the sandbox), and none of the configs the
 *     person's own tools run commands from with no further prompt
 *     (AUTO_RUN_CONFIGS). Both are unwritable in the job's scratch dir too:
 *     it is on the same volume, so a directory built there could be moved
 *     into the worktree whole, past every rule on a name;
 *   - secret files (SECRET_FILE_NAMES and the rest, isSecretFileName), at any
 *     depth of a read job's folder and of every fence grant, can't be read
 *     nor even stat'ed: dotenv files (regular files only), keys, ssh private
 *     keys, registry, git and cloud credentials, Terraform variables and
 *     state. Without the stat a loader that checks first (Vite's
 *     `loadEnv`, python-dotenv) skips the file instead of crashing on the
 *     read. A committed one stays readable through git's objects (`git show
 *     HEAD:.env`): the fence works on paths, and git needs its objects. An
 *     edit job's worktree is left alone: it is a fresh checkout of tracked
 *     files only, all readable through git anyway;
 *   - no Apple events, no LaunchServices (so no `open`), no pasteboard, and no
 *     exec of /usr/bin/open or /usr/bin/osascript;
 *   - hardening beyond the contract's profile (named in the README): no exec of
 *     anything from the writable scratch directory, and no window server,
 *     audio HAL, camera or keychain (securityd) lookups. The desktop app holds
 *     microphone and screen permissions for meeting capture, and TCC
 *     attributes a child process to the app, so a command must not reach them.
 *
 * Every path is SBPL string-escaped. A path holding a `"` or a control
 * character is rejected outright rather than escaped.
 */

/** `read`: nothing in the folder is writable. `edit`: the folder (a git worktree) is, except any `.git` in it. */
export type LocalAgentMode = 'read' | 'edit'

/** The only name an extra read root may have: a repository's git directory. */
export const EXTRA_READ_NAME = '.git'

/**
 * Toolchain dirs under HOME whose contents commands may read (relative to
 * HOME): binaries and toolchains only, never config or credential stores.
 * Volta (its shims, the node/npm/yarn images and the platform file the shims
 * read) and pyenv (shims, `pyenv` itself, the Pythons, the global `version`
 * file) are whole toolchain homes; Go is its installed binaries and module
 * cache, never `~/go/src` (the person's own sources).
 */
export const HOME_TOOLCHAIN_ALLOWLIST = ['.nvm', '.cargo/bin', '.cargo/registry', '.rustup/toolchains', '.bun/bin', '.local/bin', '.volta', 'go/bin', 'go/pkg/mod', '.pyenv'] as const
/** Single files under HOME a toolchain needs: rustup's proxies read the default toolchain here. */
export const HOME_TOOLCHAIN_FILES = ['.rustup/settings.toml'] as const
/** Top-level HOME dirs the allowlist reaches into; the credential denies apply under them. */
export const TOOLCHAIN_ROOTS = ['.nvm', '.cargo', '.rustup', '.bun', '.local', '.volta', 'go', '.pyenv'] as const

/**
 * System paths whose contents commands may read; every other path outside the
 * grant is unreadable. What git, the Xcode shims (clang, make, python3, swift),
 * node, npm, cargo, perl, ruby and the shell tools need, measured on macOS
 * 27.0.1: dyld needs `/` itself, xcrun the select links, OpenSSL (cargo,
 * python) its config under /etc/ssl, local time /etc/localtime and the
 * timezone database. /opt and /nix are package managers' trees.
 */
export const SYSTEM_READ_ROOTS = [
  '/usr',
  '/bin',
  '/sbin',
  '/System/Library',
  '/System/Cryptexes',
  '/System/Volumes/Preboot/Cryptexes',
  '/Library/Developer',
  '/Library/Apple',
  '/Library/Frameworks',
  '/Library/Java',
  '/Library/Ruby',
  '/Library/Python',
  '/Library/Perl',
  '/opt',
  '/nix',
  '/dev',
  '/private/var/db/timezone',
  '/private/var/select',
  '/private/etc/ssl',
] as const
/**
 * Single system files commands may read: `/` (the root directory itself),
 * xcode-select's link, local time, the hosts file (name resolution), and
 * Xcode's preferences, where xcrun checks the license was agreed to whenever
 * its lookup cache misses (every git, make or clang call would fail without).
 */
export const SYSTEM_READ_FILES = [
  '/',
  '/private/var/db/xcode_select_link',
  '/private/etc/localtime',
  '/private/etc/hosts',
  '/Library/Preferences/com.apple.dt.Xcode.plist',
] as const
/** Xcode and Xcode-beta bundles: the developer dir xcrun resolves when Xcode is selected. */
const XCODE_APPS = String.raw`^/Applications/Xcode[^/]*\.app(/|$)`
/** bash 3.2's here-document files (see the write rule for /private/var/tmp). */
const HEREDOC_FILES = String.raw`^/private/var/tmp/sh-thd-[0-9]+$`

/**
 * A fence grant (C3 `kind: "fence"`): one more path this job may READ. Fence
 * grants are read-only (C3, 2026-10-21): an edit job writes only in its own
 * worktree, and a write grant elsewhere could reach code that runs outside the
 * sandbox later (a sibling repo's hook config, files the shell sources, git
 * config programs).
 */
export interface FenceGrant {
  /** realpath of the path (or of its nearest existing parent, with the rest re-attached). */
  readonly path: string
  readonly access: 'read'
}

/** What a fence prompt may ask for: `read` only (C3). `write` is refused before anyone is asked. */
export type FenceAccess = 'read' | 'write'

/** The desktop's limit on a fence path (it checks the same before it asks), applied here too. */
export const MAX_FENCE_PATH_BYTES = 1024

/** Mach services a command may not look up, by exact name. */
const DENIED_MACH_NAMES = [
  'com.apple.coreservices.launchservicesd', // `open`, LaunchServices
  'com.apple.SecurityServer', // keychain
  'com.apple.audio.audiohald', // microphone (CoreAudio)
] as const

/** Mach services a command may not look up, by name prefix. */
const DENIED_MACH_PREFIXES = [
  'com.apple.pasteboard', // pbcopy / pbpaste
  'com.apple.windowserver', // screen capture, UI
  'com.apple.securityd', // keychain (data-protection, system)
  'com.apple.cmio', // camera (CoreMediaIO)
] as const

export interface SeatbeltProfileInput {
  readonly mode: LocalAgentMode
  /** realpath of the granted folder. */
  readonly folder: string
  /** realpath of HOME. */
  readonly home: string
  /** realpath of the job's scratch directory (the sandbox's TMPDIR). */
  readonly scratch: string
  /**
   * realpath of the session's directory holding `scratch` and the workspace
   * alias; readable, not writable. Defaults to `scratch`.
   */
  readonly sessionRoot?: string
  /**
   * Edit mode only: realpath of ONE extra read-only root, which must be a
   * directory named `.git` (the repository the worktree belongs to).
   */
  readonly extraRead?: string
  /** Paths the person allowed for this job in a fence prompt (fenceGrantRefusal checks each). */
  readonly grants?: readonly FenceGrant[]
  /**
   * realpath of the Node runtime the server runs on (a distribution dir with
   * `bin/node`, or the binary itself): readable, so the job's runner and the
   * `node` / `npm` first on the tool PATH work.
   */
  readonly runtime?: string
  /** Read-only dirs from the tool PATH outside HOME (toolPathReadRoots). */
  readonly toolRoots?: readonly string[]
  /**
   * realpaths of HOME's toolchain dirs (`~/.cargo`, `~/.local`...) that are
   * symlinks to somewhere else: the credential denies apply there too, so
   * `credentials.toml` can't be read through the real place.
   */
  readonly toolchainRealpaths?: readonly string[]
  /** What no write grant may be in or above (FenceGrantContext.writeProtected). */
  readonly writeProtected?: readonly string[]
  /**
   * What no grant may be in or above (FenceGrantContext.readProtected), and
   * what the profile denies reading even inside the job's own folder or a
   * grant: where credentials really live (a person who picks `~/Dropbox` as
   * the folder while `~/.ssh -> ~/Dropbox/ssh` still can't read the keys).
   * An entry that is or holds HOME, the scratch dir or the Node runtime is
   * left out (it would deny everything, or the job's own files).
   */
  readonly readProtected?: readonly string[]
}

/**
 * Every user's home, other volumes and every app's temp dirs. The profile
 * denies every read and re-allows no system root under these; grants and
 * tool PATH roots may not sit in or above them.
 */
export const READ_DENIED_ROOTS = ['/Users', '/Volumes', '/private/var/folders', '/private/tmp'] as const

/** Thrown for a path that cannot be put in a profile safely. */
export class SeatbeltPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SeatbeltPathError'
  }
}

// Every C0 control character and DEL. A `"` is rejected separately.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/

/**
 * `path` as an SBPL string literal. The path must be absolute and free of `"`
 * and control characters; a backslash is escaped. Trailing slashes are
 * dropped (Seatbelt matches resolved paths, which never end in one).
 */
export function sbplString(path: string): string {
  if (typeof path !== 'string' || path.length === 0) throw new SeatbeltPathError('empty path')
  if (path.includes('"')) throw new SeatbeltPathError(`path contains a quote: ${JSON.stringify(path)}`)
  if (CONTROL_CHAR.test(path)) throw new SeatbeltPathError(`path contains a control character: ${JSON.stringify(path)}`)
  if (!path.startsWith('/')) throw new SeatbeltPathError(`path is not absolute: ${JSON.stringify(path)}`)
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path
  return `"${trimmed.replace(/\\/g, '\\\\')}"`
}

/** System roots no grant may be, sit inside, or contain (besides HOME's own descendants). */
export const UNGRANTABLE_ROOTS = ['/private', '/etc', '/usr', '/var', '/opt', '/tmp', '/bin', '/sbin', '/dev', '/System', '/Library', '/Applications', '/Volumes', '/Users'] as const

function within(child: string, parent: string): boolean {
  return parent === '/' ? child.startsWith('/') : child === parent || child.startsWith(`${parent}/`)
}

/**
 * Why `folder` cannot be granted, or null when it can. A folder strictly
 * inside HOME is grantable. HOME itself and anything above it never are.
 * Otherwise a folder that is, sits inside, or contains a system root or a
 * read-denied root (another user, another app's temp dir, /Volumes) is
 * refused: a `/private` grant would read every app's TMPDIR.
 */
export function grantRefusal(folder: string, home: string, opts: { foldCase?: boolean } = {}): string | null {
  // foldCase: compare in any letter case (APFS is case-insensitive), for a path whose case nothing canonicalized.
  const fold = (p: string) => (opts.foldCase ? p.toLowerCase() : p)
  const f = fold(folder.replace(/\/+$/, '') || '/')
  const h = fold(home.replace(/\/+$/, '') || '/')
  if (f === '/') return 'the granted folder cannot be /'
  if (within(h, f)) return 'the granted folder cannot be HOME or a folder above it'
  if (within(f, h)) return null
  for (const root of [...UNGRANTABLE_ROOTS, ...READ_DENIED_ROOTS]) {
    if (within(f, fold(root)) || within(fold(root), f)) return `the granted folder cannot be in or above ${root}`
  }
  return null
}

/** `path` as an SBPL regex fragment matching it literally. */
function regexLiteral(path: string): string {
  return path.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&')
}

/**
 * Why `extraRead` cannot be the extra read root for `folder`, or null when it
 * can: it must be a directory named exactly `.git` (checked on disk by the
 * provider; here by name), grantable by the same rules as a folder, and
 * neither inside the folder nor holding it.
 */
export function extraReadRefusal(extraRead: string, folder: string, home: string): string | null {
  const x = extraRead.replace(/\/+$/, '') || '/'
  const f = folder.replace(/\/+$/, '') || '/'
  if (!x.startsWith('/')) return 'the extra read root must be an absolute path'
  if (x.slice(x.lastIndexOf('/') + 1) !== EXTRA_READ_NAME) return `the extra read root must be a directory named ${EXTRA_READ_NAME}`
  const refusal = grantRefusal(x, home)
  if (refusal) return `the extra read root ${refusal.replace(/^the granted folder /, '')}`
  if (within(x, f) || within(f, x)) return 'the extra read root cannot overlap the folder'
  return null
}

/**
 * The tool PATH's dirs a command may read beyond SYSTEM_READ_ROOTS: each
 * absolute entry (a realpath, as the provider resolves them) outside HOME and
 * every read-denied root whose last component ends in `bin` (`bin`, `sbin`,
 * TeX's `texbin`), or, under /Applications, the whole `.app` bundle the entry
 * sits in (its tools reach into the bundle). HOME's toolchains come from the
 * allowlist only, never from the PATH. Deduplicated, in PATH order.
 */
export function toolPathReadRoots(entries: readonly string[], home: string): string[] {
  const h = home.replace(/\/+$/, '') || '/'
  const out: string[] = []
  for (const raw of entries) {
    if (typeof raw !== 'string' || !raw.startsWith('/') || raw.includes('"') || CONTROL_CHAR.test(raw)) continue
    const e = raw.replace(/\/+$/, '')
    if (!e || within(e, h) || within(h, e) || READ_DENIED_ROOTS.some((r) => within(e, r) || within(r, e))) continue
    const app = /^\/Applications\/[^/]+\.app(?=\/|$)/.exec(e)
    const root = app ? app[0] : e.split('/').length >= 3 && /bin$/.test(e.slice(e.lastIndexOf('/') + 1)) ? e : null
    if (root && !out.includes(root)) out.push(root)
  }
  return out
}

/** Why `runtime` cannot be a read root, or null: absolute, and not `/` or above HOME, the folder or the scratch dir. */
export function runtimeRefusal(runtime: string, input: Pick<SeatbeltProfileInput, 'home' | 'folder' | 'scratch'>): string | null {
  const r = runtime.replace(/\/+$/, '') || '/'
  if (!r.startsWith('/') || r === '/') return 'the Node runtime must be an absolute path below /'
  for (const p of [input.home, input.folder, input.scratch]) {
    if (within(p.replace(/\/+$/, '') || '/', r)) return 'the Node runtime cannot hold HOME, the folder or the scratch dir'
  }
  return null
}

/**
 * True when a path component, in any letter case, is a git directory (`.git`,
 * or a bare repository's `<name>.git`) or husky's hooks dir (`.husky`, where
 * husky points `core.hooksPath`): what git runs code from on its own.
 */
export function isGitControlled(component: string): boolean {
  const c = component.toLowerCase()
  return c.endsWith('.git') || c === '.husky'
}

function hasGitComponent(path: string): boolean {
  return path.split('/').some(isGitControlled)
}

/** `word` as an SBPL regex fragment matching it in any letter case. */
function anyCase(word: string): string {
  return [...word].map((ch) => (/[a-z]/i.test(ch) ? `[${ch.toUpperCase()}${ch.toLowerCase()}]` : regexLiteral(ch))).join('')
}

/**
 * Secret files by exact name: package registry and git credentials, ssh
 * private keys under their default names (the `.pub` halves stay readable),
 * direnv's and wrangler's env files, Google's OAuth client file and Azure
 * Functions' local settings. With dotenv files (`.env`, `.env.*`, regular
 * files only: a Python venv named `.env` stays a folder like any other),
 * SECRET_FILE_EXTENSIONS and service account keys (`service-account*.json`),
 * no job reads them in a read job's folder or a fence grant (isSecretFileName).
 */
export const SECRET_FILE_NAMES = [
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_ecdsa_sk',
  'id_ed25519_sk',
  '.envrc',
  '.dev.vars',
  'credentials.json',
  'local.settings.json',
] as const
/** Private keys, certificate stores and Terraform's variables and state, by extension. */
export const SECRET_FILE_EXTENSIONS = ['pem', 'key', 'p12', 'pfx', 'tfvars', 'tfvars.json', 'tfstate', 'tfstate.backup'] as const
/** The last part of a dotenv file that is a placeholder to copy, not secrets: `.env.example`, `.env.local.sample`. */
export const DOTENV_PLACEHOLDERS = ['example', 'sample', 'template'] as const

/**
 * True when a file name, in any letter case, is a secret file
 * (SECRET_FILE_NAMES, SECRET_FILE_EXTENSIONS, `service-account*.json`, a
 * dotenv file that is no placeholder). By name only: the profile denies a
 * dotenv name only on a regular file.
 */
export function isSecretFileName(name: string): boolean {
  const n = name.toLowerCase()
  if (n === '.env' || n.startsWith('.env.')) return !DOTENV_PLACEHOLDERS.some((p) => n.endsWith(`.${p}`))
  if (n.startsWith('service-account') && n.endsWith('.json')) return true
  return (SECRET_FILE_NAMES as readonly string[]).includes(n) || SECRET_FILE_EXTENSIONS.some((e) => n.endsWith(`.${e}`))
}

/**
 * Configs the person's own tools run commands from with no further prompt
 * once they trust the folder, at any depth of an edit job's worktree (relative
 * to it). A job's commit lands in their repository, and their tools would run
 * what it planted:
 *   - agent CLIs' project config: Claude Code's settings (hooks,
 *     `apiKeyHelper`, a status line), the hook scripts they point at by
 *     convention and `.mcp.json` (an approval is kept by server name, so a
 *     changed command runs unasked); Codex's `.codex/config.toml`, Cursor's
 *     `.cursor/mcp.json`, Gemini CLI's `.gemini/settings.json`, VS Code's
 *     `.vscode/mcp.json` (MCP servers and other commands they start);
 *   - VS Code tasks (`"runOn": "folderOpen"`);
 *   - git hook managers: husky's `.husky`, `.pre-commit-config.yaml`,
 *     lefthook's config (the person's next commit or push);
 *   - package managers' project config: `.npmrc` (`script-shell`,
 *     `node-options`, on the next npm command), `.pnpmfile.cjs` (pnpm runs it
 *     on install), `.yarnrc.yml` and Yarn 1's `.yarnrc` (`yarnPath` /
 *     `yarn-path`: any JS file, run as Yarn itself), and what an existing
 *     `yarnPath` or plugin entry runs (`.yarn/releases`, `.yarn/plugins`).
 * The folders that hold them (`.claude`, `.codex`, `.cursor`, `.gemini`,
 * `.vscode`, `.husky`, `.yarn` and its `releases` and `plugins`) can't be
 * created, moved or removed either, or a folder of that name built elsewhere,
 * config inside, could be moved into place; everything else in them stays
 * editable (`.vscode/settings.json`, `.claude/commands`, `.cursor/rules`,
 * `.yarn/cache`). Not `.envrc` here: direnv asks again after every change.
 */
export const AUTO_RUN_CONFIGS = [
  '.claude',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/hooks/**',
  '.mcp.json',
  '.codex',
  '.codex/config.toml',
  '.cursor',
  '.cursor/mcp.json',
  '.gemini',
  '.gemini/settings.json',
  '.vscode',
  '.vscode/tasks.json',
  '.vscode/mcp.json',
  '.husky/**',
  '.pre-commit-config.yaml',
  'lefthook.yml',
  'lefthook.yaml',
  '.lefthook.yml',
  '.npmrc',
  '.pnpmfile.cjs',
  '.yarnrc.yml',
  '.yarnrc',
  '.yarn',
  '.yarn/releases/**',
  '.yarn/plugins/**',
] as const

/** AUTO_RUN_CONFIGS that are single files by name, at any depth. */
const AUTO_RUN_FILES = ['.mcp.json', '.pre-commit-config.yaml', 'lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.npmrc', '.pnpmfile.cjs', '.yarnrc.yml', '.yarnrc'] as const
/** AUTO_RUN_CONFIGS that are one file in a folder, which is pinned too. */
const AUTO_RUN_IN_FOLDER: ReadonlyMap<string, string> = new Map([
  ['.codex', 'config.toml'],
  ['.cursor', 'mcp.json'],
  ['.gemini', 'settings.json'],
])

/** True when `rel` (a path relative to the worktree or the scratch dir), in any letter case, is one of AUTO_RUN_CONFIGS at any depth. */
export function isAutoRunConfig(rel: string): boolean {
  const c = rel.toLowerCase().split('/').filter(Boolean)
  return c.some((name, i) => {
    const rest = c.slice(i + 1)
    if (name === '.claude') return rest.length === 0 || rest[0] === 'hooks' || (rest.length === 1 && (rest[0] === 'settings.json' || rest[0] === 'settings.local.json'))
    if (name === '.vscode') return rest.length === 0 || (rest.length === 1 && (rest[0] === 'tasks.json' || rest[0] === 'mcp.json'))
    if (name === '.husky') return true
    if (name === '.yarn') return rest.length === 0 || rest[0] === 'releases' || rest[0] === 'plugins'
    if (AUTO_RUN_IN_FOLDER.has(name)) return rest.length === 0 || (rest.length === 1 && rest[0] === AUTO_RUN_IN_FOLDER.get(name))
    return rest.length === 0 && (AUTO_RUN_FILES as readonly string[]).includes(name)
  })
}

// SBPL regex fragments for a name at any depth below a root: `^<root>/(.*/)?` goes before each, `$` after. One
// regex each, not one alternation: Seatbelt refuses a string of 1024 characters or more (MAX_SBPL_STRING).
/** A `.git` (file or folder) and everything in it. */
const GIT_AT_ANY_DEPTH = [`${anyCase('.git')}(/.*)?`]
/** An `.app` bundle and everything in it. */
const APP_AT_ANY_DEPTH = [`[^/]*\\.${anyCase('app')}(/.*)?`]
/** AUTO_RUN_CONFIGS. */
const AUTO_RUN_AT_ANY_DEPTH = [
  `${anyCase('.claude')}(/(${anyCase('settings.json')}|${anyCase('settings.local.json')}|${anyCase('hooks')}(/.*)?))?`,
  `${anyCase('.vscode')}(/(${anyCase('tasks.json')}|${anyCase('mcp.json')}))?`,
  `${anyCase('.husky')}(/.*)?`,
  `${anyCase('.yarn')}(/(${anyCase('releases')}|${anyCase('plugins')})(/.*)?)?`,
  ...[...AUTO_RUN_IN_FOLDER].map(([dir, file]) => `${anyCase(dir)}(/${anyCase(file)})?`),
  ...AUTO_RUN_FILES.map(anyCase),
]
/** isSecretFileName's dotenv files, denied on a regular file only (with `vnode-type REGULAR-FILE`). */
const DOTENV_AT_ANY_DEPTH = [`${anyCase('.env')}(\\.[^/]*)?`]
/** The rest of isSecretFileName. */
const SECRET_AT_ANY_DEPTH = [
  `[^/]*\\.(${SECRET_FILE_EXTENSIONS.map(anyCase).join('|')})`,
  `${anyCase('service-account')}[^/]*\\.${anyCase('json')}`,
  ...SECRET_FILE_NAMES.map(anyCase),
]
/** The dotenv placeholders DOTENV_AT_ANY_DEPTH also matches, re-allowed right after it. */
const DOTENV_PLACEHOLDER_AT_ANY_DEPTH = [`${anyCase('.env')}(\\.[^/]*)?\\.(${DOTENV_PLACEHOLDERS.map(anyCase).join('|')})`]

/** The longest string Seatbelt reads in a profile (measured on 27.0.1: 1024 characters is "Error reading string"). */
export const MAX_SBPL_STRING = 1023

/** What a fence grant is checked against: the job's own layout. */
export interface FenceGrantContext {
  readonly home: string
  readonly mode: LocalAgentMode
  readonly folder: string
  readonly extraRead?: string
  readonly sessionRoot: string
  /**
   * Paths no write grant may be in or above: what runs outside the sandbox as
   * the person (the tool PATH's dirs, git, gh, ssh and the login shell, lexical
   * and realpath), the agent's own code, app bundle, node_modules and Node
   * runtime, and the config that steers them (dotfiles' real places, git
   * includes) (host-folder-sandbox.ts protectedPaths). A program planted there
   * would run unsandboxed, for one on the desktop's next push or commit.
   */
  readonly writeProtected?: readonly string[]
  /**
   * Paths no grant at all may be in or above: where HOME's hidden credential
   * and settings entries really live when a symlink puts them elsewhere
   * (`~/.ssh -> ~/Dropbox/ssh`).
   */
  readonly readProtected?: readonly string[]
}

/**
 * Why `path` cannot be granted to this job for `access`, or null when it can
 * (C3 `kind: "fence"`; checked before the person is asked, and again when the
 * grant is applied). The path is a realpath (the provider resolves it). It is
 * grantable by the folder rules (strictly inside HOME, or outside every
 * system and read-denied root), never a hidden entry at HOME's top (credential
 * and config stores and shell startup files: ~/.ssh, ~/.aws, ~/.config,
 * ~/.gitconfig, ~/.zshrc, ~/.dial8...) and never under ~/Library except
 * iCloud Drive (app data: the desktop's job dir holds the model token).
 * No grant reaches where a credential or settings entry of HOME really lives
 * (read-protected: a symlinked hidden entry, the entries of the credential
 * folders, ssh identity and certificate files), and no grant is a secret file
 * (isSecretFileName; the profile denies those below a grant).
 *
 * Fence grants are read-only (C3): any `write` is refused. The write rules
 * still run first, as defense in depth and for a clearer reason: writes would
 * stay inside HOME, and never reach a `.git`, `<name>.git` or `.husky`, an
 * `.app` bundle, the read-mode folder, the person's checkout, a
 * write-protected path (the tool PATH, git, gh, ssh, the shell, the agent's
 * own code, dotfiles and git includes), or anything holding one of those.
 */
export function fenceGrantRefusal(path: string, access: FenceAccess, ctx: FenceGrantContext): string | null {
  if (access !== 'read' && access !== 'write') return 'access must be "read" or "write"'
  if (typeof path !== 'string' || !path.startsWith('/')) return 'the path must be absolute'
  if (new TextEncoder().encode(path).length > MAX_FENCE_PATH_BYTES) return `the path is longer than ${MAX_FENCE_PATH_BYTES} bytes`
  if (path.includes('"') || CONTROL_CHAR.test(path)) return 'the path contains a quote or a control character'
  // Every comparison below is in any letter case: APFS is case-insensitive, so ~/LIBRARY is ~/Library.
  const lower = (x: string) => (x.replace(/\/+$/, '') || '/').toLowerCase()
  const p = lower(path)
  const h = lower(ctx.home)
  const refusal = grantRefusal(path, ctx.home, { foldCase: true })
  if (refusal) return refusal.replace(/^the granted folder/, 'the path')
  if (within(p, h)) {
    const rel = p.slice(h.length + 1).split('/')
    if (rel[0].startsWith('.')) return 'hidden folders at the top of HOME hold credentials and settings'
    // ~/Library/Mobile Documents/<container>/...: iCloud Drive and apps' iCloud folders, the person's documents.
    if (rel[0] === 'library' && !(rel[1] === 'mobile documents' && rel.length >= 3)) return '~/Library holds app data (only iCloud Drive can be granted)'
  }
  const session = lower(ctx.sessionRoot)
  if (within(p, session) || within(session, p)) return "the path overlaps the job's own scratch directory"
  for (const raw of ctx.readProtected ?? []) {
    if (typeof raw !== 'string' || !raw.startsWith('/')) continue
    const rp = lower(raw)
    if (within(p, rp) || within(rp, p)) return `a hidden HOME entry (credentials or settings) really lives there (${raw})`
  }
  // The profile denies secret files below a grant; a grant of one itself is refused here.
  if (isSecretFileName(p.slice(p.lastIndexOf('/') + 1))) return 'secret files (.env files, keys, credentials) are never readable by a job'
  if (access === 'write') {
    if (!within(p, h)) return 'only folders inside HOME can be changed'
    if (hasGitComponent(p)) return 'a .git folder (or a bare repository, or .husky) is never writable'
    if (p.split('/').some((c) => c.endsWith('.app'))) return 'an app bundle is a program the person runs: never writable'
    const folder = lower(ctx.folder)
    if (ctx.mode === 'read' && (within(p, folder) || within(folder, p))) return 'this job was granted its folder read-only'
    if (ctx.extraRead) {
      const checkout = lower(ctx.extraRead).replace(/\/\.git$/, '')
      if (within(p, checkout) || within(checkout, p)) return "the person's own checkout is never writable (the job edits its worktree)"
    }
    for (const raw of ctx.writeProtected ?? []) {
      if (typeof raw !== 'string' || !raw.startsWith('/')) continue
      const wp = lower(raw)
      if (within(p, wp) || within(wp, p)) {
        return `programs that run outside the sandbox live there (${raw}): the tool PATH, git, gh, ssh, the shell and the agent's own code are never writable`
      }
    }
    return 'fence grants are read-only (C3): a job changes files only in its own folder'
  }
  return null
}

/** The SBPL profile for one job. */
export function buildSeatbeltProfile(input: SeatbeltProfileInput): string {
  if (input.mode !== 'read' && input.mode !== 'edit') throw new SeatbeltPathError(`unsupported mode: ${String(input.mode)}`)
  const refusal = grantRefusal(input.folder, input.home)
  if (refusal) throw new SeatbeltPathError(refusal)
  if (input.extraRead !== undefined) {
    if (input.mode !== 'edit') throw new SeatbeltPathError('an extra read root is only allowed in edit mode')
    const why = extraReadRefusal(input.extraRead, input.folder, input.home)
    if (why) throw new SeatbeltPathError(why)
  }
  const sessionRootPath = input.sessionRoot ?? input.scratch
  for (const g of input.grants ?? []) {
    if ((g.access as string) !== 'read') throw new SeatbeltPathError(`fence grant ${JSON.stringify(g.path)}: fence grants are read-only (C3)`)
    const why = fenceGrantRefusal(g.path, g.access, {
      home: input.home,
      mode: input.mode,
      folder: input.folder,
      extraRead: input.extraRead,
      sessionRoot: sessionRootPath,
      writeProtected: input.writeProtected,
      readProtected: input.readProtected,
    })
    if (why) throw new SeatbeltPathError(`fence grant ${JSON.stringify(g.path)}: ${why}`)
  }
  if (input.runtime !== undefined) {
    const why = runtimeRefusal(input.runtime, input)
    if (why) throw new SeatbeltPathError(why)
  }
  const toolRoots = input.toolRoots ?? []
  const strayToolRoot = toolRoots.find((r) => toolPathReadRoots([r], input.home)[0] !== r.replace(/\/+$/, ''))
  if (strayToolRoot !== undefined) throw new SeatbeltPathError(`not a tool PATH read root: ${JSON.stringify(strayToolRoot)}`)
  const edit = input.mode === 'edit'
  const folder = sbplString(input.folder)
  const home = sbplString(input.home)
  const scratch = sbplString(input.scratch)
  const sessionRoot = sbplString(sessionRootPath)
  const homeBase = home.slice(1, -1)
  const toolchain = [
    ...HOME_TOOLCHAIN_ALLOWLIST.map((rel) => `(subpath "${homeBase}/${rel}")`),
    ...HOME_TOOLCHAIN_FILES.map((rel) => `(literal "${homeBase}/${rel}")`),
  ].join(' ')
  for (const r of input.toolchainRealpaths ?? []) {
    if (typeof r !== 'string' || !r.startsWith('/') || r.replace(/\/+$/, '') === '' || within(input.home.replace(/\/+$/, ''), r.replace(/\/+$/, ''))) {
      throw new SeatbeltPathError(`not a toolchain realpath: ${JSON.stringify(r)}`)
    }
    sbplString(r)
  }
  // Credential files sit near a toolchain's top (cargo's `credentials.toml`), at most two dirs down
  // (SBPL regexes have no `{m,n}`); deeper the name is source code (`botocore/credentials.py`, gRPC's
  // `credentials` package), which must stay readable. The same below a symlinked toolchain's real place.
  const credentialAnchors = [
    `^${regexLiteral(input.home.replace(/\/+$/, ''))}/(${TOOLCHAIN_ROOTS.map(regexLiteral).join('|')})/`,
    ...(input.toolchainRealpaths ?? []).map((r) => `^${anyCase(r.replace(/\/+$/, ''))}/`),
  ]
  const credentialDeny = `(deny file-read-data ${credentialAnchors
    .map((a) => `(regex #"${a}([^/]+/)?([^/]+/)?${anyCase('credentials')}[^/]*$") (regex #"${a}(.*/)?\\.?${anyCase('npmrc')}$")`)
    .join(' ')})`
  const extraRead = input.extraRead === undefined ? '' : ` (subpath ${sbplString(input.extraRead)})`
  /** `names` (one of the *_AT_ANY_DEPTH lists) at any depth below `root`: one regex each. */
  const below = (root: string, names: readonly string[]) =>
    names
      .map((name) => {
        const re = `^${regexLiteral(root.replace(/\/+$/, ''))}/(.*/)?${name}$`
        if (re.length > MAX_SBPL_STRING) throw new SeatbeltPathError(`path too long for a profile rule: ${JSON.stringify(root)}`)
        return `(regex #"${re}")`
      })
      .join(' ')
  // Edit mode: a `.git` at any depth of the worktree; an `.app` bundle (a program the person could open outside the
  // sandbox) and the configs their tools run on their own, in the worktree AND the scratch dir (same volume: a folder
  // built there could be moved into the worktree whole, and a rule on a name sees only the moved folder's own name).
  // Not `.git` in the scratch dir: the desktop refuses to commit a nested one however it got there.
  const neverInWorktree = [
    below(input.folder, GIT_AT_ANY_DEPTH),
    ...[APP_AT_ANY_DEPTH, AUTO_RUN_AT_ANY_DEPTH].flatMap((names) => [input.folder, input.scratch].map((root) => below(root, names))),
  ].join(' ')
  // Secret files at any depth of a read job's folder and of every fence grant (not an edit job's fresh worktree).
  const secretRoots = [...(edit ? [] : [input.folder]), ...(input.grants ?? []).map((g) => g.path)]
  const secretReads = secretRoots
    .map((root) => [...DOTENV_AT_ANY_DEPTH.map((name) => `(require-all ${below(root, [name])} (vnode-type REGULAR-FILE))`), below(root, SECRET_AT_ANY_DEPTH)].join(' '))
    .join(' ')
  const placeholderReads = secretRoots.map((root) => below(root, DOTENV_PLACEHOLDER_AT_ANY_DEPTH)).join(' ')
  const grantReads = (input.grants ?? []).map((g) => ` (subpath ${sbplString(g.path)})`).join('')
  // Where credentials really live: denied even inside the folder or a grant (the last read rule for them).
  const keepOut = [input.home, sessionRootPath, input.scratch, ...(input.runtime === undefined ? [] : [input.runtime])].map((x) => (x.replace(/\/+$/, '') || '/').toLowerCase())
  const readDenies = [
    ...new Set(
      (input.readProtected ?? [])
        .filter((rp) => typeof rp === 'string' && rp.startsWith('/') && !rp.includes('"') && !CONTROL_CHAR.test(rp))
        .map((rp) => rp.replace(/\/+$/, '') || '/')
        .filter((rp) => !keepOut.some((x) => within(x, rp.toLowerCase()))),
    ),
  ]
  const systemReads = [
    ...SYSTEM_READ_FILES.map((f) => `(literal "${f}")`),
    ...SYSTEM_READ_ROOTS.map((r) => `(subpath "${r}")`),
    `(regex #"${XCODE_APPS}")`,
    // bash opens its here-document file read-write (written above, read back here).
    `(regex #"${HEREDOC_FILES}")`,
    ...toolRoots.map((r) => `(subpath ${sbplString(r)})`),
    ...(input.runtime === undefined ? [] : [`(subpath ${sbplString(input.runtime)})`]),
  ].join(' ')
  const machNames = DENIED_MACH_NAMES.map((n) => `(global-name "${n}")`).join(' ')
  const machPrefixes = DENIED_MACH_PREFIXES.map((n) => `(global-name-prefix "${n}")`).join(' ')

  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    // One sandbox per job (the provider's runner): its commands may signal each other, nothing else.
    '(deny signal)',
    '(allow signal (target same-sandbox))',
    // Process details, arguments and environment (the eve server's secrets) only of its own processes: another's
    // `kern.procargs2` is refused only when both `process-info*` and the sysctl are.
    '(deny process-info*)',
    '(allow process-info* (target same-sandbox))',
    '(deny sysctl-read (sysctl-name-prefix "kern.procargs"))',
    '(deny job-creation)',
    '(deny file-write*)',
    `(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/fd/[0-9]+$") (subpath ${scratch}))`,
    // macOS bash 3.2 writes here-documents to /var/tmp/sh-thd-<n> whatever TMPDIR
    // says, after an access(W_OK) check on /var/tmp itself (measured on 27.0.1).
    '(allow file-write* (literal "/private/var/tmp") (regex #"^/private/var/tmp/sh-thd-[0-9]+$"))',
    // Edit mode: the worktree is writable, never a `.git`, an `.app` or an auto-run config (the deny comes after: last
    // match wins).
    ...(edit ? [`(allow file-write* (subpath ${folder}))`, `(deny file-write* ${neverInWorktree})`] : []),
    '(deny file-read-data)',
    `(allow file-read-data ${systemReads})`,
    `(allow file-read-data (subpath ${folder}) (subpath ${sessionRoot}) (subpath ${scratch})${extraRead}${grantReads} ${toolchain})`,
    // Secret files (contents and stat), the placeholders back; the credential denies below still apply to them. None
    // without a root to put them under: a rule without a filter would match every path.
    ...(secretRoots.length > 0 ? [`(deny file-read-data file-read-metadata ${secretReads})`, `(allow file-read-data file-read-metadata ${placeholderReads})`] : []),
    credentialDeny,
    ...(readDenies.length > 0 ? [`(deny file-read-data ${readDenies.map((rp) => `(subpath ${sbplString(rp)})`).join(' ')})`] : []),
    '(allow file-read-data (regex #"^/private/var/folders/[^/]+/[^/]+/T/xcrun_db$"))',
    '(deny appleevent-send)',
    `(deny mach-lookup ${machNames} ${machPrefixes})`,
    '(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript"))',
    `(deny process-exec* (subpath ${scratch}))`,
    '',
  ].join('\n')
}
