'use client'

/**
 * The home page's recents, read (recents-model.ts says what they are): the
 * palette's two feed lists (chat/use-palette-feed.ts, the same reader),
 * longer, merged into one.
 *
 * Flat cost: read when the panel comes on screen (`active` turning on), on
 * window focus while it shows, and when a card in front of it closes or
 * another takes its place (Liam, 11-11: the panel persists when you open
 * something), so what the person just touched moves up; no timer. Two small
 * reads at a time, never two at once (one asked meanwhile runs right after).
 * In the window's workspace: another workspace's list never shows.
 * Fail-soft: a failed read keeps the last list (or nothing, before the
 * first).
 *
 * What the person opened here is remembered per device (SEEN_KEY), so a dot
 * stays gone across reloads and comes back only with something new.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FeedEntry } from '@/lib/entities/feed-model'
import { FEED_MAX_LIMIT } from '@/lib/entities/feed-model'
import { getClientWorkspaceId } from '@/lib/workspace-fetch'
import { paletteInboxUrl, paletteRecentUrl, readFeedEntries } from '../chat/use-palette-feed'
import { RECENTS_PAGE, markSeen, mergeRecents, parseSeen, type RecentItem, type SeenMap } from './recents-model'

/** Remembered per device: what the person opened from the panel, `{"type:id": iso}`. */
export const SEEN_KEY = 'ni:page-panel:seen'

/** How many of the inbox one read asks for. */
export const RECENTS_INBOX_LIMIT = RECENTS_PAGE
/** How many of the person's own records one read asks for (the feed's most). */
export const RECENTS_MINE_LIMIT = FEED_MAX_LIMIT

interface Lists {
  workspaceId: string | null
  inbox: FeedEntry[] | null
  recent: FeedEntry[] | null
  /** When the lists were last answered: the clock the rows' times and groups read against. */
  readAt: Date | null
}

function readSeen(): SeenMap {
  try {
    return typeof window === 'undefined' ? {} : parseSeen(window.localStorage.getItem(SEEN_KEY))
  } catch {
    return {}
  }
}

function writeSeen(seen: SeenMap): void {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
  } catch {
    // Storage blocked or full: it holds in memory for this session.
  }
}

export interface Recents {
  /** Newest first, each record once (empty before the first answer, or with nothing). */
  items: RecentItem[]
  /** When they were read (null before the first answer): the clock their times read against. */
  readAt: Date | null
  /** The person opened `item`: its dot goes, remembered. */
  markOpened: (item: RecentItem) => void
}

/** `frontId`: the card full screen beside the panel, or null; its closing reads again. */
export function useRecents(active: boolean, frontId: string | null = null): Recents {
  // The window's workspace, as its requests name it (lib/workspace-fetch.ts).
  const workspaceId = getClientWorkspaceId()
  const [lists, setLists] = useState<Lists>({ workspaceId, inbox: null, recent: null, readAt: null })
  const [seen, setSeen] = useState<SeenMap | null>(null)
  const inFlight = useRef(false)
  // A read asked for while one runs: it runs once that one is answered.
  const again = useRef(false)

  const read = useCallback(async (): Promise<void> => {
    if (inFlight.current) {
      again.current = true
      return
    }
    inFlight.current = true
    const forWorkspace = getClientWorkspaceId()
    try {
      const [inbox, recent] = await Promise.all([
        readFeedEntries(paletteInboxUrl(new Date(), RECENTS_INBOX_LIMIT)),
        readFeedEntries(paletteRecentUrl(RECENTS_MINE_LIMIT)),
      ])
      // The window moved to another workspace meanwhile: this answer is not its.
      if (getClientWorkspaceId() !== forWorkspace) return
      const readAt = new Date()
      setLists((was) => {
        const same = was.workspaceId === forWorkspace
        // A failed read keeps what was there (this workspace's).
        if (same && !inbox && !recent) return was
        return { workspaceId: forWorkspace, inbox: inbox ?? (same ? was.inbox : null), recent: recent ?? (same ? was.recent : null), readAt }
      })
    } finally {
      inFlight.current = false
      if (again.current) {
        again.current = false
        void read()
      }
    }
  }, [])

  useEffect(() => {
    if (!active) return
    // What was opened here, read once the panel first shows.
    setSeen((was) => was ?? readSeen())
    void read()
    const onFocus = () => void read()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [active, workspaceId, read])

  // The card in front closing (put back, or another opened in its place):
  // read again, so what it touched moves up. Not when one opens over none.
  const lastFront = useRef(frontId)
  useEffect(() => {
    const was = lastFront.current
    lastFront.current = frontId
    if (active && was !== null && was !== frontId) void read()
  }, [active, frontId, read])

  const ofWorkspace = lists.workspaceId === workspaceId
  const inbox = ofWorkspace ? lists.inbox : null
  const recent = ofWorkspace ? lists.recent : null
  const items = useMemo(() => mergeRecents({ inbox, recent, seen: seen ?? {} }), [inbox, recent, seen])

  const markOpened = useCallback((item: RecentItem) => {
    if (!item.inboxAt) return
    const inboxAt = item.inboxAt
    setSeen((was) => {
      const next = markSeen(was ?? readSeen(), item.key, inboxAt)
      if (next !== was) writeSeen(next)
      return next
    })
  }, [])

  return { items, readAt: ofWorkspace ? lists.readAt : null, markOpened }
}
