// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { MeetingAssistantView, MEETING_AGENT_URL } from '../meeting-assistant-view'

let root: Root | null = null
let container: HTMLDivElement | null = null
const calls: Array<{ url: string; method: string; body?: string }> = []
let listing: unknown = null
let status = 200

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => {})
}

beforeEach(() => {
  calls.length = 0
  status = 200
  listing = {
    attendances: [
      { id: 'a1', title: 'Pilot review', startsAt: '2026-11-30T18:00:00.000Z', status: 'scheduled', statusDetail: null, displayName: "Sam's assistant (AI)", asks: [], captureId: null, seriesRef: null },
      { id: 'a2', title: 'Weekly standup', startsAt: '2026-12-01T15:00:00.000Z', status: 'scheduled', statusDetail: null, displayName: "Sam's assistant (AI)", asks: [], captureId: null, seriesRef: 's1' },
      { id: 'a3', title: 'Acme sync', startsAt: '2026-11-29T15:00:00.000Z', status: 'in_meeting', statusDetail: null, displayName: "Sam's assistant (AI)", asks: [{ at: 'x', question: 'Can we start Monday?', messageId: 'm' }], captureId: null, seriesRef: null },
    ],
    series: [{ id: 's1', title: 'Weekly standup', pausedAt: null }],
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined })
    if ((init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify(listing), { status })
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  vi.unstubAllGlobals()
})

const button = (row: string, label: string) => [...container!.querySelectorAll(`[${row}] button`)].find((b) => b.textContent === label) as HTMLButtonElement | undefined

describe('Settings › Meetings', () => {
  it('lists each meeting with its status and the questions it asked', async () => {
    act(() => root!.render(h(MeetingAssistantView)))
    await flush()
    const text = container!.textContent ?? ''
    expect(text).toContain('Pilot review')
    expect(text).toContain('Will dial in at the start.')
    expect(text).toContain('In the meeting now.')
    expect(text).toContain('Asked you: Can we start Monday?')
    expect(text).toContain('Recurring meetings')
  })

  it('cancels one, skips an occurrence of a series, pulls it out of a meeting, and pauses or stops a series', async () => {
    act(() => root!.render(h(MeetingAssistantView)))
    await flush()
    expect(button('data-attendance="a1"', 'Cancel')).toBeTruthy()
    expect(button('data-attendance="a2"', 'Skip this one')).toBeTruthy()
    await act(async () => button('data-attendance="a3"', 'Pull it out')!.click())
    await flush()
    expect(calls).toContainEqual({ url: `${MEETING_AGENT_URL}?id=a3`, method: 'DELETE', body: undefined })
    await act(async () => button('data-series="s1"', 'Pause')!.click())
    await flush()
    expect(calls).toContainEqual({ url: MEETING_AGENT_URL, method: 'PATCH', body: JSON.stringify({ series_id: 's1', paused: true }) })
    await act(async () => button('data-series="s1"', 'Stop')!.click())
    await flush()
    expect(calls).toContainEqual({ url: `${MEETING_AGENT_URL}?series_id=s1`, method: 'DELETE', body: undefined })
  })

  it('says so when the server has it off', async () => {
    status = 403
    act(() => root!.render(h(MeetingAssistantView)))
    await flush()
    expect(container!.textContent).toContain('isn’t turned on yet')
  })
})
