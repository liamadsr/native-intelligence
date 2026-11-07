/**
 * The last sky reading, remembered on this device (localStorage), so the sky
 * starts at the right place and weather on launch instead of drawing a
 * default and snapping once /api/account/sky answers.
 *
 * Only what the route returned is kept: the location (already rounded to
 * ~11 km), its city and country, the weather and when the server answered.
 * Nothing about the time of day: that is always computed from the clock.
 *
 * Per-viewer convenience only. Storage can throw or come back empty (private
 * mode, blocked site data), so every access is wrapped and a missing, corrupt
 * or old value reads as no reading. What comes back is validated field by
 * field before the renderer ever sees it.
 */

import type { SkyLocation } from './location'
import { SKY_CONDITION_LABELS, type SkyPrecip, type SkyWeather } from './weather'

/**
 * v2: `cloudCover` became the dense (low + medium) cloud, and `cirrus` the
 * high cloud. A v1 reading's `cloudCover` was MET's total, which counts thin
 * cirrus as cloud, so it could draw a clear sky as cloudy until the next fetch:
 * v1 readings are ignored (and removed on the next save).
 */
export const SKY_CACHE_KEY = 'dial8.sky.lastReading.v2'
const LEGACY_SKY_CACHE_KEYS = ['dial8.sky.lastReading.v1'] as const

/** A saved location is used for this long: people rarely move. */
export const LOCATION_FRESH_MS = 7 * 24 * 60 * 60_000
/** A saved (or live) weather reading is trusted for this long. */
export const WEATHER_FRESH_MS = 3 * 60 * 60_000
/** A reading stamped further ahead of this device's clock than this is bad data. */
const MAX_FUTURE_MS = 60 * 60_000

export interface SavedSkyReading {
  location: SkyLocation | null
  city: string | null
  country: string | null
  weather: SkyWeather
  /** When the server answered (ISO). */
  fetchedAt: string
  /** No location at all (the sun was placed from the UTC offset). */
  approximate: boolean
}

export interface LoadedSkyReading extends SavedSkyReading {
  /** The weather is under WEATHER_FRESH_MS old. When false, don't draw or report it. */
  weatherFresh: boolean
}

export function saveSkyReading(reading: SavedSkyReading): void {
  try {
    const value: SavedSkyReading = {
      location: reading.location,
      city: reading.city,
      country: reading.country,
      weather: reading.weather,
      fetchedAt: reading.fetchedAt,
      approximate: reading.approximate,
    }
    window.localStorage.setItem(SKY_CACHE_KEY, JSON.stringify(value))
    for (const key of LEGACY_SKY_CACHE_KEYS) window.localStorage.removeItem(key)
  } catch {
    // Storage blocked or full: the sky works without it.
  }
}

/**
 * The saved reading, if there is a valid one whose location is still usable
 * (under LOCATION_FRESH_MS old), with `weatherFresh` saying whether its weather
 * is too. Null otherwise; never throws.
 */
export function loadSkyReading(now: number = Date.now()): LoadedSkyReading | null {
  let text: string | null = null
  try {
    text = window.localStorage.getItem(SKY_CACHE_KEY)
  } catch {
    return null
  }
  if (!text) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  const reading = parseSavedReading(value)
  if (!reading) return null
  const age = now - Date.parse(reading.fetchedAt)
  if (age < -MAX_FUTURE_MS || age >= LOCATION_FRESH_MS) return null
  return { ...reading, weatherFresh: age < WEATHER_FRESH_MS }
}

/** Whether a reading answered at `fetchedAt` (ISO) is still fresh weather at `now`. */
export function isWeatherFresh(fetchedAt: string | null, now: number = Date.now()): boolean {
  if (!fetchedAt) return false
  const at = Date.parse(fetchedAt)
  return Number.isFinite(at) && now - at < WEATHER_FRESH_MS
}

// ── Validation ───────────────────────────────────────────────────────────────

const PRECIP: ReadonlySet<SkyPrecip> = new Set(['none', 'rain', 'snow', 'sleet'])
const MAX_TEXT = 100

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function inRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
}

function shortText(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_TEXT
}

function parseLocation(v: unknown): SkyLocation | null | undefined {
  if (v === null) return null
  if (!isRecord(v) || !inRange(v.lat, -90, 90) || !inRange(v.lon, -180, 180)) return undefined
  if (v.city !== undefined && !shortText(v.city)) return undefined
  if (v.approximate !== undefined && typeof v.approximate !== 'boolean') return undefined
  return {
    lat: v.lat,
    lon: v.lon,
    ...(v.city !== undefined ? { city: v.city } : {}),
    ...(v.approximate !== undefined ? { approximate: v.approximate } : {}),
  }
}

function parseWeather(v: unknown): SkyWeather | null {
  if (!isRecord(v)) return null
  const { cloudCover, cirrus, windSpeedMs, windFromDeg, precip, precipIntensity, fog, storm, temperatureC, condition } = v
  if (!inRange(cloudCover, 0, 1) || !inRange(windSpeedMs, 0, 100) || !inRange(windFromDeg, 0, 360)) return null
  // Absent (a reading saved before cirrus existed) reads as none; present, it must be in range.
  if (cirrus !== undefined && !inRange(cirrus, 0, 1)) return null
  if (typeof precip !== 'string' || !PRECIP.has(precip as SkyPrecip) || !inRange(precipIntensity, 0, 1)) return null
  if (typeof fog !== 'boolean' || typeof storm !== 'boolean') return null
  if (temperatureC !== null && !inRange(temperatureC, -100, 70)) return null
  if (condition !== null && (typeof condition !== 'string' || !SKY_CONDITION_LABELS.has(condition))) return null
  return {
    cloudCover,
    cirrus: inRange(cirrus, 0, 1) ? cirrus : 0,
    windSpeedMs,
    windFromDeg,
    precip: precip as SkyPrecip,
    precipIntensity,
    fog,
    storm,
    temperatureC: temperatureC as number | null,
    condition: condition as string | null,
  }
}

/** A stored value as a SavedSkyReading, or null when any field is missing or out of range. */
export function parseSavedReading(v: unknown): SavedSkyReading | null {
  if (!isRecord(v)) return null
  const location = parseLocation(v.location)
  if (location === undefined) return null
  if (v.city !== null && !shortText(v.city)) return null
  if (v.country !== null && (typeof v.country !== 'string' || !/^[A-Z]{2}$/.test(v.country))) return null
  if (typeof v.approximate !== 'boolean' || v.approximate !== (location === null)) return null
  if (typeof v.fetchedAt !== 'string' || v.fetchedAt.length > 40 || !Number.isFinite(Date.parse(v.fetchedAt))) return null
  const weather = parseWeather(v.weather)
  if (!weather) return null
  return {
    location,
    // The city is the location's; a stored one that disagrees is ignored.
    city: location?.city ?? null,
    country: v.country as string | null,
    weather,
    fetchedAt: v.fetchedAt,
    approximate: v.approximate,
  }
}
