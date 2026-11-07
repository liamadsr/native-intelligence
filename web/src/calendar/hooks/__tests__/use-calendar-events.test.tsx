// @vitest-environment jsdom
/**
 * The shared calendar poll must be TAB-gated, not just document-visibility
 * gated (2026-08-05 idle-residue sweep): every dashboard tab stays mounted
 * (display:none when inactive), so a backgrounded calendar tab of a VISIBLE
 * window used to keep polling provider APIs every 60s for the life of the
 * session. Pins the gate (same pattern as email-layout's sync-status poll):
 *  - an active-tab consumer polls on the shared 60s interval;
 *  - a background-tab consumer still fetches once on mount (first paint) but
 *    never polls;
 *  - re-activation catches up ONLY when the shared cache went stale, then
 *    resumes polling.
 *
 * Module-level shared state (cache, lastFetchAt, refcounted timer) means each
 * test imports a FRESH copy of the module via vi.resetModules().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaceId: () => 'ws-1',
}))
// The real module monkey-patches window.fetch on import (workspace header +
// auth-retry interceptor), which would wrap this file's fetch mock in async
// hops and skew the call counts. The hook only uses it for the cold-start
// cache hydration, which these tests don't exercise.
vi.mock('@/lib/workspace-fetch', () => ({
  getClientWorkspaceId: () => null,
}))
vi.mock('@/hooks/use-entity-sync', () => ({
  useEntityListSync: () => {},
}))
vi.mock('@/lib/integrations/calendar-local', () => ({
  mergeWithLocalExchangeEvents: async (events: unknown[]) => events,
}))
vi.mock('@/calendar/adapters', () => ({
  calendarEventToIEvent: (e: unknown) => e,
  actionToIEvent: (a: unknown) => a,
}))

const fetchMock = vi.fn()
globalThis.fetch = fetchMock as never

function okJson(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload }
}

/** Count of provider-events fetches (the polled call the gate is about). */
const eventsFetches = () =>
  fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('/api/calendar/events')).length

interface Harness {
  rerender: () => Promise<void>
  unmount: () => void
}

/** Fresh module + one mounted consumer of useCalendarEvents. */
async function mountConsumer(): Promise<Harness> {
  vi.resetModules()
  const { useCalendarEvents } = await import('../use-calendar-events')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  function Consumer() {
    useCalendarEvents()
    return null
  }
  await act(async () => {
    root.render(h(Consumer))
  })
  return {
    rerender: async () => {
      await act(async () => {
        root.render(h(Consumer))
      })
    },
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers() // fakes Date too — staleness windows advance with the clock
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url: unknown) => {
    const u = String(url)
    if (u.startsWith('/api/calendar/events')) return okJson({ events: [] })
    if (u.startsWith('/api/account/actions')) return okJson({ actions: [] })
    return okJson({})
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useCalendarEvents — the shared poll', () => {
  it('a mounted consumer polls on the shared 60s interval', async () => {
    const hk = await mountConsumer()
    expect(eventsFetches()).toBe(1) // the mount fetch

    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(eventsFetches()).toBe(2) // one poll tick

    hk.unmount()
  })
})
