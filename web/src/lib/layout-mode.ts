/**
 * The app's layout (docs/plans/traditional-layout.md): today's shell, the
 * default, or Traditional: a persistent sidebar with the pages and their
 * sub-navs, a top bar with search, and pages that fill the main area as
 * flat, bordered panes. Both shells are over the same pages and components:
 * the choice changes how the shell is drawn, never data or routes.
 *
 * Kept on the ACCOUNT like the rail's bar (lib/rail-prefs.ts,
 * lib/account-setting.ts): `user_metadata.layout`, with a copy on this device
 * (LAYOUT_STORAGE_KEY, JSON like every account setting's copy) that the
 * pre-paint script reads (components/theme-script.tsx), so the first paint is
 * already in the person's layout. On <html> as LAYOUT_ATTR while Traditional
 * is on (absent: the default), which is what the CSS keys on.
 *
 * Pure: the server (api/account/profile) and the device share it.
 */

export type LayoutMode = 'default' | 'traditional'

export const LAYOUT_MODES: readonly LayoutMode[] = ['default', 'traditional']

/** Its key in `user_metadata` and in the profile GET/PATCH (api/account/profile). */
export const LAYOUT_PROFILE_FIELD = 'layout'

/** Where this device keeps its copy (wiped at sign-out: main-chat/state-wipe.ts). */
export const LAYOUT_STORAGE_KEY = 'ni:layout'

/** On <html>: `traditional` while Traditional is on; absent for the default. */
export const LAYOUT_ATTR = 'data-layout'

/** A stored, served or sent value, checked: a layout, or null. */
export function parseLayoutMode(raw: unknown): LayoutMode | null {
  return raw === 'default' || raw === 'traditional' ? raw : null
}

/** Put the layout on <html> (the CSS keys on it). */
export function applyLayoutAttr(mode: LayoutMode, root: HTMLElement = document.documentElement): void {
  if (mode === 'traditional') root.setAttribute(LAYOUT_ATTR, 'traditional')
  else root.removeAttribute(LAYOUT_ATTR)
}
