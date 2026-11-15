/**
 * The shared slots of the runtime backend (host.ts ensureCloudBrowser; the
 * owner's request of 2026-11-14): at most CLOUD_BROWSER_MAX_RUNNING browsers
 * (config.ts, default 4) hold memory on our sandbox server at once, across
 * everyone. A person whose browser needs a slot while all are taken gets the
 * one of the browser idle longest: that browser is PAUSED (the idle sweep's
 * graceful stop, with stop reason `evicted`), never removed, so its owner loses
 * nothing and their next use wakes it. When no browser is idle enough to give
 * way, the ensure fails with CloudBrowserBusyError, which callers show as is.
 * The hosted backend has no cap.
 *
 * No `server-only` and no store here: the error and its checks are read by the
 * routes, the browser tool and runtime-browser.ts (which the conformance script
 * runs outside Next).
 */

/** What a person is told when every slot is held by a browser in use. Retryable. */
export const CLOUD_BROWSER_BUSY_MESSAGE = 'All browsers are in use right now. Try again in a minute.'
/** The error code the routes answer with (and the browser tool recognises). */
export const CLOUD_BROWSER_BUSY_CODE = 'BROWSERS_BUSY'

/** Every slot is held by a browser in use (or the runtime had no memory left and none could give way). */
export class CloudBrowserBusyError extends Error {
  readonly code = CLOUD_BROWSER_BUSY_CODE
  constructor() {
    super(CLOUD_BROWSER_BUSY_MESSAGE)
    this.name = 'CloudBrowserBusyError'
  }
}

export function isCloudBrowserBusy(error: unknown): error is CloudBrowserBusyError {
  return error instanceof CloudBrowserBusyError ||
    (!!error && typeof error === 'object' && (error as { code?: unknown }).code === CLOUD_BROWSER_BUSY_CODE)
}

/**
 * The runtime refused to place a sandbox (a create, or a wake) for lack of
 * memory: its pool is shared with the coding agent's sandboxes, so this can
 * happen below the cap. Seen live on 2026-11-14: `500: Failed to place sandbox:
 * this node cannot map 4096 MiB of guest memory: its memory pool is too small
 * or in use by running sandboxes`. Never a sign that a sandbox is dead.
 */
export class CloudBrowserNoRoomError extends Error {
  readonly code = 'RUNTIME_NO_ROOM'
  constructor(message: string) {
    super(message)
    this.name = 'CloudBrowserNoRoomError'
  }
}

export function isCloudBrowserNoRoom(error: unknown): error is CloudBrowserNoRoomError {
  return error instanceof CloudBrowserNoRoomError
}

/** The runtime's words for "no memory to place it" (orchestrator placement), as the client passes them on. */
const NO_ROOM = /failed to place sandbox|cannot map \d+ ?mib of guest memory|memory pool is too small/i

/** Whether a runtime error (a create's or a connect's) is that refusal. */
export function isRuntimeNoRoomMessage(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return NO_ROOM.test(message)
}

/**
 * How long a browser must have been unused before it may give its slot away.
 * Its activity (`last_active_at`) is touched by an ensure, by each command the
 * relay claims and settles, by a take-over, and by a visible live view, which
 * pings every 60 s while its window is on screen (components/cloud-browser
 * live-view.tsx PING_MS). Two minutes is two of those pings: a watched browser
 * is never evicted between pings, even with one lost, and an agent between two
 * steps of its work (a model turn) keeps its browser. A command in flight (a
 * task between its claim and its settle can outlast this) is checked on its own
 * (store.browsersWithLiveCommands), so the floor need not cover a long task.
 */
export const EVICTION_IDLE_FLOOR_MS = 2 * 60_000

/** How many browsers one ensure tries to make give way before it says "all in use". */
export const MAX_EVICTION_TRIES = 3

/** One browser that holds a slot, as the store reads it (store.listSlotHolders). */
export interface SlotHolderRow {
  user_id: string
  workspace_id: string
  status: string
  last_active_at: string
}

/**
 * Who may give way, in order: running browsers other than `self`, unused for at
 * least the floor, idle longest first. Never one starting (an ensure is on it,
 * or the sweep will reach it) or stopping (already on its way out).
 */
export function evictionCandidates<T extends SlotHolderRow>(holders: T[], self: { userId: string; workspaceId: string }, now: number, floorMs = EVICTION_IDLE_FLOOR_MS): T[] {
  const cutoff = now - floorMs
  return holders
    .filter(h => h.status === 'running' && !(h.user_id === self.userId && h.workspace_id === self.workspaceId))
    .filter(h => {
      const at = Date.parse(h.last_active_at)
      return Number.isFinite(at) && at <= cutoff
    })
    .sort((a, b) => Date.parse(a.last_active_at) - Date.parse(b.last_active_at))
}
