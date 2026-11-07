// @vitest-environment jsdom
/**
 * A bot's notice speaks as the bot (bots v3 1b, notification-context.tsx):
 *
 *   • the OS banner's title is the teammate's name, its body the bot's
 *     sentence, and its payload names the bot (`payload.bot`: the teammate,
 *     its face, the run). It is never asked to be sticky;
 *   • in front, it always toasts, signed by the bot, the sound once;
 *   • a quiet notice (a run that left nothing) fires nothing;
 *   • a notice that names no teammate is exactly what it was.
 *
 * The REAL provider is mounted; supabase, fetch, the member id, toasts, the
 * desktop bridge and the sound layer are stubbed (as in the sounds test).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { BOT_CHARACTERS } from '@/lib/bots/bot-faces'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  desktop: false,
  insert: undefined as undefined | ((p: { new: unknown }) => void),
  announce: vi.fn(),
  toast: vi.fn(),
  showNative: vi.fn(async (_args: { id: string; title: string; body?: string; payload: string }): Promise<boolean> => true),
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const ch: Record<string, unknown> = {}
    ch.on = (_t: string, cfg: { event?: string }, cb: (p: { new: unknown }) => void) => {
      if (cfg?.event === 'INSERT') hoisted.insert = cb
      return ch
    }
    ch.subscribe = () => ch
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

import {
  NotificationProvider,
  nativeNotificationArgs,
  noticeSurface,
  toastCopy,
  type Notification,
} from '../notification-context'
import { setNativeNotificationsDisabled } from '@/lib/native-notification-path'
import { __resetNoticeFacesForTests, publishNoticeFaces } from '@/lib/bots/notice-faces'

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
    metadata: { teammate_id: 'tm-triage', teammate_name: 'Triage', sentence: SENTENCE, work_item_id: 'job-1', card_count: 3 },
    created_at: new Date().toISOString(),
    ...over,
  }
}
const plain = (id: string) =>
  row(id, { type: 'comment_added', title: 'Dana commented', body: 'Looks good', metadata: {}, target_type: null, target_id: null })

const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ notifications: [] }) }) as unknown as Response)

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
  __resetNoticeFacesForTests()
  publishNoticeFaces([{ id: 'tm-triage', bot_character: TRIAGE }])
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

describe('the banner speaks as the bot', () => {
  it('titles it with the teammate’s name, says the sentence, and names the bot', () => {
    const args = nativeNotificationArgs(row('n1', { title: 'Proposal Triage: 3 need you', body: 'old body' }))
    expect(args.title).toBe('Triage')
    expect(args.body).toBe(SENTENCE)
    const payload = JSON.parse(args.payload)
    expect(payload.bot).toEqual({ teammate_id: 'tm-triage', face: TRIAGE, work_item_id: 'job-1' })
    expect(payload.notification_id).toBe('n1')
    // Transient: no alert style or interruption level is ever asked for (the
    // thread id only groups it: phase 7, notification-context-banner-polish).
    expect(Object.keys(args).sort()).toEqual(['body', 'id', 'payload', 'threadId', 'title'])
  })

  it('a face this window doesn’t know rides as null', () => {
    __resetNoticeFacesForTests()
    expect(JSON.parse(nativeNotificationArgs(row('n1')).payload).bot.face).toBeNull()
  })

  it('a notice that names no teammate is exactly what it was', () => {
    const args = nativeNotificationArgs(plain('n2'))
    expect([args.title, args.body]).toEqual(['Dana commented', 'Looks good'])
    expect(JSON.parse(args.payload).bot).toBeUndefined()
  })

  it('fires unfocused on the desktop, as any banner does', async () => {
    hoisted.desktop = true
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    await mount()
    await insert(row('live-1'))
    expect(hoisted.showNative).toHaveBeenCalledTimes(1)
    expect(hoisted.showNative.mock.calls[0][0]).toMatchObject({ title: 'Triage', body: SENTENCE })
    expect(hoisted.toast).not.toHaveBeenCalled()
  })
})

describe('in front: a toast signed by the bot', () => {
  it('toasts at once, the sound once, with no wait for anything', async () => {
    const failed = row('live-6', {
      type: 'work_failed',
      title: 'Agent run failed',
      metadata: { teammate_id: 'tm-triage', teammate_name: 'Triage', sentence: 'Brief failed.', work_item_id: 'job-1' },
    })
    expect(noticeSurface(failed)).toBe('toast')
    await mount()
    await insert(failed)
    expect(hoisted.toast).toHaveBeenCalledWith('Triage', { description: 'Brief failed.' })
    expect(hoisted.announce).toHaveBeenCalledTimes(1)
  })

  it('the toast is signed by the bot', async () => {
    await mount()
    await insert(row('live-3', { title: 'Proposal Triage: 3 need you', body: 'old' }))
    expect(hoisted.toast).toHaveBeenCalledWith('Triage', { description: SENTENCE })
    expect(toastCopy(row('x', { title: 'app title' }))).toEqual({ title: 'Triage', description: SENTENCE })
  })

  it('a quiet notice (nothing for you) fires no toast, no banner, no sound', async () => {
    hoisted.desktop = true
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    await mount()
    await insert(row('live-4', { metadata: { teammate_id: 'tm-triage', sentence: "I skipped 'Brief' this time.", quiet: true } }))
    expect(hoisted.showNative).not.toHaveBeenCalled()
    expect(hoisted.toast).not.toHaveBeenCalled()
    expect(hoisted.announce).not.toHaveBeenCalled()
  })

  it('a notice that names no teammate toasts exactly as before', async () => {
    await mount()
    await insert(plain('live-5'))
    expect(hoisted.toast).toHaveBeenCalledWith('Dana commented', { description: 'Looks good' })
    expect(noticeSurface(plain('x'))).toBe('toast')
  })
})
