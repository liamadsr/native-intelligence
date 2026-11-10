// @vitest-environment jsdom
/**
 * The "all workspaces" scope in NotificationProvider — the workspace menu's
 * "Show all workspaces" switch (lib/workspace-span), which the banners and
 * the bots' notices follow.
 *
 * Three things have to hold, and the first is the one that would hurt:
 *
 *  1. THE DEFAULT SCOPE IS TODAY'S PROVIDER, EXACTLY. No scope parameter on the
 *     GET, ONE realtime channel named for the active member. The
 *     retention/recovery suite next door already pins the
 *     two-pool and dedup behaviour against that single channel; this file pins
 *     the request shape so the scope plumbing can't quietly rewrite it.
 *
 *  2. `all` SUBSCRIBES PER MEMBERSHIP. The realtime filter is
 *     `recipient_id=eq.<id>` — a single value — so cross-workspace delivery is N
 *     channels, one per member row the SERVER resolved (the client only ever
 *     knows the active workspace's member id). All N feed one list: the pools
 *     and the id dedup are keyed on the notification id, which is unique across
 *     workspaces.
 *
 *  3. THE PROVIDER FOLLOWS THE SWITCH — it holds no scope of its own — and a
 *     flip refetches: the two scopes are different result sets, so the loaded
 *     pool cannot carry over. A returning viewer starts in the stored answer,
 *     and one who had left the old inbox's toggle on "All workspaces" keeps it.
 *
 * The notifications page, its unread count and its bulk verbs went
 * (docs/plans/retire-notifications-page.md), so nothing here counts or POSTs.
 *
 * The REAL provider is mounted; only supabase, fetch, the member id and the
 * toast/desktop side effects are stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useEffect } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** One subscribed channel, as the supabase stub records it. */
interface FakeChannel {
  name: string
  /** The `recipient_id=eq.<id>` filter each postgres_changes binding carries. */
  filters: string[]
  handlers: Record<string, (p: { new?: unknown; old?: unknown }) => void>
  status?: (s: string) => void
  removed: boolean
}

let channels: FakeChannel[] = []

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    channel: (name: string) => {
      const entry: FakeChannel = { name, filters: [], handlers: {}, removed: false }
      channels.push(entry)
      const ch: Record<string, unknown> = {}
      ch.on = (
        _t: string,
        cfg: { event?: string; filter?: string },
        cb: (p: { new?: unknown; old?: unknown }) => void,
      ) => {
        if (cfg?.event) entry.handlers[cfg.event] = cb
        if (cfg?.filter) entry.filters.push(cfg.filter)
        return ch
      }
      ch.subscribe = (cb?: (s: string) => void) => {
        if (cb) entry.status = cb
        return ch
      }
      ;(entry as unknown as { _ch: unknown })._ch = ch
      return ch
    },
    removeChannel: (ch: unknown) => {
      const found = channels.find((c) => (c as unknown as { _ch: unknown })._ch === ch)
      if (found) found.removed = true
    },
  }),
}))
vi.mock('../workspace-switcher', () => ({ useCurrentMemberId: () => 'member-a', useWorkspaces: () => ({ workspaces: [] }) }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => false }))
vi.mock('@/lib/tauri-bridge', () => ({ tauriBridge: {} }))
vi.mock('@/lib/reminders/client', () => ({ emitReminderChanged: vi.fn() }))

import { NotificationProvider, useNotifications } from '../notification-context'
import { __resetSelfRefetchMarks, getLastRepairId } from '@/lib/supabase/realtime-recovery'
import {
  WORKSPACE_SPAN_STORAGE_KEY,
  resetWorkspaceSpanForTests,
  setShowAllWorkspaces,
} from '@/lib/workspace-span'

/** The old inbox's own toggle, before the app-wide switch replaced it. */
const LEGACY_SCOPE_STORAGE_KEY = 'ni:notifications-scope'
/** The switch's per-device cache, as lib/workspace-span writes it. */
const cachedSpan = () => JSON.parse(window.localStorage.getItem(WORKSPACE_SPAN_STORAGE_KEY) ?? 'null')?.all
const MEMBERSHIPS = [
  { memberId: 'member-a', workspaceId: 'ws-a' },
  { memberId: 'member-b', workspaceId: 'ws-b' },
  { memberId: 'member-c', workspaceId: 'ws-c' },
]

function mkNotification(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: 'ws-a',
    recipient_id: 'member-a',
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
    is_read: true,
    read_at: null,
    is_archived: false,
    group_key: null,
    metadata: {},
    created_at: new Date().toISOString(),
    ...over,
  }
}

/** Every request the provider made, in order. */
let requests: { url: string; init?: RequestInit }[] = []

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  requests.push({ url, init })
  if (url.includes('/api/account/notifications?')) {
    const params = new URL(url, 'http://x').searchParams
    const isAll = params.get('workspace_scope') === 'all'
    return {
      ok: true,
      json: async () => ({
        notifications: [
          mkNotification('srv-1'),
          ...(isAll
            ? [
                mkNotification('srv-2', {
                  workspace_id: 'ws-b',
                  recipient_id: 'member-b',
                  workspace: { id: 'ws-b', name: 'Other', slug: 'other', logo_url: null },
                }),
              ]
            : []),
        ],
        ...(isAll ? { memberships: MEMBERSHIPS } : {}),
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
  // The `all` scope re-derives its channel list once the membership set lands,
  // so settle the follow-up render before asserting on channels.
  await act(async () => {
    await Promise.resolve()
  })
}

/** Notification GETs only (flipping the switch also saves it to the account). */
const listRequests = () => requests.filter((r) => r.url.includes('/api/account/notifications?'))
/** Channels still subscribed (not torn down by a re-derive). */
const liveChannels = () => channels.filter((c) => !c.removed)

beforeEach(() => {
  requests = []
  channels = []
  holder.api = null
  __resetSelfRefetchMarks()
  try {
    window.localStorage.clear()
  } catch {
    /* storage unavailable in this environment */
  }
  resetWorkspaceSpanForTests()
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

// ── 1. The default scope is untouched ───────────────────────────────────────

describe('default scope — the provider that existed before this feature', () => {
  it('omits the scope parameter entirely, rather than sending workspace_scope=workspace', async () => {
    await mountAndLoad()
    expect(holder.api!.workspaceScope).toBe('workspace')
    expect(listRequests()).toHaveLength(1)
    // The first page also asks for the bots' newest notices (bots-v4 Phase 4c).
    expect(listRequests()[0].url).toBe('/api/account/notifications?limit=50&include_bots=1')
  })

  it('subscribes exactly ONE channel, named and filtered on the active member', async () => {
    await mountAndLoad()
    expect(liveChannels().map((c) => c.name)).toEqual(['notifications:member-a'])
    // INSERT, UPDATE and DELETE all filter on the same recipient.
    expect(liveChannels()[0].filters).toEqual([
      'recipient_id=eq.member-a',
      'recipient_id=eq.member-a',
      'recipient_id=eq.member-a',
    ])
  })

  it('leaves rows with no embedded workspace alone', async () => {
    await mountAndLoad()
    expect(holder.api!.notifications[0].workspace).toBeUndefined()
  })
})

// ── 2. `all` — one channel per membership ───────────────────────────────────

describe("workspaceScope 'all'", () => {
  async function switchToAll() {
    await act(async () => {
      setShowAllWorkspaces(true)
    })
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })
  }

  it('refetches with the scope parameter', async () => {
    await mountAndLoad()
    await switchToAll()
    expect(listRequests().map((r) => r.url)).toEqual([
      '/api/account/notifications?limit=50&include_bots=1',
      '/api/account/notifications?limit=50&workspace_scope=all&include_bots=1',
    ])
  })

  it('subscribes one channel per membership the SERVER resolved', async () => {
    await mountAndLoad()
    await switchToAll()
    expect(liveChannels().map((c) => c.name).sort()).toEqual([
      'notifications:member-a',
      'notifications:member-b',
      'notifications:member-c',
    ])
    // Each channel filters on its OWN recipient — the filter takes one value, so
    // this is the only way to reach the other workspaces' rows.
    for (const channel of liveChannels()) {
      const id = channel.name.split(':')[1]
      expect(new Set(channel.filters)).toEqual(new Set([`recipient_id=eq.${id}`]))
    }
  })

  it('takes the cross-workspace first page from the server, and an arrival from any channel', async () => {
    await mountAndLoad()
    expect(holder.api!.notifications.map((n) => n.id)).toEqual(['srv-1'])
    await switchToAll()
    // The server reads over the whole member-id set.
    expect(holder.api!.notifications.map((n) => n.id)).toEqual(['srv-1', 'srv-2'])

    // An arrival on a FOREIGN workspace's channel lands in the same list.
    const foreign = liveChannels().find((c) => c.name === 'notifications:member-c')!
    await act(async () => {
      foreign.handlers.INSERT!({
        new: mkNotification('live-c', {
          workspace_id: 'ws-c',
          recipient_id: 'member-c',
          is_read: false,
        }),
      })
    })
    expect(holder.api!.notifications[0].id).toBe('live-c')
  })

  it('feeds ONE list from every channel, ordered newest-first across workspaces', async () => {
    await mountAndLoad()
    await switchToAll()
    const [a, b, c] = liveChannels()
    await act(async () => {
      a.handlers.INSERT!({ new: mkNotification('from-a', { is_read: false }) })
    })
    await act(async () => {
      b.handlers.INSERT!({
        new: mkNotification('from-b', { workspace_id: 'ws-b', recipient_id: 'member-b', is_read: false }),
      })
    })
    await act(async () => {
      c.handlers.INSERT!({
        new: mkNotification('from-c', { workspace_id: 'ws-c', recipient_id: 'member-c', is_read: false }),
      })
    })
    // Every arrival prepends into the same pool, newest at the head.
    expect(holder.api!.notifications.slice(0, 3).map((n) => n.id)).toEqual([
      'from-c',
      'from-b',
      'from-a',
    ])
  })

  it('never subscribes two channels to the same recipient', async () => {
    await mountAndLoad()
    await switchToAll()
    // A notification row has exactly ONE recipient_id, so distinct filters mean
    // a row is delivered on exactly one channel. Duplicate filters would deliver
    // the same INSERT twice in one tick, which toasts twice (the list dedups on
    // `prev`, but the toast guard reads the render-time mirror). See
    // channelMemberIds.
    const filters = liveChannels().flatMap((c) => c.filters)
    expect(new Set(filters).size).toBe(liveChannels().length)
    expect(new Set(liveChannels().map((c) => c.name)).size).toBe(liveChannels().length)
  })

  it('still dedups an INSERT for a row already held', async () => {
    await mountAndLoad()
    await switchToAll()
    const before = holder.api!.notifications.length
    const channel = liveChannels().find((c) => c.name === 'notifications:member-b')!
    await act(async () => {
      channel.handlers.INSERT!({
        new: mkNotification('srv-2', { workspace_id: 'ws-b', recipient_id: 'member-b', is_read: false }),
      })
    })
    expect(holder.api!.notifications).toHaveLength(before)
  })

  it('keeps the embedded workspace on a row that a realtime UPDATE patches', async () => {
    await mountAndLoad()
    await switchToAll()
    const foreignRow = holder.api!.notifications.find((n) => n.id === 'srv-2')!
    expect(foreignRow.workspace).toEqual({ id: 'ws-b', name: 'Other', slug: 'other', logo_url: null })

    // A realtime payload is the raw table row — no joins — so a naive replace
    // would blank the badge the moment the user marks the row read.
    const channel = liveChannels().find((c) => c.name === 'notifications:member-b')!
    await act(async () => {
      channel.handlers.UPDATE!({
        new: mkNotification('srv-2', { workspace_id: 'ws-b', recipient_id: 'member-b', is_read: true }),
        old: { is_read: false },
      })
    })
    expect(holder.api!.notifications.find((n) => n.id === 'srv-2')!.workspace).toEqual({
      id: 'ws-b',
      name: 'Other',
      slug: 'other',
      logo_url: null,
    })
  })

  it('does not re-subscribe on an ordinary catch-up fetch', async () => {
    await mountAndLoad()
    await switchToAll()
    const before = liveChannels().map((c) => c.name)
    const beforeGets = listRequests().length
    // The app-wide recovery event with no self-catch-up: one first-page refetch.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('ni:realtime-recovered', { detail: { repairId: getLastRepairId() } }),
      )
      await Promise.resolve()
    })
    expect(listRequests().length).toBe(beforeGets + 1)
    await act(async () => {
      await Promise.resolve()
    })
    // The membership set came back identical, so the channel list is unchanged —
    // a fresh array here would tear down and rebuild every channel per fetch.
    expect(liveChannels().map((c) => c.name)).toEqual(before)
  })

  it('spends ONE refetch on a socket repair that knocks every channel', async () => {
    await mountAndLoad()
    await switchToAll()
    const beforeGets = listRequests().length

    await act(async () => {
      for (const channel of liveChannels()) {
        channel.status!('CHANNEL_ERROR')
        channel.status!('SUBSCRIBED')
      }
      await Promise.resolve()
    })
    // One gap, one catch-up — the refetch spans every membership anyway.
    expect(listRequests().length).toBe(beforeGets + 1)

    // …and the app-wide echo for the SAME repair is still suppressed, no matter
    // which channel's mark answers for it.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('ni:realtime-recovered', { detail: { repairId: getLastRepairId() } }),
      )
      await Promise.resolve()
    })
    expect(listRequests().length).toBe(beforeGets + 1)
  })
})

// ── 3. The switch ───────────────────────────────────────────────────────────

describe('the workspace menu switch', () => {
  it('is what the provider reads: flipping it on and off moves the scope and refetches', async () => {
    await mountAndLoad()
    expect(holder.api!.workspaceScope).toBe('workspace')

    await act(async () => {
      setShowAllWorkspaces(true)
    })
    expect(holder.api!.workspaceScope).toBe('all')
    expect(cachedSpan()).toBe(true)

    await act(async () => {
      setShowAllWorkspaces(false)
    })
    expect(holder.api!.workspaceScope).toBe('workspace')
    expect(cachedSpan()).toBe(false)
    expect(listRequests().map((r) => r.url.includes('workspace_scope=all'))).toEqual([false, true, false])
  })

  it('starts in the cached answer, so a returning viewer gets ONE fetch in the right scope', async () => {
    window.localStorage.setItem(WORKSPACE_SPAN_STORAGE_KEY, JSON.stringify({ all: true, user: null }))
    await mountAndLoad()
    expect(holder.api!.workspaceScope).toBe('all')
    expect(listRequests()).toHaveLength(1)
    expect(listRequests()[0].url).toContain('workspace_scope=all')
  })

  it('carries over the old inbox\'s "All workspaces" toggle for a viewer who never touched the switch', async () => {
    window.localStorage.setItem(LEGACY_SCOPE_STORAGE_KEY, 'all')
    await mountAndLoad()
    expect(holder.api!.workspaceScope).toBe('all')
    expect(listRequests()).toHaveLength(1)
    expect(listRequests()[0].url).toContain('workspace_scope=all')
  })

  it('lets the switch win over the old toggle once it has been set', async () => {
    window.localStorage.setItem(LEGACY_SCOPE_STORAGE_KEY, 'all')
    window.localStorage.setItem(WORKSPACE_SPAN_STORAGE_KEY, JSON.stringify({ all: false, user: null }))
    await mountAndLoad()
    expect(holder.api!.workspaceScope).toBe('workspace')
  })

  it('treats a junk stored value as the default', async () => {
    window.localStorage.setItem(WORKSPACE_SPAN_STORAGE_KEY, 'everything')
    await mountAndLoad()
    expect(holder.api!.workspaceScope).toBe('workspace')
    expect(listRequests()[0].url).not.toContain('workspace_scope')
  })

  it('renders and fetches normally when storage throws (private window, blocked site data)', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError')
      },
    })
    try {
      await mountAndLoad()
      expect(holder.api!.workspaceScope).toBe('workspace')
      expect(listRequests()).toHaveLength(1)
      // And flipping it still works — the choice just doesn't survive the session.
      await act(async () => {
        setShowAllWorkspaces(true)
      })
      expect(holder.api!.workspaceScope).toBe('all')
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original)
    }
  })
})
