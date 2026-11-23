'use client'

/**
 * Recent's filter (Status and Type; recents-model.ts filterRecents),
 * remembered per device as the panel's open state is (localStorage), so it
 * holds across reloads. Blocked storage: it holds for this session only.
 */
import { useCallback, useState } from 'react'
import { RECENT_TYPES } from '@/lib/entities/recents-model'
import { DEFAULT_RECENT_FILTER, parseRecentFilter, type RecentFilter } from './recents-model'

/** Remembered per device: `{"status": "all"|"unread"|"read", "types": [...]}`. */
export const RECENTS_FILTER_KEY = 'ni:page-panel:recents-filter'

const KNOWN = RECENT_TYPES.map((t) => t.key)

function readFilter(): RecentFilter {
  try {
    return typeof window === 'undefined' ? DEFAULT_RECENT_FILTER : parseRecentFilter(window.localStorage.getItem(RECENTS_FILTER_KEY), KNOWN)
  } catch {
    return DEFAULT_RECENT_FILTER
  }
}

function writeFilter(filter: RecentFilter): void {
  try {
    window.localStorage.setItem(RECENTS_FILTER_KEY, JSON.stringify({ status: filter.status, types: filter.types }))
  } catch {
    // Storage blocked or full: it holds in memory.
  }
}

export function useRecentsFilter(): [RecentFilter, (next: RecentFilter) => void] {
  const [filter, setFilter] = useState<RecentFilter>(readFilter)
  const set = useCallback((next: RecentFilter) => {
    setFilter(next)
    writeFilter(next)
  }, [])
  return [filter, set]
}
