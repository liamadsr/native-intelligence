/**
 * The desktop automation bridge's flag (desktop/src-tauri/src/automation):
 * `window.__NI_AUTOMATION__`, set at document start only when the app was
 * launched for a recorder. This check is all the normal bundle carries of the
 * automation API; the API itself loads on demand (automation-mount.tsx).
 */
import { isDesktopApp } from '@/lib/platform'
import type { NiAutomation } from './types'

export const AUTOMATION_VERSION = 1

declare global {
  interface Window {
    __NI_AUTOMATION__?: { version?: unknown }
    __niAutomation?: NiAutomation
    // TODO(rename-compat): the two names from before the rename. A desktop build made
    // then sets the first, and a recorder written then calls the second
    // (automation-bridge.tsx). Drop both once neither is in use.
    __DIAL8_AUTOMATION__?: { version?: unknown }
    __dial8Automation?: NiAutomation
  }
}

/** The desktop app, launched with the bridge (protocol version 1). */
export function automationFlagged(): boolean {
  if (typeof window === 'undefined' || !isDesktopApp()) return false
  try {
    return (window.__NI_AUTOMATION__ ?? window.__DIAL8_AUTOMATION__)?.version === AUTOMATION_VERSION
  } catch {
    return false
  }
}
