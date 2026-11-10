/**
 * "Where can this workspace push actions?" — invalidation for the ONE answer
 * that Settings changes and the "Push to…" menu reads.
 *
 * The two live in the same tab and never in the same tree: the menu sits on a
 * capture's action rows while Settings is a separate page — or, in the flow that
 * produced the bug report, an OVERLAY floating above that very capture. So
 * connecting a tracker and picking a project changed the server's answer while
 * the menu went on serving a cached one for up to a minute, telling the user to
 * "configure in settings" from on top of the settings they had just configured.
 *
 * Nothing here is a subscription: the cache drop is what makes the next read
 * correct, and the event only tells an already-mounted menu not to wait for it.
 * A surface that misses the event is stale for one open at most, because the
 * menu also force-revalidates when it opens.
 *
 * Call this from EVERY success path that changes what
 * `GET /api/account/task-destinations` returns — connect, disconnect, and any
 * settings write that moves the destination.
 */

import { invalidateCached } from '@/lib/cached-fetch'

/** The route whose cached answer this module owns. */
export const TASK_DESTINATIONS_URL = '/api/account/task-destinations'

/** Event name for menus mounted right now. Window-scoped; same tab only. */
export const TASK_DESTINATIONS_CHANGED = 'ni:task-destinations-changed'

/**
 * Declare the workspace's push destinations changed: drop the cached answer,
 * then nudge anything already showing it.
 *
 * Order matters — a listener that refetches synchronously must not be able to
 * re-populate the cache from the entry we are about to delete.
 */
export function notifyTaskDestinationsChanged(): void {
  invalidateCached(TASK_DESTINATIONS_URL)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(TASK_DESTINATIONS_CHANGED))
  }
}
