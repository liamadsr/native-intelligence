'use client'

/**
 * The palette's first view from the activity feed (GET /api/account/feed):
 *   Inbox   what @-mentions the person or was assigned to them, the last two
 *           weeks (assigned_to=me&mentioned=me);
 *   Recent  the records they touched last (actor=me).
 * Asked for each time the palette opens (two small reads), in the window's
 * workspace; the last answer shows at once while the new one comes, and
 * never another workspace's. Fail-soft: a failed read is an empty section,
 * which the palette doesn't draw.
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

export function paletteInboxUrl(now: Date): string {
  const since = new Date(now.getTime() - PALETTE_INBOX_DAYS * 86_400_000).toISOString()
  return feedUrl({ assignedToMe: true, mentionedMe: true, since, limit: INBOX_CAP })
}

/** One more than the section shows: a record also in the Inbox is left out of Recent. */
export const paletteRecentUrl = () => feedUrl({ actor: 'me', limit: RECENT_CAP + INBOX_CAP })

async function read(url: string): Promise<FeedEntry[]> {
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return []
    const data = (await res.json()) as { entries?: FeedEntry[] }
    return Array.isArray(data.entries) ? data.entries : []
  } catch {
    return []
  }
}

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
