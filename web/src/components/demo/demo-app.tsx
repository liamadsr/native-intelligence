'use client'

/**
 * The demo page's first step: make the page safe to run the app in, and only
 * then load the app (./demo-shell.tsx).
 *   - Its storage is replaced by one in memory (lib/demo/demo-storage.ts), so
 *     the app there shares nothing with the real app on this domain. If the
 *     browser will not allow that, the app is not loaded at all, and the
 *     picture under the frame stays.
 *   - The whole page is `inert`: it is a picture. The app draws its windows
 *     and menus on the page itself, outside any wrapper, so only the page as
 *     a whole can be made inert.
 * The app is imported after both, because some of its modules read storage
 * as they load.
 */
import { useEffect, useState, type ComponentType } from 'react'
import { installDemoStorage } from '@/lib/demo/demo-storage'
import type { DemoScreen } from './demo-screens'

export function DemoApp({ screen }: { screen: DemoScreen }) {
  const [Shell, setShell] = useState<ComponentType<{ screen: DemoScreen }> | null>(null)

  useEffect(() => {
    let live = true
    document.documentElement.inert = true
    if (!installDemoStorage()) return
    void import('./demo-shell')
      .then((m) => {
        if (live) setShell(() => m.DemoShell)
      })
      .catch(() => {
        // The app's code did not arrive: the picture under the frame stays.
      })
    return () => {
      live = false
    }
  }, [])

  return Shell ? <Shell screen={screen} /> : null
}
