// @vitest-environment jsdom
/**
 * The meeting's time in the HUD (./hud-schedule-bar.tsx). Pinned:
 *   - the header's fill at fixed clocks: none before or at the start, half
 *     at the middle, filling from the left in one colour that moves green →
 *     purple → red, its edge straight; past the end the whole pill red;
 *   - the header's "N min left" beside it;
 *   - no schedule (no scheduled end): no fill and no words at all;
 *   - both move in 30 s steps from one shared timeout, and render nothing in
 *     between; the clock stops with the last leaf.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/live-chat/live-chat', () => ({ LiveChat: () => h('div', { 'data-chat-stub': '' }) }))
vi.mock('../use-live-agent-name', () => ({ useLiveAgentName: () => 'Sales Coach' }))

import { HUD_CLOCK_STEP_MS, HudScheduleFill, HudTimeLeft, hudFillColor, hudScheduleUsed } from '../hud-schedule-bar'
import { AgentHudView } from '../agent-hud-view'
import { EMPTY_HUD_FEED } from '../hud-feed'
import type { HudSchedule } from '@/lib/live-agent/hud-schedule'

const MIN = 60_000
const START = Date.parse('2026-10-17T15:00:00.000Z')
const END = START + 60 * MIN
const SCHEDULE: HudSchedule = { captureId: 'cap-1', start: START, end: END }

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
})

const fill = () => container.querySelector('[data-hud-schedule-fill]') as HTMLElement | null
const used = () => fill()!.style.getPropertyValue('--hud-used')
const words = () => container.querySelector('[data-hud-time-left]')?.textContent

async function renderAt(now: number, schedule: HudSchedule = SCHEDULE) {
  vi.setSystemTime(now)
  await act(async () => root.render(h('div', null, h(HudTimeLeft, { schedule }), h(HudScheduleFill, { schedule }))))
}

describe('the fill at fixed clocks', () => {
  it('fills from the left as the call goes: none at the start, half at the middle', async () => {
    await renderAt(START)
    expect(used()).toBe('0%')
    expect(words()).toBe('1 h left')
    await act(async () => root.render(h('div')))
    await renderAt(START + 30 * MIN)
    expect(used()).toBe('50%')
    expect(fill()!.getAttribute('aria-valuenow')).toBe('50')
    expect(words()).toBe('30 min left')
    // The sweep runs to the edge, straight: the pill (its overflow) does the rounding.
    expect(fill()!.className).toContain('overflow-hidden')
    expect(fill()!.className).toContain('rounded-[inherit]')
    expect(container.querySelector('[data-hud-schedule-sweep]')!.className).toContain('w-[var(--hud-used)]')
    expect(fill()!.style.getPropertyValue('--hud-c')).toBe(hudFillColor(0.5))
  })

  it('one colour that moves with the call: green at the start, purple at the middle, red at the end', () => {
    expect(hudFillColor(0)).toBe('16 185 129')
    expect(hudFillColor(0.5)).toBe('139 92 246')
    expect(hudFillColor(1)).toBe('225 29 72')
    expect(hudFillColor(0.25)).toBe('78 139 188')
    expect(hudFillColor(-1)).toBe(hudFillColor(0))
    expect(hudFillColor(2)).toBe(hudFillColor(1))
  })

  it('before the start: nothing used yet', () => {
    expect(hudScheduleUsed(SCHEDULE, START - 3 * MIN)).toEqual({ used: 0, over: false })
    expect(hudScheduleUsed(SCHEDULE, START + 45 * MIN)).toEqual({ used: 0.75, over: false })
  })

  it('past the end: the whole pill red, and how far over in the same quiet words', async () => {
    await renderAt(END + 5 * MIN)
    expect(fill()!.hasAttribute('data-over')).toBe(true)
    expect(fill()!.className).toContain('rgb(225_29_72/0.26)')
    expect(container.querySelector('[data-hud-schedule-sweep]')).toBeNull()
    expect(used()).toBe('')
    expect(words()).toBe('5 min over')
  })
})

describe('steps', () => {
  it('moves only at each 30 s step, from one shared timeout, and stops with the last leaf', async () => {
    // A step boundary, so the next one is a whole step away.
    await renderAt(START + 20 * MIN)
    expect(words()).toBe('40 min left')
    expect(vi.getTimerCount()).toBe(1)
    const width = used()

    await act(async () => { await vi.advanceTimersByTimeAsync(HUD_CLOCK_STEP_MS - 1000) })
    expect(used()).toBe(width)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000 + 10) })
    expect(used()).not.toBe(width)
    expect(words()).toBe('40 min left')
    await act(async () => { await vi.advanceTimersByTimeAsync(HUD_CLOCK_STEP_MS) })
    expect(words()).toBe('39 min left')
    expect(vi.getTimerCount()).toBe(1)

    await act(async () => root.render(h('div')))
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('in the HUD', () => {
  it('no scheduled end: no fill and no time left at all', async () => {
    vi.setSystemTime(START)
    await act(async () => root.render(h(AgentHudView, { host: 'window', feed: EMPTY_HUD_FEED, actions: { sendVoiceIdAction: () => {} } })))
    expect(fill()).toBeNull()
    expect(words()).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a schedule: the time left in the header, and the header itself fills behind its words', async () => {
    vi.setSystemTime(START + 48 * MIN)
    await act(async () =>
      root.render(h(AgentHudView, { host: 'window', feed: { ...EMPTY_HUD_FEED, schedule: SCHEDULE }, actions: { sendVoiceIdAction: () => {} } })),
    )
    const header = container.querySelector('[data-hud-header]')!
    expect(header.querySelector('[data-hud-time-left]')!.textContent).toBe('12 min left')
    expect(header.firstElementChild).toBe(fill())
    expect(header.className).toMatch(/(^|\s)relative(\s|$)/)
    expect(header.className).toMatch(/(^|\s)isolate(\s|$)/)
    expect(fill()!.className).toContain('-z-10')
    expect(used()).toBe('80%')
    expect(container.querySelector('[data-hud-schedule-bar]')).toBeNull()
  })
})
