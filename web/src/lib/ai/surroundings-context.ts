/**
 * The `surroundings` turn-context section: the person's local conditions
 * ("Light rain, 9°C (49°F) in Toronto; sunset 18:42 local time"), so the chat
 * can use them when a question touches what's around the person (a run, what
 * to wear, getting somewhere) and stays quiet about them otherwise.
 *
 * The main chat's client sends them with the turn (systemContext.surroundings,
 * from src/lib/sky/surroundings.ts). Client-controlled, so nothing is trusted:
 * the condition must be one of the labels the weather mapping itself writes,
 * the temperature a plausible number, the city a short run of letters, the
 * sunrise or sunset a clock time. Anything else drops that field, or the
 * whole section when the condition or temperature fails. Nothing here is a
 * model call, and no field can carry instructions.
 *
 * The chat-agent sends a section only when it changed since the version the
 * model last saw (agents/chat-agent/lib/turn-context.ts), so this costs a
 * line every half hour or so, not every turn.
 */

export const SURROUNDINGS_SECTION_KEY = 'surroundings'

/** What the client sends. Mirrors `TurnSurroundings` in src/lib/sky/surroundings.ts. */
export interface TurnSurroundings {
  condition: string
  temperatureC: number
  city?: string
  nextSun?: { kind: 'sunrise' | 'sunset'; at: string }
}

/**
 * The condition labels src/lib/sky/weather.ts writes (and the dev presets):
 * clear to cloudy, fog, thunderstorm, and rain / snow / sleet, light or heavy,
 * as showers or not.
 */
const CONDITION_RE =
  /^(?:Clear|Mostly clear|Partly cloudy|Cloudy|Fog|Thunderstorm|(?:Light |Heavy )?(?:rain|snow|sleet)(?: showers)?|(?:Rain|Snow|Sleet)(?: showers)?)$/

/** Coldest and hottest air temperatures ever measured, with room: outside is not a reading. */
const MIN_C = -90
const MAX_C = 60

/** A place name: letters (any script) and the marks, spaces and punctuation real names use. */
const CITY_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u
const MAX_CITY_CHARS = 48
/** "Rancho Santa Margarita" is three; a sentence is not a city. */
const MAX_CITY_WORDS = 4

const CLOCK_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/

/** The checked surroundings, or null when the condition or temperature fails. */
export function parseSurroundings(value: unknown): TurnSurroundings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const condition = typeof v.condition === 'string' ? v.condition.trim() : ''
  if (!CONDITION_RE.test(condition)) return null
  const t = v.temperatureC
  if (typeof t !== 'number' || !Number.isFinite(t) || t < MIN_C || t > MAX_C) return null

  const out: TurnSurroundings = { condition, temperatureC: Math.round(t * 10) / 10 }
  const city = typeof v.city === 'string' ? v.city.replace(/\s+/g, ' ').trim() : ''
  if (city && city.length <= MAX_CITY_CHARS && city.split(' ').length <= MAX_CITY_WORDS && CITY_RE.test(city)) out.city = city
  const sun = v.nextSun
  if (sun && typeof sun === 'object' && !Array.isArray(sun)) {
    const { kind, at } = sun as Record<string, unknown>
    if ((kind === 'sunrise' || kind === 'sunset') && typeof at === 'string' && CLOCK_RE.test(at)) out.nextSun = { kind, at }
  }
  return out
}

/** Whole degrees, never "-0". */
const whole = (n: number) => {
  const r = Math.round(n)
  return r === 0 ? 0 : r
}

/** The section's text, or null without valid surroundings. */
export function renderSurroundingsSection(value: unknown): string | null {
  const s = parseSurroundings(value)
  if (!s) return null
  const temp = `${whole(s.temperatureC)}°C (${whole(s.temperatureC * 1.8 + 32)}°F)`
  const where = s.city ? ` in ${s.city}` : ''
  const sun = s.nextSun ? `; ${s.nextSun.kind} ${s.nextSun.at} local time` : ''
  return [
    '## Local conditions',
    `${s.condition}, ${temp}${where}${sun}.`,
    "Use this only when the person's question touches their surroundings, plans, travel or wellbeing (a run, what to wear, getting somewhere). Don't bring it up otherwise.",
  ].join('\n')
}
