// @vitest-environment jsdom
/**
 * Wake-storm fixes for the shared calendar fetch (2026-09-13 desktop perf
 * work). Measured before: one return-to-app issued 21 API requests with a
 * single calendar tab and 40 with six, because every mounted consumer (six
 * calendar tabs + the dashboard agenda widget) ran its own copy of the fetch
 * closure, and the 'ni:realtime-recovered' wave force-fetched on hidden
 * tabs seconds after the visibility wave already had.
 *
 * Pins the three mechanisms:
 *  - module-level in-flight dedupe keyed by workspace+filter: N instances
 *    triggered together share ONE round-trip;
 *  - the bus/recovered refetch is tab-gated (hidden → dirty flag, reconciled
 *    once on activation);
 *  - a recovered refetch on an ACTIVE tab is skipped while the last fetch for
 *    the key is still inside FOCUS_STALE_MS.
 *  - plus the change-detection baseline ignoring attendeeDetails[].responseStatus.
 *
 * Unlike use-calendar-events.test.tsx (one consumer per fresh module), these
 * tests mount several consumers against ONE module instance — that shared
 * module state is exactly what is under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { IEvent } from '@/calendar/interfaces'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let mockWorkspaceId = 'ws-1'
vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaceId: () => mockWorkspaceId,
}))
// The real module monkey-patches window.fetch on import (workspace header +
// auth-retry interceptor), which would wrap this file's fetch mock in async
// hops and skew the call counts.
vi.mock('@/lib/workspace-fetch', () => ({
  getClientWorkspaceId: () => null,
}))
// Controllable fake: capture the callbacks the hook registers so a test can
// fire a "real calendar_event mutation" without a window event, and assert
// the hook opted out of useEntityListSync's own recovered handling.
//
// The real hook keeps the callback in a ref and subscribes once per mount, so
// the fake must too — it is called on EVERY render, and pushing each time
// would let one instance fire N times and silently fake the dedupe result.
let busHandlers: Array<() => void> = []
let lastListSyncOpts: unknown = undefined
vi.mock('@/hooks/use-entity-sync', () => {
  const { useEffect, useRef } = require('react') as typeof import('react')
  return {
    useEntityListSync: (_kinds: string[], cb: () => void, opts?: unknown) => {
      const ref = useRef(cb)
      ref.current = cb
      lastListSyncOpts = opts
      useEffect(() => {
        const fire = () => ref.current()
        busHandlers.push(fire)
        return () => {
          busHandlers = busHandlers.filter((h) => h !== fire)
        }
      }, [])
    },
  }
})
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

const eventsFetches = () =>
  fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('/api/calendar/events')).length
const linkedCaptureFetches = () =>
  fetchMock.mock.calls.filter((c) => String(c[0]) === '/api/account/calendar/linked-captures').length

/** Events the provider mock returns; swapped per test. */
let providerEvents: unknown[] = []

type HookModule = typeof import('../use-calendar-events')

interface Mounted {
  rerender: () => Promise<void>
  unmount: () => void
}

/** Roots mounted by the current test, torn down in afterEach — a failing
 *  assertion skips the test's own unmount, and a surviving root would keep
 *  its window listeners and leak fetches into the next test. */
let mountedRoots: Array<() => void> = []

/** Mount one more consumer against an ALREADY-imported module instance. */
async function mountAgainst(mod: HookModule): Promise<Mounted> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  function Consumer() {
    mod.useCalendarEvents()
    return null
  }
  await act(async () => {
    root.render(h(Consumer))
  })
  let done = false
  const unmount = () => {
    if (done) return
    done = true
    act(() => root.unmount())
    container.remove()
  }
  mountedRoots.push(unmount)
  return {
    rerender: async () => {
      await act(async () => {
        root.render(h(Consumer))
      })
    },
    unmount,
  }
}

/** Fresh module (module-level cache, lastFetchAt, in-flight slot all reset). */
async function freshModule(): Promise<HookModule> {
  vi.resetModules()
  return import('../use-calendar-events')
}

beforeEach(() => {
  vi.useFakeTimers() // fakes Date too — staleness windows advance with the clock
  mockWorkspaceId = 'ws-1'
  busHandlers = []
  lastListSyncOpts = undefined
  providerEvents = []
  mountedRoots = []
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url: unknown) => {
    const u = String(url)
    if (u.startsWith('/api/calendar/events')) return okJson({ events: providerEvents })
    if (u.startsWith('/api/account/actions')) return okJson({ actions: [] })
    if (u === '/api/account/calendar/linked-captures') return okJson({})
    return okJson({})
  })
})

afterEach(() => {
  mountedRoots.forEach((u) => u())
  mountedRoots = []
  vi.useRealTimers()
})

describe('useCalendarEvents — multi-instance fetch dedupe', () => {
  it('two consumers force-refetching together share ONE round-trip', async () => {
    const mod = await freshModule()
    const a = await mountAgainst(mod)
    const b = await mountAgainst(mod)
    expect(eventsFetches()).toBe(1) // one mount fetch between them

    // The wake case: both instances get the same trigger and each calls its
    // OWN fetch closure with force (so neither can be short-circuited by the
    // freshness window). Only the in-flight dedupe collapses these.
    await act(async () => {
      busHandlers.forEach((cb) => cb())
    })
    expect(busHandlers.length).toBe(2) // both instances really registered
    expect(eventsFetches()).toBe(2) // ...but one network round-trip

    // ...and one poll tick still drives exactly one fetch, not two.
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(eventsFetches()).toBe(3)

    a.unmount()
    b.unmount()
  })

  it('a slow in-flight fetch is joined, not duplicated, by a second trigger', async () => {
    const mod = await freshModule()
    // Hold the provider response open so both triggers overlap in flight.
    let release!: (v: unknown) => void
    const pending = new Promise((r) => {
      release = r
    })
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.startsWith('/api/calendar/events')) {
        await pending
        return okJson({ events: [] })
      }
      if (u.startsWith('/api/account/actions')) return okJson({ actions: [] })
      return okJson({})
    })

    const a = await mountAgainst(mod)
    expect(eventsFetches()).toBe(1) // in flight, unresolved

    // A second consumer mounts while the first request is still open.
    const b = await mountAgainst(mod)
    // ...and a real calendar_event bus mutation lands too (force: true, so it
    // cannot be short-circuited by the freshness window).
    await act(async () => {
      busHandlers.forEach((cb) => cb())
    })
    expect(eventsFetches()).toBe(1) // both joined the open promise

    await act(async () => {
      release(null)
      await Promise.resolve()
    })
    expect(eventsFetches()).toBe(1)
    // One shared primary fetch → one shared background linked-captures POST
    // would only run with events present; with none, none is issued.
    expect(linkedCaptureFetches()).toBe(0)

    a.unmount()
    b.unmount()
  })

  it('opts out of useEntityListSync’s own recovered refetch (handled directly)', async () => {
    const mod = await freshModule()
    const a = await mountAgainst(mod)
    expect(lastListSyncOpts).toEqual({ refetchOnRecovered: false })
    a.unmount()
  })
})

describe('useCalendarEvents — recovered refetch gating', () => {
  it('an active tab skips a recovered refetch inside FOCUS_STALE_MS, then fetches after it', async () => {
    const mod = await freshModule()
    const hk = await mountAgainst(mod)
    expect(eventsFetches()).toBe(1)

    // Same wake as the fetch that just completed — redundant, skipped.
    await act(async () => {
      window.dispatchEvent(new CustomEvent('ni:realtime-recovered'))
    })
    expect(eventsFetches()).toBe(1)

    // Past FOCUS_STALE_MS the catch-up is real news again. Advance in one step
    // shorter than the 60s poll so no poll tick contributes.
    await act(async () => {
      vi.advanceTimersByTime(31_000)
    })
    await act(async () => {
      window.dispatchEvent(new CustomEvent('ni:realtime-recovered'))
    })
    expect(eventsFetches()).toBe(2)

    hk.unmount()
  })

  it('a real calendar_event bus mutation is NOT subject to the recency guard', async () => {
    const mod = await freshModule()
    const hk = await mountAgainst(mod)
    expect(eventsFetches()).toBe(1)

    // Immediately after a completed fetch — a genuine mutation still refetches
    // (unlike the recovered wave, it carries actual news).
    await act(async () => {
      busHandlers.forEach((cb) => cb())
    })
    expect(eventsFetches()).toBe(2)

    hk.unmount()
  })
})

describe('useCalendarEvents — change-detection baseline', () => {
  it('treats two baselines differing only in responseStatus as unchanged', async () => {
    const withStatus = (status: string): IEvent[] => [
      {
        id: 'e1',
        startDate: '2026-09-13T10:00:00.000Z',
        endDate: '2026-09-13T11:00:00.000Z',
        title: 'Standup',
        color: 'blue',
        description: '',
        attendees: ['a@x.com'],
        attendeeDetails: [{ email: 'a@x.com', responseStatus: status }],
      } as IEvent,
    ]

    providerEvents = withStatus('needsAction')
    const mod = await freshModule()
    const hk = await mountAgainst(mod)
    expect(eventsFetches()).toBe(1)

    // Capture the array identity the shared cache settled on.
    let notified: IEvent[] | null = null
    mod.patchCalendarEventsCache((events) => {
      notified = events
      return events // no-op patch, just to read the cache
    })
    const first = notified as IEvent[] | null
    expect(first).not.toBeNull()

    // Someone RSVPs: the ONLY difference in the next poll's payload.
    providerEvents = withStatus('accepted')
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(eventsFetches()).toBe(2)

    let after: IEvent[] | null = null
    mod.patchCalendarEventsCache((events) => {
      after = events
      return events
    })
    // sameData: the cached array (and therefore every consumer's state) keeps
    // its identity, so nothing downstream re-renders.
    expect(after).toBe(first)

    hk.unmount()
  })

  it('a real content change DOES replace the cached array', async () => {
    providerEvents = [
      {
        id: 'e1',
        startDate: '2026-09-13T10:00:00.000Z',
        endDate: '2026-09-13T11:00:00.000Z',
        title: 'Standup',
        color: 'blue',
        description: '',
      } as IEvent,
    ]
    const mod = await freshModule()
    const hk = await mountAgainst(mod)

    let first: IEvent[] | null = null
    mod.patchCalendarEventsCache((events) => {
      first = events
      return events
    })

    providerEvents = [{ ...(providerEvents[0] as IEvent), title: 'Standup (moved)' }]
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })

    let after: IEvent[] | null = null
    mod.patchCalendarEventsCache((events) => {
      after = events
      return events
    })
    expect(after).not.toBe(first)
    expect((after as unknown as IEvent[])[0].title).toBe('Standup (moved)')

    hk.unmount()
  })
})

describe('useCalendarEvents — superseded fetches must not commit to the shared cache', () => {
  /**
   * performFetch runs detached from any instance's generation counter, so the
   * ONLY thing standing between a superseded response and the shared cache is
   * the module-level "latest requested key" guard. Without it, an all-accounts
   * fetch that resolves after the user switched filters wrote
   * cachedEvents/cachedFilterKey and called notifyEvents — repainting every
   * calendar surface with the account set the user just left.
   */
  it('an all-accounts fetch resolving AFTER a filter switch does not clobber the filtered data', async () => {
    const mod = await freshModule()

    const allEvent = { id: 'all-1', title: 'All accounts', startDate: 'x', endDate: 'y' }
    const filteredEvent = { id: 'f-1', title: 'Filtered', startDate: 'x', endDate: 'y' }

    // The all-accounts request hangs until we release it; the filtered one
    // (accountIds=acct-a) answers immediately.
    let releaseAll!: () => void
    const allPending = new Promise<void>((r) => {
      releaseAll = r
    })
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.startsWith('/api/calendar/events')) {
        if (u.includes('accountIds=acct-a')) return okJson({ events: [filteredEvent] })
        await allPending
        return okJson({ events: [allEvent] })
      }
      if (u.startsWith('/api/account/actions')) return okJson({ actions: [] })
      return okJson({})
    })

    // Mount with the default (all-accounts) filter — its fetch is now open.
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    let api: ReturnType<HookModule['useCalendarEvents']> | null = null
    function Consumer() {
      api = mod.useCalendarEvents()
      return null
    }
    await act(async () => {
      root.render(h(Consumer))
    })
    mountedRoots.push(() => {
      act(() => root.unmount())
      container.remove()
    })
    expect(eventsFetches()).toBe(1)

    // Switch to a single account. Its fetch resolves first and commits.
    await act(async () => {
      api!.setFilterAccountIds(['acct-a'])
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(eventsFetches()).toBe(2)

    let committed: unknown[] | null = null
    mod.patchCalendarEventsCache((events) => {
      committed = events
      return events
    })
    expect((committed as unknown as IEvent[])[0].id).toBe('f-1')

    // NOW the superseded all-accounts response lands.
    await act(async () => {
      releaseAll()
      await Promise.resolve()
      await Promise.resolve()
    })

    // The shared cache — and therefore every consumer — must still hold the
    // FILTERED data, not the stale all-accounts payload.
    let after: unknown[] | null = null
    mod.patchCalendarEventsCache((events) => {
      after = events
      return events
    })
    expect((after as unknown as IEvent[])[0].id).toBe('f-1')
    expect(api!.events[0]?.id).toBe('f-1')
  })

  it('a fetch resolving AFTER a workspace switch does not clobber the new workspace’s data', async () => {
    const mod = await freshModule()

    const wsOneEvent = { id: 'ws1-e', title: 'Workspace one', startDate: 'x', endDate: 'y' }
    const wsTwoEvent = { id: 'ws2-e', title: 'Workspace two', startDate: 'x', endDate: 'y' }

    let releaseOne!: () => void
    const onePending = new Promise<void>((r) => {
      releaseOne = r
    })
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.startsWith('/api/calendar/events')) {
        if (u.includes('workspaceId=ws-2')) return okJson({ events: [wsTwoEvent] })
        await onePending
        return okJson({ events: [wsOneEvent] })
      }
      if (u.startsWith('/api/account/actions')) return okJson({ actions: [] })
      return okJson({})
    })

    const a = await mountAgainst(mod)
    expect(eventsFetches()).toBe(1) // ws-1, still open

    // The workspace context flips; the hook refetches under the new id.
    mockWorkspaceId = 'ws-2'
    await a.rerender()
    await act(async () => {
      await Promise.resolve()
    })
    expect(eventsFetches()).toBe(2)

    let committed: unknown[] | null = null
    mod.patchCalendarEventsCache((events) => {
      committed = events
      return events
    })
    expect((committed as unknown as IEvent[])[0].id).toBe('ws2-e')

    // The superseded ws-1 response lands late.
    await act(async () => {
      releaseOne()
      await Promise.resolve()
      await Promise.resolve()
    })

    let after: unknown[] | null = null
    mod.patchCalendarEventsCache((events) => {
      after = events
      return events
    })
    expect((after as unknown as IEvent[])[0].id).toBe('ws2-e')
  })
})

describe('useCalendarEvents — the linked-captures POST must not hold the in-flight slot', () => {
  /**
   * The LC POST used to be awaited INSIDE the promise stored in
   * inFlightPromise, so for its whole duration every poll tick / bus event /
   * focus catch-up "joined" a promise that issued no request of its own —
   * measured as ten consecutive 60s poll ticks producing ZERO events fetches.
   * The primary result must settle the in-flight slot; the LC merge runs
   * detached.
   */
  it('a poll tick during an open linked-captures POST still issues a new events fetch', async () => {
    const mod = await freshModule()

    const evt = { id: 'e1', title: 'Standup', startDate: 'x', endDate: 'y' }
    let releaseLc!: () => void
    const lcPending = new Promise<void>((r) => {
      releaseLc = r
    })
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.startsWith('/api/calendar/events')) return okJson({ events: [evt] })
      if (u.startsWith('/api/account/actions')) return okJson({ actions: [] })
      if (u === '/api/account/calendar/linked-captures') {
        await lcPending
        return okJson({})
      }
      return okJson({})
    })

    const a = await mountAgainst(mod)
    await act(async () => {
      await Promise.resolve()
    })
    expect(eventsFetches()).toBe(1)
    expect(linkedCaptureFetches()).toBe(1) // open, never resolved

    // Ten poll ticks while the LC POST is still open. Each must reach the
    // network: the primary promise already settled, so nothing to join.
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        vi.advanceTimersByTime(60_000)
      })
      await act(async () => {
        await Promise.resolve()
      })
    }
    expect(eventsFetches()).toBe(11)

    releaseLc()
    a.unmount()
  })

  it('a bus mutation during an open linked-captures POST is not swallowed', async () => {
    const mod = await freshModule()

    const evt = { id: 'e1', title: 'Standup', startDate: 'x', endDate: 'y' }
    let releaseLc!: () => void
    const lcPending = new Promise<void>((r) => {
      releaseLc = r
    })
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.startsWith('/api/calendar/events')) return okJson({ events: [evt] })
      if (u.startsWith('/api/account/actions')) return okJson({ actions: [] })
      if (u === '/api/account/calendar/linked-captures') {
        await lcPending
        return okJson({})
      }
      return okJson({})
    })

    const a = await mountAgainst(mod)
    await act(async () => {
      await Promise.resolve()
    })
    expect(eventsFetches()).toBe(1)

    await act(async () => {
      busHandlers.forEach((cb) => cb())
    })
    expect(eventsFetches()).toBe(2)

    releaseLc()
    a.unmount()
  })
})

describe('useCalendarEvents — detached linked-captures still reach consumers', () => {
  /**
   * performFetch used to RETURN the capture-merged array, so the awaiting
   * caller's setEvents got it. Now it returns the primary result and the
   * detached merge reaches every consumer through notifyEvents — which is the
   * only path, so it must actually work.
   */
  it('capture links land in the shared cache and in consumer state', async () => {
    const mod = await freshModule()
    const evt = { id: 'e1', title: 'Standup', startDate: 'x', endDate: 'y' }
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.startsWith('/api/calendar/events')) return okJson({ events: [evt] })
      if (u.startsWith('/api/account/actions')) return okJson({ actions: [] })
      if (u === '/api/account/calendar/linked-captures')
        return okJson({ e1: { id: 'cap-1', title: 'Standup notes' } })
      return okJson({})
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    let api: ReturnType<HookModule['useCalendarEvents']> | null = null
    function Consumer() {
      api = mod.useCalendarEvents()
      return null
    }
    await act(async () => {
      root.render(h(Consumer))
    })
    mountedRoots.push(() => {
      act(() => root.unmount())
      container.remove()
    })
    // Let the detached merge settle.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api!.events[0]?.linkedCapture).toEqual({ id: 'cap-1', title: 'Standup notes' })
  })
})

describe('useCalendarEvents — supersede is by request SEQUENCE, not key equality', () => {
  /**
   * Round-1's guard compared `latestRequestedKey === startKey`. Key equality
   * cannot distinguish "the key the app wants now" from "a response to an
   * OLDER request for that same key", so an A→B→A cycle let the abandoned A1
   * response (resolving LAST) commit on top of the fresher A2 data and repaint
   * every consumer with stale rows. The guard is now a monotonic sequence over
   * STARTED requests.
   */
  it('A→B→A: the abandoned A1 response resolving LAST cannot overwrite A2', async () => {
    const mod = await freshModule()

    const a1Event = { id: 'a1', title: 'All accounts (stale)', startDate: 'x', endDate: 'y' }
    const a2Event = { id: 'a2', title: 'All accounts (fresh)', startDate: 'x', endDate: 'y' }
    const bEvent = { id: 'b1', title: 'Filtered', startDate: 'x', endDate: 'y' }

    // A1 (the first all-accounts request) hangs until released. A2 — the
    // SECOND all-accounts request, same key — answers immediately, as does B.
    let releaseA1!: () => void
    const a1Pending = new Promise<void>((r) => {
      releaseA1 = r
    })
    let allAccountsCalls = 0
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.startsWith('/api/calendar/events')) {
        if (u.includes('accountIds=acct-a')) return okJson({ events: [bEvent] })
        allAccountsCalls++
        if (allAccountsCalls === 1) {
          await a1Pending
          return okJson({ events: [a1Event] })
        }
        return okJson({ events: [a2Event] })
      }
      if (u.startsWith('/api/account/actions')) return okJson({ actions: [] })
      return okJson({})
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    let api: ReturnType<HookModule['useCalendarEvents']> | null = null
    function Consumer() {
      api = mod.useCalendarEvents()
      return null
    }
    // A1: mount with the default (all-accounts) filter. Its fetch hangs.
    await act(async () => {
      root.render(h(Consumer))
    })
    mountedRoots.push(() => {
      act(() => root.unmount())
      container.remove()
    })
    expect(eventsFetches()).toBe(1)

    // B: switch to one account. Resolves immediately and commits.
    await act(async () => {
      api!.setFilterAccountIds(['acct-a'])
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(eventsFetches()).toBe(2)

    // A: switch BACK to all accounts. A2 is a fresh request for the SAME key
    // as the still-open A1, and it resolves first.
    await act(async () => {
      api!.setFilterAccountIds(null)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(eventsFetches()).toBe(3)

    let committed: unknown[] | null = null
    mod.patchCalendarEventsCache((events) => {
      committed = events
      return events
    })
    expect((committed as unknown as IEvent[])[0].id).toBe('a2')

    // NOW the abandoned A1 response lands — same key, older request.
    await act(async () => {
      releaseA1()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    let after: unknown[] | null = null
    mod.patchCalendarEventsCache((events) => {
      after = events
      return events
    })
    // Under the key-equality guard this was 'a1' — the stale payload.
    expect((after as unknown as IEvent[])[0].id).toBe('a2')
    expect(api!.events[0]?.id).toBe('a2')
  })

  it('a joiner of an in-flight request does NOT supersede it — the fetch still commits', async () => {
    const mod = await freshModule()

    const evt = { id: 'joined', title: 'Joined', startDate: 'x', endDate: 'y' }
    let release!: () => void
    const pending = new Promise<void>((r) => {
      release = r
    })
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.startsWith('/api/calendar/events')) {
        await pending
        return okJson({ events: [evt] })
      }
      if (u.startsWith('/api/account/actions')) return okJson({ actions: [] })
      return okJson({})
    })

    const a = await mountAgainst(mod)
    expect(eventsFetches()).toBe(1) // in flight

    // A poll tick lands on the open request for the same key and JOINS it —
    // it must not bump the sequence, or the request it is waiting on would be
    // treated as superseded and skip every shared write.
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(eventsFetches()).toBe(1) // joined, no second round-trip

    await act(async () => {
      release()
      await Promise.resolve()
      await Promise.resolve()
    })

    let committed: unknown[] | null = null
    mod.patchCalendarEventsCache((events) => {
      committed = events
      return events
    })
    expect(committed).not.toBeNull()
    expect((committed as unknown as IEvent[])[0].id).toBe('joined')
    expect(a).toBeTruthy()
  })

  it('B resolving first then A1 landing late leaves B’s data in place', async () => {
    const mod = await freshModule()

    const aEvent = { id: 'a-old', title: 'All accounts', startDate: 'x', endDate: 'y' }
    const bEvent = { id: 'b-new', title: 'Filtered', startDate: 'x', endDate: 'y' }

    let releaseA!: () => void
    const aPending = new Promise<void>((r) => {
      releaseA = r
    })
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.startsWith('/api/calendar/events')) {
        if (u.includes('accountIds=acct-a')) return okJson({ events: [bEvent] })
        await aPending
        return okJson({ events: [aEvent] })
      }
      if (u.startsWith('/api/account/actions')) return okJson({ actions: [] })
      return okJson({})
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    let api: ReturnType<HookModule['useCalendarEvents']> | null = null
    function Consumer() {
      api = mod.useCalendarEvents()
      return null
    }
    await act(async () => {
      root.render(h(Consumer))
    })
    mountedRoots.push(() => {
      act(() => root.unmount())
      container.remove()
    })

    await act(async () => {
      api!.setFilterAccountIds(['acct-a'])
    })
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      releaseA()
      await Promise.resolve()
      await Promise.resolve()
    })

    let after: unknown[] | null = null
    mod.patchCalendarEventsCache((events) => {
      after = events
      return events
    })
    expect((after as unknown as IEvent[])[0].id).toBe('b-new')
    expect(api!.events[0]?.id).toBe('b-new')
  })
})
