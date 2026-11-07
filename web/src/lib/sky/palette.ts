/**
 * The sky's colours from the sun's elevation: night, astronomical / nautical /
 * civil twilight, golden hour, day, blended smoothly between keyframes, then
 * dimmed and greyed by cloud and storm. Pure; colours are sRGB 0..1 triples.
 *
 * Besides the plain top-to-horizon pair, twilight has the parts that make a
 * real one read as a sky and not a tint: the glow on the sun's side of the
 * horizon (orange low, through pink and violet above), and on the far side
 * the Belt of Venus (a pink band) over Earth's shadow (slate blue). The
 * shader places them; this only says what colour and how strong.
 */

import type { SkyWeather } from './weather'

export type Rgb = readonly [number, number, number]

export interface SkyPalette {
  /** Zenith colour (the top of the screen). */
  top: Rgb
  /** Horizon colour (the bottom). */
  horizon: Rgb
  /** The sun's glow colour. */
  sun: Rgb
  /** 0..1: how much the sun's glow shows (0 once it's well below the horizon). */
  sunGlow: number
  /** 0..1: the faint disc, only when the sun is up. */
  sunDisc: number
  /** Sunlit side of the clouds. */
  cloudLit: Rgb
  /** Shaded underside of the clouds. */
  cloudShade: Rgb
  /** 0 night .. 1 full day: how much daylight there is (drives theme tuning). */
  daylight: number
  /** Twilight glow low on the sun's side of the horizon (orange / peach). */
  glow: Rgb
  /** The same glow higher up, where it turns pink and violet. */
  glowHigh: Rgb
  /** 0..1: how strong the sun-side glow is (rises before sunrise, gone by mid-morning). */
  glowAmount: number
  /** The Belt of Venus: a soft pink band above the horizon opposite the sun. */
  belt: Rgb
  /** Earth's shadow: the slate-blue band under the belt. */
  shadow: Rgb
  /** 0..1: how strong the belt and the shadow are (around sunrise and sunset only). */
  beltAmount: number
}

interface Key {
  elevation: number
  top: Rgb
  horizon: Rgb
  sun: Rgb
  cloudLit: Rgb
  cloudShade: Rgb
  glow: Rgb
  glowHigh: Rgb
  belt: Rgb
  shadow: Rgb
}

const COLOURS = ['top', 'horizon', 'sun', 'cloudLit', 'cloudShade', 'glow', 'glowHigh', 'belt', 'shadow'] as const

const hex = (h: string): Rgb => {
  const n = parseInt(h.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/**
 * Keyframes by solar elevation (degrees), ascending. `top` is the top of the
 * window (about 50° up), `horizon` the haze at the horizon all round; the
 * sun-side glow and the belt are layered on by the shader, so the twilight
 * horizon here is a muted mauve, not orange everywhere.
 */
const KEYS: readonly Key[] = [
  // Night: a deep navy, a little lighter toward the horizon. The city's own
  // skyglow is added by the shader (scene.skyglow), so night clouds here are
  // only a dim grey it lights from below, never black.
  { elevation: -18, top: hex('#0a1640'), horizon: hex('#26305c'), sun: hex('#1a2244'), cloudLit: hex('#24346e'), cloudShade: hex('#101a44'), glow: hex('#26305c'), glowHigh: hex('#26305c'), belt: hex('#26305c'), shadow: hex('#121a40') },
  // Astronomical twilight: only a faint residual light on the sun's side
  { elevation: -12, top: hex('#0c1a4c'), horizon: hex('#323e78'), sun: hex('#2c3766'), cloudLit: hex('#33427e'), cloudShade: hex('#162052'), glow: hex('#4e4274'), glowHigh: hex('#2e3a72'), belt: hex('#28346a'), shadow: hex('#162050') },
  // Nautical twilight: a bluer, dimmer glow (dusky rose low, slate violet above)
  { elevation: -9, top: hex('#12245e'), horizon: hex('#46548e'), sun: hex('#5a4a7a'), cloudLit: hex('#58588c'), cloudShade: hex('#24305e'), glow: hex('#9a6a80'), glowHigh: hex('#4e5290'), belt: hex('#3e4680'), shadow: hex('#1e2a5c') },
  // Civil → nautical: deep navy-indigo up high over a periwinkle horizon, a
  // peach band low on the sun's side, violet above it
  { elevation: -6, top: hex('#182e72'), horizon: hex('#5a669a'), sun: hex('#8a5a8a'), cloudLit: hex('#84648a'), cloudShade: hex('#2e3866'), glow: hex('#d88a66'), glowHigh: hex('#7e6ca4'), belt: hex('#6c5a8c'), shadow: hex('#2a3662') },
  // Just after sunset (before sunrise): peach on the sun's side, pink above; the belt opposite
  { elevation: -2, top: hex('#2c4896'), horizon: hex('#8a8cb0'), sun: hex('#f09a6a'), cloudLit: hex('#e9a08a'), cloudShade: hex('#4c4a72'), glow: hex('#f8a560'), glowHigh: hex('#d48ca4'), belt: hex('#d69aae'), shadow: hex('#4a5686') },
  // Sun on the horizon: golden
  { elevation: 2, top: hex('#4569ae'), horizon: hex('#c8b4ac'), sun: hex('#ffb35c'), cloudLit: hex('#ffcf9a'), cloudShade: hex('#7a6a86'), glow: hex('#ffb66a'), glowHigh: hex('#eeb2a6'), belt: hex('#e2b2be'), shadow: hex('#687aa8') },
  // Golden hour: the horizon pales toward the day's haze
  { elevation: 8, top: hex('#4f87d0'), horizon: hex('#dcd4c8'), sun: hex('#ffd38a'), cloudLit: hex('#fff0d8'), cloudShade: hex('#9a9aae'), glow: hex('#ffd69c'), glowHigh: hex('#f4d8c8'), belt: hex('#e8d2d8'), shadow: hex('#9aaed0') },
  // Day: a clear blue up high, a pale hazy horizon
  { elevation: 20, top: hex('#4a88da'), horizon: hex('#bad6f0'), sun: hex('#fff4dc'), cloudLit: hex('#ffffff'), cloudShade: hex('#bcc7d6'), glow: hex('#fff0d8'), glowHigh: hex('#f4ecea'), belt: hex('#dce4f0'), shadow: hex('#b4c6e0') },
  // High sun: a saturated blue at the top easing to a cyan-white haze
  { elevation: 45, top: hex('#3d7cd8'), horizon: hex('#c4def5'), sun: hex('#fffaf0'), cloudLit: hex('#ffffff'), cloudShade: hex('#c4ced9'), glow: hex('#fff6e8'), glowHigh: hex('#f4f2f2'), belt: hex('#dce6f2'), shadow: hex('#bccbe2') },
]

export function skyPalette(elevation: number, weather: Pick<SkyWeather, 'cloudCover' | 'storm' | 'fog'>): SkyPalette {
  const k = interpolate(elevation)
  const cover = clamp01(weather.cloudCover)
  const daylight = smoothstep(-8, 10, elevation)

  // Overcast greys the sky toward its own luminance and dims it a little;
  // a storm darkens it further. Fog lifts it toward a pale grey haze. Without
  // daylight cloud greys it far less: an overcast dusk or night stays blue.
  const grey = cover * (0.25 + 0.4 * daylight) + (weather.storm ? 0.2 : 0)
  const dim = 1 - cover * 0.18 - (weather.storm ? 0.32 : 0)
  const shape = (c: Rgb) => scale(desaturate(c, grey), dim)

  let top = shape(k.top)
  let horizon = shape(k.horizon)
  let cloudLit = scale(desaturate(k.cloudLit, cover * (0.15 + 0.35 * daylight)), weather.storm ? 0.55 : 1 - cover * 0.15)
  let cloudShade = scale(desaturate(k.cloudShade, cover * (0.1 + 0.3 * daylight)), weather.storm ? 0.5 : 1 - cover * 0.1)
  if (weather.fog) {
    const haze = mix(horizon, [0.78, 0.8, 0.83], 0.5 * daylight + 0.1)
    top = mix(top, haze, 0.35)
    horizon = mix(horizon, haze, 0.55)
    cloudLit = mix(cloudLit, haze, 0.3)
  }

  // The sun-side glow brightens from astronomical twilight (a faint residual
  // light) through nautical (bluer, dimmer) to just before sunrise, then hands over to the sun's own glow as it climbs. The belt
  // and Earth's shadow show from just before sunset until it's nearly dark
  // (and the same before sunrise). Cloud hides both; fog washes them out.
  const veil = (1 - cover * 0.75) * (weather.fog ? 0.4 : 1)
  const glowAmount = smoothstep(-14, -3, elevation) * (1 - smoothstep(3, 11, elevation)) * veil
  const beltAmount = smoothstep(2.5, -0.5, elevation) * smoothstep(-9, -4, elevation) * (1 - cover) * (weather.fog ? 0.4 : 1)

  return {
    top,
    horizon,
    sun: k.sun,
    sunGlow: smoothstep(-10, 0, elevation),
    sunDisc: smoothstep(-1, 3, elevation),
    cloudLit,
    cloudShade,
    daylight,
    glow: shape(k.glow),
    glowHigh: shape(k.glowHigh),
    glowAmount,
    belt: shape(k.belt),
    shadow: shape(k.shadow),
    beltAmount,
  }
}

function interpolate(elevation: number): Key {
  if (elevation <= KEYS[0].elevation) return KEYS[0]
  const last = KEYS[KEYS.length - 1]
  if (elevation >= last.elevation) return last
  let i = 0
  while (KEYS[i + 1].elevation < elevation) i++
  const a = KEYS[i]
  const b = KEYS[i + 1]
  // Smooth within each span so the blend has no visible kinks at the keys.
  const t = smoothstep(a.elevation, b.elevation, elevation)
  const out = { elevation } as { -readonly [K in keyof Key]: Key[K] }
  for (const c of COLOURS) out[c] = mix(a[c], b[c], t)
  return out
}

export function luminance(c: Rgb): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

/** Saturation-ish measure: max channel minus min channel. */
export function chroma(c: Rgb): number {
  return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

export function scale(c: Rgb, s: number): Rgb {
  return [clamp01(c[0] * s), clamp01(c[1] * s), clamp01(c[2] * s)]
}

export function desaturate(c: Rgb, amount: number): Rgb {
  const l = luminance(c)
  return mix(c, [l, l, l], clamp01(amount))
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * A Tailwind/shadcn HSL triplet as the CSS variables hold it ("0 0% 96%",
 * "220 14.3% 95.9%", commas tolerated) to sRGB, or null if it doesn't parse.
 */
export function hslTripletToRgb(value: string): Rgb | null {
  const parts = value.trim().replace(/,/g, ' ').split(/\s+/)
  if (parts.length < 3) return null
  const h = Number.parseFloat(parts[0])
  const s = Number.parseFloat(parts[1]) / 100
  const l = Number.parseFloat(parts[2]) / 100
  if (![h, s, l].every(Number.isFinite)) return null
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return [clamp01(f(0)), clamp01(f(8)), clamp01(f(4))]
}
