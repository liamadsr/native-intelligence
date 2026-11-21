'use client'

import { useEffect } from 'react'

declare global {
  interface Window {
    /** Set by the boot watchdog (boot-watchdog-script.tsx): the page has started. */
    __niBoot?: () => void
    __niBooted?: boolean
  }
}

/** Tell the boot watchdog (boot-watchdog-script.tsx) this page started, so it does not reload it. */
export function markBooted(): void {
  if (window.__niBoot) window.__niBoot()
  else window.__niBooted = true
}

/**
 * Whether an error is a script chunk that failed to load: Turbopack's
 * "Failed to load chunk …", webpack's ChunkLoadError, and the browsers' own
 * words for a module import that failed. That is the boot watchdog's case (a
 * reload fixes it), not a crash in the app's own code.
 */
export function isChunkLoadFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const { name, message } = error as { name?: unknown; message?: unknown }
  const text = `${typeof name === 'string' ? name : ''} ${typeof message === 'string' ? message : ''}`
  return /ChunkLoadError|Failed to load chunk|Loading (CSS )?chunk .* failed|dynamically imported module|Importing a module script failed/i.test(
    text,
  )
}

/**
 * Tells the boot watchdog that React has committed on this page. Renders
 * nothing; once per page load (client navigations keep the same document).
 */
export function BootMark() {
  useEffect(() => {
    markBooted()
  }, [])
  return null
}
