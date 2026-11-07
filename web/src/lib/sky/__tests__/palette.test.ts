import { describe, expect, it } from 'vitest'
import { chroma, hslTripletToRgb, luminance, skyPalette, type Rgb } from '../palette'

const clear = { cloudCover: 0, storm: false, fog: false }
const dist = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

describe('skyPalette', () => {
  it('is a dark, saturated navy at night with no sun (and no stars: the shader draws none)', () => {
    const p = skyPalette(-30, clear)
    expect(luminance(p.top)).toBeLessThan(0.1)
    expect(p.top[2]).toBeGreaterThan(p.top[0] * 4)
    expect(p).not.toHaveProperty('stars')
    expect(p.sunGlow).toBe(0)
    expect(p.sunDisc).toBe(0)
    expect(p.daylight).toBe(0)
  })

  it('is a bright blue at midday', () => {
    const p = skyPalette(55, clear)
    expect(p.top[2]).toBeGreaterThan(p.top[0])
    expect(luminance(p.horizon)).toBeGreaterThan(0.6)
    expect(p.sunDisc).toBe(1)
    expect(p.daylight).toBe(1)
  })

  it('has a warm horizon at golden hour', () => {
    const p = skyPalette(4, clear)
    expect(p.horizon[0]).toBeGreaterThan(p.horizon[2])
    expect(p.sun[0]).toBeGreaterThan(p.sun[2])
  })

  it('has a muted mauve-blue horizon in civil twilight (the glow and the belt carry the colour)', () => {
    const p = skyPalette(-4, clear)
    expect(p.horizon[2]).toBeGreaterThan(p.horizon[1])
    expect(p.horizon[0]).toBeGreaterThan(p.horizon[1] - 0.05)
  })

  it('keeps a strong vertical range through twilight and night: a deep blue zenith over a lighter horizon', () => {
    for (const e of [-2, -4, -6, -8, -10, -12, -15, -18, -30]) {
      const p = skyPalette(e, clear)
      // Deep and blue up high, never slate: blue well over red.
      expect(p.top[2]).toBeGreaterThan(p.top[0] * 2.5)
      expect(chroma(p.top)).toBeGreaterThan(0.2)
      // The horizon clearly lighter than the top.
      expect(luminance(p.horizon) - luminance(p.top)).toBeGreaterThan(0.06)
    }
  })

  it('has a deep navy night, no glow, no belt', () => {
    for (const e of [-90, -30, -18]) {
      const p = skyPalette(e, clear)
      expect(p.top).toEqual([0x0a / 255, 0x16 / 255, 0x40 / 255])
      expect(p.horizon).toEqual([0x26 / 255, 0x30 / 255, 0x5c / 255])
      expect(p.glowAmount).toBe(0)
      expect(p.beltAmount).toBe(0)
    }
  })

  it('keeps night clouds in the blue family, never neutral grey', () => {
    for (const e of [-12, -18, -30]) {
      const p = skyPalette(e, clear)
      expect(p.cloudLit[2]).toBeGreaterThan(p.cloudLit[0] * 1.5)
      expect(p.cloudShade[2]).toBeGreaterThan(p.cloudShade[0] * 2)
    }
  })

  it('keeps an overcast dusk and night blue: cloud greys a sky with no daylight far less', () => {
    const overcast = { cloudCover: 1, storm: false, fog: false }
    for (const e of [-8, -12, -20]) {
      const p = skyPalette(e, overcast)
      expect(p.top[2]).toBeGreaterThan(p.top[0] * 2)
      expect(chroma(p.top)).toBeGreaterThan(chroma(skyPalette(e, clear).top) * 0.55)
    }
  })

  it('brightens a warm dawn glow on the sun side as sunrise nears', () => {
    const amounts = [-12, -10, -8, -6, -4, -2].map((e) => skyPalette(e, clear).glowAmount)
    for (let i = 1; i < amounts.length; i++) expect(amounts[i]).toBeGreaterThan(amounts[i - 1])
    // Astronomical twilight: only a faint residual light.
    expect(amounts[0]).toBeLessThan(0.12)
    const preDawn = skyPalette(-5, clear)
    expect(preDawn.glowAmount).toBeGreaterThan(0.6)
    // Orange low, cooler (pink, violet) higher up.
    expect(preDawn.glow[0]).toBeGreaterThan(preDawn.glow[2] + 0.3)
    expect(preDawn.glow[0]).toBeGreaterThan(preDawn.glow[1])
    expect(preDawn.glowHigh[2]).toBeGreaterThan(preDawn.glow[2])
    // Brighter than the plain horizon beside it: it reads as light, not a tint.
    expect(luminance(preDawn.glow)).toBeGreaterThan(luminance(preDawn.horizon))
    // Handed over to the sun's own glow by mid-morning.
    expect(skyPalette(12, clear).glowAmount).toBe(0)
  })

  it('shows the Belt of Venus over Earth\'s shadow at dusk, gone by day and by night', () => {
    const dusk = skyPalette(-2, clear)
    expect(dusk.beltAmount).toBeGreaterThan(0.9)
    // A pink band: red over green, some blue.
    expect(dusk.belt[0]).toBeGreaterThan(dusk.belt[1] + 0.1)
    expect(dusk.belt[2]).toBeGreaterThan(dusk.belt[1])
    // Under it a slate-blue band, darker than the belt.
    expect(dusk.shadow[2]).toBeGreaterThan(dusk.shadow[0])
    expect(luminance(dusk.shadow)).toBeLessThan(luminance(dusk.belt))
    expect(skyPalette(-6.5, clear).beltAmount).toBeGreaterThan(0.3)
    expect(skyPalette(20, clear).beltAmount).toBe(0)
    expect(skyPalette(-12, clear).beltAmount).toBe(0)
  })

  it('has a saturated blue top at noon over a pale, hazy horizon', () => {
    const noon = skyPalette(45, clear)
    expect(chroma(noon.top)).toBeGreaterThan(0.5)
    expect(noon.top[2]).toBeGreaterThan(noon.top[1])
    expect(noon.top[1]).toBeGreaterThan(noon.top[0])
    expect(chroma(noon.horizon)).toBeLessThan(chroma(noon.top) * 0.5)
    expect(luminance(noon.horizon)).toBeGreaterThan(luminance(noon.top) + 0.3)
    expect(noon.glowAmount).toBe(0)
  })

  it('hides the twilight glow and the belt under cloud', () => {
    const clearDusk = skyPalette(-2, clear)
    const overcast = skyPalette(-2, { cloudCover: 1, storm: false, fog: false })
    expect(overcast.beltAmount).toBe(0)
    expect(overcast.glowAmount).toBeLessThan(clearDusk.glowAmount * 0.4)
  })

  it('blends continuously through every key', () => {
    for (let e = -25; e < 60; e += 0.5) {
      const a = skyPalette(e, clear)
      const b = skyPalette(e + 0.5, clear)
      expect(dist(a.top, b.top)).toBeLessThan(0.08)
      expect(dist(a.horizon, b.horizon)).toBeLessThan(0.12)
      expect(dist(a.glow, b.glow)).toBeLessThan(0.12)
      expect(dist(a.belt, b.belt)).toBeLessThan(0.12)
      expect(Math.abs(a.glowAmount - b.glowAmount)).toBeLessThan(0.12)
      expect(Math.abs(a.beltAmount - b.beltAmount)).toBeLessThan(0.3)
    }
  })

  it('greys and dims the sky under cloud, darker still in a storm', () => {
    const sunny = skyPalette(40, clear)
    const overcast = skyPalette(40, { cloudCover: 1, storm: false, fog: false })
    const storm = skyPalette(40, { cloudCover: 1, storm: true, fog: false })
    expect(chroma(overcast.top)).toBeLessThan(chroma(sunny.top) * 0.5)
    expect(luminance(overcast.top)).toBeLessThan(luminance(sunny.top))
    expect(luminance(storm.top)).toBeLessThan(luminance(overcast.top))
    expect(luminance(storm.cloudLit)).toBeLessThan(luminance(overcast.cloudLit))
  })

  it('pales the horizon in fog', () => {
    const fog = skyPalette(30, { cloudCover: 0.9, storm: false, fog: true })
    const plain = skyPalette(30, { cloudCover: 0.9, storm: false, fog: false })
    expect(chroma(fog.horizon)).toBeLessThanOrEqual(chroma(plain.horizon))
  })
})

describe('hslTripletToRgb', () => {
  it('reads the theme variables', () => {
    expect(hslTripletToRgb('0 0% 96%')).toEqual([0.96, 0.96, 0.96])
    const blue = hslTripletToRgb('220, 100%, 50%')!
    expect(blue[2]).toBeCloseTo(1)
    expect(blue[0]).toBeCloseTo(0)
    expect(hslTripletToRgb('')).toBeNull()
    expect(hslTripletToRgb('red')).toBeNull()
  })
})
