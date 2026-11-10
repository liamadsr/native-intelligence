/**
 * The window event that opens the workspaces veil (see
 * `(dashboard)/workspaces-veil.tsx`). Events rather than a context: the
 * workspace menu that asks for the veil also renders outside the dashboard's
 * providers, and the veil imports the workspace switcher, so the switcher
 * can't import the veil back.
 */
export const OPEN_WORKSPACES_EVENT = 'ni:open-workspaces'

/** Send the app into the background and show every workspace. */
export function openWorkspacesVeil(): void {
  window.dispatchEvent(new CustomEvent(OPEN_WORKSPACES_EVENT))
}
