/**
 * The timeline ruler's marks (../ruler-ticks.ts; Liam, 11-24: "can you make it so that the timeline numbers never
 * overlap like this regardless of size"): round steps, never closer than a label's room, none at or past the end.
 */
import { describe, expect, it } from 'vitest'
import { RULER_CHAR_PX, rulerLabel, rulerTicks } from '../ruler-ticks'

/** No two labels touch, and none runs past the ruler's right edge. */
function fits(duration: number, width: number) {
  const ticks = rulerTicks(duration, width)
  const px = (s: number) => (s / duration) * width
  for (let i = 0; i < ticks.length; i++) {
    const right = px(ticks[i].seconds) + ticks[i].label.length * RULER_CHAR_PX
    if (i + 1 < ticks.length) expect(right, `${duration}s at ${width}px: ${ticks[i].label} vs ${ticks[i + 1].label}`).toBeLessThan(px(ticks[i + 1].seconds))
    else expect(right).toBeLessThanOrEqual(width)
  }
  return ticks
}

describe('rulerTicks', () => {
  it('the screenshot’s 10.95s video on a narrow ruler (337px): a few round marks, nothing overlapping', () => {
    const ticks = fits(10.95, 337)
    expect(ticks.map((t) => t.label)).toEqual(['0:00', '0:02', '0:04', '0:06', '0:08'])
  })

  it('the same on a wide ruler (732px): seconds', () => {
    const ticks = fits(10.95, 732)
    expect(ticks[1].label).toBe('0:01')
    expect(ticks.at(-1)!.seconds).toBeLessThan(10.95)
  })

  it('zoomed in far (8×): halves, then quarters as the ruler grows', () => {
    expect(fits(10.95, 732 * 8)[1].label).toBe('0:00.2')
    expect(fits(10.95, 732 * 16).some((t) => t.label === '0:00.25' || t.label === '0:00.1')).toBe(true)
  })

  it('a long video on a small ruler: minutes', () => {
    const ticks = fits(45 * 60, 600)
    expect(ticks.every((t) => t.seconds % 60 === 0)).toBe(true)
  })

  it('never overlaps at any width', () => {
    for (const duration of [1.5, 10.95, 37, 125, 900]) for (let width = 120; width <= 6000; width += 97) fits(duration, width)
  })

  it('labels: minutes and seconds with the step’s decimals', () => {
    expect(rulerLabel(5, 1)).toBe('0:05')
    expect(rulerLabel(2.5, 0.5)).toBe('0:02.5')
    expect(rulerLabel(0.25, 0.25)).toBe('0:00.25')
    expect(rulerLabel(750, 30)).toBe('12:30')
  })
})
