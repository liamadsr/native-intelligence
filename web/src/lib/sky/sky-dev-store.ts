/**
 * Dev-only sky preview settings, set from Settings → Developer → Sky preview
 * or the floating panel (components/sky/sky-dev-panel.tsx): a weather preset,
 * a fixed time of day and a stand-in place, so every condition can be looked
 * at in the desktop app, which has no URL bar for `?sky=…` (dev-override.ts).
 *
 * Remembered on this device (localStorage, every access guarded: storage can
 * throw or come back empty). The sky store (sky-state.ts) subscribes and
 * re-publishes on every change, so the canvas follows live. Precedence, per
 * field: the URL's override, then this, then the real reading.
 *
 * Production: inert. Every read returns the defaults and every write is
 * dropped, whatever storage holds.
 */

import { useSyncExternalStore } from 'react'
import { SKY_PRESETS, type SkyOverride } from './dev-override'

export const SKY_DEV_STORAGE_KEY = 'ni.sky.devOverride.v1'

export interface SkyDevPlace {
  label: string
  lat: number
  lon: number
  country: string
  /** IANA zone, only to label the place's own clock in the controls. */
  timeZone: string
}

export const SKY_DEV_PLACES = {
  'new-york': { label: 'New York', lat: 40.71, lon: -74.01, country: 'US', timeZone: 'America/New_York' },
  london: { label: 'London', lat: 51.51, lon: -0.13, country: 'GB', timeZone: 'Europe/London' },
  tokyo: { label: 'Tokyo', lat: 35.68, lon: 139.69, country: 'JP', timeZone: 'Asia/Tokyo' },
  sydney: { label: 'Sydney', lat: -33.87, lon: 151.21, country: 'AU', timeZone: 'Australia/Sydney' },
  reykjavik: { label: 'Reykjavik', lat: 64.15, lon: -21.94, country: 'IS', timeZone: 'Atlantic/Reykjavik' },
} as const satisfies Record<string, SkyDevPlace>

export type SkyDevPlaceKey = keyof typeof SKY_DEV_PLACES

export interface SkyDevSettings {
  /** A SKY_PRESETS key, or null for the real weather. */
  weather: string | null
  /** Minutes after local midnight (this device's clock), or null for now. */
  minuteOfDay: number | null
  /** A SKY_DEV_PLACES key, or null for the real location. */
  place: SkyDevPlaceKey | null
  /** The floating controls are shown over the app. */
  floating: boolean
}

export const SKY_DEV_DEFAULTS: SkyDevSettings = Object.freeze({ weather: null, minuteOfDay: null, place: null, floating: false })

const off = () => process.env.NODE_ENV === 'production'

let settings: SkyDevSettings = SKY_DEV_DEFAULTS
let loaded = false
/** A time slider is being dragged: the renderer snaps instead of blending. Not persisted. */
let scrubbing = false
const listeners = new Set<() => void>()

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** A stored value, field by field; anything malformed reads as its default. */
function sanitize(value: unknown): SkyDevSettings {
  if (!value || typeof value !== 'object') return SKY_DEV_DEFAULTS
  const v = value as Record<string, unknown>
  const weather = typeof v.weather === 'string' && has(SKY_PRESETS, v.weather) ? v.weather : null
  const m = v.minuteOfDay
  const minuteOfDay = typeof m === 'number' && Number.isInteger(m) && m >= 0 && m < 24 * 60 ? m : null
  const place = typeof v.place === 'string' && has(SKY_DEV_PLACES, v.place) ? (v.place as SkyDevPlaceKey) : null
  return { weather, minuteOfDay, place, floating: v.floating === true }
}

function load(): void {
  if (loaded || typeof window === 'undefined') return
  loaded = true
  try {
    const raw = window.localStorage.getItem(SKY_DEV_STORAGE_KEY)
    if (raw) settings = sanitize(JSON.parse(raw))
  } catch {
    // Storage blocked or the value corrupt: the defaults.
  }
}

function save(): void {
  try {
    window.localStorage.setItem(SKY_DEV_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Storage full or blocked: it still applies for this session.
  }
}

export function getSkyDevSettings(): SkyDevSettings {
  if (off()) return SKY_DEV_DEFAULTS
  load()
  return settings
}

export function setSkyDevSettings(patch: Partial<SkyDevSettings>): void {
  if (off() || typeof window === 'undefined') return
  load()
  const next = sanitize({ ...settings, ...patch })
  if (
    next.weather === settings.weather &&
    next.minuteOfDay === settings.minuteOfDay &&
    next.place === settings.place &&
    next.floating === settings.floating
  ) {
    return
  }
  settings = next
  save()
  for (const l of [...listeners]) l()
}

/** Back to the real sky. The floating panel stays as it is. */
export function resetSkyDevOverride(): void {
  setSkyDevSettings({ weather: null, minuteOfDay: null, place: null })
}

export function subscribeSkyDevSettings(listener: () => void): () => void {
  if (off()) return () => {}
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useSkyDevSettings(): SkyDevSettings {
  return useSyncExternalStore(subscribeSkyDevSettings, getSkyDevSettings, () => SKY_DEV_DEFAULTS)
}

export function setSkyDevScrubbing(on: boolean): void {
  if (off()) return
  scrubbing = on
}

/** A time slider is mid-drag: a new source should snap, not blend. */
export function isSkyDevScrubbing(): boolean {
  return !off() && scrubbing
}

/** The settings as a sky override, or null when they leave everything real. */
export function skyDevOverride(s: SkyDevSettings): SkyOverride | null {
  const weather = s.weather && has(SKY_PRESETS, s.weather) ? SKY_PRESETS[s.weather] : null
  const p = s.place ? SKY_DEV_PLACES[s.place] : null
  const place = p ? { location: { lat: p.lat, lon: p.lon, city: p.label }, country: p.country } : undefined
  if (!weather && s.minuteOfDay === null && !place) return null
  return { weather, minuteOfDay: s.minuteOfDay, ...(place ? { place } : {}) }
}

