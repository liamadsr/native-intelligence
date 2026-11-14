/**
 * The sky state for the whole app: where the person is (roughly), the weather
 * there, and where the sun is. One store, fed by one fetch loop (on start,
 * then every 30 minutes while the document is visible) that its mount starts
 * once (startSkyFeed) with its endpoint: /api/account/sky in the signed-in
 * app (the dashboard shell), the public /api/sky on the signed-out pages
 * (landing, blog: marketing-sky.tsx), which redirects to a CDN-cached cell.
 * The sky background draws from it; anything else that wants the conditions
 * reads useSkyState().
 *
 * With no location from the server (a time zone it does not know) the sun is
 * placed from the browser's UTC offset at a default latitude, and `approximate`
 * is true. Until the fetch answers, and whenever it fails, the weather is the
 * clear-sky default, whose `condition` and `temperatureC` are null.
 *
 * Launch: the last reading is remembered on the device (sky-cache.ts). On the
 * client the store starts from it, before anything draws: its location while
 * under a week old, its weather while under three hours old (older weather
 * reads as the clear default, so nothing invents clouds or reports it). The
 * fetch then runs as usual and updates it. With no usable saved reading the
 * store isn't `ready` until the fetch answers, fails, or SKY_READY_TIMEOUT_MS
 * passes; the sky stays hidden until then (sky-canvas.tsx). The server and
 * hydration always see the empty state (no reading, not ready).
 *
 * Dev only: `?sky=<preset>&skyTime=HH:MM&skyPlace=…` overrides the weather,
 * the clock and the place (dev-override.ts), and so do the dev settings
 * (Settings → Developer → Sky preview, sky-dev-store.ts), field by field
 * behind the URL. A change to the settings re-publishes at once.
 */

import { useSyncExternalStore } from 'react'
import { applyOverrideTime, mergeSkyOverrides, parseSkyOverride, type SkyOverride } from './dev-override'
import { getSkyDevSettings, skyDevOverride, subscribeSkyDevSettings } from './sky-dev-store'
import type { SkyLocation } from './location'
import { FALLBACK_LATITUDE, isSunRising, longitudeFromOffset, skyPhase, standardTimezoneOffset, type SkyPhase } from './scene'
import { solarPosition } from './sun'
import { CLEAR_SKY, type SkyWeather } from './weather'
import { loadSkyReading, saveSkyReading } from './sky-cache'

export interface SkyState {
  /** The time zone's principal city, rounded to ~11 km. Null when unknown. */
  location: SkyLocation | null
  city: string | null
  /** ISO 3166-1 alpha-2 country of that place, null when unknown. */
  country: string | null
  weather: SkyWeather
  /** Degrees above the horizon, now. */
  sunElevation: number
  phase: SkyPhase
  /** What the sun is placed from: the location, or an approximation. */
  latitude: number
  longitude: number
  /**
   * No location at all: the sun is placed from the UTC offset and nothing
   * reports the weather. A location from the time zone (`location.approximate`)
   * is still a real place with real weather, so it isn't approximate here.
   */
  approximate: boolean
  /** When the server answered (ISO), null before it has. From a saved reading, when it answered then. */
  fetchedAt: string | null
  /**
   * The state is as real as it's going to get for now: from a saved reading,
   * a fetch answer, a failed fetch or the launch timeout. The sky shows only
   * once this is true, so it never draws a default and then snaps.
   */
  ready: boolean
  /** Dev override of the local clock, minutes after midnight. */
  timeOverride: number | null
}

export interface SkyApiResponse {
  location: SkyLocation | null
  /** Absent from a response before the field existed. */
  country?: string | null
  weather: SkyWeather
  fetchedAt: string
}

/** The signed-in route (auth required): the dashboard shell's feed. */
export const ACCOUNT_SKY_ENDPOINT = '/api/account/sky'
/** The public route (no auth, CDN-cached per cell): the signed-out pages' feed. */
export { PUBLIC_SKY_ENDPOINT } from './public-cell'

const FETCH_EVERY_MS = 30 * 60_000
/** With no saved reading, stop waiting for the fetch after this long and show the best state there is. */
export const SKY_READY_TIMEOUT_MS = 2_500
/** The sun is brought up to date this often while visible (a quarter degree a minute). */
const SUN_EVERY_MS = 5 * 60_000

interface Raw {
  location: SkyLocation | null
  country: string | null
  weather: SkyWeather
  fetchedAt: string | null
  ready: boolean
  override: SkyOverride | null
}

let raw: Raw = { location: null, country: null, weather: CLEAR_SKY, fetchedAt: null, ready: false, override: null }
let state: SkyState = derive(raw, new Date())
/**
 * What the server renders and hydration reads: before any reading
 * (`fetchedAt: null`, not ready), never the saved one. Its sun is computed
 * from the clock it ran on, so text from the store belongs behind
 * `fetchedAt !== null` (client only).
 */
const INITIAL: SkyState = state
const listeners = new Set<() => void>()

// Client only, at module load (before any component reads the store): start
// from the reading saved on this device, if it's recent enough.
if (typeof window !== 'undefined') {
  const saved = loadSkyReading()
  if (saved) {
    raw = {
      ...raw,
      location: saved.location,
      country: saved.country,
      weather: saved.weatherFresh ? saved.weather : CLEAR_SKY,
      fetchedAt: saved.fetchedAt,
      ready: true,
    }
    state = derive(raw, new Date())
  }
}

/** Dev: the URL's override, as of the feed's start (or module load). */
let urlOverride: SkyOverride | null = null

/** Dev: the URL's override, then the dev settings, field by field. */
function devOverride(): SkyOverride | null {
  return mergeSkyOverrides(urlOverride, skyDevOverride(getSkyDevSettings()))
}

// Dev, client only: the override applies from the first frame, and the dev
// settings changing re-publishes it (the canvas follows without a reload).
if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
  urlOverride = parseSkyOverride(window.location.search)
  raw = { ...raw, override: devOverride() }
  state = derive(raw, new Date())
  subscribeSkyDevSettings(() => publish({ ...raw, override: devOverride() }))
}

function derive(input: Raw, now: Date): SkyState {
  // Dev: a `skyPlace` override stands in for the IP location.
  const place = input.override?.place
  const r = place ? { ...input, location: place.location, country: place.country } : input
  const approximate = !r.location
  const latitude = r.location?.lat ?? FALLBACK_LATITUDE
  const longitude = r.location?.lon ?? longitudeFromOffset(standardTimezoneOffset(now))
  const timeOverride = r.override?.minuteOfDay ?? null
  const at = applyOverrideTime(now, timeOverride)
  const sunElevation = solarPosition(at, latitude, longitude).elevation
  return {
    location: r.location,
    city: r.location?.city ?? null,
    country: r.country,
    weather: r.override?.weather ?? r.weather,
    sunElevation,
    phase: skyPhase(sunElevation, isSunRising(at, latitude, longitude)),
    latitude,
    longitude,
    approximate,
    fetchedAt: r.fetchedAt,
    ready: r.ready,
    timeOverride,
  }
}

function publish(next: Raw): void {
  raw = next
  state = derive(raw, new Date())
  for (const l of [...listeners]) l()
}

export function getSkyState(): SkyState {
  return state
}

export function subscribeSkyState(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The sky state, re-rendering when it changes (the fetch, the sun's five-minute step). */
export function useSkyState(): SkyState {
  return useSyncExternalStore(subscribeSkyState, getSkyState, () => INITIAL)
}

/** Feed the store from an API answer, and remember it on the device (exported for tests). */
export function receiveSkyResponse(body: SkyApiResponse): void {
  const location = body.location ?? null
  const country = typeof body.country === 'string' ? body.country : null
  const weather = body.weather ?? CLEAR_SKY
  const fetchedAt = body.fetchedAt ?? null
  publish({ ...raw, location, country, weather, fetchedAt, ready: true })
  if (fetchedAt) saveSkyReading({ location, city: location?.city ?? null, country, weather, fetchedAt, approximate: !location })
}

/** Stop waiting: show what there is (the fetch failed, or took too long on launch). */
function markReady(): void {
  if (!raw.ready) publish({ ...raw, ready: true })
}

/**
 * The route, with the browser's IANA time zone: the server places the request
 * at the zone's principal city. Exported for tests.
 */
export function skyUrl(endpoint: string = ACCOUNT_SKY_ENDPOINT): string {
  let tz = ''
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
  } catch {
    // No Intl time zone: the server falls back to the UTC offset.
  }
  return tz ? `${endpoint}?tz=${encodeURIComponent(tz)}` : endpoint
}

let feedCount = 0
let stopFeed: (() => void) | null = null

/**
 * Start the one fetch loop (ref-counted: each sky mount calls it once), from
 * `endpoint`: ACCOUNT_SKY_ENDPOINT in the app (the default), PUBLIC_SKY_ENDPOINT
 * on the signed-out pages. The first caller's endpoint is the loop's; the app
 * and the marketing pages never mount together (a client navigation between
 * them unmounts one, which stops its loop, before the other starts its own).
 * One timer chain at a time: every five minutes while visible the sun steps
 * forward, and every thirty the weather is fetched again. Hidden, nothing
 * runs; on showing again it catches up at once.
 */
export function startSkyFeed(endpoint: string = ACCOUNT_SKY_ENDPOINT): () => void {
  feedCount++
  if (feedCount === 1) stopFeed = runFeed(endpoint)
  let done = false
  return () => {
    if (done) return
    done = true
    feedCount--
    if (feedCount === 0) {
      stopFeed?.()
      stopFeed = null
    }
  }
}

function runFeed(endpoint: string): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastFetch = 0
  let inflight = false
  let stopped = false

  if (process.env.NODE_ENV !== 'production') {
    urlOverride = parseSkyOverride(window.location.search)
    const override = devOverride()
    if (JSON.stringify(override) !== JSON.stringify(raw.override)) publish({ ...raw, override })
  }

  const fetchNow = async () => {
    if (inflight) return
    inflight = true
    lastFetch = Date.now()
    try {
      const res = await fetch(skyUrl(endpoint), { credentials: 'same-origin' })
      if (!res.ok) {
        if (!stopped) markReady()
        return
      }
      const body = (await res.json()) as SkyApiResponse
      if (!stopped) receiveSkyResponse(body)
    } catch {
      // Offline or the route failed: keep what we have (the clear default at worst).
      if (!stopped) markReady()
    } finally {
      inflight = false
    }
  }

  const tick = () => {
    timer = null
    if (stopped) return
    if (document.visibilityState === 'visible') {
      if (Date.now() - lastFetch >= FETCH_EVERY_MS) void fetchNow()
      else publish(raw)
      timer = setTimeout(tick, SUN_EVERY_MS)
    }
  }

  const onVisibility = () => {
    if (document.visibilityState !== 'visible' || timer !== null) return
    tick()
  }
  document.addEventListener('visibilitychange', onVisibility)
  void fetchNow()
  timer = setTimeout(tick, SUN_EVERY_MS)
  // No saved reading: a slow network never leaves the sky blank for long.
  let readyTimer: ReturnType<typeof setTimeout> | null = raw.ready
    ? null
    : setTimeout(() => {
        readyTimer = null
        if (!stopped) markReady()
      }, SKY_READY_TIMEOUT_MS)

  return () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
    if (readyTimer !== null) clearTimeout(readyTimer)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
