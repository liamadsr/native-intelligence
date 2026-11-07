// @vitest-environment jsdom
/**
 * Reply's flight (card-reply-flight.ts): the path (down, then right), its
 * pace (faster and faster), its keyframes and the landing's bounce, and the
 * flyer's life: held at the press, flown to the chip as it mounts, gone when
 * it lands, the real chip hidden only meanwhile; nothing without the Web
 * Animations API or with reduced motion; a chip that never comes lets it fade.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FLIGHT_MS,
  FLIGHT_PACE,
  FLIGHT_WAIT_MS,
  SETTLE_MS,
  arrivalDirection,
  cubicBezier,
  flightFrames,
  flightPoint,
  landCardReplyFlight,
  launchCardReplyFlight,
  reversedFrames,
  departureDirection,
  settleFrames,
  type FlightRect,
} from '../card-reply-flight'

const CARD = { kind: 'card' as const, id: '11111111-1111-4111-8111-111111111111' }
const OTHER = { kind: 'card' as const, id: '22222222-2222-4222-8222-222222222222' }
const FROM: FlightRect = { left: 40, top: 200, width: 280, height: 120 }
const TO: FlightRect = { left: 500, top: 800, width: 360, height: 44 }

describe('flightFrames', () => {
  it('starts on the card and ends on the chip', () => {
    const { card, chip } = flightFrames(FROM, TO)
    expect(card[0]).toEqual({ offset: 0, transform: 'translate(40px, 200px) scale(1)', opacity: 1 })
    expect(chip[0]).toEqual({ offset: 0, transform: `translate(40px, 200px) scale(${Math.round((280 / 360) * 1e4) / 1e4})`, opacity: 0 })
    expect(chip.at(-1)).toEqual({ offset: 1, transform: 'translate(500px, 800px) scale(1)', opacity: 1 })
    expect(card.at(-1)?.opacity).toBe(0)
  })

  it('samples evenly in time, the card turned into the chip in the first third', () => {
    const { card, chip } = flightFrames(FROM, TO, 10)
    expect(card.map((f) => f.offset)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1])
    expect(card[3].opacity).toBe(0)
    expect(card[2].opacity).toBeGreaterThan(0)
    expect(chip[3].opacity).toBe(1)
    expect(chip[2].opacity).toBeLessThan(1)
  })

  it('grows with the slide, never bigger than the card as it takes off', () => {
    const { chip } = flightFrames(FROM, TO, 20)
    const scale = (f: { transform: string }) => Number(/scale\(([\d.]+)\)/.exec(f.transform)?.[1])
    const widths = chip.map((f) => scale(f) * TO.width)
    // Never shrinks on the way, and lands at the chip's width.
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1] - 1e-6)
    expect(widths.at(-1)).toBeCloseTo(TO.width, 3)
    // While it turns into the chip (the first third of the time) it stays about the card's width.
    for (const w of widths.slice(0, 7)) expect(w).toBeLessThan(FROM.width * 1.05)
  })
})

describe('the path', () => {
  it('goes down first, then right, and arrives level', () => {
    const mid = flightPoint(FROM, TO, 0.5)
    const down = (mid.y - FROM.top) / (TO.top - FROM.top)
    const across = (mid.x - FROM.left) / (TO.left - FROM.left)
    expect(down).toBeGreaterThan(0.7)
    expect(across).toBeLessThan(0.3)
    const dir = arrivalDirection(FROM, TO)
    expect(dir.x).toBeGreaterThan(0.99)
    expect(Math.abs(dir.y)).toBeLessThan(0.1)
  })

  it('speeds up all the way: the last fifth of the time covers more than the first half', () => {
    const p = cubicBezier(...FLIGHT_PACE)
    expect(p(0)).toBe(0)
    expect(p(1)).toBe(1)
    expect(p(1) - p(0.8)).toBeGreaterThan(p(0.5) - p(0))
    // Each tenth of the time covers more than the one before.
    for (let i = 1; i < 10; i++) expect(p((i + 1) / 10) - p(i / 10)).toBeGreaterThan(p(i / 10) - p((i - 1) / 10))
  })

  it('arrives straight down when there is nowhere across to go', () => {
    expect(arrivalDirection(FROM, { ...TO, left: FROM.left })).toEqual({ x: 0, y: 1 })
  })
})

describe('settleFrames', () => {
  it('carries on the way it came, squashed along it, and ends at rest', () => {
    const frames = settleFrames({ x: 1, y: 0 })
    expect(frames[0].transform).toBe('none')
    expect(frames.at(-1)?.transform).toBe('none')
    expect(frames[1].transform).toBe('translate(7px, 0px) scale(1.035, 0.965)')
    // Springs back past its place a touch.
    expect(frames[2].transform).toMatch(/^translate\(-1\.96px, 0px\)/)
  })
})

describe('the flight', () => {
  let finish: Array<() => void>
  let animate: ReturnType<typeof vi.fn>
  let reducedMotion: boolean

  function box(rect: FlightRect, attrs: Record<string, string> = {}): HTMLElement {
    const el = document.createElement('div')
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    el.innerHTML = '<span id="inner" data-compact-verb="">Add</span> the follow-up'
    el.getBoundingClientRect = () => ({ ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON: () => ({}) })
    document.body.append(el)
    return el
  }
  const flyer = () => document.querySelector<HTMLElement>('[data-card-reply-flight]')

  beforeEach(() => {
    finish = []
    reducedMotion = false
    animate = vi.fn(() => {
      let resolve!: () => void
      let reject!: (e: unknown) => void
      const finished = new Promise<void>((res, rej) => {
        resolve = res
        reject = rej
      })
      // As browsers do: a cancelled animation's rejection is marked handled.
      finished.catch(() => {})
      finish.push(resolve)
      return { finished, cancel: vi.fn(() => reject(new Error('cancelled'))) }
    })
    ;(HTMLElement.prototype as unknown as { animate: unknown }).animate = animate
    window.matchMedia = ((query: string) => ({ matches: reducedMotion && query.includes('reduce') })) as unknown as typeof window.matchMedia
  })

  afterEach(() => {
    // Ends whatever is left in the air.
    launchCardReplyFlight(CARD, null)
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('holds a still copy of the card where it stood, then flies it to the chip', async () => {
    const source = box(FROM, { 'data-compact-focus-card': 'x', id: 'card' })
    launchCardReplyFlight(CARD, source)
    const f = flyer()
    expect(f).not.toBeNull()
    expect(f?.getAttribute('aria-hidden')).toBe('true')
    expect(f?.style.pointerEvents).toBe('none')
    // A copy: no ids and no data attributes, so nothing that finds the real card finds it.
    expect(f?.querySelector('[id]')).toBeNull()
    expect(f?.querySelector('[data-compact-focus-card], [data-compact-verb]')).toBeNull()
    expect(f?.textContent).toContain('the follow-up')
    expect(animate).not.toHaveBeenCalled()

    const chip = box(TO, { 'data-card-quote': '' })
    landCardReplyFlight(CARD, chip)
    expect(chip.style.opacity).toBe('0')
    expect(animate).toHaveBeenCalledTimes(2)
    const [cardFrames, timing] = animate.mock.calls[0] as [Array<{ transform: string }>, KeyframeAnimationOptions]
    expect(timing.duration).toBe(FLIGHT_MS)
    expect(cardFrames[0].transform).toBe('translate(40px, 200px) scale(1)')
    const [chipFrames] = animate.mock.calls[1] as [Array<{ transform: string }>]
    expect(chipFrames.at(-1)?.transform).toBe('translate(500px, 800px) scale(1)')

    // Landed: the real chip shows, the flyer is gone, and the chip bounces once.
    finish[1]()
    await Promise.resolve()
    await Promise.resolve()
    expect(flyer()).toBeNull()
    expect(chip.style.opacity).toBe('')
    expect(animate).toHaveBeenCalledTimes(3)
    expect(animate.mock.contexts[2]).toBe(chip)
    expect(animate.mock.calls[2]).toEqual([settleFrames(arrivalDirection(FROM, TO)), { duration: SETTLE_MS }])
  })

  it("lands only the card's own chip", () => {
    launchCardReplyFlight(CARD, box(FROM))
    const chip = box(TO)
    landCardReplyFlight(OTHER, chip)
    expect(animate).not.toHaveBeenCalled()
    expect(chip.style.opacity).toBe('')
  })

  it('a chip taken off mid-air shows again and the card waits to land again', () => {
    launchCardReplyFlight(CARD, box(FROM))
    const first = box(TO)
    const undo = landCardReplyFlight(CARD, first)
    undo()
    expect(first.style.opacity).toBe('')
    expect(flyer()).not.toBeNull()
    // React's development double mount: the second chip lands it.
    const second = box(TO)
    landCardReplyFlight(CARD, second)
    expect(animate).toHaveBeenCalledTimes(4)
    expect(second.style.opacity).toBe('0')
  })

  it('a new Reply ends the flight in the air', () => {
    launchCardReplyFlight(CARD, box(FROM))
    const chip = box(TO)
    landCardReplyFlight(CARD, chip)
    launchCardReplyFlight(OTHER, box(FROM))
    expect(chip.style.opacity).toBe('')
    expect(document.querySelectorAll('[data-card-reply-flight]')).toHaveLength(1)
  })

  it('a card whose chip never comes fades away', async () => {
    vi.useFakeTimers()
    launchCardReplyFlight(CARD, box(FROM))
    vi.advanceTimersByTime(FLIGHT_WAIT_MS)
    expect(animate).toHaveBeenCalledTimes(1)
    finish[0]()
    await vi.runAllTimersAsync()
    expect(flyer()).toBeNull()
  })

  it('does nothing with reduced motion', () => {
    reducedMotion = true
    launchCardReplyFlight(CARD, box(FROM))
    expect(flyer()).toBeNull()
    const chip = box(TO)
    landCardReplyFlight(CARD, chip)
    expect(chip.style.opacity).toBe('')
  })

  it('does nothing without the Web Animations API', () => {
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate
    launchCardReplyFlight(CARD, box(FROM))
    expect(flyer()).toBeNull()
  })

  it('does nothing for a card with no size (not on screen)', () => {
    launchCardReplyFlight(CARD, box({ left: 0, top: 0, width: 0, height: 0 }))
    expect(flyer()).toBeNull()
  })
})

describe('the way back (flyBack): the same path, backwards', () => {
  const HOME = { left: 60, top: 6, width: 36, height: 36 }
  const BOX = { left: 192, top: 108, width: 640, height: 553 }

  it('starts where the way there ended and ends where it began, offsets mirrored', () => {
    const there = flightFrames(HOME, BOX, 10).chip
    const back = reversedFrames(there)
    expect(back[0].transform).toBe(there.at(-1)!.transform)
    expect(back.at(-1)!.transform).toBe(there[0].transform)
    expect(back.map((f) => f.offset)).toEqual(there.map((f) => f.offset))
    expect(back[0].opacity).toBe(there.at(-1)!.opacity)
  })

  it('sets out downwards from the button, so it comes home moving up', () => {
    const dir = departureDirection(HOME, BOX)
    expect(dir.y).toBeGreaterThan(0.9)
  })
})

describe('kept corners (keepCorners: the search box)', () => {
  const HOME = { left: 60, top: 6, width: 36, height: 36 }
  const BOX = { left: 192, top: 108, width: 640, height: 553 }
  const px = (v: string | undefined) => parseFloat(v ?? '')

  it('draws the box’s 16px corners at 16px whatever its scale, and a pill while it’s the button’s size', () => {
    const { chip } = flightFrames(HOME, BOX, 10, { card: 18, chip: 16 })
    for (const f of chip) {
      const scale = Number(/scale\(([\d.]+)\)/.exec(f.transform)![1])
      // On screen: radius × scale, at most half the drawn height.
      expect(Math.min(px(f.borderRadius) * scale, (BOX.height * scale) / 2)).toBeCloseTo(Math.min(16, (BOX.height * scale) / 2), 0)
    }
    // At the start it's no bigger than the button, so its corners are half its height: a pill.
    expect(px(chip[0].borderRadius)).toBeCloseTo(BOX.height / 2, 0)
    expect(px(chip.at(-1)!.borderRadius)).toBeCloseTo(16, 1)
  })

  it('leaves the frames alone without radii (a Reply’s flight)', () => {
    expect(flightFrames(HOME, BOX, 4).chip.every((f) => f.borderRadius === undefined)).toBe(true)
  })
})
