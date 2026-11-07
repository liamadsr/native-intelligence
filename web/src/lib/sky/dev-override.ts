/**
 * Dev-only sky override, so every state can be looked at without waiting for
 * the weather: `?sky=clear|cirrus|fair|cloudy|overcast|rain|snow|sleet|storm|fog`, `&skyTime=HH:MM`
 * (local time today) and `&skyPlace=lat,lon,City,CC` (local dev has no IP
 * geolocation, so nothing there is ever "located" otherwise). The caller
 * honours it only outside production; this module only parses. The dev
 * settings (sky-dev-store.ts) give the same three from a UI; the URL wins.
 */

import type { SkyLocation } from './location'
import { CLEAR_SKY, type SkyWeather } from './weather'

export const SKY_PRESETS: Record<string, SkyWeather> = {
  clear: { ...CLEAR_SKY, temperatureC: 21, condition: 'Clear' },
  // High thin cloud only: a blue sky veiled by faint streaks (New York, 10 October 2026).
  cirrus: { ...CLEAR_SKY, cloudCover: 0, cirrus: 0.9, temperatureC: 15, condition: 'Mostly clear' },
  fair: { ...CLEAR_SKY, cloudCover: 0.25, cirrus: 0.3, temperatureC: 18, condition: 'Mostly clear' },
  cloudy: { cloudCover: 0.6, cirrus: 0.4, windSpeedMs: 5, windFromDeg: 240, precip: 'none', precipIntensity: 0, fog: false, storm: false, temperatureC: 14, condition: 'Partly cloudy' },
  // A full grey lid with nothing falling.
  overcast: { cloudCover: 0.97, cirrus: 0, windSpeedMs: 4, windFromDeg: 250, precip: 'none', precipIntensity: 0, fog: false, storm: false, temperatureC: 12, condition: 'Cloudy' },
  rain: { cloudCover: 0.9, cirrus: 0, windSpeedMs: 6, windFromDeg: 230, precip: 'rain', precipIntensity: 0.7, fog: false, storm: false, temperatureC: 11, condition: 'Rain' },
  snow: { cloudCover: 0.85, cirrus: 0, windSpeedMs: 2, windFromDeg: 300, precip: 'snow', precipIntensity: 0.6, fog: false, storm: false, temperatureC: -2, condition: 'Snow' },
  sleet: { cloudCover: 0.9, cirrus: 0, windSpeedMs: 4, windFromDeg: 280, precip: 'sleet', precipIntensity: 0.6, fog: false, storm: false, temperatureC: 1, condition: 'Sleet' },
  storm: { cloudCover: 1, cirrus: 0, windSpeedMs: 12, windFromDeg: 220, precip: 'rain', precipIntensity: 1, fog: false, storm: true, temperatureC: 22, condition: 'Thunderstorm' },
  fog: { cloudCover: 0.6, cirrus: 0, windSpeedMs: 1, windFromDeg: 200, precip: 'none', precipIntensity: 0, fog: true, storm: false, temperatureC: 9, condition: 'Fog' },
}

export interface SkyOverride {
  weather: SkyWeather | null
  /** Minutes after local midnight. */
  minuteOfDay: number | null
  /** A stand-in location (and its country), only when `skyPlace` names one. */
  place?: { location: SkyLocation; country: string | null }
}

/** `lat,lon[,City[,CC]]` → a place, or null. */
export function parseSkyPlace(raw: string | null): SkyOverride['place'] | null {
  if (!raw) return null
  const [latRaw, lonRaw, city, cc] = raw.split(',').map((v) => v.trim())
  const lat = Number.parseFloat(latRaw ?? '')
  const lon = Number.parseFloat(lonRaw ?? '')
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return {
    location: { lat, lon, ...(city ? { city } : {}) },
    country: cc && /^[A-Za-z]{2}$/.test(cc) ? cc.toUpperCase() : null,
  }
}

export function parseSkyOverride(search: string): SkyOverride | null {
  const params = new URLSearchParams(search)
  const preset = params.get('sky')
  const time = params.get('skyTime')
  const weather = preset && Object.prototype.hasOwnProperty.call(SKY_PRESETS, preset) ? SKY_PRESETS[preset] : null
  const match = time ? /^(\d{1,2}):(\d{2})$/.exec(time) : null
  const minuteOfDay =
    match && Number(match[1]) < 24 && Number(match[2]) < 60 ? Number(match[1]) * 60 + Number(match[2]) : null
  const place = parseSkyPlace(params.get('skyPlace'))
  if (!weather && minuteOfDay === null && !place) return null
  return { weather, minuteOfDay, ...(place ? { place } : {}) }
}

/** `now` with its local clock set to the override's time of day. */
export function applyOverrideTime(now: Date, minuteOfDay: number | null): Date {
  if (minuteOfDay === null) return now
  const d = new Date(now)
  d.setHours(Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, 0)
  return d
}

/**
 * Two overrides as one, field by field: `first` (the URL's) wins wherever it
 * says something, `then` (the dev settings, sky-dev-store.ts) fills the rest.
 */
export function mergeSkyOverrides(first: SkyOverride | null, then: SkyOverride | null): SkyOverride | null {
  if (!first) return then
  if (!then) return first
  const place = first.place ?? then.place
  return {
    weather: first.weather ?? then.weather,
    minuteOfDay: first.minuteOfDay ?? then.minuteOfDay,
    ...(place ? { place } : {}),
  }
}
