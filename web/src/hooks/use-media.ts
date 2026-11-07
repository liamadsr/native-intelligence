'use client'

import { useSyncExternalStore } from 'react'

/** A live `matchMedia` query: false on the server and until mounted. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== 'function') return () => {}
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    // The server can't know the window.
    () => false,
  )
}
