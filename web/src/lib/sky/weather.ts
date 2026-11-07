/**
 * The weather as the sky draws it: a small state any provider maps onto.
 * Client-safe (no fetch here): the provider lives in met-norway.ts, server
 * side, so it can be swapped without touching the renderer.
 */

/** Credit for the weather data (MET Norway, CC BY 4.0): shown where the Sky background is chosen. */
export const SKY_WEATHER_CREDIT = 'Weather data from MET Norway (CC BY 4.0)'
export const SKY_WEATHER_CREDIT_URL = 'https://api.met.no/doc/License'

export type SkyPrecip = 'none' | 'rain' | 'snow' | 'sleet'

export interface SkyWeather {
  /**
   * 0 (clear) to 1 (overcast): the dense cloud that reads as clouds (low and
   * medium cloud), which draws the cloud field and names the condition.
   */
  cloudCover: number
  /**
   * 0..1: thin high cloud (cirrus). It barely veils a blue sky, so it only
   * draws faint streaks and never makes a sky "cloudy". A reading saved or
   * served before this field existed has none: readers take that as 0
   * (sky-cache.ts parses it so; the scene guards it).
   */
  cirrus: number
  /** Metres per second. */
  windSpeedMs: number
  /** Meteorological direction the wind blows FROM, degrees clockwise from north. */
  windFromDeg: number
  precip: SkyPrecip
  /** 0..1: light drizzle to a downpour. 0 when precip is 'none'. */
  precipIntensity: number
  fog: boolean
  storm: boolean
  /** Air temperature, °C. Null when unknown (the default sky). */
  temperatureC: number | null
  /** Short condition label ("Clear", "Light rain", "Thunderstorm"). Null when unknown (the default sky). */
  condition: string | null
}

/**
 * What the sky draws when it knows nothing (no location, or the provider
 * failed): a clear sky. `condition` and `temperatureC` are null, so nothing
 * that reports the weather mistakes it for a reading.
 */
export const CLEAR_SKY: SkyWeather = Object.freeze({
  cloudCover: 0.08,
  cirrus: 0,
  windSpeedMs: 3,
  windFromDeg: 250,
  precip: 'none',
  precipIntensity: 0,
  fog: false,
  storm: false,
  temperatureC: null,
  condition: null,
}) as SkyWeather

/**
 * The subset of a MET Norway Locationforecast 2.0 response we read. The cloud
 * layers (`cloud_area_fraction_low` / `_medium` / `_high`) and the fog
 * fraction come only from the `complete` endpoint; `compact` has the total.
 */
export interface MetNorwayForecast {
  properties?: {
    timeseries?: Array<{
      time?: string
      data?: {
        instant?: {
          details?: {
            cloud_area_fraction?: number
            cloud_area_fraction_low?: number
            cloud_area_fraction_medium?: number
            cloud_area_fraction_high?: number
            wind_speed?: number
            wind_from_direction?: number
            fog_area_fraction?: number
            air_temperature?: number
          }
        }
        next_1_hours?: MetPeriod
        next_6_hours?: MetPeriod
      }
    }>
  }
}

interface MetPeriod {
  summary?: { symbol_code?: string }
  details?: { precipitation_amount?: number }
}

/** What a MET symbol code says, its `_day` / `_night` / `_polartwilight` suffix stripped. */
export interface SymbolReading {
  cloudCover: number
  precip: SkyPrecip
  precipIntensity: number
  fog: boolean
  storm: boolean
  /** Short label for the condition. */
  label: string
}

export function readSymbol(code: string | undefined | null): SymbolReading | null {
  if (!code) return null
  const base = code.replace(/_(day|night|polartwilight)$/, '')
  const storm = base.includes('thunder')
  const precip: SkyPrecip = base.includes('sleet')
    ? 'sleet'
    : base.includes('snow')
      ? 'snow'
      : base.includes('rain')
        ? 'rain'
        : 'none'
  // MET spells some light codes "lights…" (lightssnowshowersandthunder).
  const precipIntensity =
    precip === 'none' ? 0 : base.startsWith('light') ? 0.35 : base.startsWith('heavy') ? 1 : 0.65
  const fog = base === 'fog'
  let cloudCover: number
  if (base === 'clearsky') cloudCover = 0.05
  else if (base === 'fair') cloudCover = 0.25
  else if (base === 'partlycloudy') cloudCover = 0.5
  else if (base === 'cloudy' || fog) cloudCover = 0.95
  else if (base.includes('showers')) cloudCover = 0.7
  else cloudCover = precip === 'none' ? 0.5 : 0.9
  return { cloudCover, precip, precipIntensity, fog, storm, label: symbolLabel(base, precip, storm, fog) }
}

const SKY_LABELS: Record<string, string> = {
  clearsky: 'Clear',
  fair: 'Mostly clear',
  partlycloudy: 'Partly cloudy',
  cloudy: 'Cloudy',
}

function symbolLabel(base: string, precip: SkyPrecip, storm: boolean, fog: boolean): string {
  if (storm) return 'Thunderstorm'
  if (fog) return 'Fog'
  if (precip !== 'none') {
    const noun = precip === 'rain' ? 'rain' : precip === 'snow' ? 'snow' : 'sleet'
    const strength = base.startsWith('light') ? 'Light ' : base.startsWith('heavy') ? 'Heavy ' : ''
    const phrase = `${strength}${noun}${base.includes('showers') ? ' showers' : ''}`
    return phrase.charAt(0).toUpperCase() + phrase.slice(1)
  }
  return SKY_LABELS[base] ?? coverLabel(0.5)
}

/**
 * Every condition label this module can produce (readSymbol, coverLabel), so a
 * label read back from storage can be checked against them.
 */
export const SKY_CONDITION_LABELS: ReadonlySet<string> = new Set([
  'Clear',
  'Mostly clear',
  'Partly cloudy',
  'Cloudy',
  'Thunderstorm',
  'Fog',
  ...(['rain', 'snow', 'sleet'] as const).flatMap((noun) =>
    ['', 'Light ', 'Heavy '].flatMap((strength) =>
      ['', ' showers'].map((showers) => {
        const phrase = `${strength}${noun}${showers}`
        return phrase.charAt(0).toUpperCase() + phrase.slice(1)
      }),
    ),
  ),
])

/**
 * A label from the dense cloud cover (and, optionally, the high cirrus), when
 * nothing is falling. The dense cover sets it: Clear under 0.15, Mostly clear
 * under 0.4, Partly cloudy under 0.75, Cloudy above. Cirrus at or above
 * CIRRUS_LABEL_MIN can turn "Clear" into "Mostly clear", and no further: a
 * thin high veil over a blue sky is never "cloudy".
 */
export function coverLabel(cloudCover: number, cirrus = 0): string {
  if (cloudCover < 0.15) return cirrus >= CIRRUS_LABEL_MIN ? 'Mostly clear' : 'Clear'
  if (cloudCover < 0.4) return 'Mostly clear'
  if (cloudCover < 0.75) return 'Partly cloudy'
  return 'Cloudy'
}

/** High cloud from this fraction up makes a clear sky "Mostly clear". */
export const CIRRUS_LABEL_MIN = 0.4
/**
 * Medium cloud counts a little less than low cloud toward the dense cover:
 * it's higher and thinner, so the same fraction shades the sky a little less.
 */
export const MEDIUM_CLOUD_WEIGHT = 0.85
/** Fog from this fraction (percent) up is drawn as fog. */
const FOG_FRACTION_MIN = 30

/**
 * The dense cover from the low and medium layers (fractions 0..1), combined
 * as overlapping layers rather than added, so two half-covered layers make
 * 0.75, not 1: `1 - (1 - low)(1 - MEDIUM_CLOUD_WEIGHT * medium)`.
 */
export function denseCover(low: number, medium: number): number {
  return clamp01(1 - (1 - clamp01(low)) * (1 - MEDIUM_CLOUD_WEIGHT * clamp01(medium)))
}

/**
 * The first timeseries entry of a MET `complete` forecast as a SkyWeather, or
 * null when the response doesn't carry one. Instant details win where both
 * exist (cloud cover, fog); the next hour's symbol says what's falling.
 *
 * Clouds by layer: low and medium cloud are the dense cover (`denseCover`),
 * high cloud is `cirrus`. MET's total `cloud_area_fraction` counts a sky of
 * thin cirrus as 90% cloud, which drew a blue sky as overcast, so the total
 * is used only when the layers are missing (a `compact` body).
 */
export function skyWeatherFromMetNorway(json: unknown): SkyWeather | null {
  const entry = (json as MetNorwayForecast | null)?.properties?.timeseries?.[0]
  const instant = entry?.data?.instant?.details
  if (!instant) return null
  const period = entry?.data?.next_1_hours ?? entry?.data?.next_6_hours
  const symbol = readSymbol(period?.summary?.symbol_code)
  const amount = finite(period?.details?.precipitation_amount)
  // next_6_hours amounts are six hours' worth: an hourly rate is what we draw.
  const hourly = amount === null ? null : entry?.data?.next_1_hours ? amount : amount / 6

  const precip = symbol?.precip ?? 'none'
  const storm = symbol?.storm ?? false
  let precipIntensity = symbol?.precipIntensity ?? 0
  if (precip !== 'none' && hourly !== null && hourly > 0) {
    precipIntensity = clamp01(0.25 + hourly / 5)
  }

  const fogFraction = finite(instant.fog_area_fraction)
  const fog = (fogFraction !== null && fogFraction >= FOG_FRACTION_MIN) || (symbol?.fog ?? false)

  const low = finite(instant.cloud_area_fraction_low)
  const medium = finite(instant.cloud_area_fraction_medium)
  const high = finite(instant.cloud_area_fraction_high)
  const hasLayers = low !== null || medium !== null || high !== null
  const total = finite(instant.cloud_area_fraction)
  let cloudCover = hasLayers
    ? denseCover((low ?? 0) / 100, (medium ?? 0) / 100)
    : total !== null
      ? clamp01(total / 100)
      : (symbol?.cloudCover ?? CLEAR_SKY.cloudCover)
  const cirrus = high !== null ? clamp01(high / 100) : 0
  // Something falling means a sky full of what it falls from.
  if (precip !== 'none') cloudCover = Math.max(cloudCover, 0.75)
  if (storm) cloudCover = Math.max(cloudCover, 0.9)

  const temperature = finite(instant.air_temperature)
  return {
    cloudCover,
    cirrus,
    windSpeedMs: Math.max(0, finite(instant.wind_speed) ?? CLEAR_SKY.windSpeedMs),
    windFromDeg: ((finite(instant.wind_from_direction) ?? CLEAR_SKY.windFromDeg) % 360 + 360) % 360,
    precip,
    precipIntensity: precip === 'none' ? 0 : precipIntensity,
    fog,
    storm,
    temperatureC: temperature === null ? null : Math.round(temperature * 10) / 10,
    // Something falling or a storm: the symbol's words. Fog (by fraction or
    // symbol): "Fog", not a cloudy symbol's words. Otherwise the sky as it is
    // now (the instant dense cover the sky is drawn from), not the next
    // hour's summary, so the label and the picture agree; high cirrus alone
    // makes "Clear" "Mostly clear" at most.
    condition:
      storm || precip !== 'none'
        ? (symbol?.label ?? coverLabel(cloudCover))
        : fog
          ? 'Fog'
          : coverLabel(cloudCover, cirrus),
  }
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
