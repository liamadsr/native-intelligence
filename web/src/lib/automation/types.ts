/**
 * The automation API's shape (README.md): `window.__niAutomation`, present
 * only in the desktop app launched with the automation bridge.
 */

export interface NiAutomationInfo {
  /** The deployed web commit this bundle was built from, or null (local dev). */
  buildId: string | null
  /** The current path. */
  route: string
  /** The active workspace, or null before it has loaded. */
  workspaceId: string | null
}

export interface NiAutomation {
  version: 1
  info(): NiAutomationInfo
  /** Resolves once it is safe to start driving; rejects with the reason after `timeoutMs` (default 30000). */
  ready(opts?: { timeoutMs?: number }): Promise<void>
  /** Back to a clean, known UI: one blank chat, no card anywhere. */
  resetUi(): Promise<void>
}
