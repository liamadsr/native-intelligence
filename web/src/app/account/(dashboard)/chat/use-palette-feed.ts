'use client'

/**
 * The palette's first view from the activity feed (GET /api/account/feed):
 *   Inbox   what @-mentions the person, was assigned to them or was shared
 *           with them ("Ana shared this with you", migration 513), the last
 *           two weeks (assigned_to=me&mentioned=me&shared=me);
 *   Recent  the records they touched last (actor=me).
 * Asked for each time the palette opens (two small reads), in the window's
 * workspace; the last answer shows at once while the new one comes, and
 * never another workspace's. Fail-soft: a failed read is an empty section,
 * which the palette doesn't draw.
 *
 * The page panel's recents (page-panel/use-recents.ts; Liam, 11-11) read the
 * same two lists, longer, through the same reader (readFeedEntries), which
 * tells a failed read (null: the panel keeps its last list) from an empty one.
 */
import { useEffect, useState } from 'react'
import { feedUrl, type FeedEntry } from '@/lib/entities/feed-model'
import { getClientWorkspaceId } from '@/lib/workspace-fetch'
import { INBOX_CAP, RECENT_CAP } from './command-menu-model'

/** How far back the palette's Inbox reaches. */
export const PALETTE_INBOX_DAYS = 14

export interface PaletteFeed {
  inbox: FeedEntry[] | null
  recent: FeedEntry[] | null
}

const EMPTY: PaletteFeed = { inbox: null, recent: null }

/** The Inbox: assigned to, mentioning or shared with the person, the last PALETTE_INBOX_DAYS; `limit` entries at most. */
export function paletteInboxUrl(now: Date, limit: number = INBOX_CAP): string {
  const since = new Date(now.getTime() - PALETTE_INBOX_DAYS * 86_400_000).toISOString()
  return feedUrl({ assignedToMe: true, mentionedMe: true, sharedWithMe: true, since, limit })
}

/** One more than the section shows: a record also in the Inbox is left out of Recent. */
export const paletteRecentUrl = (limit: number = RECENT_CAP + INBOX_CAP) => feedUrl({ actor: 'me', limit })

/** One feed read: its entries, or null when it failed (an error, a bad answer). */
export async function readFeedEntries(url: string): Promise<FeedEntry[] | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return null
    const data = (await res.json()) as { entries?: FeedEntry[] }
    return Array.isArray(data.entries) ? data.entries : null
  } catch {
    return null
  }
}

const read = async (url: string): Promise<FeedEntry[]> => (await readFeedEntries(url)) ?? []

/** The Inbox and Recent while the palette is open (null until the first answer). */
export function usePaletteFeed(open: boolean): PaletteFeed {
  // The window's workspace, as its requests name it (lib/workspace-fetch.ts).
  const workspaceId = getClientWorkspaceId()
  const [state, setState] = useState<{ workspaceId: string | null; feed: PaletteFeed }>({ workspaceId, feed: EMPTY })
  useEffect(() => {
    if (!open) return
    let live = true
    const forWorkspace = getClientWorkspaceId()
    void Promise.all([read(paletteInboxUrl(new Date())), read(paletteRecentUrl())]).then(([inbox, recent]) => {
      if (live) setState({ workspaceId: forWorkspace, feed: { inbox, recent } })
    })
    return () => {
      live = false
    }
  }, [open, workspaceId])
  return state.workspaceId === workspaceId ? state.feed : EMPTY
}
