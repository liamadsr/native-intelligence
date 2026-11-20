/**
 * Open the keyboard shortcuts sheet (./shortcuts-sheet.tsx) from anywhere:
 * `?` (./global-shortcuts.tsx), and the workspace menu's "Keyboard shortcuts"
 * (workspace-switcher.tsx). The sheet, mounted once in the dashboard shell,
 * answers the event.
 *
 * Client-safe: no server imports.
 */

export const OPEN_SHORTCUTS_SHEET_EVENT = 'ni:open-shortcuts-sheet'

export function openShortcutsSheet(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(OPEN_SHORTCUTS_SHEET_EVENT))
}
