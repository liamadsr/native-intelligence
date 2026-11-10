'use client'

import { useSyncExternalStore } from 'react'
import { lazyComponent } from '@/lib/lazy-component'
import { automationFlagged } from './flag'

const AutomationBridge = lazyComponent(() => import('./automation-bridge').then((m) => m.AutomationBridge))

const subscribe = () => () => {}

/**
 * Mounted once by the dashboard shell: registers `window.__niAutomation`
 * (README.md) when the desktop app was launched with the automation bridge.
 * Everywhere else it renders nothing and never fetches the API's code. The
 * flag is set before the page's scripts and never changes, so it is read
 * once; the server's render (and hydration) says no.
 */
export function AutomationMount() {
  const flagged = useSyncExternalStore(subscribe, automationFlagged, () => false)
  return flagged ? <AutomationBridge /> : null
}
