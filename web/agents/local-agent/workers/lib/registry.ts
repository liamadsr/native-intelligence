/**
 * The agents a worker job can run, as data (../registry.json, bundled into
 * acp.mjs). The adapter has no code for any one agent: everything that
 * differs between them is an entry here, keyed by the worker id the desktop
 * sends (`LOCAL_AGENT_WORKER`).
 *
 *   label        the agent's name in sentences ("Claude Code")
 *   cli          the executable the desktop looks up on PATH (LOCAL_AGENT_WORKER_BIN's name)
 *   command      the ACP adapter's argv: `$NODE` (this Node), `$ACP_DIR`
 *                (LOCAL_AGENT_ACP_DIR, where install-agents.sh put the
 *                packages), `$CLI` (the person's CLI, realpath)
 *   env          extra environment: `$CLI`, `$TMP` (the agent's temp folder), `$HOME` (its private home)
 *   sessionMode  set with `session/set_mode` after the session exists (the
 *                mode in which the agent's own sandbox is off: it cannot nest
 *                inside ours on macOS)
 *   homeFolders  the agent's own state folders, made empty in its private
 *                home before it starts (`.claude`): their names are ones the
 *                profile never lets it create, so it couldn't make them itself
 *   login        where the person's existing login is: the Mac's keychain
 *                (`keychain`), and/or single login files of the real HOME
 *                (`files`: each linked into the private home, with the
 *                `scratch` names its atomic save makes beside it)
 *   signInHint   the sentence for a person whose agent is not signed in
 *   packages     the npm package and exact version of its ACP adapter (install-agents.sh)
 */
import raw from '../registry.json'

export interface RegistryEntry {
  readonly label: string
  readonly cli: string
  readonly command: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly sessionMode?: string
  readonly homeFolders: readonly string[]
  readonly login: { readonly keychain?: boolean; readonly files: readonly LoginFile[] }
  readonly signInHint: string
  readonly packages: Readonly<Record<string, string>>
}

/** One login file of the real HOME, shared into the private home by a link; nothing else of its folder is. */
export interface LoginFile {
  /** Relative to HOME: `.codex/auth.json`. */
  readonly path: string
  /** Names the agent's atomic save makes in the same folder (`.auth-*`, `auth.json.lock`): `*` within a name only. */
  readonly scratch: readonly string[]
}

export type Registry = Readonly<Record<string, RegistryEntry>>

const WORKER_ID = /^[a-z][a-z0-9-]{0,31}$/
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/
/** One name in a HOME-relative path: never `.`, `..` or empty. */
const NAME = /^(?!\.\.?$)[A-Za-z0-9._-]+$/
/** A scratch name: a NAME that may hold `*`. */
const SCRATCH = /^(?!\.\.?$)[A-Za-z0-9._*-]+$/
/** Environment names the adapter sets itself or that carry Native Intelligence's own settings: never from a registry entry. */
const RESERVED_ENV = /^(HOME|PATH|TMPDIR|NO_BROWSER|USER|LOGNAME|SHELL|LOCAL_AGENT_.*|NI_.*)$/
/** An exact version: no ranges, so what runs is what was reviewed. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

const COMMAND_VARS = ['NODE', 'ACP_DIR', 'CLI'] as const
const ENV_VARS = ['CLI', 'TMP', 'HOME'] as const

function placeholders(s: string): string[] {
  return [...s.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1])
}

function fail(id: string, what: string): never {
  throw new Error(`registry entry ${JSON.stringify(id)}: ${what}`)
}

function str(id: string, v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) fail(id, `${name} must be a non-empty string`)
  return v
}

/** The registry, checked: a malformed entry is a bug in the bundle, so it throws. */
export function parseRegistry(input: unknown): Registry {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('the registry must be an object')
  const out: Record<string, RegistryEntry> = {}
  for (const [id, e] of Object.entries(input as Record<string, unknown>)) {
    if (!WORKER_ID.test(id)) fail(id, 'not a worker id')
    if (!e || typeof e !== 'object') fail(id, 'must be an object')
    const r = e as Record<string, unknown>
    const label = str(id, r.label, 'label')
    const cli = str(id, r.cli, 'cli')
    if (cli.includes('/')) fail(id, 'cli is a name, not a path')
    if (!Array.isArray(r.command) || r.command.length === 0) fail(id, 'command must be a non-empty array')
    const command = r.command.map((c, i) => str(id, c, `command[${i}]`))
    for (const c of command) for (const p of placeholders(c)) if (!(COMMAND_VARS as readonly string[]).includes(p)) fail(id, `command uses $${p}`)
    const env: Record<string, string> = {}
    if (r.env !== undefined) {
      if (!r.env || typeof r.env !== 'object' || Array.isArray(r.env)) fail(id, 'env must be an object')
      for (const [k, v] of Object.entries(r.env)) {
        if (!ENV_NAME.test(k)) fail(id, `env name ${JSON.stringify(k)}`)
        if (RESERVED_ENV.test(k)) fail(id, `env may not set ${k}`)
        if (typeof v !== 'string') fail(id, `env ${k} must be a string`)
        for (const p of placeholders(v)) if (!(ENV_VARS as readonly string[]).includes(p)) fail(id, `env ${k} uses $${p}`)
        env[k] = v
      }
    }
    const sessionMode = r.sessionMode === undefined ? undefined : str(id, r.sessionMode, 'sessionMode')
    const login = (r.login ?? {}) as Record<string, unknown>
    if (typeof login !== 'object' || Array.isArray(login)) fail(id, 'login must be an object')
    if (login.keychain !== undefined && typeof login.keychain !== 'boolean') fail(id, 'login.keychain must be a boolean')
    const files: LoginFile[] = []
    for (const f of (login.files ?? []) as unknown[]) {
      const o = (f ?? {}) as Record<string, unknown>
      const path = typeof o.path === 'string' ? o.path : ''
      const parts = path.split('/')
      if (parts.length < 2 || !parts.every((p) => NAME.test(p)) || !parts[0].startsWith('.')) fail(id, `login file ${JSON.stringify(path)} must be a file in a hidden folder of HOME`)
      const dir = parts.slice(0, -1).join('/')
      const scratch = Array.isArray(o.scratch) ? o.scratch : []
      for (const g of scratch) {
        if (typeof g !== 'string' || !g.startsWith(`${dir}/`) || !SCRATCH.test(g.slice(dir.length + 1))) fail(id, `scratch ${JSON.stringify(g)} must be a name beside ${path}`)
      }
      files.push({ path, scratch: (scratch as string[]).map((g) => g.slice(dir.length + 1)) })
    }
    const homeFolders = r.homeFolders === undefined ? [] : r.homeFolders
    if (!Array.isArray(homeFolders) || !homeFolders.every((h) => typeof h === 'string' && NAME.test(h) && h.startsWith('.'))) fail(id, 'homeFolders must be hidden folder names')
    const signInHint = str(id, r.signInHint, 'signInHint')
    if (!r.packages || typeof r.packages !== 'object' || Array.isArray(r.packages) || Object.keys(r.packages).length === 0) fail(id, 'packages must name the ACP adapter')
    for (const [name, version] of Object.entries(r.packages)) {
      if (!PACKAGE.test(name)) fail(id, `package name ${JSON.stringify(name)}`)
      if (typeof version !== 'string' || !EXACT_VERSION.test(version)) fail(id, `package ${name} needs an exact version`)
    }
    out[id] = {
      label,
      cli,
      command,
      env,
      ...(sessionMode === undefined ? {} : { sessionMode }),
      homeFolders: homeFolders as string[],
      login: { ...(login.keychain ? { keychain: true } : {}), files },
      signInHint,
      packages: r.packages as Record<string, string>,
    }
  }
  return out
}

let shipped: Registry | null = null

/**
 * The registry shipped with this bundle, checked on first use (never at
 * import: a damaged one must end in a `fatal` line, not a stack trace).
 */
export function loadRegistry(input: unknown = raw): Registry {
  if (input === raw && shipped) return shipped
  try {
    const r = parseRegistry(input)
    if (input === raw) shipped = r
    return r
  } catch (err) {
    throw new Error(`the list of agents shipped with this app is damaged (${err instanceof Error ? err.message : String(err)}): reinstall the app`)
  }
}

/** `$NAME` placeholders in `s` replaced from `vars` (parseRegistry has already refused any other name). */
export function expand(s: string, vars: Readonly<Record<string, string>>): string {
  return s.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name: string) => vars[name] ?? whole)
}

/** The entry's argv and environment for one launch. */
export function agentLaunch(entry: RegistryEntry, vars: { node: string; acpDir: string; cli: string; tmp: string; home: string }) {
  const command = entry.command.map((c) => expand(c, { NODE: vars.node, ACP_DIR: vars.acpDir, CLI: vars.cli }))
  const env = Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [k, expand(v, { CLI: vars.cli, TMP: vars.tmp, HOME: vars.home })]))
  return { command, env }
}
