// @vitest-environment jsdom
/**
 * Two-pool retention + recovery-dedup tests for NotificationProvider.
 *
 * Realtime INSERTs prepend to the held list without bound. The desktop shell
 * runs for hours (948 MB WebContent heap measured after 7 h), so an unbounded
 * list is a genuine leak. The fix is TWO POOLS:
 *
 *   • FETCHED rows (the first page, on mount and on a realtime catch-up) are
 *     NEVER trimmed by realtime activity.
 *   • LIVE rows (realtime INSERT) are tracked by id in insertion order. Past
 *     MAX_LIVE_NOTIFICATIONS = 200 the OLDEST live ids are evicted from both the
 *     pool and the list. A fetched row is never an eviction candidate.
 *
 * Membership bookkeeping keeps the pool honest at its edges: a first-page
 * replace clears it, and a realtime DELETE forgets the id it removes so that
 * slot frees up again. (The notifications page, its paging, unread count and
 * bulk verbs went: docs/plans/retire-notifications-page.md.)
 *
 * INVARIANT, asserted throughout: list.length ≤ (rows fetched) + 200.
 *
 * Plus: one socket repair must cost this provider ONE refetch, not two (its own
 * SUBSCRIBED-after-failure AND the app-wide `ni:realtime-recovered`).
 *
 * The REAL provider is mounted; only supabase, fetch, the member id and the
 * toast/desktop side effects are stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useEffect } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Channel handlers by event, plus the subscribe status callback — captured so a
// test can drive a real INSERT and a real drop/re-SUBSCRIBE through the hook.
const realtime: {
  INSERT?: (p: { new: unknown }) => void
  DELETE?: (p: { old: unknown }) => void
  status?: (s: string) => void
} = {}

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const ch: Record<string, unknown> = {}
    ch.on = (
      _t: string,
      cfg: { event?: string },
      cb: (p: { new?: unknown; old?: unknown }) => void,
    ) => {
      if (cfg?.event === 'INSERT') realtime.INSERT = cb as (p: { new: unknown }) => void
      if (cfg?.event === 'DELETE') realtime.DELETE = cb as (p: { old: unknown }) => void
      return ch
    }
    ch.subscribe = (cb?: (s: string) => void) => {
      if (cb) realtime.status = cb
      return ch
    }
    return { channel: () => ch, removeChannel: () => {} }
  },
}))
vi.mock('../workspace-switcher', () => ({ useCurrentMemberId: () => 'member-1', useWorkspaces: () => ({ workspaces: [] }) }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => false }))
vi.mock('@/lib/tauri-bridge', () => ({ tauriBridge: {} }))
vi.mock('@/lib/reminders/client', () => ({ emitReminderChanged: vi.fn() }))

import { NotificationProvider, useNotifications } from '../notification-context'
import {
  __resetSelfRefetchMarks,
  getLastRepairId,
} from '@/lib/supabase/realtime-recovery'

const PAGE_SIZE = 50
/** Mirrors MAX_LIVE_NOTIFICATIONS in notification-context.tsx — the ceiling on
 *  the LIVE pool only. Fetched rows sit outside it. */
const LIVE_CAP = 200

/** The contract's one invariant, in the only form a test can observe it. */
function expectWithinInvariant(list: { id: string }[], fetchedRows: number) {
  expect(list.length).toBeLessThanOrEqual(fetchedRows + LIVE_CAP)
}

function mkNotification(id: string, isRead = true) {
  return {
    id,
    workspace_id: 'ws-1',
    recipient_id: 'member-1',
    type: 'mention',
    title: `n-${id}`,
    body: null,
    actor_id: null,
    actor_name: null,
    actor_avatar: null,
    target_type: null,
    target_id: null,
    context_type: null,
    context_id: null,
    is_read: isRead,
    read_at: null,
    created_at: new Date().toISOString(),
  }
}

// Every notifications GET, in order, so a test can read what the provider asked
// for (the first page only: there is no paging any more).
let getCalls = 0
let getUrls: string[] = []
// The server hands back one full first page: row `srv-<n>` at index n, newest first.
const fetchMock = vi.fn(async (url: string) => {
  if (typeof url === 'string' && url.includes('/api/account/notifications?')) {
    getCalls++
    getUrls.push(url)
    return {
      ok: true,
      json: async () => ({
        notifications: Array.from({ length: PAGE_SIZE }, (_, i) => mkNotification(`srv-${i}`)),
      }),
    } as unknown as Response
  }
  return { ok: true, json: async () => ({}) } as unknown as Response
})

const holder: { api: ReturnType<typeof useNotifications> | null } = { api: null }
function Probe() {
  const api = useNotifications()
  useEffect(() => {
    holder.api = api
  }, [api])
  return null
}

let container: HTMLDivElement
let root: Root

async function mountAndLoad() {
  await act(async () => {
    root.render(h(NotificationProvider, null, h(Probe)))
  })
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  getCalls = 0
  getUrls = []
  realtime.INSERT = undefined
  realtime.DELETE = undefined
  realtime.status = undefined
  holder.api = null
  __resetSelfRefetchMarks()
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('NotificationProvider two-pool retention', () => {
  /** Drive n realtime INSERTs, oldest first (each one prepends). */
  async function insertLive(prefix: string, n: number, isRead = true, from = 0) {
    await act(async () => {
      for (let i = from; i < from + n; i++) {
        realtime.INSERT!({ new: mkNotification(`${prefix}-${i}`, isRead) })
      }
    })
  }
  const ids = (list: { id: string }[]) => new Set(list.map((n) => n.id))

  // ── 1. The first page, and live rows under the cap ──
  it('asks for the first page only, and holds 60 INSERTs above it with nothing evicted', async () => {
    await mountAndLoad() // srv-0..srv-49
    expect(getUrls).toEqual([`/api/account/notifications?limit=${PAGE_SIZE}&include_bots=1`])
    expect(holder.api!.notifications).toHaveLength(PAGE_SIZE)

    await insertLive('live', 60)
    const held = ids(holder.api!.notifications)
    for (let i = 0; i < PAGE_SIZE; i++) expect(held.has(`srv-${i}`)).toBe(true)
    for (let i = 0; i < 60; i++) expect(held.has(`live-${i}`)).toBe(true)
    expect(holder.api!.notifications).toHaveLength(PAGE_SIZE + 60)
    expect(holder.api!.notifications[0].id).toBe('live-59')
    expectWithinInvariant(holder.api!.notifications, PAGE_SIZE)
  })

  // ── 2. Only live rows are eviction candidates ──
  it('evicts the 60 oldest live rows at 260 INSERTs and keeps all 50 fetched rows', async () => {
    await mountAndLoad()
    await insertLive('live', 260)

    const list = holder.api!.notifications
    const held = ids(list)
    // 50 fetched + exactly LIVE_CAP live.
    expect(list).toHaveLength(PAGE_SIZE + LIVE_CAP)
    expect(list.filter((n) => n.id.startsWith('live-'))).toHaveLength(LIVE_CAP)

    // The 60 oldest live ids are gone…
    for (let i = 0; i < 60; i++) expect(held.has(`live-${i}`)).toBe(false)
    // …and the 200 newest are all present, newest at the head.
    for (let i = 60; i < 260; i++) expect(held.has(`live-${i}`)).toBe(true)
    expect(list[0].id).toBe('live-259')

    // Not one fetched row was touched: they are outside the pool entirely.
    for (let i = 0; i < PAGE_SIZE; i++) expect(held.has(`srv-${i}`)).toBe(true)

    expect(list).toHaveLength(250)
    expectWithinInvariant(list, PAGE_SIZE)
  })


  // ── 3. A first-page replace restarts the live pool empty ──
  it('a catch-up refetch resets the live pool to empty', async () => {
    await mountAndLoad()
    await insertLive('a', 30)
    expect(holder.api!.notifications).toHaveLength(PAGE_SIZE + 30)

    // The app-wide recovery event with no self-catch-up: one first-page refetch.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('ni:realtime-recovered', { detail: { repairId: getLastRepairId() } }),
      )
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })
    // The page IS the new baseline: exactly the server page, nothing else.
    const afterRefetch = holder.api!.notifications
    expect(afterRefetch).toHaveLength(PAGE_SIZE)
    expect(afterRefetch.map((n) => n.id)).toEqual(
      Array.from({ length: PAGE_SIZE }, (_, i) => `srv-${i}`),
    )
    expect(afterRefetch.some((n) => n.id.startsWith('a-'))).toBe(false)

    // The pool restarted empty, so it takes a fresh 201 arrivals — not 171 —
    // before the first eviction, and the row evicted is the first NEW one.
    await insertLive('b', LIVE_CAP)
    expect(ids(holder.api!.notifications).has('b-0')).toBe(true)
    expect(holder.api!.notifications).toHaveLength(PAGE_SIZE + LIVE_CAP)

    await insertLive('b', 1, true, LIVE_CAP) // the 201st
    const held = ids(holder.api!.notifications)
    expect(held.has('b-0')).toBe(false)
    expect(held.has('b-1')).toBe(true)
    expect(held.has(`b-${LIVE_CAP}`)).toBe(true)
    expect(holder.api!.notifications).toHaveLength(PAGE_SIZE + LIVE_CAP)
    expectWithinInvariant(holder.api!.notifications, PAGE_SIZE)
  })

  // ── 5. DELETE frees the slot it vacated ──
  it('a realtime DELETE of a live row frees its eviction slot', async () => {
    await mountAndLoad()
    await insertLive('d', LIVE_CAP) // pool exactly full: d-0..d-199
    expect(holder.api!.notifications).toHaveLength(PAGE_SIZE + LIVE_CAP)

    await act(async () => {
      realtime.DELETE!({ old: { id: 'd-150', is_read: true } })
    })
    let held = ids(holder.api!.notifications)
    expect(held.has('d-150')).toBe(false)
    expect(holder.api!.notifications).toHaveLength(PAGE_SIZE + LIVE_CAP - 1)

    // One more arrival now fits in the vacated slot, so the OLDEST live row
    // survives. If DELETE had not forgotten d-150, its ghost id would still
    // occupy a slot and d-0 would be evicted here.
    await insertLive('d', 1, true, LIVE_CAP)
    held = ids(holder.api!.notifications)
    expect(held.has('d-0')).toBe(true)
    expect(held.has('d-150')).toBe(false)
    expect(held.has(`d-${LIVE_CAP}`)).toBe(true)
    expect(holder.api!.notifications).toHaveLength(PAGE_SIZE + LIVE_CAP)
    expectWithinInvariant(holder.api!.notifications, PAGE_SIZE)
  })


  it('dedupes an INSERT for a row already held', async () => {
    await mountAndLoad()
    const before = holder.api!.notifications.length
    await act(async () => {
      realtime.INSERT!({ new: mkNotification('srv-0') })
    })
    expect(holder.api!.notifications).toHaveLength(before)
  })

})

describe('NotificationProvider recovery refetch dedup', () => {
  async function dropAndResubscribe() {
    await act(async () => {
      realtime.status!('CHANNEL_ERROR')
      realtime.status!('SUBSCRIBED')
      await Promise.resolve()
    })
  }
  async function fireRecovered() {
    await act(async () => {
      // Mirror the real dispatch (use-realtime-entities.ts): the event carries the
      // watchdog's CURRENT repair id, which is what a self-refetch mark stamps.
      window.dispatchEvent(
        new CustomEvent('ni:realtime-recovered', { detail: { repairId: getLastRepairId() } }),
      )
      await Promise.resolve()
    })
  }

  it('refetches once on its own re-SUBSCRIBE, and suppresses the app-wide echo', async () => {
    await mountAndLoad()
    const afterMount = getCalls
    await dropAndResubscribe()
    expect(getCalls).toBe(afterMount + 1)
    await fireRecovered()
    // Same gap, already caught up.
    expect(getCalls).toBe(afterMount + 1)
  })

  it('still refetches on a recovered event with no recent self-catch-up', async () => {
    await mountAndLoad()
    const afterMount = getCalls
    await fireRecovered()
    expect(getCalls).toBe(afterMount + 1)
  })
})
