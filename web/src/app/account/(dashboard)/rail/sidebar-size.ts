/**
 * Traditional's sidebar width and fold (./traditional-sidebar.tsx), kept on
 * this device: a window's own convenience, like the page panel's open or
 * closed, not the account's. On <html> as SIDEBAR_W_VAR (px) and
 * SIDEBAR_COLLAPSED_ATTR, which the CSS reads for `--app-rail-w` in
 * Traditional (tailwind.css); the pre-paint script applies the saved ones
 * (components/theme-script.tsx), so the first paint has them.
 */

export const SIDEBAR_STORAGE_KEY = 'ni:sidebar'
export const SIDEBAR_W_VAR = '--ni-sidebar-w'
export const SIDEBAR_COLLAPSED_ATTR = 'data-sidebar-collapsed'

export const SIDEBAR_DEFAULT_W = 240
export const SIDEBAR_MIN_W = 200
export const SIDEBAR_MAX_W = 400

export interface SidebarSize {
  w: number | null
  collapsed: boolean
}

export function clampSidebarWidth(px: number): number {
  return Math.round(Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, px)))
}

export function parseSidebarSize(raw: unknown): SidebarSize {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const w = typeof o.w === 'number' && Number.isFinite(o.w) ? clampSidebarWidth(o.w) : null
  return { w, collapsed: o.collapsed === true }
}

function read(): SidebarSize {
  try {
    return parseSidebarSize(JSON.parse(window.localStorage.getItem(SIDEBAR_STORAGE_KEY) || 'null'))
  } catch {
    return { w: null, collapsed: false }
  }
}

function write(size: SidebarSize): void {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify(size))
  } catch {
    // Storage refused: it holds for this page load.
  }
}

/** The sidebar's width now, px (its saved one, else the default). */
export function sidebarWidthNow(): number {
  return read().w ?? SIDEBAR_DEFAULT_W
}

/** Set the width (null: back to the default); `save` keeps it (the end of a drag), otherwise it only shows. */
export function setSidebarWidth(px: number | null, save: boolean): void {
  const html = document.documentElement
  const w = px === null ? null : clampSidebarWidth(px)
  if (w === null) html.style.removeProperty(SIDEBAR_W_VAR)
  else html.style.setProperty(SIDEBAR_W_VAR, `${w}px`)
  if (save) write({ ...read(), w })
}

/** Fold the sidebar away (true) or bring it back. */
export function setSidebarCollapsed(collapsed: boolean): void {
  const html = document.documentElement
  if (collapsed) html.setAttribute(SIDEBAR_COLLAPSED_ATTR, '')
  else html.removeAttribute(SIDEBAR_COLLAPSED_ATTR)
  write({ ...read(), collapsed })
}
