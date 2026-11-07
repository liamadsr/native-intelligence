'use client'

import { useEffect } from 'react'
import { isDesktopApp } from '@/lib/platform'
import { getThisWebviewLabel, tauriBridge } from '@/lib/tauri-bridge'

/**
 * Closes the bots' desktop overlay once, as the desktop shell's main window
 * starts. The web app no longer drives it, but a native build from before
 * may have left its window open (always on top, over the desktop) with
 * nothing to send it home.
 *
 * REMOVE once the native overlay removal (desktop repo, persona removal part
 * 2) has shipped: from then on no shell has the window.
 */
export function CloseStaleBotsOverlay() {
  useEffect(() => {
    if (!isDesktopApp() || window.location.pathname.startsWith('/hud/')) return
    let live = true
    void getThisWebviewLabel()
      .then((label) => {
        // A shell without the command rejects: nothing to close there.
        if (live && label === 'main') return tauriBridge.hideDesktopBots()
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  return null
}
