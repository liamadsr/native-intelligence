'use client'

import { useSyncExternalStore } from 'react'
import { mediaMatches, subscribeMedia } from '@/lib/media-query'

/** A live `matchMedia` query: false on the server and until mounted. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => subscribeMedia(query, onChange),
    () => mediaMatches(query),
    // The server can't know the window.
    () => false,
  )
}
