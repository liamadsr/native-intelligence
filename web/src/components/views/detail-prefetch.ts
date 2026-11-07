// Bridges list/board rows to detail-panel caches so clicking into an item
// renders instantly (Linear-style):
//   - on hover: seed the detail cache from row data and start fetching the
//     full record, so it's usually already there by the time the user clicks
//   - on click: seed synchronously as a fallback for clicks without hover
//     (keyboard nav, touch), letting the panel paint from row data while its
//     background fetch reconciles
// Captures are deliberately NOT seeded: capture rows don't carry `content`,
// and a partially-seeded capture would render an empty notes editor for a
// capture that has notes.

import { seedActionCacheFromListItem, prefetchActionDetail } from '@/lib/action-cache'
import { getClientWorkspaceId } from '@/lib/workspace-fetch'
import { isForeignWorkspace, rowWorkspace } from './row-workspace'
import type { ViewEntityType } from '@/lib/views/types'

export function seedDetailFromListItem(
  entityType: ViewEntityType,
  item: Record<string, unknown> | undefined,
) {
  if (!item) return
  if (entityType === 'action') seedActionCacheFromListItem(item)
}

export function prefetchDetailOnHover(
  entityType: ViewEntityType,
  item: Record<string, unknown>,
) {
  if (entityType !== 'action') return
  // The seed is right for EVERY row: it is the row's own data, the cache is
  // module-level, and a cross-workspace click switches workspaces and opens the
  // panel on the other side — where this seed is what it paints from.
  seedActionCacheFromListItem(item)
  if (typeof item.id !== 'string') return
  // The FETCH is not. `prefetchActionDetail` GETs /api/account/actions/:id with
  // no workspace of its own, so for a row from another workspace it is a
  // guaranteed 404 — one per hovered row, for nothing. Sweeping the cursor down
  // a cross-workspace list would fire a request per row and cache nothing.
  // Reading the interceptor's OWN active-workspace value (rather than React
  // context) is deliberate: the question here is literally "where would an
  // un-headered request land?", and this is the value that decides it.
  if (isForeignWorkspace(rowWorkspace(item), getClientWorkspaceId())) return
  void prefetchActionDetail(item.id)
}

/** How long the pointer must rest on a row before its hover prefetch fires.
 *  A sweep down a list crosses each row faster than this, so only the rows the
 *  cursor actually stops on warm the cache. */
export const HOVER_PREFETCH_DELAY_MS = 100

// The one pending hover prefetch. One is enough: the pointer rests on one row
// at a time, and entering the next row means it has left the last.
let pendingHover: { timer: ReturnType<typeof setTimeout>; item: Record<string, unknown> } | null = null

/**
 * Row mouseenter: `prefetchDetailOnHover` for this row once the pointer has
 * rested on it for HOVER_PREFETCH_DELAY_MS. Pair with `cancelHoverPrefetch` on
 * mouseleave. The prefetch itself is unchanged, and still deduped per id
 * inside action-cache.
 */
export function prefetchDetailOnHoverIntent(
  entityType: ViewEntityType,
  item: Record<string, unknown>,
) {
  if (pendingHover) clearTimeout(pendingHover.timer)
  const timer = setTimeout(() => {
    pendingHover = null
    prefetchDetailOnHover(entityType, item)
  }, HOVER_PREFETCH_DELAY_MS)
  pendingHover = { timer, item }
}

/** Row mouseleave: drop this row's pending hover prefetch, if it has one. */
export function cancelHoverPrefetch(item: Record<string, unknown>) {
  if (!pendingHover) return
  // By identity, or by id when the list re-rendered the row with a fresh
  // object while the pointer sat on it.
  const same =
    pendingHover.item === item ||
    (typeof item.id === 'string' && pendingHover.item.id === item.id)
  if (!same) return
  clearTimeout(pendingHover.timer)
  pendingHover = null
}
