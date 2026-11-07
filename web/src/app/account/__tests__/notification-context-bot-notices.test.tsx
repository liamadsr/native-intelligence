// @vitest-environment jsdom
/**
 * The window holds a bot's notices apart from the rest (bots-v4 Phase 4c,
 * decision 8). A bot's notice (its row names a teammate,
 * `metadata.teammate_id`) lives with its bot:
 *
 *   • it's never in `notifications` (the plain notices: people, clocks, Dial8
 *     itself), whether it came with the first page or by realtime, and
 *     whatever happens to it after (read, deleted);
 *   • the window still holds it (`botNotices`: failed runs, an item
 *     opened again reads its late one, the bot's Notices part reads again);
 *   • its OS banner, toast and sound are exactly as before;
 *   • marking it read (a banner's click) PATCHes it and keeps it held;
 *   • a bot's FAILED run (`work_failed`) is a bot's notice like any other: the
 *     bell's exception for it went with the bell (2026-10-20,
 *     docs/plans/retire-notifications-page.md), and a failure reaches the
 *     person through the agent;
 *   • an orphaned bot's notice (out of the caller's reach: the route's
 *     `orphan_teammate_ids`) is a plain notice, live too;
 *   • a live notice naming a teammate the first page didn't is held as a
 *     bot's for a beat, and the first page is read again so the route sorts it.
 *
 * The REAL provider is mounted; supabase, fetch, the member id, toasts, the
 * desktop bridge and the sound layer are stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useEffect } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Handler = (p: { new?: unknown; old?: unknown }) => void

const hoisted = vi.hoisted(() => ({
  desktop: false,
  handlers: {} as Record<string, Handler>,
  toast: vi.fn(),
  announce: vi.fn(),
  showNative: vi.fn(async (_args: { id: string; title: string; body?: string; payload: string }): Promise<boolean> => true),
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const ch: Record<string, unknown> = {}
    ch.on = (_t: string, cfg: { event?: string }, cb: Handler) => {
      if (cfg?.event) hoisted.handlers[cfg.event] = cb
      return ch
    }
    ch.subscribe = () => ch
    return { channel: () => ch, removeChannel: () => {} }
  },
}))
vi.mock('@/app/account/workspace-switcher', () => ({
  useCurrentMemberId: () => 'member-1',
  useWorkspaces: () => ({ workspaces: [], currentId: 'ws-1' }),
  useWorkspaceId: () => 'ws-1',
}))
vi.mock('sonner', () => ({ toast: Object.assign(hoisted.toast, { error: vi.fn(), success: vi.fn() }) }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => hoisted.desktop }))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    notificationPermissionState: async () => 'granted',
    requestNotificationPermission: async () => 'granted',
    showNativeNotification: hoisted.showNative,
  },
}))
vi.mock('@/lib/reminders/client', () => ({ emitReminderChanged: vi.fn() }))
vi.mock('@/lib/sounds/triggers', () => ({ announceNotification: hoisted.announce }))

import { NotificationProvider, useNotifications, type Notification } from '../notification-context'
import { setNativeNotificationsDisabled } from '@/lib/native-notification-path'

const SENTENCE = 'I couldn’t finish Weekly brief: the calendar is not connected.'

function bot(id: string, over: Partial<Notification> = {}): Notification {
  return {
    id,
    workspace_id: 'ws-1',
    recipient_id: 'member-1',
    type: 'work_needs_you',
    title: 'Writer',
    body: SENTENCE,
    actor_id: null,
    actor_name: null,
    actor_avatar: null,
    target_type: 'work_item',
    target_id: `job-${id}`,
    context_type: null,
    context_id: null,
    is_read: false,
    read_at: null,
    is_archived: false,
    group_key: null,
    metadata: { teammate_id: 'tm-writer', teammate_name: 'Writer', sentence: SENTENCE, work_item_id: `job-${id}` },
    created_at: new Date().toISOString(),
    ...over,
  }
}

function plain(id: string, over: Partial<Notification> = {}): Notification {
  return bot(id, {
    type: 'action_assigned',
    title: `Assigned ${id}`,
    body: 'Ship it',
    target_type: 'action',
    target_id: `act-${id}`,
    metadata: {},
    ...over,
  })
}

let page: {
  notifications: Notification[]
  bot_notifications?: Notification[]
  orphan_teammate_ids?: string[]
  bot_teammate_ids?: string[]
}
const requests: Array<{ url: string; init?: RequestInit }> = []
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  requests.push({ url, init })
  if (url.startsWith('/api/account/notifications?')) return { ok: true, json: async () => page } as unknown as Response
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

async function mount() {
  await act(async () => {
    root.render(h(NotificationProvider, null, h(Probe)))
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function fire(event: 'INSERT' | 'UPDATE' | 'DELETE', payload: { new?: unknown; old?: unknown }) {
  await act(async () => {
    hoisted.handlers[event]!(payload)
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  hoisted.desktop = false
  hoisted.handlers = {}
  hoisted.showNative.mockImplementation(async () => true)
  setNativeNotificationsDisabled(false)
  requests.length = 0
  holder.api = null
  page = { notifications: [plain('p1')], bot_notifications: [bot('b1')], orphan_teammate_ids: [], bot_teammate_ids: ['tm-writer'] }
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const ids = (list: Notification[]) => list.map((n) => n.id)

describe('a bot’s notice is held apart from the plain notices', () => {
  it('the first page: the plain notices and the bot’s are held apart', async () => {
    await mount()
    expect(requests[0].url).toBe('/api/account/notifications?limit=50&include_bots=1')
    expect(ids(holder.api!.notifications)).toEqual(['p1'])
    expect(ids(holder.api!.botNotices)).toEqual(['b1'])
  })

  it('by realtime: a bot’s notice joins botNotices only; a plain one joins notifications', async () => {
    await mount()
    await fire('INSERT', { new: bot('b2') })
    expect(ids(holder.api!.notifications)).toEqual(['p1'])
    expect(ids(holder.api!.botNotices)).toEqual(['b2', 'b1'])

    await fire('INSERT', { new: plain('p2') })
    expect(ids(holder.api!.notifications)).toEqual(['p2', 'p1'])
    expect(ids(holder.api!.botNotices)).toEqual(['b2', 'b1'])
  })

  it('its toast and sound are as before (signed by the bot)', async () => {
    await mount()
    await fire('INSERT', { new: bot('b2') })
    expect(hoisted.toast).toHaveBeenCalledWith('Writer', { description: SENTENCE })
    expect(hoisted.announce).toHaveBeenCalledTimes(1)
  })

  it('its OS banner fires as before (unfocused, in the desktop app), as the bot', async () => {
    hoisted.desktop = true
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    await mount()
    await fire('INSERT', { new: bot('b2') })
    expect(hoisted.showNative).toHaveBeenCalledTimes(1)
    expect(hoisted.showNative.mock.calls[0][0]).toMatchObject({ title: 'Writer', body: SENTENCE, threadId: 'tm-writer' })
    expect(JSON.parse(hoisted.showNative.mock.calls[0][0].payload).bot).toMatchObject({ teammate_id: 'tm-writer', work_item_id: 'job-b2' })
  })

  it('read (its item opened anywhere), or deleted: the window keeps its state', async () => {
    await mount()
    await fire('UPDATE', { new: bot('b1', { is_read: true }), old: bot('b1') })
    expect(holder.api!.botNotices[0].is_read).toBe(true)
    await fire('INSERT', { new: bot('b3') })
    await fire('DELETE', { old: bot('b3') })
    expect(ids(holder.api!.botNotices)).toEqual(['b1'])
    expect(ids(holder.api!.notifications)).toEqual(['p1'])
  })

  it('a banner’s click marks the bot’s notice read and keeps it held', async () => {
    await mount()
    await act(async () => {
      await holder.api!.markAsRead('b1')
    })
    expect(holder.api!.botNotices[0].is_read).toBe(true)
    expect(requests.some((r) => r.url === '/api/account/notifications/b1' && r.init?.method === 'PATCH')).toBe(true)
  })
})

describe('a bot’s failed run is a bot’s notice only (the bell’s exception went)', () => {
  const FAILED = 'I couldn’t finish Weekly brief: the calendar is not connected.'
  const failed = (id: string, over: Partial<Notification> = {}) =>
    bot(id, { type: 'work_failed', metadata: { teammate_id: 'tm-writer', teammate_name: 'Writer', sentence: FAILED, work_item_id: `job-${id}` }, body: FAILED, ...over })

  it('the first page: held with its bot’s notices, not with the plain ones', async () => {
    page = { notifications: [plain('p1')], bot_notifications: [failed('f1'), bot('b1')], orphan_teammate_ids: [], bot_teammate_ids: ['tm-writer'] }
    await mount()
    expect(ids(holder.api!.notifications)).toEqual(['p1'])
    expect(ids(holder.api!.botNotices)).toEqual(['f1', 'b1'])
  })

  it('by realtime: a failed run joins botNotices only; its toast is as before', async () => {
    await mount()
    await fire('INSERT', { new: failed('f2') })
    expect(ids(holder.api!.notifications)).toEqual(['p1'])
    expect(ids(holder.api!.botNotices)).toEqual(['f2', 'b1'])
    expect(hoisted.toast).toHaveBeenCalledWith('Writer', { description: FAILED })
  })
})

describe('an orphaned bot’s notice is a plain notice (its bot out of reach)', () => {
  const orphan = (id: string, over: Partial<Notification> = {}) =>
    bot(id, { title: 'Gone bot', metadata: { teammate_id: 'tm-gone', sentence: 'From a bot you can’t reach.' }, ...over })

  it('held with the plain notices, from the first page and live', async () => {
    page = { notifications: [orphan('o1'), plain('p1')], bot_notifications: [bot('b1')], orphan_teammate_ids: ['tm-gone'], bot_teammate_ids: ['tm-writer'] }
    await mount()
    expect(ids(holder.api!.notifications)).toEqual(['o1', 'p1'])
    expect(ids(holder.api!.botNotices)).toEqual(['b1'])
    await fire('INSERT', { new: orphan('o2') })
    expect(ids(holder.api!.notifications)).toEqual(['o2', 'o1', 'p1'])
    expect(ids(holder.api!.botNotices)).toEqual(['b1'])
    // Read elsewhere: patched in place.
    await fire('UPDATE', { new: orphan('o2', { is_read: true }), old: orphan('o2') })
    expect(holder.api!.notifications[0].is_read).toBe(true)
  })

  it('a live notice naming a teammate the first page didn’t: held as a bot’s for a beat, then the first page read again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { UNKNOWN_TEAMMATE_REREAD_MS } = await import('../notification-context')
    await mount()
    const firstPages = () => requests.filter((r) => r.url.includes('include_bots=1')).length
    expect(firstPages()).toBe(1)
    await fire('INSERT', { new: bot('b-new', { metadata: { teammate_id: 'tm-new', sentence: 'My first.' } }) })
    expect(ids(holder.api!.notifications)).toEqual(['p1'])
    expect(ids(holder.api!.botNotices)).toContain('b-new')
    // A notice from a teammate it already knows reads nothing again.
    await fire('INSERT', { new: bot('b-known') })
    await act(async () => {
      vi.advanceTimersByTime(UNKNOWN_TEAMMATE_REREAD_MS)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(firstPages()).toBe(2)
    vi.useRealTimers()
  })
})
