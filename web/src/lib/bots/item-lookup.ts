/**
 * What a click on a work item needs to know to decide where it opens
 * (bots-v4.md "An item opens on its bot's page", Phase 2) when nothing on
 * screen says: its teammate, its workspace and its title. The shared source
 * holds open rows only, so a settled item named by a teammate's report in
 * chat, or by a plain notice, is asked for: GET /api/account/activity/[id]
 * ?light=1, the item route's owner-only read, with none of the panel's joins.
 * The panel's own read follows once the item opens.
 */
import { isWorkItemId } from '@/lib/work/item-id'

/** Who an item is: its id, its own workspace, its teammate (null: none), and its title. */
export interface ItemFacts {
  workItemId: string
  workspaceId: string
  teammateId: string | null
  title: string | null
}

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128

/**
 * Reads work item `itemId`'s facts. Null when it isn't one (a malformed id), it
 * isn't the user's (404: the read is owner-only), or the read failed: the
 * caller opens it the way it would without them.
 */
export async function lookupWorkItem(itemId: string): Promise<ItemFacts | null> {
  if (!isWorkItemId(itemId) || typeof fetch !== 'function') return null
  try {
    const res = await fetch(`/api/account/activity/${encodeURIComponent(itemId)}?light=1`, { cache: 'no-store' })
    if (!res.ok) return null
    const body = (await res.json().catch(() => null)) as { item?: Record<string, unknown> | null } | null
    const item = body?.item
    if (!item || item.id !== itemId || !isId(item.workspace_id)) return null
    return {
      workItemId: itemId,
      workspaceId: item.workspace_id,
      teammateId: isId(item.ai_team_member_id) ? item.ai_team_member_id : null,
      title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : null,
    }
  } catch {
    return null
  }
}
