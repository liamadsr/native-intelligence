/**
 * @vitest-environment jsdom
 *
 * Palette parsing + premultiplication. jsdom because `readPalette` reads the
 * `dark` class off a real element; the parser itself is pure and most of the
 * assertions below exercise it directly.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { parseCssColor, premultiply, readPalette } from '@/components/knowledge-map/palette'

describe('parseCssColor', () => {
  it('parses hex in 3, 4, 6 and 8 digit forms', () => {
    expect(parseCssColor('#fff')).toEqual([1, 1, 1, 1])
    expect(parseCssColor('#000')).toEqual([0, 0, 0, 1])
    expect(parseCssColor('#ffffff')).toEqual([1, 1, 1, 1])
    const [r, g, b, a] = parseCssColor('#8000ff80')!
    expect(r).toBeCloseTo(128 / 255, 6)
    expect(g).toBe(0)
    expect(b).toBe(1)
    expect(a).toBeCloseTo(128 / 255, 6)
    const short = parseCssColor('#f008')!
    expect(short[0]).toBe(1)
    expect(short[3]).toBeCloseTo(136 / 255, 6)
  })

  it('parses rgb() and rgba() in both comma and space syntax', () => {
    const a = parseCssColor('rgba(30,35,51,0.34)')!
    expect(a[0]).toBeCloseTo(30 / 255, 6)
    expect(a[1]).toBeCloseTo(35 / 255, 6)
    expect(a[2]).toBeCloseTo(51 / 255, 6)
    expect(a[3]).toBeCloseTo(0.34, 6)

    expect(parseCssColor('rgb(255 0 0)')).toEqual([1, 0, 0, 1])
    const slash = parseCssColor('rgb(255 0 0 / 50%)')!
    expect(slash[3]).toBeCloseTo(0.5, 6)
  })

  it('parses hsl() including the bare-channel form Tailwind emits', () => {
    const red = parseCssColor('hsl(0 100% 50%)')!
    expect(red[0]).toBeCloseTo(1, 6)
    expect(red[1]).toBeCloseTo(0, 6)
    expect(red[2]).toBeCloseTo(0, 6)

    const grey = parseCssColor('hsl(210, 0%, 50%)')!
    expect(grey[0]).toBeCloseTo(0.5, 6)
    expect(grey[1]).toBeCloseTo(0.5, 6)
    expect(grey[2]).toBeCloseTo(0.5, 6)

    const black = parseCssColor('hsl(222 47% 0%)')!
    expect(black.slice(0, 3)).toEqual([0, 0, 0])

    // Hue wraps: 360 and 720 are the same colour as 0.
    expect(parseCssColor('hsl(360 100% 50%)')![0]).toBeCloseTo(1, 6)
    const alpha = parseCssColor('hsla(120, 100%, 50%, 0.25)')!
    expect(alpha[3]).toBeCloseTo(0.25, 6)
  })

  it('clamps out-of-range channels and alpha', () => {
    expect(parseCssColor('rgb(300, -20, 128)')!.slice(0, 2)).toEqual([1, 0])
    expect(parseCssColor('rgba(0,0,0,5)')![3]).toBe(1)
    expect(parseCssColor('rgba(0,0,0,-1)')![3]).toBe(0)
  })

  it('returns null for anything it does not understand', () => {
    for (const bad of ['', '   ', 'rebeccapurple', '#12345', '#ggg', 'rgb(1,2)', 'oklch(0.5 0 0)']) {
      expect(parseCssColor(bad)).toBeNull()
    }
    expect(parseCssColor('transparent')).toEqual([0, 0, 0, 0])
  })
})

describe('premultiply', () => {
  it('scales rgb by alpha and leaves alpha alone', () => {
    expect(premultiply([1, 0.5, 0, 0.5])).toEqual([0.5, 0.25, 0, 0.5])
    expect(premultiply([1, 1, 1, 0])).toEqual([0, 0, 0, 0])
    expect(premultiply([0.2, 0.4, 0.6, 1])).toEqual([0.2, 0.4, 0.6, 1])
  })
})

describe('readPalette', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark')
  })

  it('returns premultiplied light values', () => {
    const p = readPalette()
    expect(p.isDark).toBe(false)
    // rgba(30,35,51,0.46) premultiplied. The alphas moved up from the legacy
    // graph's (claim 0.34, entity 0.6) because the dots, not the labels, are
    // now the thing the map is read by — a 0.34 disc reads as a smudge.
    expect(p.claim[0]).toBeCloseTo((30 / 255) * 0.46, 6)
    expect(p.claim[3]).toBeCloseTo(0.46, 6)
    expect(p.entity[3]).toBeCloseTo(0.82, 6)
    // Edges and labels went the other way, for the same reason.
    expect(p.edge[3]).toBeCloseTo(0.11, 6)
    expect(p.label[3]).toBeCloseTo(0.56, 6)
  })

  it('flips to the dark values when <html> carries the dark class', () => {
    document.documentElement.classList.add('dark')
    const p = readPalette()
    expect(p.isDark).toBe(true)
    expect(p.claim[3]).toBeCloseTo(0.54, 6)
    expect(p.entity[3]).toBeCloseTo(0.9, 6)
    // Dark claims are lighter than light-mode claims once un-premultiplied.
    expect(p.claim[0] / p.claim[3]).toBeGreaterThan(0.5)
  })

  it('carries an accent that is a COOL NEUTRAL and legible on BOTH grounds', () => {
    // This assertion used to demand chroma (spread > 0.25), back when the
    // accent was a violet and hue was what separated a hovered neighbourhood
    // from the rest. It was deliberately inverted: a saturated accent read as
    // a brand colour dropped into an otherwise monochrome instrument, so the
    // separation moved onto value + full opacity against a field dimmed to
    // DIM, and the colour became a confirmation rather than the signal.
    //
    // So the window is now two-sided. Too much chroma and the violet is back;
    // none at all and it is literally the foreground ink, which is where this
    // started and which was invisible.
    for (const dark of [false, true]) {
      document.documentElement.classList.toggle('dark', dark)
      const p = readPalette()
      const [r, g, b, a] = p.accent
      // Full opacity is load-bearing: it is what the accent has that the
      // dimmed map does not.
      expect(a).toBeGreaterThan(0.9)
      // Un-premultiply before comparing channels, or alpha masquerades as hue.
      const [sr, sg, sb] = [r / a, g / a, b / a]
      const spread = Math.max(sr, sg, sb) - Math.min(sr, sg, sb)
      expect(spread).toBeLessThan(0.25)
      expect(spread).toBeGreaterThan(0.05)
      // Cool, not warm — blue is the channel that leads, on both grounds.
      expect(sb).toBeGreaterThan(sr)
      // Dark ground needs a light accent, light ground a dark one.
      const luma = 0.2126 * sr + 0.7152 * sg + 0.0722 * sb
      if (dark) expect(luma).toBeGreaterThan(0.5)
      else expect(luma).toBeLessThan(0.5)
    }
  })

  it('keeps the accent separable from the base node colour it replaces', () => {
    // The failure this guards is specific to the DARK ground, where `entity`
    // is already a near-white grey: a neutral accent can land so close to it
    // that a hover reads as nothing happening for anyone who does not notice
    // the rest of the map recede. Compare EFFECTIVE luma — premultiplied, so
    // the accent's full alpha counts in its favour against entity's 0.9.
    const effLuma = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    document.documentElement.classList.add('dark')
    const darkP = readPalette()
    expect(effLuma(darkP.accent)).toBeGreaterThan(effLuma(darkP.entity) + 0.05)

    document.documentElement.classList.remove('dark')
    const lightP = readPalette()
    // On the light ground the map's ink is near-black, so the accent separates
    // by being lighter and fully opaque rather than darker.
    expect(effLuma(lightP.accent)).toBeGreaterThan(effLuma(lightP.entity) + 0.05)
  })

  it('every premultiplied channel stays within [0, alpha]', () => {
    for (const dark of [false, true]) {
      document.documentElement.classList.toggle('dark', dark)
      const p = readPalette()
      for (const key of ['claim', 'claimSuggested', 'entity', 'virtual', 'edge', 'accent', 'label'] as const) {
        const c = p[key]
        expect(c).toHaveLength(4)
        for (const ch of c.slice(0, 3)) {
          expect(ch).toBeGreaterThanOrEqual(0)
          // Premultiplied rgb can never exceed its own alpha.
          expect(ch).toBeLessThanOrEqual(c[3] + 1e-9)
        }
        expect(c[3]).toBeGreaterThanOrEqual(0)
        expect(c[3]).toBeLessThanOrEqual(1)
      }
      expect(p.dim).toBeGreaterThan(0)
      expect(p.dim).toBeLessThan(1)
    }
  })

  it('accepts an explicit root element', () => {
    const el = document.createElement('div')
    el.classList.add('dark')
    document.body.appendChild(el)
    expect(readPalette(el).isDark).toBe(true)
    el.remove()
  })

  it('suggested claims are more present than filled ones (they render as rings)', () => {
    const p = readPalette()
    expect(p.claimSuggested[3]).toBeGreaterThan(p.claim[3])
  })
})
