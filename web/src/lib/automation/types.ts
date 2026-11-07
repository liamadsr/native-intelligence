/**
 * The automation API's shape (README.md): `window.__dial8Automation`, present
 * only in the desktop app launched with the automation bridge.
 */

export interface Dial8AutomationInfo {
  /** The deployed web commit this bundle was built from, or null (local dev). */
  buildId: string | null
  /** The current path. */
  route: string
  /** The active workspace, or null before it has loaded. */
  workspaceId: string | null
}

export interface Dial8Automation {
  version: 1
  info(): Dial8AutomationInfo
  /** Resolves once it is safe to start driving; rejects with the reason after `timeoutMs` (default 30000). */
  ready(opts?: { timeoutMs?: number }): Promise<void>
  /** Back to a clean, known UI: one blank chat, no card anywhere. */
  resetUi(): Promise<void>
}
