/**
 * Label selection. Pure and hot (it runs on every camera settle over up to a
 * few thousand candidates), so it is tested without any DOM: the `measure`
 * hook stands in for the atlas's real `measureText`.
 */

import { describe, expect, it } from 'vitest'

import {
  atlasShelfMetrics,
  fontSpec,
  LABEL_FONT_PX,
  LABEL_GAP_PX,
  LABEL_LINE_HEIGHT_PX,
  LABEL_MAX_CHARS,
  selectLabels,
  truncateLabel,
  type LabelCandidate,
} from '@/components/knowledge-map/labels'
import type { CameraState, Viewport } from '@/components/knowledge-map/types'

const CAMERA: CameraState = { x: 0, y: 0, k: 1 }
const VIEWPORT: Viewport = { width: 800, height: 600, dpr: 2 }
/** Fixed width so collision geometry in the tests is exact. */
const measure = () => 100

function cand(over: Partial<LabelCandidate> & { id: number }): LabelCandidate {
  return {
    wx: 0,
    wy: 0,
    screenRadiusPx: 3,
    text: `label ${over.id}`,
    weight: 0,
    importance: 1,
    ...over,
  }
}

describe('selectLabels', () => {
  it('places a lone candidate under its node', () => {
    const out = selectLabels([cand({ id: 1, wx: 0, wy: 0, screenRadiusPx: 4 })], CAMERA, VIEWPORT, {
      measure,
    })
    expect(out).toHaveLength(1)
    expect(out[0].wx).toBe(0)
    expect(out[0].offsetPx).toBeCloseTo(4 + LABEL_GAP_PX, 12)
    expect(out[0].emphasised).toBe(false)
  })

  it('rejects an overlapping candidate and keeps the earlier (more important) one', () => {
    // Both at the same world point: boxes coincide exactly.
    const out = selectLabels(
      [cand({ id: 1, text: 'winner' }), cand({ id: 2, text: 'loser' })],
      CAMERA,
      VIEWPORT,
      { measure },
    )
    expect(out.map((l) => l.text)).toEqual(['winner'])
  })

  it('accepts candidates far enough apart', () => {
    // 100px wide boxes: 150 world units at k=1 clears them comfortably.
    const out = selectLabels(
      [cand({ id: 1, wx: -150 }), cand({ id: 2, wx: 0 }), cand({ id: 3, wx: 150 })],
      CAMERA,
      VIEWPORT,
      { measure },
    )
    expect(out).toHaveLength(3)
  })

  it('separates labels vertically as well as horizontally', () => {
    const stacked = selectLabels(
      [cand({ id: 1, wy: 0 }), cand({ id: 2, wy: -8 })],
      CAMERA,
      VIEWPORT,
      { measure },
    )
    // 8px apart is inside the 15px line box → collision.
    expect(stacked).toHaveLength(1)

    const spread = selectLabels(
      [cand({ id: 1, wy: 0 }), cand({ id: 2, wy: -40 })],
      CAMERA,
      VIEWPORT,
      { measure },
    )
    expect(spread).toHaveLength(2)
  })

  it('stops at `max`', () => {
    const cands = Array.from({ length: 50 }, (_, i) => cand({ id: i, wx: i * 150 - 3000 }))
    const out = selectLabels(cands, CAMERA, VIEWPORT, { measure, max: 5 })
    expect(out).toHaveLength(5)
  })

  it('returns nothing for max <= 0 or no candidates', () => {
    expect(selectLabels([cand({ id: 1 })], CAMERA, VIEWPORT, { measure, max: 0 })).toEqual([])
    expect(selectLabels([], CAMERA, VIEWPORT, { measure })).toEqual([])
  })

  it('places forced labels first and never rejects them', () => {
    // The forced label sits exactly on top of a higher-priority regular one.
    const out = selectLabels(
      [cand({ id: 1, text: 'regular' }), cand({ id: 2, text: 'hovered', forced: true })],
      CAMERA,
      VIEWPORT,
      { measure },
    )
    expect(out[0].text).toBe('hovered')
    expect(out[0].emphasised).toBe(true)
    // The regular one now loses the cell the forced label took.
    expect(out.map((l) => l.text)).toEqual(['hovered'])
  })

  // Seen in the real view: selecting a hub whose 35 claims sit a pixel apart at
  // overview zoom printed all 35 forced labels on top of each other — a solid
  // black smear. Neighbourhood labels get priority, not immunity.
  it('lets overlapping FORCED labels collide with each other (no label pile-up)', () => {
    const out = selectLabels(
      [
        cand({ id: 1, text: 'a', forced: true }),
        cand({ id: 2, text: 'b', forced: true }),
        cand({ id: 3, text: 'c', forced: true }),
      ],
      CAMERA,
      VIEWPORT,
      { measure },
    )
    expect(out.map((l) => l.text)).toEqual(['a'])
    expect(out[0].emphasised).toBe(true)
  })

  it('never rejects the PINNED focus label, and places it before its neighbours', () => {
    const out = selectLabels(
      [
        // Arrives AFTER a forced neighbour and an ordinary label on the same spot.
        cand({ id: 1, text: 'ordinary' }),
        cand({ id: 2, text: 'neighbour', forced: true }),
        cand({ id: 3, text: 'focus', forced: true, pinned: true }),
      ],
      CAMERA,
      VIEWPORT,
      { measure },
    )
    expect(out.map((l) => l.text)).toEqual(['focus'])
    expect(out[0].emphasised).toBe(true)
  })

  it('still prefers a forced neighbour over an ordinary label for the same cell', () => {
    const out = selectLabels(
      [cand({ id: 1, text: 'ordinary' }), cand({ id: 2, text: 'neighbour', forced: true })],
      CAMERA,
      VIEWPORT,
      { measure },
    )
    expect(out.map((l) => l.text)).toEqual(['neighbour'])
  })

  it('skips candidates well outside the viewport', () => {
    const out = selectLabels(
      [
        cand({ id: 1, wx: 0, wy: 0 }),
        cand({ id: 2, wx: 5000, wy: 0 }),
        cand({ id: 3, wx: 0, wy: 5000 }),
        cand({ id: 4, wx: -5000, wy: -5000 }),
      ],
      CAMERA,
      VIEWPORT,
      { measure },
    )
    expect(out).toHaveLength(1)
  })

  it('skips off-screen forced labels too (a pinned node scrolled away)', () => {
    const out = selectLabels([cand({ id: 1, wx: 9999, forced: true })], CAMERA, VIEWPORT, {
      measure,
    })
    expect(out).toEqual([])
  })

  it('truncates long text and drops empty text', () => {
    const long = 'x'.repeat(120)
    const out = selectLabels([cand({ id: 1, text: long })], CAMERA, VIEWPORT, { measure })
    expect(out[0].text).toHaveLength(LABEL_MAX_CHARS)
    expect(out[0].text.endsWith('…')).toBe(true)

    expect(selectLabels([cand({ id: 1, text: '   ' })], CAMERA, VIEWPORT, { measure })).toEqual([])
  })

  it('drops candidates a measurer reports as zero-width', () => {
    const out = selectLabels([cand({ id: 1 })], CAMERA, VIEWPORT, { measure: () => 0 })
    expect(out).toEqual([])
  })

  it('tracks the camera: panning moves which labels are on screen', () => {
    const cands = [cand({ id: 1, wx: 0 }), cand({ id: 2, wx: 2000 })]
    expect(selectLabels(cands, CAMERA, VIEWPORT, { measure })).toHaveLength(1)
    const panned: CameraState = { x: 2000, y: 0, k: 1 }
    const out = selectLabels(cands, panned, VIEWPORT, { measure })
    expect(out).toHaveLength(1)
    expect(out[0].wx).toBe(2000)
  })

  it('stays fast on a few thousand candidates', () => {
    const cands = Array.from({ length: 4000 }, (_, i) =>
      cand({ id: i, wx: (i % 80) * 10 - 400, wy: Math.floor(i / 80) * 10 - 250 }),
    )
    const t0 = performance.now()
    const out = selectLabels(cands, CAMERA, VIEWPORT, { measure, max: 120 })
    expect(performance.now() - t0).toBeLessThan(120)
    expect(out.length).toBeLessThanOrEqual(120)
  })
})

describe('truncateLabel', () => {
  it('leaves short text alone and trims whitespace', () => {
    expect(truncateLabel('  hello  ')).toBe('hello')
    expect(truncateLabel('x'.repeat(LABEL_MAX_CHARS))).toHaveLength(LABEL_MAX_CHARS)
  })

  it('handles multi-byte text without crashing', () => {
    const arabic = 'مرحبا بالعالم '.repeat(10)
    const out = truncateLabel(arabic)
    expect(out.length).toBeLessThanOrEqual(LABEL_MAX_CHARS)
  })
})

/**
 * Atlas resolution.
 *
 * The rasterisation itself needs a GL context and a Canvas2D, so the ARITHMETIC
 * that decides whether text is crisp is extracted into `atlasShelfMetrics` and
 * pinned here. The invariant: the shelf a label is rasterised into must be
 * `dpr` times as tall in device pixels as the quad it is drawn on is in CSS
 * pixels. Get that wrong and the quad — which the vertex shader sizes in CSS px
 * against `uViewportCss`, while the framebuffer is device px — stretches a
 * low-resolution bitmap by exactly the factor that is missing.
 */
describe('label atlas resolution', () => {
  it('scales the device shelf with dpr while the drawn height stays constant', () => {
    const one = atlasShelfMetrics(1)
    const two = atlasShelfMetrics(2)
    const three = atlasShelfMetrics(3)

    expect(one.deviceRows).toBe(LABEL_LINE_HEIGHT_PX)
    expect(two.deviceRows).toBe(LABEL_LINE_HEIGHT_PX * 2)
    expect(three.deviceRows).toBe(LABEL_LINE_HEIGHT_PX * 3)

    // The CSS size the quad covers is the same at every ratio — only the
    // number of real pixels behind it changes. That is the whole definition
    // of "crisp on Retina".
    for (const m of [one, two, three]) {
      expect(m.cssPx).toBeCloseTo(LABEL_LINE_HEIGHT_PX, 10)
    }
  })

  it('an atlas built at dpr 1 and drawn at dpr 2 is exactly half resolution', () => {
    // This is the defect in numbers: the shelf holds 15 device rows but the
    // quad covers 15 CSS px = 30 device px, so gl.LINEAR magnifies 2x.
    const built = atlasShelfMetrics(1)
    const drawnDevicePx = built.cssPx * 2
    expect(drawnDevicePx / built.deviceRows).toBe(2)

    // Built correctly, the ratio is 1 — a texel per pixel.
    const correct = atlasShelfMetrics(2)
    expect((correct.cssPx * 2) / correct.deviceRows).toBe(1)
  })

  it('stays pixel-snapped: the shelf is a whole number of device rows', () => {
    for (const dpr of [1, 1.25, 1.5, 2, 2.5, 3]) {
      const m = atlasShelfMetrics(dpr)
      expect(Number.isInteger(m.deviceRows)).toBe(true)
      // Never SHORTER than the line box it must hold, or glyphs are clipped.
      expect(m.deviceRows).toBeGreaterThanOrEqual(LABEL_LINE_HEIGHT_PX * dpr)
      expect(m.deviceRows).toBeLessThan(LABEL_LINE_HEIGHT_PX * dpr + 1)
    }
  })

  it('never rasterises below 1x, whatever the reported ratio', () => {
    // A zero or fractional-below-1 dpr would shrink the shelf below the line
    // box and clip every glyph.
    expect(atlasShelfMetrics(0).dpr).toBe(1)
    expect(atlasShelfMetrics(0.5).deviceRows).toBe(LABEL_LINE_HEIGHT_PX)
  })

  it('the font is requested at device pixels, matching the shelf', () => {
    // fontSpec and the shelf height must move together: a 12px font in a
    // 30-device-row shelf would be crisp but tiny.
    expect(fontSpec(0, 2)).toContain(`${LABEL_FONT_PX * 2}px`)
    expect(fontSpec(1, 2)).toContain(`${LABEL_FONT_PX * 2}px`)
    expect(fontSpec(1, 2)).toContain('600')
    expect(fontSpec(0, 1)).toContain(`${LABEL_FONT_PX}px`)
  })
})
