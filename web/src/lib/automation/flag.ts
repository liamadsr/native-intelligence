/**
 * The desktop automation bridge's flag (dial8-desktop src-tauri/src/automation):
 * `window.__DIAL8_AUTOMATION__`, set at document start only when the app was
 * launched for a recorder. This check is all the normal bundle carries of the
 * automation API; the API itself loads on demand (automation-mount.tsx).
 */
import { isDesktopApp } from '@/lib/platform'
import type { Dial8Automation } from './types'

export const AUTOMATION_VERSION = 1

declare global {
  interface Window {
    __DIAL8_AUTOMATION__?: { version?: unknown }
    __dial8Automation?: Dial8Automation
  }
}

/** The desktop app, launched with the bridge (protocol version 1). */
export function automationFlagged(): boolean {
  if (typeof window === 'undefined' || !isDesktopApp()) return false
  try {
    return window.__DIAL8_AUTOMATION__?.version === AUTOMATION_VERSION
  } catch {
    return false
  }
}
