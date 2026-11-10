/**
 * Where the web HUD sits (./web-hud.tsx): remembered per device (this
 * browser's storage, read and written in try/catch: private windows and
 * blocked storage just start from the default), and always kept on screen.
 */

export const HUD_POSITION_KEY = 'ni-live-hud:position'
/** The HUD's size, the desktop window's (commands/hud.rs). */
export const HUD_WIDTH = 472
export const HUD_HEIGHT = 536
/** Kept at least this far from the viewport's edges (px). */
export const HUD_GUTTER = 16

export interface HudPoint {
  x: number
  y: number
}
export interface HudSize {
  width: number
  height: number
}

/** The HUD's size in a viewport: its own, shrunk to fit inside the gutters. */
export function hudSizeIn(viewport: HudSize): HudSize {
  return {
    width: Math.max(0, Math.min(HUD_WIDTH, viewport.width - HUD_GUTTER * 2)),
    height: Math.max(0, Math.min(HUD_HEIGHT, viewport.height - HUD_GUTTER * 2)),
  }
}

/** `pos` moved just enough to keep a `size` panel inside the viewport's gutters. */
export function clampHudPosition(pos: HudPoint, size: HudSize, viewport: HudSize): HudPoint {
  const maxX = Math.max(HUD_GUTTER, viewport.width - size.width - HUD_GUTTER)
  const maxY = Math.max(HUD_GUTTER, viewport.height - size.height - HUD_GUTTER)
  return {
    x: Math.round(Math.min(maxX, Math.max(HUD_GUTTER, pos.x))),
    y: Math.round(Math.min(maxY, Math.max(HUD_GUTTER, pos.y))),
  }
}

/** Where it starts on a device with nothing remembered: the bottom-right corner. */
export function defaultHudPosition(size: HudSize, viewport: HudSize): HudPoint {
  return clampHudPosition({ x: viewport.width - size.width - HUD_GUTTER * 1.5, y: viewport.height - size.height - HUD_GUTTER * 1.5 }, size, viewport)
}

/** The remembered position, or null (none, unreadable, or not a point). */
export function readHudPosition(): HudPoint | null {
  try {
    const raw = localStorage.getItem(HUD_POSITION_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<HudPoint> | null
    return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? { x: v.x as number, y: v.y as number } : null
  } catch {
    return null
  }
}

/** Remember `pos` (best-effort). */
export function writeHudPosition(pos: HudPoint): void {
  try {
    localStorage.setItem(HUD_POSITION_KEY, JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) }))
  } catch {
    /* storage unavailable: it starts from the default next time */
  }
}
