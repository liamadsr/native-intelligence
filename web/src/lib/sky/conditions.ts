/**
 * The empty chat's two quiet lines, as plain strings: a greeting for the hour
 * ("Good evening, Liam") and, under it, what it's like outside ("Light rain ·
 * 9° · Toronto"). Pure, so every case is checked without a browser.
 *
 * Accuracy over charm: the greeting comes from the local clock, the condition
 * and temperature only from a real reading (a known location and a provider
 * answer: `temperatureC` and `condition` non-null), never from the clear-sky
 * default. With no reading there is no second line.
 */

import type { SkyPhase } from './scene'

export type TemperatureUnit = 'C' | 'F'

/**
 * The greeting for a local hour (0–23): morning 5–12, afternoon 12–17, evening
 * 17–24, and a plain "Hello" after midnight ("Good night" reads as a goodbye
 * to someone opening the app at 1am).
 */
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 12 && hour < 17) return 'Good afternoon'
  if (hour >= 17) return 'Good evening'
  return 'Hello'
}

const MAX_NAME_CHARS = 24

/**
 * The first word of a display name, or null when there isn't a usable one (no
 * name, an email address standing in for one, something too long to greet).
 */
export function firstNameOf(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0] ?? ''
  if (!first || first.includes('@') || first.length > MAX_NAME_CHARS) return null
  if (!/\p{L}/u.test(first)) return null
  return first
}

/** The greeting line: "Good evening, Liam", or just "Good evening". */
export function greetingLine(hour: number, name: string | null | undefined): string {
  const first = firstNameOf(name)
  return first ? `${greetingFor(hour)}, ${first}` : greetingFor(hour)
}

/**
 * Countries (and territories) where people read Fahrenheit: the US and its
 * territories, the Bahamas, the Cayman Islands, Liberia, Palau, Micronesia
 * and the Marshall Islands.
 */
const FAHRENHEIT = new Set(['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM', 'BS', 'KY', 'LR', 'PW', 'FM', 'MH'])

/** The region of a BCP 47 tag ("en-US" → "US"), or null when it names none. */
export function regionOfLocale(tag: string | null | undefined): string | null {
  const match = tag ? /^[A-Za-z]{2,3}(?:[-_][A-Za-z]{4})?[-_]([A-Za-z]{2})(?:$|[-_])/.exec(tag) : null
  return match ? match[1].toUpperCase() : null
}

/**
 * °F where the request's country reads it, else °C. Without a country, the
 * browser locale's region decides (en-US → °F); without either, °C.
 */
export function temperatureUnit(country: string | null | undefined, locale?: string | null): TemperatureUnit {
  const region = country ?? regionOfLocale(locale)
  return region && FAHRENHEIT.has(region.toUpperCase()) ? 'F' : 'C'
}

/** A temperature as the line shows it: whole degrees, no unit letter, a true minus sign ("9°", "−3°", "48°"). */
export function formatTemperature(celsius: number, unit: TemperatureUnit): string {
  const value = Math.round(unit === 'F' ? celsius * 1.8 + 32 : celsius)
  return value < 0 ? `\u2212${-value}°` : `${value === 0 ? 0 : value}°`
}

export interface ConditionsInput {
  condition: string | null
  temperatureC: number | null
  city: string | null
  /** True when the sky has a real location (not the UTC-offset approximation). */
  located: boolean
  unit: TemperatureUnit
  phase: SkyPhase
  /** The next sunrise, already formatted for this person ("7:12 AM"); shown at night only. */
  sunrise?: string | null
}

const MAX_CITY_CHARS = 32

/**
 * "Light rain · 9° · Toronto", and at night "Clear · 4° · Toronto · sunrise
 * 7:12 AM". Null without a real reading: no location, or no condition or
 * temperature from the provider.
 */
export function conditionsLine({ condition, temperatureC, city, located, unit, phase, sunrise }: ConditionsInput): string | null {
  if (!located || condition === null || temperatureC === null || !Number.isFinite(temperatureC)) return null
  const parts = [condition, formatTemperature(temperatureC, unit)]
  const place = city?.trim()
  if (place && place.length <= MAX_CITY_CHARS) parts.push(place)
  if (phase === 'night' && sunrise) parts.push(`sunrise ${sunrise}`)
  return parts.join(' · ')
}
