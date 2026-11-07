// @vitest-environment jsdom
/**
 * A bot's banner is stacked with its bot's, and leaves once read (bots v3,
 * phase 7, notification-context.tsx):
 *
 *   • the banner carries a thread id (the teammate, so Notification Center
 *     stacks each bot's banners) and the workspace as its subtitle; no banner
 *     carries an image (the OS draws the app's icon); a notice that names no
 *     teammate carries neither, and none of them is an alert style or an
 *     interruption level;
 *   • a notice that's read (its item opened, read on any device, marked read
 *     here: a banner's click) or deleted takes its banner out of Notification
 *     Center, and so does one a later fetch finds read (a read this page
 *     never heard over realtime: the socket was down, or another workspace);
 *   • VERSION SKEW: an older desktop without the remove command rejects it.
 *     That only stops the removes: the banner path is never disabled by it.
 *
 * The REAL provider is mounted; supabase, fetch, the workspace cache, toasts,
 * the desktop bridge and the sound layer are stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { BOT_CHARACTERS } from '@/lib/bots/bot-faces'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Handler = (p: { new?: unknown; old?: unknown }) => void

const hoisted = vi.hoisted(() => ({
  desktop: true,
  handlers: {} as Record<string, Handler>,
  workspaces: [] as Array<{ id: string; name: string }>,
  toast: vi.fn(),
  showNative: vi.fn(async (_args: Record<string, unknown>): Promise<boolean> => true),
  removeDelivered: vi.fn(async (_id: string): Promise<boolean> => true),
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
vi.mock('../workspace-switcher', () => ({
  useCurrentMemberId: () => 'member-1',
  useWorkspaces: () => ({ workspaces: hoisted.workspaces }),
}))
vi.mock('sonner', () => ({ toast: Object.assign(hoisted.toast, { error: vi.fn(), success: vi.fn() }) }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => hoisted.desktop }))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    notificationPermissionState: async () => 'granted',
    requestNotificationPermission: async () => 'granted',
    showNativeNotification: hoisted.showNative,
    removeDeliveredNotification: hoisted.removeDelivered,
  },
}))
vi.mock('@/lib/reminders/client', () => ({ emitReminderChanged: vi.fn() }))
vi.mock('@/lib/sounds/triggers', () => ({ announceNotification: vi.fn() }))

import { NotificationProvider, nativeNotificationArgs, useNotifications, type Notification } from '../notification-context'
import {
  __resetBannerRemovalForTests,
  areNativeNotificationsDisabled,
  setNativeNotificationsDisabled,
} from '@/lib/native-notification-path'
import { __resetNoticeFacesForTests, publishNoticeFaces } from '@/lib/bots/notice-faces'
import { HOME_MESSAGE_EVENT } from '@/lib/chat/home-message'

const TRIAGE = BOT_CHARACTERS[0].type
const SENTENCE = "I triaged 'Call with Acme': three proposals need you."

function row(id: string, over: Partial<Notification> = {}): Notification {
  return {
    id,
    workspace_id: 'ws-1',
    recipient_id: 'member-1',
    type: 'flow_run_output',
    title: 'Triage',
    body: SENTENCE,
    actor_id: null,
    actor_name: null,
    actor_avatar: null,
    target_type: 'work_item',
    target_id: 'job-1',
    context_type: null,
    context_id: null,
    is_read: false,
    read_at: null,
    is_archived: false,
    group_key: null,
    metadata: { teammate_id: 'tm-triage', teammate_name: 'Triage', sentence: SENTENCE, work_item_id: 'job-1' },
    created_at: new Date().toISOString(),
    ...over,
  }
}
const plain = (id: string) =>
  row(id, { type: 'comment_added', title: 'Dana commented', body: 'Looks good', metadata: {}, target_type: null, target_id: null })

const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ notifications: [] }) }) as unknown as Response)

let container: HTMLDivElement
let root: Root
let ctx: ReturnType<typeof useNotifications>

function Probe() {
  ctx = useNotifications()
  return null
}

async function flush() {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

async function mount() {
  await act(async () => {
    root.render(h(NotificationProvider, null, h(Probe)))
  })
  await act(flush)
}

async function fire(event: 'INSERT' | 'UPDATE' | 'DELETE', payload: { new?: unknown; old?: unknown }) {
  await act(async () => {
    hoisted.handlers[event]!(payload)
    await flush()
  })
}

beforeEach(() => {
  hoisted.desktop = true
  hoisted.handlers = {}
  hoisted.workspaces = [{ id: 'ws-1', name: 'Acme' }]
  hoisted.showNative.mockImplementation(async () => true)
  hoisted.removeDelivered.mockImplementation(async () => true)
  setNativeNotificationsDisabled(false)
  __resetBannerRemovalForTests()
  __resetNoticeFacesForTests()
  publishNoticeFaces([{ id: 'tm-triage', bot_character: TRIAGE }])
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
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

describe('the banner is stacked with its bot’s', () => {
  it('groups by the teammate and says the workspace; no image (the OS draws the app’s icon)', () => {
    const args = nativeNotificationArgs(row('n1'), { workspaceName: ' Acme ' })
    expect(args).toMatchObject({ threadId: 'tm-triage', subtitle: 'Acme' })
    // Dress only: still never sticky, never a raised interruption level.
    expect(Object.keys(args).sort()).toEqual(['body', 'id', 'payload', 'subtitle', 'threadId', 'title'])
  })

  it('a face this window doesn’t know still stacks; an unknown workspace goes without a subtitle', () => {
    __resetNoticeFacesForTests()
    const args = nativeNotificationArgs(row('n1'))
    expect(args.threadId).toBe('tm-triage')
    expect(args.subtitle).toBeUndefined()
    expect(args).not.toHaveProperty('image')
  })

  it('a notice that names no teammate gets neither', () => {
    const args = nativeNotificationArgs(plain('n2'), { workspaceName: 'Acme' })
    expect(Object.keys(args).sort()).toEqual(['body', 'id', 'payload', 'title'])
  })

  it('a live notice’s banner carries them, with the workspace from the cache', async () => {
    await mount()
    await fire('INSERT', { new: row('live-1') })
    expect(hoisted.showNative).toHaveBeenCalledTimes(1)
    expect(hoisted.showNative.mock.calls[0][0]).toMatchObject({
      id: 'live-1',
      title: 'Triage',
      body: SENTENCE,
      threadId: 'tm-triage',
      subtitle: 'Acme',
    })
    expect(hoisted.showNative.mock.calls[0][0]).not.toHaveProperty('image')
  })
})

describe('a read notice’s banner leaves Notification Center', () => {
  it('when it turns read anywhere (its item opened), once', async () => {
    await mount()
    await fire('INSERT', { new: row('n1') })
    await fire('UPDATE', { new: row('n1', { is_read: true }), old: row('n1') })
    expect(hoisted.removeDelivered.mock.calls).toEqual([['n1']])
    // An update to a row already read asks nothing more.
    await fire('UPDATE', { new: row('n1', { is_read: true, title: 'x' }), old: row('n1', { is_read: true }) })
    expect(hoisted.removeDelivered).toHaveBeenCalledTimes(1)
  })

  it('when it’s archived or deleted', async () => {
    await mount()
    await fire('UPDATE', { new: row('n1', { is_archived: true }), old: row('n1') })
    await fire('DELETE', { old: row('n2') })
    expect(hoisted.removeDelivered.mock.calls).toEqual([['n1'], ['n2']])
  })

  it('when it’s marked read here (a banner’s click), a plain notice’s or a bot’s', async () => {
    fetchMock.mockImplementationOnce(
      async () =>
        ({
          ok: true,
          json: async () => ({
            notifications: [plain('a'), { ...plain('b'), is_read: true }],
            bot_notifications: [row('d')],
          }),
        }) as unknown as Response,
    )
    await mount()
    await act(async () => {
      await ctx.markAsRead('a')
    })
    expect(hoisted.removeDelivered.mock.calls).toEqual([['a']])
    hoisted.removeDelivered.mockClear()
    // The bot's own banner, clicked (its notice read): it leaves too.
    await act(async () => {
      await ctx.markAsRead('d')
    })
    expect(hoisted.removeDelivered.mock.calls).toEqual([['d']])
  })

  it('when a catch-up fetch finds a banner this page posted read (an UPDATE it never heard)', async () => {
    await mount()
    await fire('INSERT', { new: row('posted') })
    expect(hoisted.showNative).toHaveBeenCalledTimes(1)
    fetchMock.mockImplementationOnce(
      async () =>
        ({
          ok: true,
          json: async () => ({
            notifications: [row('posted', { is_read: true }), row('elsewhere', { is_read: true })],
          }),
        }) as unknown as Response,
    )
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dial8:realtime-recovered'))
      await flush()
    })
    // Only the banner this page posted: a row it never bannered asks nothing.
    expect(hoisted.removeDelivered.mock.calls).toEqual([['posted']])
  })

  it('never in a browser', async () => {
    hoisted.desktop = false
    await mount()
    await fire('UPDATE', { new: row('n1', { is_read: true }), old: row('n1') })
    expect(hoisted.removeDelivered).not.toHaveBeenCalled()
  })
})

describe('version skew: an older desktop without the remove command', () => {
  it('rejects the remove, and the banner path stays on: the next notice is still a banner', async () => {
    hoisted.removeDelivered.mockImplementation(async () => {
      throw new Error('command remove_delivered_notification not found')
    })
    await mount()
    await fire('UPDATE', { new: row('n1', { is_read: true }), old: row('n1') })
    expect(hoisted.removeDelivered).toHaveBeenCalledTimes(1)
    expect(areNativeNotificationsDisabled()).toBe(false)

    await fire('INSERT', { new: row('n2') })
    expect(hoisted.showNative).toHaveBeenCalledTimes(1)
    expect(hoisted.toast).not.toHaveBeenCalled()

    // And it stops asking: no wasted round trip per read.
    await fire('UPDATE', { new: row('n2', { is_read: true }), old: row('n2') })
    expect(hoisted.removeDelivered).toHaveBeenCalledTimes(1)
    expect(areNativeNotificationsDisabled()).toBe(false)
  })
})

describe('the router’s banner about a home-thread message (lib/chat/home-message.ts)', () => {
  // PROD 2026-10-31: the banner arrived while the open chat lacked its message.
  // Its arrival now tells the chat to read that message in.
  it('announces its message to the chat as it arrives; any other notice announces nothing', async () => {
    const heard: unknown[] = []
    const listen = (e: Event) => heard.push((e as CustomEvent).detail)
    window.addEventListener(HOME_MESSAGE_EVENT, listen)
    try {
      await mount()
      await fire('INSERT', {
        new: row('agent-1', {
          type: 'agent_message',
          target_type: null,
          target_id: null,
          metadata: { conversation_id: 'home-1', home_message_id: 'row-1', message_id: 'home-turn:1', messages: 1 },
        }),
      })
      await fire('INSERT', { new: plain('plain-1') })
      expect(heard).toEqual([{ workspaceId: 'ws-1', conversationId: 'home-1', messageId: 'home-turn:1' }])
    } finally {
      window.removeEventListener(HOME_MESSAGE_EVENT, listen)
    }
  })
})
