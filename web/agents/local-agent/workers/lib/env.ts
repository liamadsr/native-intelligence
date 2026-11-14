/**
 * What the desktop passes a worker, checked once at launch. The desktop
 * spawns `<node> <bundle>/workers/acp.mjs` with exactly the launcher's fence
 * environment (built from scratch) plus the worker's three:
 *
 *   HOME, TMPDIR, LANG, PATH          as for the launcher
 *   LOCAL_AGENT_JOB_ID                the job
 *   LOCAL_AGENT_FOLDER                realpath of the folder (edit mode: the worktree)
 *   LOCAL_AGENT_MODE                  `read` | `edit`
 *   LOCAL_AGENT_TOOL_PATH             PATH for the agent and its commands
 *   LOCAL_AGENT_DIR                   the bundle (unused here; the launcher's contract)
 *   LOCAL_AGENT_EXTRA_READ            edit mode: the repository's `.git`
 *   LOCAL_AGENT_WORKER                a registry key (`claude-code` | `codex`)
 *   LOCAL_AGENT_WORKER_BIN            absolute path of the person's CLI, found by the
 *                                     desktop; run exactly, PATH is never searched
 *   LOCAL_AGENT_ACP_DIR               where install-agents.sh installed the ACP adapters
 *   LOCAL_AGENT_CLOSED_PORTS          optional: comma-separated ports of the app's own local
 *                                     servers at launch, which the fence denies on loopback
 *   LOCAL_AGENT_TOOLS_FILE            optional: the workspace tools the desktop wrote for this
 *                                     launch (workspace-tools.ts; nothing secret in it)
 *   LOCAL_AGENT_FENCE_DIR             the desktop's fence folder, holding the empty files
 *                                     `<job id>` and `<job id>.open` (agent-profile.ts: how
 *                                     the desktop finds this job's processes)
 *
 * No relay URL, no session token, no dev key (each is refused: NI_CREDENTIALS):
 * a worker uses its vendor's model on the person's own login. A local-model
 * setting is refused here too (the desktop refuses first): a worker sends the
 * folder to its vendor, which is what that setting rules out.
 */
import { accessSync, constants as fsConstants, lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { LocalAgentMode } from '../../lib/seatbelt.js'
import type { Registry, RegistryEntry } from './registry.js'

/** The environment as read here (process.env, or a plain object in tests). */
export type WorkerEnv = Readonly<Record<string, string | undefined>>

export interface WorkerLaunch {
  readonly worker: string
  readonly entry: RegistryEntry
  /** realpath of the person's CLI (the desktop passes its PATH lookup, symlinks and all). */
  readonly bin: string
  /** realpath of LOCAL_AGENT_ACP_DIR. */
  readonly acpDir: string
  /** LOCAL_AGENT_FENCE_DIR, a real folder holding `<job id>` and `<job id>.open`. */
  readonly fenceDir: string
  /** LOCAL_AGENT_TOOLS_FILE as given (checked when read: a bad one means no workspace tools, never a fatal). */
  readonly toolsFile?: string
  /** LOCAL_AGENT_CLOSED_PORTS: the app's own local ports at launch, denied on loopback (none when unset). */
  readonly closedPorts: readonly number[]
  readonly jobId: string
  readonly folder: string
  readonly mode: LocalAgentMode
  readonly toolPath: string
  readonly extraRead?: string
  readonly home: string
  /** The job's own temp folder (realpath). */
  readonly tmpdir: string
  readonly lang: string
}

export class WorkerLaunchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkerLaunchError'
  }
}

const JOB_ID = /^[A-Za-z0-9_-]{1,96}$/

/** Native Intelligence's model relay, session and dev credentials: never in a worker's environment. */
export const NI_CREDENTIALS = [
  'LOCAL_AGENT_MODEL_TOKEN',
  'LOCAL_AGENT_MODEL_BASE_URL',
  'LOCAL_AGENT_MODEL_TOKEN_FILE',
  'LOCAL_AGENT_SESSION_TOKEN_FILE',
  'LOCAL_AGENT_DEV_ENV_FILE',
  'AI_GATEWAY_API_KEY',
] as const

function realDir(path: string | undefined, name: string): string {
  if (!path || !path.startsWith('/')) throw new WorkerLaunchError(`${name} is missing or not absolute`)
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    throw new WorkerLaunchError(`${name} does not exist: ${path}`)
  }
  if (!statSync(real).isDirectory()) throw new WorkerLaunchError(`${name} is not a folder: ${path}`)
  return real
}

/**
 * The fence folder: a real folder at its own path (no link), holding the two
 * empty files the desktop made for this job. Without them the desktop could
 * not find the job's processes, so the job does not run.
 */
function fenceDirFromEnv(dir: string | undefined, jobId: string): string {
  const missing = (what: string) => new WorkerLaunchError(`this job can't start: the app did not set up its fence marker (${what})`)
  if (!dir || !dir.startsWith('/')) throw missing('LOCAL_AGENT_FENCE_DIR is missing or not absolute')
  let real: string
  try {
    real = realpathSync(dir)
  } catch {
    throw missing(`${dir} does not exist`)
  }
  if (real !== dir.replace(/\/+$/, '') || !lstatSync(real).isDirectory()) throw missing(`${dir} is not a real folder`)
  for (const name of [jobId, `${jobId}.open`]) {
    let ok = false
    try {
      ok = lstatSync(join(real, name)).isFile()
    } catch {
      // missing
    }
    if (!ok) throw missing(`${name} is not in ${dir}`)
  }
  return real
}

/** The most ports LOCAL_AGENT_CLOSED_PORTS may list (each becomes a profile rule). */
export const MAX_CLOSED_PORTS = 512

/**
 * The app's own local ports, strictly: integers 1 to 65535, comma-separated,
 * at most MAX_CLOSED_PORTS. Unset or empty: none (an older desktop).
 */
export function closedPortsFromEnv(value: string | undefined): number[] {
  if (value === undefined || value.trim() === '') return []
  const items = value.split(',').map((x) => x.trim())
  const bad = () => new WorkerLaunchError(`this job can't start: the app passed an unreadable list of its own ports (LOCAL_AGENT_CLOSED_PORTS=${JSON.stringify(value.slice(0, 80))})`)
  if (items.length > MAX_CLOSED_PORTS) throw bad()
  const ports = items.map((x) => (/^[0-9]{1,5}$/.test(x) ? Number(x) : NaN))
  if (ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) throw bad()
  return [...new Set(ports)].sort((a, b) => a - b)
}

/** The launch, or a WorkerLaunchError saying what is wrong. */
export function workerLaunchFromEnv(env: WorkerEnv, registry: Registry): WorkerLaunch {
  const worker = env.LOCAL_AGENT_WORKER
  if (!worker || !Object.hasOwn(registry, worker)) throw new WorkerLaunchError(`no worker is called ${JSON.stringify(worker ?? null)}`)
  const entry = registry[worker]
  if (env.LOCAL_AGENT_LOCAL_MODEL_BASE_URL || env.LOCAL_AGENT_LOCAL_MODEL_ID) {
    throw new WorkerLaunchError("this Mac is set to keep the model on the Mac, and a worker would send the folder to its vendor's model")
  }
  // A worker uses its vendor's model on the person's own login: a Native Intelligence credential has no business here.
  const credentials = NI_CREDENTIALS.filter((k) => env[k])
  if (credentials.length) throw new WorkerLaunchError(`a worker job must not be given ${credentials.join(', ')}`)
  const jobId = env.LOCAL_AGENT_JOB_ID
  if (!jobId || !JOB_ID.test(jobId)) throw new WorkerLaunchError('LOCAL_AGENT_JOB_ID is missing or not a job id')
  const mode = env.LOCAL_AGENT_MODE
  if (mode !== 'read' && mode !== 'edit') throw new WorkerLaunchError(`unsupported mode: ${JSON.stringify(mode ?? null)}`)
  const toolPath = env.LOCAL_AGENT_TOOL_PATH
  if (!toolPath) throw new WorkerLaunchError('LOCAL_AGENT_TOOL_PATH is missing')
  // The folder must already be a realpath: the fence (resolveHostFolder) re-checks it and the grant.
  const folder = env.LOCAL_AGENT_FOLDER
  if (!folder || realDir(folder, 'LOCAL_AGENT_FOLDER') !== folder) throw new WorkerLaunchError('LOCAL_AGENT_FOLDER must be the realpath of the granted folder')
  const extraRead = env.LOCAL_AGENT_EXTRA_READ || undefined
  if (extraRead !== undefined && mode !== 'edit') throw new WorkerLaunchError('LOCAL_AGENT_EXTRA_READ is only allowed in edit mode')
  if (mode === 'edit' && extraRead === undefined) throw new WorkerLaunchError('edit mode needs LOCAL_AGENT_EXTRA_READ (the repository git directory)')
  const acpDir = realDir(env.LOCAL_AGENT_ACP_DIR, 'LOCAL_AGENT_ACP_DIR')
  const fenceDir = fenceDirFromEnv(env.LOCAL_AGENT_FENCE_DIR, jobId)
  const closedPorts = closedPortsFromEnv(env.LOCAL_AGENT_CLOSED_PORTS)

  const binPath = env.LOCAL_AGENT_WORKER_BIN
  if (!binPath || !binPath.startsWith('/')) throw new WorkerLaunchError('LOCAL_AGENT_WORKER_BIN is missing or not absolute')
  // The desktop looks the CLI up by the registry's name: anything else is not this worker's CLI.
  if (basename(binPath) !== entry.cli) throw new WorkerLaunchError(`LOCAL_AGENT_WORKER_BIN is not ${entry.label}'s CLI (${entry.cli}): ${binPath}`)
  let bin: string
  try {
    bin = realpathSync(binPath)
    accessSync(bin, fsConstants.X_OK)
  } catch {
    throw new WorkerLaunchError(`the ${entry.label} CLI is not an executable file: ${binPath}`)
  }
  if (!statSync(bin).isFile()) throw new WorkerLaunchError(`LOCAL_AGENT_WORKER_BIN is not a file: ${binPath}`)

  return {
    worker,
    entry,
    bin,
    acpDir,
    fenceDir,
    closedPorts,
    ...(env.LOCAL_AGENT_TOOLS_FILE ? { toolsFile: env.LOCAL_AGENT_TOOLS_FILE } : {}),
    jobId,
    folder,
    mode,
    toolPath,
    ...(extraRead === undefined ? {} : { extraRead }),
    home: realDir(env.HOME, 'HOME'),
    tmpdir: realDir(env.TMPDIR, 'TMPDIR'),
    lang: env.LANG || 'en_US.UTF-8',
  }
}
