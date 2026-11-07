/**
 * The sky on the public pages (everything outside the signed-in app:
 * public-sky-routes.ts): the pure parts, so they can be checked without a
 * browser.
 *
 * Text sits right on the sky there (Liam: full page, no panels, no column
 * scrims), so the sky is washed toward the page background: one number per
 * theme, applied as a lower strength in the final mix (scene.ts washedStrength), the
 * same at every point of the screen. It was picked so body text keeps 4.5:1
 * and large headings 3:1 against the sky as drawn at bright noon, sunset,
 * overcast and night, in both themes (the measurements are in the PR).
 *
 * Until the WebGL canvas arrives (it loads after the page's `load` event),
 * and for good with reduced motion or Save-Data, a static CSS gradient of the
 * same sky shows: a neutral daytime sky from the server, then the sky for
 * the reading the device has (or the clock alone) once hydrated.
 */

import type { SkySource } from '@/components/sky/sky-controller'
import { mix, type Rgb } from './palette'
import { computeSkyScene, washedStrength, type SkyScene } from './scene'
import { applyOverrideTime } from './dev-override'
import { CLEAR_SKY } from './weather'

/**
 * The even wash toward the page background, [light, dark]: half way, in both
 * themes. Measured on the drawn sky (1440x900, New York, the 0.1% of pixels
 * least favourable to the text left out: stars, the sun's core), with the
 * sky-page greys in tailwind.css (muted 25% light, 80% dark), the worst case:
 *   light: the night (blue-hour indigo): text 8.7:1, muted 4.6:1
 *   dark:  the sunset glow:               text 6.5:1, muted 4.7:1
 * Noon, sunset, overcast and night all clear 4.5:1 for body text in both.
 */
export const MARKETING_SKY_WASH: readonly [number, number] = [0.5, 0.5]

/** The page background in each theme (`--background`: white, and 6% grey). */
export const PAGE_SURFACE_LIGHT: Rgb = [1, 1, 1]
export const PAGE_SURFACE_DARK: Rgb = [0.06, 0.06, 0.06]

/** After the `load` event, wait this long before fetching the WebGL code. */
export const MARKETING_SKY_LOAD_DELAY_MS = 1_200

/** The CSS colour for an sRGB 0..1 triple. */
export function cssRgb(c: Rgb): string {
  return `rgb(${Math.round(c[0] * 255)} ${Math.round(c[1] * 255)} ${Math.round(c[2] * 255)})`
}

/**
 * The sky as a static gradient: the horizon at the bottom, the top colour at
 * the top, each mixed over the surface by `strength` (already washed). The
 * WebGL sky's own fallback draws the same.
 */
export function skyGradientCss(scene: Pick<SkyScene, 'top' | 'horizon'>, surface: Rgb, strength: number): string {
  const top = cssRgb(mix(surface, scene.top, strength))
  const horizon = cssRgb(mix(surface, scene.horizon, strength))
  return `linear-gradient(to top, ${horizon}, ${top})`
}

export interface ThemeGradients {
  light: string
  dark: string
}

/** Both themes' washed gradients for one source at `now`. */
export function marketingGradients(source: SkySource, now: Date, wash: readonly [number, number] = MARKETING_SKY_WASH): ThemeGradients {
  const date = applyOverrideTime(now, source.minuteOfDay)
  const scene = (dark: boolean) =>
    computeSkyScene({ date, latitude: source.latitude, longitude: source.longitude, weather: source.weather, dark })
  const light = scene(false)
  const dark = scene(true)
  return {
    light: skyGradientCss(light, PAGE_SURFACE_LIGHT, washedStrength(light.strength, wash[0])),
    dark: skyGradientCss(dark, PAGE_SURFACE_DARK, washedStrength(dark.strength, wash[1])),
  }
}

/**
 * What the server renders (and hydration reads): a neutral clear daytime sky,
 * the same for everyone (mid-morning in early summer at 40° N), so the first
 * paint already reads as a sky and nothing depends on the visitor.
 */
export const NEUTRAL_DAY_SOURCE: SkySource = {
  weather: CLEAR_SKY,
  latitude: 40,
  longitude: -74,
  minuteOfDay: null,
}
const NEUTRAL_DAY_DATE = new Date(Date.UTC(2026, 5, 21, 14, 30))

export const NEUTRAL_DAY_GRADIENTS: ThemeGradients = marketingGradients(NEUTRAL_DAY_SOURCE, NEUTRAL_DAY_DATE)

/**
 * Static only (no WebGL code fetched at all): the visitor asked for reduced
 * motion, or for less data (`navigator.connection.saveData`).
 */
export function marketingSkyStaticOnly(win: Window = window): boolean {
  try {
    if (typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches) return true
  } catch {
    // No media queries: assume motion is fine.
  }
  const connection = (win.navigator as Navigator & { connection?: { saveData?: boolean } }).connection
  return connection?.saveData === true
}

/** Dev only: `?skyWash=0.4` or `?skyWash=0.5,0.3` (light, dark) to tune the wash live. */
export function parseWashOverride(search: string): readonly [number, number] | null {
  const raw = new URLSearchParams(search).get('skyWash')
  if (!raw) return null
  const parts = raw.split(',').map((v) => Number.parseFloat(v))
  if (parts.length < 1 || parts.length > 2 || !parts.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) return null
  return [parts[0], parts[1] ?? parts[0]]
}
