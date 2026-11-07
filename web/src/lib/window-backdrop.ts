/**
 * Glass (Preferences → Background, desktop only): the desktop window itself
 * turns see-through, so the chat and every page float over whatever is behind
 * Dial8.
 *
 * Two halves, both needed:
 *   - Native (dial8-desktop `set_window_backdrop`, window_backdrop.rs): the
 *     NSWindow goes transparent and the window server blurs what's behind it
 *     by `blur` points.
 *   - Page: `<html data-glass-window>` (set here, only once the desktop said
 *     yes) makes html, body and the shell's surfaces transparent
 *     (tailwind.css), leaving a tint of the app's own background colour at
 *     `--window-tint`.
 *
 * The Opacity slider (glassLayers) sets how solid the glass is: the blur stays
 * full, and the tint rises from frosted glass at 0% to near solid at 100%.
 * (The blur is the window server's, not a faded NSVisualEffectView: macOS
 * drops that one's blur entirely once it's faded at all.)
 *
 * A desktop that predates the command refuses it; the attribute is then never
 * set, the page keeps its opaque surfaces, and `<html data-glass-window-unsupported>`
 * brings the Sky back in Glass's place (sky-gate.ts) and lets Preferences say
 * to update the app.
 *
 * Every dashboard window (main and workspace popouts) applies its own, from the
 * shell (components/window-backdrop-sync.tsx), and turns it back off when the
 * shell goes away, so pages outside the dashboard are never see-through. The
 * live agent's HUD window (app/hud/agent) runs the same sync: the desktop gives
 * it a frosted layer masked to its rounded sheet, and the sheet's fill becomes
 * the same tint (tailwind.css). Other windows' changes reach each one through
 * `storage` events (shared localStorage).
 */

import { isDesktopApp } from './platform'

export type NativeWindowBackdrop = 'off' | 'glass'

/** On <html> while the window is see-through. */
export const GLASS_WINDOW_ATTR = 'data-glass-window'
/** On <html> once the desktop refused (too old, or not macOS). */
export const GLASS_WINDOW_UNSUPPORTED_ATTR = 'data-glass-window-unsupported'
/** The tint's alpha (0–1) over the see-through window. */
export const WINDOW_TINT_VAR = '--window-tint'

export const GLASS_OPACITY_STORAGE_KEY = 'dial8-glass-opacity'
/** Window event fired (on this window) when the Opacity slider moves. */
export const GLASS_OPACITY_EVENT = 'dial8:glass-opacity'
/** Opacity slider, percent: 0 the most see-through glass, 100 near solid. */
export const DEFAULT_GLASS_OPACITY = 30
/** The blur behind the window, in points. */
export const FULL_GLASS_BLUR = 30
/** Tint at 100%: the app's background colour at this alpha. */
const MAX_TINT = 0.9
/** Tint at 0%, the lightest the glass goes: frosted, still readable. */
const MIN_TINT = 0.47

function clampOpacity(n: number): number {
  return Math.min(100, Math.max(0, Math.round(n)))
}

/** What an Opacity slider value means: the native blur (points) and the
 * page's tint (alpha), which only grows as the slider moves right. */
export function glassLayers(opacity: number): { blur: number; tint: number } {
  const o = clampOpacity(opacity) / 100
  return {
    blur: FULL_GLASS_BLUR,
    tint: Math.round((MIN_TINT + o * (MAX_TINT - MIN_TINT)) * 100) / 100,
  }
}

/** The stored Opacity (percent). */
export function getGlassOpacity(): number {
  if (typeof window === 'undefined') return DEFAULT_GLASS_OPACITY
  try {
    const raw = localStorage.getItem(GLASS_OPACITY_STORAGE_KEY)
    const n = raw === null ? NaN : Number(raw)
    return Number.isFinite(n) ? clampOpacity(n) : DEFAULT_GLASS_OPACITY
  } catch {
    return DEFAULT_GLASS_OPACITY
  }
}

/** Reflect an Opacity's tint onto `--window-tint`. */
export function applyGlassTint(opacity: number) {
  document.documentElement.style.setProperty(WINDOW_TINT_VAR, String(glassLayers(opacity).tint))
}

/** Save the Opacity, apply its tint, and tell this window's sync (the blur). */
export function setGlassOpacity(opacity: number) {
  const value = clampOpacity(opacity)
  try {
    if (value === DEFAULT_GLASS_OPACITY) localStorage.removeItem(GLASS_OPACITY_STORAGE_KEY)
    else localStorage.setItem(GLASS_OPACITY_STORAGE_KEY, String(value))
  } catch {
    // Storage blocked: the change still applies for this session.
  }
  applyGlassTint(value)
  window.dispatchEvent(new CustomEvent(GLASS_OPACITY_EVENT, { detail: value }))
}

async function invokeSetWindowBackdrop(mode: NativeWindowBackdrop, blur: number, dark: boolean): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('set_window_backdrop', { mode, blur, dark })
}

/**
 * Ask the desktop for this window's backdrop. True when it took it; false
 * outside the desktop app or when the desktop refused (an older build, not
 * macOS). Never rejects. `dark` picks the HUD's frosted layer's appearance
 * (the app's theme can differ from the Mac's); dashboard windows ignore it.
 */
export async function setNativeWindowBackdrop(
  mode: NativeWindowBackdrop,
  blur: number = FULL_GLASS_BLUR,
  dark: boolean = false,
  invoke: (mode: NativeWindowBackdrop, blur: number, dark: boolean) => Promise<void> = invokeSetWindowBackdrop,
): Promise<boolean> {
  if (!isDesktopApp()) return false
  try {
    await invoke(mode, blur, dark)
    return true
  } catch {
    return false
  }
}

/** Mark the page see-through (or not) once the native side answered. */
export function reflectWindowBackdrop(glass: boolean, supported: boolean) {
  const root = document.documentElement
  if (glass && supported) {
    root.setAttribute(GLASS_WINDOW_ATTR, '')
    applyGlassTint(getGlassOpacity())
  } else {
    root.removeAttribute(GLASS_WINDOW_ATTR)
  }
  if (glass && !supported) root.setAttribute(GLASS_WINDOW_UNSUPPORTED_ATTR, '')
  else if (supported) root.removeAttribute(GLASS_WINDOW_UNSUPPORTED_ATTR)
}
