'use client'

import { useSyncExternalStore } from 'react'

const noop = () => () => {}

/** A time in the reader's own zone ("Tue, Nov 12, 2:45 PM"); the server's render says it in UTC until the page hydrates. */
export function LocalTime({ iso }: { iso: string }) {
  const local = useSyncExternalStore(
    noop,
    () => format(iso, undefined),
    () => format(iso, 'UTC'),
  )
  return <time dateTime={iso}>{local}</time>
}

function format(iso: string, timeZone: string | undefined): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return at.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone, timeZoneName: 'short' } : {}) })
}
