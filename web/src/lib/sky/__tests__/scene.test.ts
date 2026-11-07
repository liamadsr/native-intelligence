import { describe, expect, it } from 'vitest'
import { applyOverrideTime, parseSkyOverride, SKY_PRESETS } from '../dev-override'
import { BASE_VEIL, clearSkyTexture, computeSkyScene, DIM_STRENGTH, exposeColour, isSunRising, lerpScene, NIGHT_TEXTURE, longitudeFromOffset, skyPhase, standardTimezoneOffset, viewY, VIEW_BOTTOM_DEG, VIEW_TOP_DEG } from '../scene'
import { chroma, luminance } from '../palette'
import { CLEAR_SKY } from '../weather'

// London, the June solstice.
const LAT = 51.5
const LON = -0.13
const scene = (iso: string, extra: Partial<Parameters<typeof computeSkyScene>[0]> = {}) =>
  computeSkyScene({ date: new Date(iso), latitude: LAT, longitude: LON, weather: CLEAR_SKY, dark: false, ...extra })

describe('computeSkyScene', () => {
  it('puts the morning sun on the left and the evening sun on the right (facing south)', () => {
    expect(scene('2024-06-21T06:00:00Z').sunX).toBeLessThan(0.4)
    expect(scene('2024-06-21T18:00:00Z').sunX).toBeGreaterThan(0.6)
    const noon = scene('2024-06-21T12:00:00Z')
    expect(Math.abs(noon.sunX - 0.5)).toBeLessThan(0.05)
    expect(noon.sunY).toBeGreaterThan(0.7)
  })

  it('is a window onto the sky: the sun sits at its real elevation, offset toward its real side', () => {
    // Toronto, 10 October 2026 (UTC-4).
    const at = (hhmm: string, extra: Partial<Parameters<typeof computeSkyScene>[0]> = {}) => {
      const [h, m] = hhmm.split(':').map(Number)
      return computeSkyScene({ date: new Date(Date.UTC(2026, 9, 10, h + 4, m)), latitude: 43.65, longitude: -79.38, weather: CLEAR_SKY, dark: false, ...extra })
    }
    const dawn = at('07:00')
    expect(dawn.elevation).toBeLessThan(-3)
    // The sun is east of south: left of the middle, not dead centre, and still on the window's left half.
    expect(dawn.sunAzimuthView).toBeLessThan(-15)
    expect(dawn.sunX).toBeGreaterThan(0)
    expect(dawn.sunX).toBeLessThan(0.35)
    // Below the horizon, so below the window's horizon line.
    expect(dawn.sunY).toBeLessThan(viewY(0))
    expect(dawn.glowAmount).toBeGreaterThan(0.5)
    const dusk = at('19:00')
    expect(dusk.sunX).toBeGreaterThan(0.65)
    expect(dusk.beltAmount).toBeGreaterThan(0.5)
    // The horizon gets more of the window than a straight line would give it.
    expect(viewY(10)).toBeGreaterThan((10 - VIEW_BOTTOM_DEG) / (VIEW_TOP_DEG - VIEW_BOTTOM_DEG))
    expect(viewY(VIEW_TOP_DEG)).toBeCloseTo(1)
    expect(viewY(VIEW_BOTTOM_DEG)).toBeCloseTo(0)
  })

  it('draws the high cloud day and night, scaled by it, hidden by dense cloud, fog or rain', () => {
    // Toronto, 10 October 2026 (UTC-4).
    const at = (hhmm: string, weather: Parameters<typeof computeSkyScene>[0]['weather']) => {
      const [h, m] = hhmm.split(':').map(Number)
      return computeSkyScene({ date: new Date(Date.UTC(2026, 9, 10, h + 4, m)), latitude: 43.65, longitude: -79.38, weather, dark: false })
    }
    // No high cloud, no streaks; a sky of thin cirrus shows them nearly in full, clouds untouched.
    expect(at('12:30', CLEAR_SKY).cirrus).toBe(0)
    const veiled = at('12:30', SKY_PRESETS.cirrus)
    expect(veiled.cirrus).toBeGreaterThan(0.8)
    expect(veiled.cloudCover).toBe(0)
    // Scaled by the high cloud.
    const half = at('12:30', { ...SKY_PRESETS.cirrus, cirrus: 0.45 }).cirrus
    expect(half).toBeCloseTo(veiled.cirrus / 2, 2)
    // Partly cloudy: some show between the clouds; overcast, fog or rain: none.
    const partly = at('12:30', SKY_PRESETS.cloudy).cirrus
    expect(partly).toBeGreaterThan(0)
    expect(partly).toBeLessThan(SKY_PRESETS.cloudy.cirrus)
    expect(at('12:30', { ...SKY_PRESETS.cirrus, cloudCover: 1 }).cirrus).toBe(0)
    expect(at('12:30', { ...SKY_PRESETS.cirrus, fog: true }).cirrus).toBe(0)
    expect(at('12:30', { ...SKY_PRESETS.rain, cirrus: 1 }).cirrus).toBe(0)
    // Dusk and night: thin high cloud stays (lit by the glow, then the
    // skyglow), and thickens the soft masses into a veil.
    for (const t of ['18:40', '19:20', '23:30']) {
      const night = at(t, SKY_PRESETS.cirrus)
      const clearNight = at(t, CLEAR_SKY)
      expect(night.cirrus).toBeCloseTo(veiled.cirrus)
      expect(night.veil).toBeGreaterThan(0.9)
      expect(clearNight.cirrus).toBe(0)
      expect(clearNight.veil).toBeGreaterThanOrEqual(BASE_VEIL)
      expect(clearNight.veil).toBeLessThan(BASE_VEIL + 0.05)
    }
  })

  it('has a base layer of soft cloud masses in every dry sky, a floor the forecast only adds to', () => {
    const at = (iso: string, weather: Parameters<typeof computeSkyScene>[0]['weather']) => scene(iso, { weather })
    for (const iso of ['2024-06-21T12:00:00Z', '2024-06-21T20:30:00Z', '2024-12-21T00:00:00Z']) {
      const clear = at(iso, CLEAR_SKY)
      // Ambience, not data: the cover stays the forecast's.
      expect(clear.veil).toBeGreaterThanOrEqual(BASE_VEIL)
      expect(clear.veil).toBeLessThan(BASE_VEIL + 0.05)
      expect(clear.cloudCover).toBe(CLEAR_SKY.cloudCover)
      expect(clear.cirrus).toBe(0)
      // More with high cloud and with cover; full high cloud is a full veil.
      expect(at(iso, { ...CLEAR_SKY, cirrus: 0.6 }).veil).toBeGreaterThan(clear.veil)
      expect(at(iso, SKY_PRESETS.fair).veil).toBeGreaterThan(clear.veil)
      expect(at(iso, { ...CLEAR_SKY, cirrus: 1 }).veil).toBeCloseTo(1)
      // Rain, snow and fog keep their own look.
      expect(at(iso, SKY_PRESETS.rain).veil).toBe(0)
      expect(at(iso, SKY_PRESETS.snow).veil).toBe(0)
      expect(at(iso, SKY_PRESETS.fog).veil).toBe(0)
    }
    // Clearly there, never an overcast.
    expect(BASE_VEIL).toBeGreaterThanOrEqual(0.2)
    expect(BASE_VEIL).toBeLessThanOrEqual(0.4)
  })

  it('has no stars: the scene carries none', () => {
    expect(scene('2024-12-21T00:00:00Z')).not.toHaveProperty('stars')
  })

  it('lengthens the ramp and adds city skyglow once the daylight goes, never by day', () => {
    const noon = scene('2024-06-21T12:00:00Z')
    expect(noon.dusk).toBe(0)
    expect(noon.skyglowAmount).toBe(0)
    const night = scene('2024-12-21T00:00:00Z')
    expect(night.dusk).toBe(1)
    expect(night.skyglowAmount).toBeGreaterThan(0.4)
    // A soft grey-mauve with a hint of warmth, deeper in the dark theme.
    expect(night.skyglow[0]).toBeGreaterThan(night.skyglow[2] - 0.2)
    const darkNight = scene('2024-12-21T00:00:00Z', { dark: true })
    expect(luminance(darkNight.skyglow)).toBeLessThan(luminance(night.skyglow))
    // The same amount everywhere and every night: it doesn't depend on the place.
    const elsewhere = computeSkyScene({ date: new Date('2024-12-21T05:00:00Z'), latitude: 40.7, longitude: -74, weather: CLEAR_SKY, dark: false })
    expect(elsewhere.skyglowAmount).toBeCloseTo(night.skyglowAmount)
  })

  it('reads a weather from before cirrus existed as none, with nothing NaN', () => {
    const { cirrus: _drop, ...old } = SKY_PRESETS.fair
    void _drop
    const s = scene('2024-06-21T12:00:00Z', { weather: old as typeof CLEAR_SKY })
    expect(s.cirrus).toBe(0)
    for (const [key, value] of Object.entries(s)) {
      for (const n of [value].flat()) expect(Number.isFinite(n), key).toBe(true)
    }
  })

  it('keeps the twilight glow luminous in the dark theme while it dims the day', () => {
    const light = scene('2024-06-21T03:50:00Z')
    const dark = scene('2024-06-21T03:50:00Z', { dark: true })
    expect(light.glowAmount).toBeGreaterThan(0.5)
    expect(luminance(dark.glow)).toBeGreaterThan(luminance(light.glow) * 0.75)
  })

  it('mirrors in the southern hemisphere (facing north)', () => {
    const s = computeSkyScene({ date: new Date('2024-06-21T21:00:00Z'), latitude: -33.9, longitude: 151.2, weather: CLEAR_SKY, dark: false })
    // 07:00 in Sydney: the sun rises in the east, on the right facing north.
    expect(s.sunX).toBeGreaterThan(0.5)
  })

  it('drifts clouds where a westerly blows them: east, which is left facing south', () => {
    const s = scene('2024-06-21T12:00:00Z', { weather: { ...CLEAR_SKY, windFromDeg: 270, windSpeedMs: 5 } })
    expect(s.windX).toBeLessThan(0)
    const calm = scene('2024-06-21T12:00:00Z', { weather: { ...CLEAR_SKY, windSpeedMs: 0 } })
    expect(Math.hypot(calm.windX, calm.windY)).toBeGreaterThan(0)
    expect(Math.hypot(calm.windX, calm.windY)).toBeLessThan(Math.hypot(s.windX, s.windY))
  })

  it('dims a day sky in the dark theme; keeps the dark night deep and lifts it to blue hour in the light theme', () => {
    const lightDay = scene('2024-06-21T12:00:00Z')
    const darkDay = scene('2024-06-21T12:00:00Z', { dark: true })
    expect(luminance(darkDay.top)).toBeLessThan(luminance(lightDay.top) * 0.6)
    const lightNight = scene('2024-12-21T00:00:00Z')
    const darkNight = scene('2024-12-21T00:00:00Z', { dark: true })
    expect(luminance(darkNight.top)).toBeLessThan(0.1)
    // Both themes keep a saturated deep blue at night, never slate grey.
    for (const n of [lightNight, darkNight]) {
      expect(n.top[2]).toBeGreaterThan(n.top[0] * 4)
      expect(chroma(n.top)).toBeGreaterThan(0.2)
    }
    // The light theme shows a sky without daylight more strongly, so it keeps its range over a pale surface.
    expect(lightNight.strength).toBeGreaterThan(scene('2024-06-21T12:00:00Z').strength)
    expect(lightNight.strength).toBeLessThanOrEqual(0.95)
  })

  it('carries precipitation through', () => {
    const s = scene('2024-06-21T12:00:00Z', { weather: SKY_PRESETS.snow })
    expect(s.precipKind).toBe(2)
    expect(s.precipIntensity).toBeCloseTo(0.6)
    expect(scene('2024-06-21T12:00:00Z', { weather: SKY_PRESETS.storm }).storm).toBe(1)
  })
})

describe('skyPhase', () => {
  it('names the part of the day', () => {
    expect(skyPhase(-20, true)).toBe('night')
    expect(skyPhase(-3, true)).toBe('dawn')
    expect(skyPhase(-3, false)).toBe('dusk')
    expect(skyPhase(5, false)).toBe('golden')
    expect(skyPhase(40, true)).toBe('day')
  })

  it('knows morning from evening', () => {
    expect(isSunRising(new Date('2024-06-21T06:00:00Z'), LAT, LON)).toBe(true)
    expect(isSunRising(new Date('2024-06-21T18:00:00Z'), LAT, LON)).toBe(false)
  })
})

describe('longitudeFromOffset', () => {
  it('turns the UTC offset into degrees', () => {
    expect(longitudeFromOffset(420)).toBe(-105)
    expect(longitudeFromOffset(-60)).toBe(15)
    expect(longitudeFromOffset(0)).toBe(0)
  })

  it('uses the standard offset, not the daylight-saving one', () => {
    const d = new Date(2026, 6, 1)
    expect(standardTimezoneOffset(d)).toBeGreaterThanOrEqual(d.getTimezoneOffset())
    expect(standardTimezoneOffset(d)).toBe(standardTimezoneOffset(new Date(2026, 0, 15)))
  })
})

describe('parseSkyOverride', () => {
  it('reads a preset and a time', () => {
    expect(parseSkyOverride('?sky=rain&skyTime=18:45')).toEqual({ weather: SKY_PRESETS.rain, minuteOfDay: 18 * 60 + 45 })
    expect(parseSkyOverride('?skyTime=7:05')).toEqual({ weather: null, minuteOfDay: 425 })
  })

  it('ignores junk', () => {
    expect(parseSkyOverride('')).toBeNull()
    expect(parseSkyOverride('?sky=toString')).toBeNull()
    expect(parseSkyOverride('?skyTime=25:00')).toBeNull()
    expect(parseSkyOverride('?skyPlace=95,1,Nowhere')).toBeNull()
  })

  it('reads a stand-in place for local dev, which has no IP location', () => {
    expect(parseSkyOverride('?skyPlace=43.65,-79.38,Toronto,ca')).toEqual({
      weather: null,
      minuteOfDay: null,
      place: { location: { lat: 43.65, lon: -79.38, city: 'Toronto' }, country: 'CA' },
    })
    expect(parseSkyOverride('?sky=fair&skyPlace=51.5,-0.1')?.place).toEqual({ location: { lat: 51.5, lon: -0.1 }, country: null })
  })

  it('sets the local clock', () => {
    const d = applyOverrideTime(new Date(2026, 9, 9, 3, 2), 18 * 60 + 30)
    expect(d.getHours()).toBe(18)
    expect(d.getMinutes()).toBe(30)
    expect(d.getDate()).toBe(9)
  })
})

describe('lerpScene', () => {
  const clear = scene('2026-06-21T12:00:00Z')
  const rain = scene('2026-06-21T12:00:00Z', { weather: SKY_PRESETS.rain })
  const snow = scene('2026-06-21T12:00:00Z', { weather: SKY_PRESETS.snow })

  it('is the start at 0 and the end at 1, and in between for numbers and colours', () => {
    expect(lerpScene(clear, rain, 0)).toEqual(clear)
    expect(lerpScene(clear, rain, 1)).toEqual(rain)
    const mid = lerpScene(clear, rain, 0.5)
    expect(mid.cloudCover).toBeCloseTo((clear.cloudCover + rain.cloudCover) / 2)
    // The cirrus streaks blend too.
    const veiled = scene('2026-06-21T12:00:00Z', { weather: SKY_PRESETS.cirrus })
    expect(veiled.cirrus).toBeGreaterThan(0.5)
    expect(lerpScene(clear, veiled, 0.5).cirrus).toBeCloseTo((clear.cirrus + veiled.cirrus) / 2)
    expect(mid.top[2]).toBeCloseTo((clear.top[2] + rain.top[2]) / 2)
  })

  it('a change of what falls fades the old kind out, then the new one in', () => {
    expect(lerpScene(clear, rain, 0.25)).toMatchObject({ precipKind: 0, precipIntensity: 0 })
    const late = lerpScene(clear, rain, 0.75)
    expect(late.precipKind).toBe(1)
    expect(late.precipIntensity).toBeCloseTo(rain.precipIntensity * 0.5)
    const early = lerpScene(rain, snow, 0.25)
    expect(early.precipKind).toBe(1)
    expect(early.precipIntensity).toBeCloseTo(rain.precipIntensity * 0.5)
    expect(lerpScene(rain, snow, 0.75).precipKind).toBe(2)
  })
})

describe('clear-sky texture', () => {
  // New York, 10 October 2026 (UTC-4), as Liam saw it.
  const ny = (hhmm: string, weather = CLEAR_SKY, dark = false) => {
    const [h, m] = hhmm.split(':').map(Number)
    return computeSkyScene({ date: new Date(Date.UTC(2026, 9, 10, h + 4, m)), latitude: 40.71, longitude: -74.01, weather, dark })
  }

  it('shows fully on a clear sunset: the sun pattern, the texture and the haze strata', () => {
    const sunset = ny('18:40')
    expect(sunset.elevation).toBeLessThan(0)
    expect(sunset.sunPattern).toBeGreaterThan(0.9)
    expect(sunset.texture).toBeGreaterThan(0.9)
    expect(sunset.strata).toBeGreaterThan(0.9)
  })

  it('keeps the strata to a low sun: a little by day, barely at night', () => {
    const noon = ny('12:30')
    const sunset = ny('18:40')
    expect(noon.strata).toBeGreaterThan(0.3)
    expect(noon.strata).toBeLessThan(sunset.strata * 0.75)
    expect(ny('23:30').strata).toBeLessThan(0.15)
  })

  it('keeps a gentle texture at night: no sun pattern, the texture at its night floor', () => {
    const night = ny('23:30')
    expect(night.sunPattern).toBe(0)
    expect(night.texture).toBeCloseTo(NIGHT_TEXTURE)
    // A clear night has the day's gentle texture too, a little quieter.
    expect(NIGHT_TEXTURE).toBeGreaterThanOrEqual(0.6)
    expect(NIGHT_TEXTURE).toBeLessThan(1)
  })

  it('is hidden by dense cloud, fog and anything falling (an overcast is lit evenly)', () => {
    const overcast = ny('15:00', SKY_PRESETS.overcast)
    expect(overcast.strata).toBe(0)
    expect(overcast.sunPattern).toBeLessThan(0.35)
    expect(ny('15:00', SKY_PRESETS.fog).strata).toBe(0)
    expect(ny('15:00', SKY_PRESETS.rain).strata).toBe(0)
    expect(ny('10:00', SKY_PRESETS.fair).strata).toBeGreaterThan(0.2)
  })

  it('stays within 0..1 everywhere', () => {
    for (const el of [-30, -12, -6, -2, 0, 3, 10, 30, 60]) {
      for (const w of Object.values(SKY_PRESETS)) {
        for (const dark of [false, true]) {
          const t = clearSkyTexture(el, w, dark)
          for (const v of [t.sunPattern, t.texture, t.strata]) {
            expect(v).toBeGreaterThanOrEqual(0)
            expect(v).toBeLessThanOrEqual(1)
          }
        }
      }
    }
  })

  it('adds no cloud: cloudCover and cirrus come from the weather alone, as before', () => {
    const clear = ny('18:40')
    expect(clear.cloudCover).toBe(CLEAR_SKY.cloudCover)
    expect(clear.cirrus).toBe(0)
    expect(ny('12:30').cloudCover).toBe(CLEAR_SKY.cloudCover)
    expect(ny('12:30').cirrus).toBe(0)
    expect(ny('10:00', SKY_PRESETS.fair).cloudCover).toBe(SKY_PRESETS.fair.cloudCover)
    expect(ny('15:00', SKY_PRESETS.overcast).cloudCover).toBe(SKY_PRESETS.overcast.cloudCover)
    // cirrus: the high cloud, day and night, gone under dense cover.
    expect(ny('12:30', SKY_PRESETS.cirrus).cirrus).toBeGreaterThan(0.8)
    expect(ny('23:30', SKY_PRESETS.cirrus).cirrus).toBeGreaterThan(0.8)
    // The texture never feeds back into either.
    const a = ny('18:40')
    const b = computeSkyScene({ date: new Date(Date.UTC(2026, 9, 10, 22, 40)), latitude: 40.71, longitude: -74.01, weather: CLEAR_SKY, dark: true })
    expect([a.cloudCover, a.cirrus]).toEqual([b.cloudCover, b.cirrus])
  })

  it('blends the new amounts over the 2 s like every other number (lerpScene)', () => {
    const clear = ny('18:40')
    const overcast = ny('18:40', SKY_PRESETS.overcast)
    const mid = lerpScene(clear, overcast, 0.5)
    for (const k of ['sunPattern', 'texture', 'strata', 'veil', 'dusk', 'skyglowAmount'] as const) {
      expect(typeof mid[k]).toBe('number')
      expect(mid[k]).toBeCloseTo((clear[k] + overcast[k]) / 2)
    }
    expect(lerpScene(clear, overcast, 1).strata).toBe(overcast.strata)
  })
})

describe('the app\u2019s dark theme (dim): the same sky exposed for the dark, never a filter', () => {
  const noon = '2026-06-21T12:00:00Z'
  const sat = (c: readonly [number, number, number]) => chroma(c) / Math.max(luminance(c), 1e-6)

  it('darkens a bright day sky but makes it more saturated, keeping its hue', () => {
    const light = scene(noon)
    const dim = scene(noon, { dim: true })
    expect(luminance(dim.top)).toBeLessThan(luminance(light.top) * 0.6)
    expect(sat(dim.top)).toBeGreaterThan(sat(light.top) * 1.2)
    // Blue stays the strongest channel, red the weakest: the same hue.
    expect(dim.top[2]).toBeGreaterThan(dim.top[1])
    expect(dim.top[1]).toBeGreaterThan(dim.top[0])
    // The pale haze turns toward the blue rather than grey.
    expect(sat(dim.horizon)).toBeGreaterThan(sat(light.horizon))
  })

  it('keeps the clouds bright against the deeper sky: more contrast, not less', () => {
    const fair = { weather: SKY_PRESETS.fair }
    const light = scene(noon, fair)
    const dim = scene(noon, { ...fair, dim: true })
    const contrast = (s: typeof light) => luminance(s.cloudLit) / luminance(s.top)
    expect(contrast(dim)).toBeGreaterThan(contrast(light) * 1.2)
    // Still darker overall, and the glare calmed.
    expect(luminance(dim.cloudLit)).toBeLessThan(luminance(light.cloudLit))
    expect(dim.sunGlow).toBeLessThan(light.sunGlow)
  })

  it('darkens a full deck more, with no blue for it to stand out against', () => {
    const fair = scene(noon, { weather: SKY_PRESETS.fair, dim: true })
    const overcast = scene(noon, { weather: SKY_PRESETS.overcast, dim: true })
    const lightOvercast = scene(noon, { weather: SKY_PRESETS.overcast })
    expect(luminance(overcast.cloudLit) / luminance(lightOvercast.cloudLit)).toBeLessThan(luminance(fair.cloudLit) / luminance(scene(noon, { weather: SKY_PRESETS.fair }).cloudLit))
  })

  it('leaves a night as it is (no light-theme lift), shown nearly fully over the dark surface', () => {
    const night = '2026-06-21T00:30:00Z'
    const dim = scene(night, { dim: true })
    const signedOutDark = scene(night, { dark: true })
    // Night is already dark: the raw night palette, the same as the dimmed sky's
    // (which only dims daylight), never the light theme's lifted ultramarine.
    expect(dim.top).toEqual(signedOutDark.top)
    expect(luminance(dim.top)).toBeLessThan(luminance(scene(night).top))
    expect(dim.strength).toBe(DIM_STRENGTH)
    expect(DIM_STRENGTH).toBeGreaterThan(0.85)
  })

  it('is ignored on the signed-out pages\u2019 dimmed sky (dark wins)', () => {
    expect(scene(noon, { dark: true, dim: true })).toEqual(scene(noon, { dark: true }))
  })

  it('exposeColour scales luminance and pushes chroma out from it, never toward grey', () => {
    const c: [number, number, number] = [0.3, 0.5, 0.85]
    const same = exposeColour(c, 0.5, 0)
    expect(luminance(same)).toBeCloseTo(luminance(c) * 0.5, 5)
    expect(sat(same)).toBeCloseTo(sat(c), 5)
    expect(sat(exposeColour(c, 0.5, 0.35))).toBeGreaterThan(sat(c))
    expect(exposeColour(c, 1, 0)).toEqual(c)
  })
})
