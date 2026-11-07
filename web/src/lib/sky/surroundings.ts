/**
 * The person's local conditions as the chat sends them with a turn
 * (systemContext.surroundings): what it's like outside, how warm, where, and
 * the next sunrise or sunset. The main chat's transport reads it at send time
 * (eve-chat-transport encodeTurnContext); the app's spec route checks it again
 * before it reaches the model as the `surroundings` turn-context section
 * (src/lib/ai/surroundings-context.ts), which the chat-agent sends only when
 * it changed.
 *
 * Only a real reading goes: a known location and a provider answer
 * (`condition` and `temperatureC`), never the clear-sky default, and only
 * while it's fresh (under three hours old, WEATHER_FRESH_MS): a reading
 * remembered from an earlier session, or one a failing fetch left behind,
 * isn't what it's like outside now.
 */

import { applyOverrideTime } from './dev-override'
import { isWeatherFresh } from './sky-cache'
import { getSkyState, type SkyState } from './sky-state'
import { nextSunCrossing, solarPosition, SUNRISE_ELEVATION } from './sun'

/** What rides the turn. Mirrors `TurnSurroundings` in src/lib/ai/surroundings-context.ts. */
export interface TurnSurroundings {
  condition: string
  /** °C, one decimal. */
  temperatureC: number
  city?: string
  /** The next sunrise or sunset, local time "HH:MM" (24-hour). */
  nextSun?: { kind: 'sunrise' | 'sunset'; at: string }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** The turn's surroundings from the sky state, or null without a real reading. */
export function surroundingsFrom(state: SkyState, now: Date = new Date()): TurnSurroundings | null {
  const { condition, temperatureC } = state.weather
  if (state.fetchedAt === null || state.approximate || condition === null || temperatureC === null) return null
  if (!Number.isFinite(temperatureC)) return null
  if (!isWeatherFresh(state.fetchedAt, now.getTime())) return null
  const at = applyOverrideTime(now, state.timeOverride)
  // The sun is up once its centre clears the visible horizon: the next event is its setting.
  // Its height is computed for this moment, the one the search starts from:
  // the store's `sunElevation` can be five minutes old, and just after sunset
  // that would name tomorrow's sunset instead of the next sunrise.
  const elevation = solarPosition(at, state.latitude, state.longitude).elevation
  const kind = elevation > SUNRISE_ELEVATION ? 'sunset' : 'sunrise'
  const next = nextSunCrossing(at, state.latitude, state.longitude, kind === 'sunset' ? 'set' : 'rise')
  return {
    condition,
    temperatureC,
    ...(state.city ? { city: state.city } : {}),
    ...(next ? { nextSun: { kind, at: `${pad(next.getHours())}:${pad(next.getMinutes())}` } } : {}),
  }
}

/**
 * This send's surroundings, read from the one sky store. Memoized on the
 * store's state object (it is replaced on each publish) and the minute, so a
 * burst of sends costs one sun scan.
 */
let memo: { state: SkyState; minute: number; value: TurnSurroundings | null } | null = null
export function currentSurroundings(): TurnSurroundings | null {
  try {
    const state = getSkyState()
    const minute = Math.floor(Date.now() / 60_000)
    if (memo && memo.state === state && memo.minute === minute) return memo.value
    const value = surroundingsFrom(state)
    memo = { state, minute, value }
    return value
  } catch {
    return null
  }
}
