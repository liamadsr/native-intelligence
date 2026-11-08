// @vitest-environment jsdom
/**
 * UI sounds from NotificationProvider: a notification arriving LIVE plays its
 * sound on the in-app toast path only. The native OS banner (desktop, window
 * not focused) makes its own sound, so that path plays none; rows loaded by a
 * fetch (page load, catch-up) never play.
 *
 * The REAL provider is mounted; supabase, fetch, the member id, toasts, the
 * desktop bridge and the sound layer are stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  desktop: false,
  insert: undefined as undefined | ((p: { new: unknown }) => void),
  status: undefined as undefined | ((s: string) => void),
  announce: vi.fn(),
  toast: vi.fn(),
  showNative: vi.fn(async (): Promise<boolean> => true),
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const ch: Record<string, unknown> = {}
    ch.on = (_t: string, cfg: { event?: string }, cb: (p: { new: unknown }) => void) => {
      if (cfg?.event === 'INSERT') hoisted.insert = cb
      return ch
    }
    ch.subscribe = (cb?: (s: string) => void) => {
      if (cb) hoisted.status = cb
      return ch
    }
    return { channel: () => ch, removeChannel: () => {} }
  },
}))
vi.mock('../workspace-switcher', () => ({ useCurrentMemberId: () => 'member-1', useWorkspaces: () => ({ workspaces: [] }) }))
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

import { NotificationProvider } from '../notification-context'
import { setNativeNotificationsDisabled } from '@/lib/native-notification-path'

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: 'ws-1',
    recipient_id: 'member-1',
    type: 'comment_added',
    title: `n-${id}`,
    body: null,
    actor_id: null,
    target_type: null,
    target_id: null,
    context_type: null,
    context_id: null,
    is_read: false,
    read_at: null,
    is_archived: false,
    group_key: null,
    metadata: {},
    created_at: new Date().toISOString(),
    ...over,
  }
}

const fetchMock = vi.fn(async (url: string) => {
  if (url.includes('/api/account/notifications?')) {
    return {
      ok: true,
      json: async () => ({ notifications: [row('loaded-1'), row('loaded-2')] }),
    } as unknown as Response
  }
  return { ok: true, json: async () => ({}) } as unknown as Response
})

let container: HTMLDivElement
let root: Root

async function mount() {
  await act(async () => {
    root.render(h(NotificationProvider, null, null))
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function insert(r: unknown) {
  await act(async () => {
    hoisted.insert!({ new: r })
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  hoisted.desktop = false
  hoisted.insert = undefined
  hoisted.showNative.mockImplementation(async () => true)
  setNativeNotificationsDisabled(false)
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
  vi.restoreAllMocks()
})

describe('NotificationProvider UI sounds', () => {
  it('rows from the page load never play; a live INSERT plays with its toast', async () => {
    await mount()
    expect(hoisted.announce).not.toHaveBeenCalled()
    await insert(row('live-1'))
    expect(hoisted.toast).toHaveBeenCalledTimes(1)
    expect(hoisted.announce).toHaveBeenCalledTimes(1)
    expect(hoisted.announce.mock.calls[0][0]).toMatchObject({ id: 'live-1' })
  })

  it('a live INSERT for a row already held (fetch race) plays nothing', async () => {
    await mount()
    await insert(row('loaded-1'))
    expect(hoisted.announce).not.toHaveBeenCalled()
  })

  it('a catch-up refetch after a reconnect plays nothing', async () => {
    await mount()
    await act(async () => {
      hoisted.status!('CHANNEL_ERROR')
      hoisted.status!('SUBSCRIBED')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/account/notifications?')).length).toBeGreaterThan(1)
    expect(hoisted.announce).not.toHaveBeenCalled()
  })

  it('desktop, window not focused: the native banner shows and makes the sound — none from us', async () => {
    hoisted.desktop = true
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    await mount()
    await insert(row('live-2'))
    expect(hoisted.showNative).toHaveBeenCalledTimes(1)
    expect(hoisted.toast).not.toHaveBeenCalled()
    expect(hoisted.announce).not.toHaveBeenCalled()
  })

  it('desktop: when the native side skips the banner (a Native Intelligence window is frontmost), the toast plays the sound', async () => {
    hoisted.desktop = true
    hoisted.showNative.mockImplementation(async () => false)
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    await mount()
    await insert(row('live-3'))
    expect(hoisted.toast).toHaveBeenCalledTimes(1)
    expect(hoisted.announce).toHaveBeenCalledTimes(1)
  })

  it('desktop, window focused: toast and sound', async () => {
    hoisted.desktop = true
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await mount()
    await insert(row('live-4'))
    expect(hoisted.showNative).not.toHaveBeenCalled()
    expect(hoisted.announce).toHaveBeenCalledTimes(1)
  })
})
