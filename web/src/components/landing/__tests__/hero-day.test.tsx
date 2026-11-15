/**
 * The agent's day (../hero-day.tsx): the clock that moves with the marker
 * between stops and stands still at each one, all the way round the dial;
 * which result the middle shows when; and the still picture the server (and a
 * visitor without motion) gets.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HeroDay, NIGHT_STOPS, STOPS, hourAt, latestEvent } from '../hero-day'

const steps = Array.from({ length: 2001 }, (_, i) => i / 2000)

describe('hourAt', () => {
  it('starts and ends at sunrise and never leaves the clock', () => {
    expect(hourAt(0)).toBe(6)
    expect(hourAt(0.02)).toBe(6)
    expect(hourAt(0.97)).toBe(6)
    for (const p of [...steps, -1, 2]) {
      expect(hourAt(p)).toBeGreaterThanOrEqual(0)
      expect(hourAt(p)).toBeLessThan(24)
    }
  })

  it('goes once round the whole day: through noon, sunset and midnight, back to morning', () => {
    const hours = steps.filter((p) => p < 0.9).map(hourAt)
    // Unwrap the clock: it only ever moves forward, and passes midnight once.
    let wraps = 0
    for (let i = 1; i < hours.length; i++) {
      if (hours[i] < hours[i - 1] - 1e-9) {
        expect(hours[i - 1] - hours[i]).toBeGreaterThan(12)
        wraps++
      }
    }
    expect(wraps).toBe(1)
    for (const through of [12, 18, 23, 2, 5]) expect(hours.some((h) => Math.abs(h - through) < 0.5), String(through)).toBe(true)
  })

  it('stands still at every stop', () => {
    const held = new Set<number>()
    for (let i = 8; i < steps.length; i++) {
      const now = hourAt(steps[i])
      if (now === hourAt(steps[i - 8]) && latestEvent(steps[i]) >= 0 && steps[i] < 0.88) held.add(now)
    }
    expect(held.size).toBe(STOPS)
  })
})

describe('latestEvent', () => {
  it('shows nothing while the scene sets, then each event in turn, then nothing', () => {
    const seen: number[] = []
    for (const p of steps) {
      const now = latestEvent(p)
      if (seen[seen.length - 1] !== now) seen.push(now)
    }
    expect(seen).toEqual([-1, ...Array.from({ length: STOPS }, (_, i) => i), -1])
  })

  it('keeps working after sunset: several of the stops are at night', () => {
    expect(NIGHT_STOPS).toBeGreaterThanOrEqual(3)
    expect(STOPS - NIGHT_STOPS).toBeGreaterThanOrEqual(5)
  })
})

describe('the still picture', () => {
  it('shows every event of the day and the night with what was done about it, and no clock or card', () => {
    const markup = renderToStaticMarkup(createElement(HeroDay))
    for (const text of ['Lena’s email', 'Reply drafted', 'It texted you', 'You replied yes', 'Held until morning', 'Pull request opened', 'Inbox cleared']) {
      expect(markup).toContain(text)
    }
    expect(markup).not.toContain('class="ni-day-card')
    expect(markup).toContain('aria-hidden')
  })

  it('names the hours all the way round the dial', () => {
    const markup = renderToStaticMarkup(createElement(HeroDay))
    for (const hour of ['00', '06', '12', '18', '21']) expect(markup).toContain(`>${hour}<`)
  })

  it('moves on three curves and no others, and never at a constant speed between stops', () => {
    const css = renderToStaticMarkup(createElement(HeroDay)).split('<style>')[1]?.split('</style>')[0] ?? ''
    const curves = new Set(css.match(/cubic-bezier\([^)]*\)/g) ?? [])
    expect(curves.size).toBe(3)
    const marker = css.split('@keyframes ni-day-marker {')[1]?.split('\n}')[0] ?? ''
    expect(marker.split('animation-timing-function').length - 1).toBeGreaterThanOrEqual(STOPS + 1)
  })
})
