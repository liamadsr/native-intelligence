'use client'

import { useSyncExternalStore } from 'react'
import { isTimeZone } from '@/lib/time-offers/display'

const subscribe = () => () => {}

function browserZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return isTimeZone(zone) ? zone : null
  } catch {
    return null
  }
}

/**
 * The guest's own zone, read in the browser. The server renders (and the
 * client hydrates) in `serverZone`, the host's, so the first paint matches;
 * the browser's zone takes over right after.
 */
export function useGuestTimeZone(serverZone: string): string {
  return useSyncExternalStore(subscribe, () => browserZone() ?? serverZone, () => serverZone)
}
