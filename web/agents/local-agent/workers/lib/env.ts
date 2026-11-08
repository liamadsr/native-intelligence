/**
 * What the desktop passes a worker adapter, checked once at launch. The
 * desktop spawns `<node> <bundle>/workers/<worker>.mjs` with exactly the
 * launcher's fence environment (built from scratch) plus the worker's two:
 *
 *   HOME, TMPDIR, LANG, PATH          as for the launcher
 *   LOCAL_AGENT_JOB_ID                the job (names the fence's scratch dir)
 *   LOCAL_AGENT_FOLDER                realpath of the folder (edit mode: the worktree)
 *   LOCAL_AGENT_MODE                  `read` | `edit`
 *   LOCAL_AGENT_TOOL_PATH             PATH for fenced commands
 *   LOCAL_AGENT_DIR                   the bundle (unused here; the launcher's contract)
 *   LOCAL_AGENT_EXTRA_READ            edit mode: the repository's `.git`
 *   LOCAL_AGENT_WORKER                `claude-code` | `codex`: must match the entry file
 *   LOCAL_AGENT_WORKER_BIN            absolute path of the person's CLI, found by the
 *                                     desktop; run exactly, PATH is never searched
 *
 * No relay URL, no session token, no dev key (each is refused: DIAL8_CREDENTIALS):
 * a worker uses its vendor's model on the person's own login. A local-model setting is refused here too
 * (the desktop refuses first): a worker sends the folder to Anthropic or
 * OpenAI, which is what that setting rules out.
 */
import { accessSync, constants as fsConstants, realpathSync, statSync } from 'node:fs'
import type { LocalAgentMode } from '../../lib/seatbelt.js'
import type { WorkerName } from './protocol.js'

/** The environment as read here (process.env, or a plain object in tests). */
export type WorkerEnv = Readonly<Record<string, string | undefined>>

export interface WorkerLaunch {
  readonly worker: WorkerName
  /** realpath of the person's CLI (the desktop passes its PATH lookup, symlinks and all). */
  readonly bin: string
  /** The path as the desktop passed it (a `~/.local/bin/claude` symlink): argv[0] for the CLI. */
  readonly binPath: string
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
export const DIAL8_CREDENTIALS = [
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
 * The launch, or a WorkerLaunchError saying what is wrong. `expected` is the
 * entry file's worker: an adapter never runs the other vendor's CLI.
 */
export function workerLaunchFromEnv(env: WorkerEnv, expected: WorkerName): WorkerLaunch {
  if (env.LOCAL_AGENT_WORKER !== expected) {
    throw new WorkerLaunchError(`this adapter runs ${expected}, but LOCAL_AGENT_WORKER is ${JSON.stringify(env.LOCAL_AGENT_WORKER ?? null)}`)
  }
  if (env.LOCAL_AGENT_LOCAL_MODEL_BASE_URL || env.LOCAL_AGENT_LOCAL_MODEL_ID) {
    throw new WorkerLaunchError("this Mac is set to keep the model on the Mac, and a worker would send the folder to its vendor's model")
  }
  // A worker uses its vendor's model on the person's own login: a Native Intelligence credential has no business here.
  const credentials = DIAL8_CREDENTIALS.filter((k) => env[k])
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

  const binPath = env.LOCAL_AGENT_WORKER_BIN
  if (!binPath || !binPath.startsWith('/')) throw new WorkerLaunchError('LOCAL_AGENT_WORKER_BIN is missing or not absolute')
  let bin: string
  try {
    bin = realpathSync(binPath)
    accessSync(bin, fsConstants.X_OK)
  } catch {
    throw new WorkerLaunchError(`the ${expected === 'claude-code' ? 'Claude Code' : 'Codex'} CLI is not an executable file: ${binPath}`)
  }
  if (!statSync(bin).isFile()) throw new WorkerLaunchError(`LOCAL_AGENT_WORKER_BIN is not a file: ${binPath}`)

  return {
    worker: expected,
    bin,
    binPath,
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
