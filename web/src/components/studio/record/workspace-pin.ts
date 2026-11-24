// A take belongs to the workspace it started in. The window's workspace is what every Studio request names
// (lib/workspace-fetch.ts adds it), so if the window moved to another workspace while a take records or is saved
// (the switcher refuses that, but another path could: a popout, a deep link), its pieces and its filing would go to
// the wrong one. The server refuses those anyway (a take id is looked up in its own workspace only), and here nothing
// is even sent: every send for a take checks the pin first, and a take whose workspace moved needs attention instead.
import { getClientWorkspaceId } from '@/lib/workspace-fetch'

export const WORKSPACE_MOVED =
  'Recording needs attention: it started in another workspace. Switch back to that workspace, then Try again.'

export class WorkspaceMovedError extends Error {
  readonly code = 'WORKSPACE_MOVED'
  constructor() { super(WORKSPACE_MOVED); this.name = 'WorkspaceMovedError' }
}

let pinned: string | null = null

/** The take starting now belongs to the window's workspace now. */
export function pinWorkspace(id: string | null = getClientWorkspaceId()): void { pinned = id }
export function unpinWorkspace(): void { pinned = null }
export function pinnedWorkspace(): string | null { return pinned }

/** Throws when a take is pinned to a workspace the window is no longer on. */
export function checkWorkspace(current: string | null = getClientWorkspaceId()): void {
  if (pinned && current && current !== pinned) throw new WorkspaceMovedError()
}
