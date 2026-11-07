// @vitest-environment jsdom
/**
 * The calendar's warm-start copy in localStorage stays inside a budget.
 *
 * localStorage is ONE 5 MB bucket per origin, shared with every tab's chat
 * thread. The copy used to be kept per workspace — up to 4M characters each —
 * and never removed; in the desktop app four workspaces' calendars filled the
 * bucket (98.6% of it, measured), and from then on every chat thread write
 * was refused, silently: tabs came back named, windows open, chats EMPTY.
 *
 * Pinned: all the copies together stay under the budget — the workspace being
 * written first, a copy too old to warm-start anything removed, then the least
 * recently written — a calendar too big for the budget keeps no copy at all,
 * and a copy read after it expired is removed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/views/unified-view-layout', () => ({}))
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws-1' }))
vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => null }))
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))
vi.mock('@/lib/integrations/calendar-local', () => ({
  mergeWithLocalExchangeEvents: async (events: unknown[]) => events,
}))
vi.mock('@/calendar/adapters', () => ({
  calendarEventToIEvent: (e: unknown) => e,
  actionToIEvent: (a: unknown) => a,
}))

const KEY = (ws: string) => `dial8:calendar-events:v1:${ws}`
const HOUR = 60 * 60 * 1000
const BUDGET_BYTES = 2_000_000

/** A stored copy as persistCache writes it, padded to about `chars` long. */
function storedCopy(at: number, chars: number): string {
  const head = JSON.stringify({ at, events: [{ id: 'e', title: '' }] })
  return JSON.stringify({ at, events: [{ id: 'e', title: 'x'.repeat(Math.max(0, chars - head.length)) }] })
}

/** What every calendar copy costs, the way the budget counts it. */
function calendarBytes(): number {
  let total = 0
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!
    if (key.startsWith('dial8:calendar-events:v1:')) total += (key.length + localStorage.getItem(key)!.length) * 2
  }
  return total
}

let providerEvents: unknown[] = []
let eventsResponse: Promise<unknown> | null = null
const fetchMock = vi.fn()

let root: Root | null = null
let container: HTMLDivElement | null = null

async function mountConsumer() {
  vi.resetModules()
  const { useCalendarEvents } = await import('../use-calendar-events')
  container = document.createElement('div')
  document.body.appendChild(container)
  const r = createRoot(container)
  root = r
  function Consumer() {
    useCalendarEvents()
    return null
  }
  await act(async () => {
    r.render(h(Consumer))
  })
  // The fetch, its mapping and the persist behind it.
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

beforeEach(() => {
  localStorage.clear()
  providerEvents = [{ id: 'ev-1', title: 'Standup', startDate: '2026-09-25T09:00:00Z', endDate: '2026-09-25T09:15:00Z' }]
  eventsResponse = null
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url: unknown) => {
    const u = String(url)
    if (u.startsWith('/api/calendar/events')) {
      if (eventsResponse) return eventsResponse
      return { ok: true, status: 200, json: async () => ({ events: providerEvents }) }
    }
    if (u.startsWith('/api/account/actions')) return { ok: true, status: 200, json: async () => ({ actions: [] }) }
    return { ok: true, status: 200, json: async () => ({}) }
  })
  globalThis.fetch = fetchMock as never
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

describe('the calendar warm-start copy stays inside its budget', () => {
  it('writes this workspace\'s copy, drops copies too old to use, then the least recently written', async () => {
    const now = Date.now()
    localStorage.setItem(KEY('ws-expired'), storedCopy(now - 30 * HOUR, 10_000))
    localStorage.setItem(KEY('ws-older'), storedCopy(now - 2 * HOUR, 600_000))
    localStorage.setItem(KEY('ws-recent'), storedCopy(now - 1 * HOUR, 600_000))
    // Not a calendar copy: never touched.
    localStorage.setItem('dial8-tabs-chat:ws-1:tab-a', JSON.stringify({ chatSessionId: 's', chatMessages: [], chatInput: '' }))

    await mountConsumer()

    expect(JSON.parse(localStorage.getItem(KEY('ws-1'))!).events).toEqual(providerEvents)
    expect(localStorage.getItem(KEY('ws-expired'))).toBeNull()
    expect(localStorage.getItem(KEY('ws-older'))).toBeNull()
    expect(localStorage.getItem(KEY('ws-recent'))).not.toBeNull()
    expect(localStorage.getItem('dial8-tabs-chat:ws-1:tab-a')).not.toBeNull()
    expect(calendarBytes()).toBeLessThanOrEqual(BUDGET_BYTES)
  })

  it('keeps every usable copy that fits, and never one too old to use', async () => {
    const now = Date.now()
    localStorage.setItem(KEY('ws-2'), storedCopy(now - 3 * HOUR, 50_000))
    localStorage.setItem(KEY('ws-3'), storedCopy(now - 5 * HOUR, 50_000))
    localStorage.setItem(KEY('ws-expired'), storedCopy(now - 30 * HOUR, 5_000))

    await mountConsumer()

    expect(localStorage.getItem(KEY('ws-1'))).not.toBeNull()
    expect(localStorage.getItem(KEY('ws-2'))).not.toBeNull()
    expect(localStorage.getItem(KEY('ws-3'))).not.toBeNull()
    // Everything fits — and this one still goes: no warm start reads it again.
    expect(localStorage.getItem(KEY('ws-expired'))).toBeNull()
  })

  it('a calendar too big for the budget keeps no copy — not even its older one', async () => {
    localStorage.setItem(KEY('ws-1'), storedCopy(Date.now() - 1 * HOUR, 5_000))
    localStorage.setItem(KEY('ws-2'), storedCopy(Date.now() - 1 * HOUR, 5_000))
    providerEvents = [{ id: 'ev-big', title: 'Offsite', description: 'x'.repeat(BUDGET_BYTES / 2) }]

    await mountConsumer()

    expect(localStorage.getItem(KEY('ws-1'))).toBeNull()
    // Nothing else was evicted to make room for a copy that was never written.
    expect(localStorage.getItem(KEY('ws-2'))).not.toBeNull()
  })

  it('a copy read after it expired is removed, not kept for nothing', async () => {
    localStorage.setItem(KEY('ws-1'), storedCopy(Date.now() - 25 * HOUR, 5_000))
    eventsResponse = new Promise(() => {}) // the revalidation never lands

    await mountConsumer()

    expect(localStorage.getItem(KEY('ws-1'))).toBeNull()
  })
})

/**
 * Only a mounted calendar writes a copy, so only a mounted calendar pruned
 * them — a long wait for a bucket they had already filled, with every chat
 * thread write refused meanwhile. The dashboard's boot sweep prunes them
 * (tab-lazy-mount.test.tsx pins that it runs).
 */
describe('prunePersistedEvents — the boot-time prune, no calendar mounted', () => {
  it('removes copies too old to use and brings the rest inside the budget, newest kept', async () => {
    const { prunePersistedEvents } = await import('../../persisted-events')
    const now = Date.now()
    localStorage.setItem(KEY('ws-expired'), storedCopy(now - 30 * HOUR, 5_000))
    localStorage.setItem(KEY('ws-oldest'), storedCopy(now - 3 * HOUR, 450_000))
    localStorage.setItem(KEY('ws-middle'), storedCopy(now - 2 * HOUR, 450_000))
    localStorage.setItem(KEY('ws-newest'), storedCopy(now - 1 * HOUR, 450_000))
    localStorage.setItem('dial8-tabs-chat:ws-1:tab-a', JSON.stringify({ chatSessionId: 's', chatMessages: [], chatInput: '' }))

    prunePersistedEvents()

    expect(localStorage.getItem(KEY('ws-expired'))).toBeNull()
    expect(localStorage.getItem(KEY('ws-oldest'))).toBeNull()
    expect(localStorage.getItem(KEY('ws-middle'))).not.toBeNull()
    expect(localStorage.getItem(KEY('ws-newest'))).not.toBeNull()
    expect(localStorage.getItem('dial8-tabs-chat:ws-1:tab-a')).not.toBeNull()
    expect(calendarBytes()).toBeLessThanOrEqual(BUDGET_BYTES)
  })

  it('leaves copies that are usable and fit exactly as they are', async () => {
    const { prunePersistedEvents } = await import('../../persisted-events')
    const copy = storedCopy(Date.now() - HOUR, 20_000)
    localStorage.setItem(KEY('ws-2'), copy)
    prunePersistedEvents()
    expect(localStorage.getItem(KEY('ws-2'))).toBe(copy)
  })
})
