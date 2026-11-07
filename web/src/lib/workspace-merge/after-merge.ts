/**
 * What the merging person's browser does once merge_workspace has committed.
 *
 * The server already pointed this browser's workspace cookie at the
 * destination and re-pointed device and MCP tokens inside the merge. What is
 * left is this window's own state: the fetch interceptor's workspace id, and
 * the per-workspace localStorage the app keeps (the chat thread and draft, the
 * active view per entity, the home-thread adoption flag, the onboarding
 * checklist flag, the knowledge view mode, the calendar cache, the desktop's
 * local Exchange allow-list, the chat's last-workspace pointer). A stale
 * cookie or header would otherwise fall through to the person's OLDEST
 * workspace, not the destination (lib/workspace.ts), and the source's keys
 * would linger forever (only the chat and tab keys are swept on sign-out).
 *
 * The sweep is pure over a Storage-like interface so it can be tested; the
 * finish step touches the window.
 */
import { setClientWorkspaceId } from '@/lib/workspace-fetch'

export interface StorageLike {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** The desktop's allow-list of workspaces whose local Exchange events are pushed (lib/integrations/calendar-local.ts). */
export const LOCAL_EXCHANGE_WORKSPACES_KEY = 'dial8:local-exchange:enabled-workspaces'
/** The chat's pointer to the workspace whose chat was on screen last (main-chat-storage.ts): the id is the VALUE. */
export const LAST_CHAT_WORKSPACE_KEY = 'dial8-chat:last-workspace'

export interface SweepResult {
  removed: string[]
  rewritten: string[]
}

/**
 * Remove every key that names the source workspace, carry the source's entry
 * in the local Exchange allow-list over to the destination, and re-point the
 * chat's last-workspace value. Never touches a key that does not name the
 * source.
 */
export function sweepWorkspaceLocalState(storage: StorageLike, sourceWorkspaceId: string, destinationWorkspaceId: string): SweepResult {
  const result: SweepResult = { removed: [], rewritten: [] }
  if (!sourceWorkspaceId) return result

  // The allow-list is a JSON array of ids: replace, dedupe, keep order.
  try {
    const raw = storage.getItem(LOCAL_EXCHANGE_WORKSPACES_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.includes(sourceWorkspaceId)) {
        const next: unknown[] = []
        for (const id of parsed) {
          const mapped = id === sourceWorkspaceId ? destinationWorkspaceId : id
          if (!next.includes(mapped)) next.push(mapped)
        }
        storage.setItem(LOCAL_EXCHANGE_WORKSPACES_KEY, JSON.stringify(next))
        result.rewritten.push(LOCAL_EXCHANGE_WORKSPACES_KEY)
      }
    }
  } catch {
    // an unreadable allow-list is left alone
  }

  // The chat's last-workspace pointer holds the id as its value.
  try {
    if (storage.getItem(LAST_CHAT_WORKSPACE_KEY) === sourceWorkspaceId) {
      storage.setItem(LAST_CHAT_WORKSPACE_KEY, destinationWorkspaceId)
      result.rewritten.push(LAST_CHAT_WORKSPACE_KEY)
    }
  } catch {
    // left alone
  }

  // Everything keyed by the source id goes (collected first: removing while iterating shifts indexes).
  const doomed: string[] = []
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i)
    if (key && key.includes(sourceWorkspaceId)) doomed.push(key)
  }
  for (const key of doomed) {
    try {
      storage.removeItem(key)
      result.removed.push(key)
    } catch {
      // a key that will not go is not worth failing the merge over
    }
  }
  return result
}

/**
 * Land this browser in the destination: sweep the source's local state, point
 * the fetch interceptor at the destination, and hard-navigate so every list
 * and cache reloads under the new workspace (the cookie was set by the merge
 * route, before this runs).
 */
export function finishWorkspaceMerge(sourceWorkspaceId: string, destinationWorkspaceId: string, href = '/account'): SweepResult {
  let swept: SweepResult = { removed: [], rewritten: [] }
  try {
    swept = sweepWorkspaceLocalState(window.localStorage, sourceWorkspaceId, destinationWorkspaceId)
  } catch {
    // storage blocked (private window): the navigation still lands in the destination
  }
  setClientWorkspaceId(destinationWorkspaceId)
  window.location.assign(href)
  return swept
}
