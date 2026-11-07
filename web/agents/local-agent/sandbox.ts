/**
 * The local agent's sandbox: the granted folder on this Mac, under Seatbelt
 * (lib/host-folder-sandbox.ts). The desktop app passes the grant in the
 * environment it builds for the launcher (L0 contract §1, L1 contract C3/C5);
 * the selector reads it once, when the session first touches its sandbox, and
 * eve checkpoints the provider state. Restarts call the provider's resume(),
 * which re-checks the folder against that state and against the relaunch's
 * environment.
 *
 *   LOCAL_AGENT_FOLDER       realpath of the folder (edit mode: the worktree)
 *   LOCAL_AGENT_MODE         `read` or `edit`
 *   LOCAL_AGENT_TOOL_PATH    PATH for sandboxed commands
 *   LOCAL_AGENT_EXTRA_READ   edit mode only: the repository's `.git` (read-only)
 *
 * Fails closed: a missing folder, mode or tool PATH throws, so the session
 * gets no sandbox at all rather than a default one.
 */
import { defineSandbox } from 'eve/sandbox'
import { HostFolderSandbox, type HostFolderOpenOptions, type LaunchEnv } from './lib/host-folder-sandbox.js'

export const environment = HostFolderSandbox.environment()

/** The grant from the launch environment, or a throw naming what is missing. */
export function openOptionsFromEnv(env: LaunchEnv): HostFolderOpenOptions {
  const folder = env.LOCAL_AGENT_FOLDER
  const mode = env.LOCAL_AGENT_MODE
  const toolPath = env.LOCAL_AGENT_TOOL_PATH
  const extraRead = env.LOCAL_AGENT_EXTRA_READ || undefined
  const missing = [!folder && 'LOCAL_AGENT_FOLDER', !mode && 'LOCAL_AGENT_MODE', !toolPath && 'LOCAL_AGENT_TOOL_PATH'].filter(Boolean)
  if (missing.length > 0) throw new Error(`local-agent sandbox: ${missing.join(', ')} not set; refusing to open a sandbox`)
  if (mode !== 'read' && mode !== 'edit') throw new Error(`local-agent sandbox: mode ${JSON.stringify(mode)} is not supported (read or edit)`)
  if (extraRead !== undefined && mode !== 'edit') throw new Error('local-agent sandbox: LOCAL_AGENT_EXTRA_READ is only allowed in edit mode')
  return extraRead === undefined ? { folder: folder!, mode, toolPath: toolPath! } : { folder: folder!, mode, toolPath: toolPath!, extraRead }
}

export default defineSandbox(() => environment.open(openOptionsFromEnv(process.env)))
