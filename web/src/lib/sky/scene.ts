/**
 * Everything the sky renderer draws, as plain numbers: the palette for the
 * sun's elevation at this place and instant, where the sun sits on screen,
 * the clouds' cover and drift, what's falling, and how strongly the sky shows
 * over the app's own surface in the current theme. Pure, so the whole picture
 * can be checked without a GPU.
 */

import { clamp01, luminance, mix, scale, skyPalette, smoothstep, type Rgb } from './palette'
import { solarPosition } from './sun'
import type { SkyWeather } from './weather'

export interface SkyScene {
  top: Rgb
  horizon: Rgb
  sun: Rgb
  /** Sun on screen, 0..1 with y up (off the window below the horizon, or past its top at a high noon). */
  sunX: number
  sunY: number
  /** The sun's azimuth relative to the middle of the window, degrees (negative: left). */
  sunAzimuthView: number
  /** Twilight: the sun-side glow, the belt of Venus, Earth's shadow (see SkyPalette). */
  glow: Rgb
  glowHigh: Rgb
  glowAmount: number
  belt: Rgb
  shadow: Rgb
  beltAmount: number
  /**
   * 0..1: the weather's `cirrus` (high cloud): none without it, gone under
   * dense cloud, fog or anything falling, day and night alike (thin high
   * cloud catches the last light at dusk and the city's glow at night). The
   * shader draws the close-up cloud's thin wisps as silky strands with it,
   * and more of them (`veil`).
   */
  cirrus: number
  /**
   * 0..1: the thin cloud every dry sky has (the shader's uVeil.x), drawn as
   * the close-up cloud's translucent wisps (lib/sky/cloud-closeup.ts
   * WISP_COVER): present as ambience (BASE_VEIL, a clear sky included, never
   * read as overcast), more with the forecast's high cloud and cover. Not
   * data: the conditions line still says "Clear".
   */
  veil: number
  /**
   * 0..1: how long the sky's top-to-horizon ramp runs (uVeil.y): 0 by day,
   * 1 from just after sunset through the night, so twilight and night range
   * from a deep zenith down through a lighter middle to the horizon instead
   * of one even fill.
   */
  dusk: number
  /**
   * City skyglow (the shader's uSkyglow): the soft warm grey-mauve haze the
   * lowest sky turns toward at night, and a little of the clouds' underside,
   * by `skyglowAmount` (constant, faded out as daylight swamps it). Darker in
   * the dark theme.
   */
  skyglow: Rgb
  skyglowAmount: number
  /**
   * Clear-sky texture, 0..1 each (the shader's uTex): never cloud, only how a
   * real clear sky varies. `sunPattern` is the brightness and saturation
   * pattern around the sun (gone at night, softened under cloud and fog);
   * `texture` the low-frequency luminance and hue texture (quiet at night);
   * `strata` the faint haze layers low in the view (strongest with a low sun,
   * hidden by dense cloud, fog or anything falling).
   */
  sunPattern: number
  texture: number
  strata: number
  sunGlow: number
  sunDisc: number
  cloudCover: number
  cloudLit: Rgb
  cloudShade: Rgb
  /** Cloud drift in noise-space units per second (before the motion ease). */
  windX: number
  windY: number
  /** -1..1: how far rain leans with the wind. */
  rainLean: number
  /** 0 none, 1 rain, 2 snow, 3 sleet. */
  precipKind: number
  precipIntensity: number
  /** 0..1: how visible rain and snow are (quieter on the dark theme, where white flakes stand out). */
  precipAlpha: number
  fog: number
  storm: number
  /** 0..1: how much the sky shows over the theme background. */
  strength: number
  daylight: number
  /** The sun's elevation, for tests and the debug readout. */
  elevation: number
}

export interface SceneInput {
  date: Date
  latitude: number
  longitude: number
  weather: SkyWeather
  /**
   * The signed-out pages' dark theme (a `themed` sky, where text sits right on
   * it): the whole sky dimmed and calmed. Only the sky's tuning changes; never
   * the theme.
   */
  dark: boolean
  /**
   * The app's dark theme (darkExposure): the same sky exposed for a dark app
   * instead, deeper and richer rather than dimmed. Ignored with `dark`.
   */
  dim?: boolean
}

/**
 * The clouds' drift, in cloud offset units per second (cloud-closeup.ts): a
 * steady speed, nudged by the wind and the cloud, not set by them. It once
 * scaled with the wind, so a still clear day crawled and a breezy cloudy one
 * raced (Liam, 10-10: "when there's little clouds there isn't enough
 * movement, but when I turn on cloudy it's moving too fast").
 */
export const CLOUD_SPEED = 0.13
/** The wind adds up to this much on top, from still air up to WIND_FULL_MS. */
export const WIND_SPEED_GAIN = 0.4
const WIND_FULL_MS = 12
/**
 * A thin sky drifts a little faster and a full deck a little slower: sparse,
 * soft clouds read as slow at the same speed, a full deck as fast.
 */
export const CLEAR_SPEED_FACTOR = 1.2
export const OVERCAST_SPEED_FACTOR = 0.85

/** The drift speed for a wind (m/s) and a cloud cover (0..1). */
export function cloudDriftSpeed(windSpeedMs: number, cloudCover: number): number {
  const wind = 1 + WIND_SPEED_GAIN * smoothstep(0, WIND_FULL_MS, Math.max(0, windSpeedMs))
  const cover = CLEAR_SPEED_FACTOR + (OVERCAST_SPEED_FACTOR - CLEAR_SPEED_FACTOR) * clamp01(cloudCover)
  return CLOUD_SPEED * wind * cover
}

/**
 * The screen is a window onto the sky: its bottom edge is just below the
 * horizon, its top about 50° up, and it spans about 100° of azimuth. The
 * shader maps every pixel to a direction with these, so they live here once.
 */
export const VIEW_BOTTOM_DEG = -3
export const VIEW_TOP_DEG = 50
export const VIEW_WIDTH_DEG = 100
/**
 * Elevation grows with screen height to this power, like a wide lens tilted
 * a little up: the first ten degrees above the horizon, where nearly all of
 * a sky's colour happens, get about a third of the screen instead of a fifth.
 */
export const VIEW_CURVE = 1.35

/** Screen height (0 bottom .. 1 top) of an elevation, the inverse of the shader's mapping. */
export function viewY(elevation: number): number {
  const t = (elevation - VIEW_BOTTOM_DEG) / (VIEW_TOP_DEG - VIEW_BOTTOM_DEG)
  return t <= 0 ? t : t ** (1 / VIEW_CURVE)
}
/**
 * The window faces the equator but turns part of the way toward the sun's
 * side, so a morning sun far to the east still lights the left of the window
 * (offset from the middle, never dead centre) instead of glowing off-screen.
 */
const VIEW_FOLLOWS_SUN = 0.6

export function computeSkyScene({ date, latitude, longitude, weather, dark, dim: dimIn = false }: SceneInput): SkyScene {
  const dim = dimIn && !dark
  const { elevation, azimuth } = solarPosition(date, latitude, longitude)
  const p = skyPalette(elevation, weather)

  // The viewer faces the equator: south in the north, north in the south, so
  // the sun crosses from left (east) to right (west) in the north.
  const facing = latitude >= 0 ? 180 : 0
  const sunRel = wrap180(azimuth - facing)
  const sunAzimuthView = sunRel * (1 - VIEW_FOLLOWS_SUN)
  const sunX = 0.5 + sunAzimuthView / VIEW_WIDTH_DEG
  const sunY = viewY(elevation)

  // Clouds go where the wind blows TO, seen the same way round as the sun.
  const toRel = wrap180(weather.windFromDeg + 180 - facing) * (Math.PI / 180)
  const speed = cloudDriftSpeed(weather.windSpeedMs, weather.cloudCover)
  const windX = Math.sin(toRel) * speed
  const windY = Math.cos(toRel) * speed * 0.25

  // Theme tuning. In the dark theme a bright day sky would glare out of a
  // near-black app, so daylight is dimmed and calmed (night is already dark).
  // In the light theme a night sky would sit as a heavy block in a pale app,
  // so it shows a little less strongly than a day sky.
  let { top, horizon, cloudLit, cloudShade, glow, glowHigh, belt, shadow } = p
  let sun = p.sun
  let sunGlow = p.sunGlow
  let sunDisc = p.sunDisc
  if (dim) {
    ;({ top, horizon, cloudLit, cloudShade, glow, glowHigh, belt, shadow, sun, sunGlow, sunDisc } = darkExposure(
      { top, horizon, cloudLit, cloudShade, glow, glowHigh, belt, shadow, sun, sunGlow, sunDisc },
      p.daylight,
      weather.cloudCover,
    ))
  }
  if (dark) {
    const dim = 1 - 0.5 * p.daylight
    const tone = (c: Rgb, s = dim) => scale(c, s)
    // Dimmed but not greyed: a dimmed day sky stays a deep blue.
    top = tone(top, 1 - 0.42 * p.daylight)
    // A pale day haze dimmed only turns grey: keep it a lighter blue instead.
    horizon = tone(mix(horizon, p.top, 0.45 * p.daylight))
    // The glows are light: dimmed as far, a sunrise's orange turns brown.
    glow = tone(glow, 1 - 0.25 * p.daylight)
    glowHigh = tone(glowHigh)
    belt = tone(belt)
    shadow = tone(shadow)
    cloudLit = scale(cloudLit, 1 - 0.55 * p.daylight)
    cloudShade = scale(cloudShade, 1 - 0.5 * p.daylight)
    sun = mix(sun, scale(sun, 0.7), p.daylight * smoothstep(4, 14, elevation))
  }
  if (!dark && !dim) {
    // A near-black night mixed over a pale surface only makes grey. In the
    // light theme the night sky is a deep, saturated ultramarine instead, shown a
    // little more strongly, so it reads as night rather than as dust. In
    // twilight the top is lifted to a clearer blue-hour blue instead, so the
    // dawn and dusk sky stays blue above its glow rather than slate.
    // The horizon lifts to a periwinkle (the skyglow warms it toward a soft
    // grey-mauve), so the night keeps its range, and night clouds stay in the
    // blue family, lighter and darker blues, never grey.
    const night = 1 - smoothstep(-14, -3, elevation)
    const blueHour = smoothstep(-15, -7, elevation) * (1 - smoothstep(-1, 6, elevation))
    top = mix(mix(top, [0.03, 0.09, 0.38], 0.85 * night), [0.12, 0.22, 0.6], 0.4 * blueHour)
    horizon = mix(horizon, [0.44, 0.55, 0.88], 0.85 * night)
    cloudLit = mix(cloudLit, [0.24, 0.34, 0.7], 0.8 * night)
    cloudShade = mix(cloudShade, [0.06, 0.11, 0.38], 0.8 * night)
  }
  // In the light theme a dusk or night sky mixed over a pale surface at the
  // day's strength loses its range (the darkest it can reach is a quarter
  // white): shown more strongly once the sun is down (the day and golden
  // hour as before).
  const strength = dim
    ? DIM_STRENGTH
    : dark
      ? 0.82 - 0.12 * p.daylight
      : 0.74 + 0.02 * p.daylight + LIGHT_NIGHT_STRENGTH_LIFT * (1 - smoothstep(-6, 4, elevation))

  // High thin cloud, day and night (hidden as the dense cover closes in).
  // Guarded: a reading from before the field existed has none.
  const highCloud = typeof weather.cirrus === 'number' && Number.isFinite(weather.cirrus) ? clamp01(weather.cirrus) : 0
  const dry = weather.fog || weather.precip !== 'none' ? 0 : 1
  const cover = clamp01(weather.cloudCover)
  const cirrus = highCloud * dry * smoothstep(0.85, 0.35, cover)
  // The thin cloud: the base floor in every dry sky, more with high cloud
  // (from about 0.3, a full veil at 1) and with cover. Rain, snow and fog keep
  // their own look.
  const veil = dry * (1 - (1 - BASE_VEIL) * (1 - smoothstep(0.3, 1, cirrus)) * (1 - 0.6 * cover))
  const dusk = 1 - smoothstep(-2, 6, elevation)
  const skyglow = dark || dim ? SKYGLOW_DARK : SKYGLOW_LIGHT
  const skyglowAmount = SKYGLOW_AMOUNT * (1 - smoothstep(-6, 4, elevation))

  const tex = clearSkyTexture(elevation, weather, dark)

  const precipKind = weather.precip === 'rain' ? 1 : weather.precip === 'snow' ? 2 : weather.precip === 'sleet' ? 3 : 0
  return {
    top,
    horizon,
    sun,
    sunX,
    sunY,
    sunAzimuthView,
    glow,
    glowHigh,
    glowAmount: p.glowAmount,
    belt,
    shadow,
    beltAmount: p.beltAmount,
    cirrus,
    veil,
    dusk,
    skyglow,
    skyglowAmount,
    ...tex,
    sunGlow: sunGlow * (1 - 0.6 * weather.cloudCover),
    sunDisc: sunDisc * smoothstep(0.6, 0.1, weather.cloudCover),
    cloudCover: weather.cloudCover,
    cloudLit,
    cloudShade,
    windX,
    windY,
    rainLean: Math.max(-1, Math.min(1, Math.sin(toRel) * (weather.windSpeedMs / 12))),
    precipKind,
    precipIntensity: precipKind ? weather.precipIntensity : 0,
    precipAlpha: dark || dim ? 0.6 : 1,
    fog: weather.fog ? 1 : 0,
    storm: weather.storm ? 1 : 0,
    strength,
    daylight: p.daylight,
    elevation,
  }
}

/**
 * The scene a fraction `t` (0..1) of the way from `a` to `b`, for the short
 * blend when the weather or the place changes mid-session: every number and
 * colour eased linearly (the caller shapes `t`). What's falling can't be half
 * rain and half snow, so a change of kind fades the old one out over the
 * first half and the new one in over the second.
 */
export function lerpScene(a: SkyScene, b: SkyScene, t: number): SkyScene {
  const out = {} as Record<keyof SkyScene, number | Rgb>
  for (const key of Object.keys(b) as Array<keyof SkyScene>) {
    const x = a[key]
    const y = b[key]
    // a(1 - t) + bt: exactly a at 0 and exactly b at 1, whatever the floats.
    out[key] = typeof y === 'number' ? (x as number) * (1 - t) + y * t : mix(x as Rgb, y, t)
  }
  const scene = out as unknown as SkyScene
  if (a.precipKind === b.precipKind) {
    scene.precipKind = b.precipKind
  } else if (t < 0.5) {
    scene.precipKind = a.precipKind
    scene.precipIntensity = a.precipIntensity * (1 - 2 * t)
  } else {
    scene.precipKind = b.precipKind
    scene.precipIntensity = b.precipIntensity * (2 * t - 1)
  }
  return scene
}

/**
 * How strongly the app's dark-theme sky shows over the dark surface: nearly
 * fully, so its colour is its own; the darkness comes from darkExposure, not
 * from mixing toward black (which flattens a sky like a filter).
 */
export const DIM_STRENGTH = 0.92

/**
 * The app's dark theme: the same sky, exposed for a dark app, the way a
 * photographer shoots a bright day darker (about a stop and a half under,
 * through a polariser) rather than laying a dark filter over it (Liam, 10-18:
 * the old dimming "took away the contrast of the colors"). By `daylight`
 * (0 at night, 1 in full day), so a night, already dark, is left as it is and
 * a sunset nearly so:
 *  - the blue sky and its haze are darkened most and grow MORE saturated (a
 *    polariser cuts the scattered skylight), the pale haze turning toward
 *    the zenith's blue instead of grey;
 *  - the clouds, which a polariser leaves bright, are darkened least, so they
 *    stand out more against the deeper sky, not less; under a full deck,
 *    with no blue to stand out against, they are darkened more (`cloudCover`);
 *  - the twilight glows keep most of their light and colour;
 *  - the sun's glare (its glow and core) is calmed.
 * Each colour keeps its hue: its luminance is scaled and its chroma pushed out
 * from that luminance (exposeColour), never mixed toward black or grey.
 */
export function darkExposure<T extends Pick<SkyScene, 'top' | 'horizon' | 'cloudLit' | 'cloudShade' | 'glow' | 'glowHigh' | 'belt' | 'shadow' | 'sun' | 'sunGlow' | 'sunDisc'>>(
  c: T,
  daylight: number,
  cloudCover = 0,
): T {
  const d = clamp01(daylight)
  const deck = DIM_DECK * smoothstep(0.4, 1, cloudCover)
  return {
    ...c,
    top: exposeColour(c.top, 1 - DIM_SKY * d, DIM_SKY_SAT * d),
    horizon: exposeColour(mix(c.horizon, c.top, DIM_HAZE_CLEAR * d), 1 - DIM_SKY * d, DIM_SKY_SAT * d),
    glow: exposeColour(c.glow, 1 - DIM_GLOW * d, 0.2 * d),
    glowHigh: exposeColour(c.glowHigh, 1 - DIM_GLOW * d, 0.2 * d),
    belt: exposeColour(c.belt, 1 - DIM_GLOW * d, 0.2 * d),
    shadow: exposeColour(c.shadow, 1 - DIM_SKY * d, DIM_SKY_SAT * d),
    cloudLit: exposeColour(c.cloudLit, 1 - (DIM_CLOUD_LIT + deck) * d, 0.1 * d),
    cloudShade: exposeColour(c.cloudShade, 1 - (DIM_CLOUD_SHADE + deck) * d, 0.15 * d),
    sun: exposeColour(c.sun, 1 - 0.2 * d, 0),
    sunGlow: c.sunGlow * (1 - DIM_GLARE * d),
    sunDisc: c.sunDisc * (1 - DIM_GLARE * d),
  }
}

/**
 * darkExposure's amounts at full daylight: how much darker the sky, its
 * twilight glows, the clouds' lit and shaded sides and the sun's glare get
 * (fractions of their luminance), how much more saturated the sky grows, and
 * how much of the pale haze clears toward the zenith's blue.
 */
export const DIM_SKY = 0.55
export const DIM_SKY_SAT = 0.35
export const DIM_HAZE_CLEAR = 0.3
export const DIM_GLOW = 0.35
export const DIM_CLOUD_LIT = 0.3
export const DIM_CLOUD_SHADE = 0.4
export const DIM_GLARE = 0.4
/** How much more the clouds are darkened under a full deck, on top of DIM_CLOUD_LIT / DIM_CLOUD_SHADE. */
export const DIM_DECK = 0.25

/**
 * A colour with its luminance scaled by `gain` and its chroma pushed out from
 * that luminance by `saturate` (0: the same saturation, 0.35: 35% more): the
 * same hue, deeper or lighter, never mixed toward black or grey.
 */
export function exposeColour(c: Rgb, gain: number, saturate: number): Rgb {
  const l = luminance(c) * gain
  const k = 1 + saturate
  return [
    clamp01(l + (c[0] * gain - l) * k),
    clamp01(l + (c[1] * gain - l) * k),
    clamp01(l + (c[2] * gain - l) * k),
  ]
}

/**
 * The strength the sky is mixed over the surface with after an even wash
 * toward that surface: `strength * (1 - wash)`, the same as laying the
 * surface colour over the sky at opacity `wash`, alike at every point (the
 * signed-out pages, where text sits right on the sky). A washed sky starts
 * from at most WASHED_STRENGTH_CAP: the light theme's stronger night
 * (LIGHT_NIGHT_STRENGTH_LIFT) is for range behind the app's cards, and
 * behind bare text it would cost the 4.5:1 the wash was measured for.
 */
export function washedStrength(strength: number, wash: number): number {
  const w = clamp01(wash)
  return (w > 0 ? Math.min(strength, WASHED_STRENGTH_CAP) : strength) * (1 - w)
}

/** The most a washed sky's own strength counts for (a light-theme day's). */
export const WASHED_STRENGTH_CAP = 0.76

/** The clear-sky texture amount at night, against 1 by day: a clear night is textured too, gently. */
export const NIGHT_TEXTURE = 0.7

/**
 * The thin cloud's floor (SkyScene.veil): every dry sky has some, so even a
 * clear one has a real sky's texture. At this cover the shader shows a few
 * translucent wisps drifting by, over roughly a tenth of the screen.
 */
export const BASE_VEIL = 0.3

/**
 * City skyglow at night (SkyScene.skyglow): the haze colour the horizon turns
 * toward, by SKYGLOW_AMOUNT at most, the same everywhere (most people use this
 * in or near a town). A soft grey-mauve with a hint of warmth, deeper in the
 * dark theme.
 */
export const SKYGLOW_LIGHT: Rgb = [0.66, 0.57, 0.5]
export const SKYGLOW_DARK: Rgb = [0.27, 0.26, 0.38]
export const SKYGLOW_AMOUNT = 0.62

/** How much more strongly the light theme shows a sky once the sun is down (0.76 by day, 0.92 at night). */
export const LIGHT_NIGHT_STRENGTH_LIFT = 0.18

/**
 * How strongly the clear sky's texture shows (SkyScene sunPattern, texture,
 * strata). None of it adds cloud: cloudCover and cirrus alone do that.
 */
export function clearSkyTexture(
  elevation: number,
  weather: Pick<SkyWeather, 'cloudCover' | 'fog' | 'precip'>,
  dark: boolean,
): Pick<SkyScene, 'sunPattern' | 'texture' | 'strata'> {
  const cover = clamp01(weather.cloudCover)
  const fog = weather.fog ? 1 : 0
  const falling = weather.precip !== 'none' ? 1 : 0
  // Scattered sunlight: whenever the sky is lit, through the twilight (just
  // after sunset the deep blue 90° from the sun is at its most striking), and
  // diffused by dense cloud and fog (an overcast is lit evenly).
  const lit = smoothstep(-14, -3, elevation)
  // In the dark theme a whiter patch round the sun only greys the dimmed blue.
  const sunPattern = lit * (1 - 0.75 * smoothstep(0.3, 0.95, cover)) * (1 - 0.6 * fog) * (dark ? 0.7 : 1)
  const texture = (NIGHT_TEXTURE + (1 - NIGHT_TEXTURE) * lit) * (1 - 0.4 * fog)
  // Haze layers show best with a low sun (dawn, dusk, golden hour), still a
  // little by day, barely at night; dense cloud, fog or rain hide them.
  const lowSun = 1 - smoothstep(6, 30, elevation)
  const strata = (0.45 + 0.55 * lowSun) * (0.12 + 0.88 * lit) * smoothstep(0.85, 0.4, cover) * (1 - fog) * (1 - falling) * (dark ? 0.85 : 1)
  return { sunPattern, texture, strata }
}

function wrap180(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180
}

export type SkyPhase = 'night' | 'dawn' | 'day' | 'golden' | 'dusk'

/**
 * The part of the day the sun's elevation (degrees) says it is: night below
 * civil twilight (-6°), dawn / dusk from there to just over the horizon
 * (rising or setting), golden hour while the sun is low, day above that.
 */
export function skyPhase(elevation: number, rising: boolean): SkyPhase {
  if (elevation < -6) return 'night'
  if (elevation < 2) return rising ? 'dawn' : 'dusk'
  if (elevation < 10) return 'golden'
  return 'day'
}

/** Whether the sun is climbing at this instant (it's higher ten minutes on). */
export function isSunRising(date: Date, latitude: number, longitude: number): boolean {
  const now = solarPosition(date, latitude, longitude).elevation
  const later = solarPosition(new Date(date.getTime() + 10 * 60_000), latitude, longitude).elevation
  return later > now
}

/** Default latitude when the request carries no location: just for the sun's height, never shown. */
export const FALLBACK_LATITUDE = 40

/**
 * The zone's standard (non-daylight-saving) UTC offset, in getTimezoneOffset
 * minutes: daylight saving always moves the clock forward, which makes the
 * offset smaller, so the standard one is the larger of January's and July's.
 * Without this a summer clock would put the sun 15° (an hour) out.
 */
export function standardTimezoneOffset(date: Date): number {
  const year = date.getFullYear()
  return Math.max(new Date(year, 0, 1).getTimezoneOffset(), new Date(year, 6, 1).getTimezoneOffset())
}

/**
 * Longitude from the browser's UTC offset: `getTimezoneOffset()` is minutes
 * BEHIND UTC (420 in California), and the sun moves 15° an hour.
 */
export function longitudeFromOffset(timezoneOffsetMinutes: number): number {
  return Math.max(-180, Math.min(180, -timezoneOffsetMinutes / 4)) + 0
}
