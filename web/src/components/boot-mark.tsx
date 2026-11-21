'use client'

import { useEffect } from 'react'

declare global {
  interface Window {
    /** Set by the boot watchdog (boot-watchdog-script.tsx): the page has started. */
    __niBoot?: () => void
    __niBooted?: boolean
  }
}

/**
 * Tells the boot watchdog (boot-watchdog-script.tsx) that React has committed
 * on this page, so it does not reload it. Renders nothing; once per page load
 * (client navigations keep the same document).
 */
export function BootMark() {
  useEffect(() => {
    if (window.__niBoot) window.__niBoot()
    else window.__niBooted = true
  }, [])
  return null
}
