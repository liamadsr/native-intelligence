// @vitest-environment jsdom
/**
 * Notices, on a bot's page (bots-v4 Phase 4c, decision 8): the notices the
 * bell no longer lists, read through useBotNotices
 * (GET /api/account/notifications/bot?teammate=).
 *
 *   • newest first, read and unread, the unread ones marked and counted
 *     beside the title; a failed run's wears the alert and sits there unread;
 *   • a click reads it (here at once, and the server: markAsRead) and opens
 *     its item (`onOpen` with the run it's about);
 *   • opening the item anywhere reads it: the window's channel says so
 *     (`botNotices` turns read), the row shows it at once and the list is
 *     read again a beat later;
 *   • a new one of its own landing reads the list again; another bot's never;
 *   • a bot you can't reach shows nothing and asks nothing; a refused read
 *     (404) is an empty list, never an error;
 *   • "Mark all read" (while any is unread) reads every one of this bot's, for
 *     you only (its route), shown at once; "Show more" asks for more;
 *   • a notice clicked stays read here though a read that started before its
 *     PATCH landed still says unread (review F6).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Notification } from '@/app/account/notification-context'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  botNotices: [] as unknown[],
  markAsRead: vi.fn(async (_id: string) => {}),
}))
vi.mock('@/app/account/notification-context', () => ({
  useNotifications: () => ({ botNotices: hoisted.botNotices, markAsRead: hoisted.markAsRead }),
}))

import { BOT_NOTICES_MARK_ALL_URL, BOT_NOTICES_REREAD_MS } from '@/hooks/use-bot-notices'
import { Notices, PAGE_NOTICES_LIMIT } from '../notices'

function notice(id: string, over: Partial<Notification> = {}): Notification {
  return {
    id,
    workspace_id: 'w1',
    recipient_id: 'm1',
    type: 'flow_run_output',
    title: 'Writer',
    body: `Body ${id}`,
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
    metadata: { teammate_id: 'writer', teammate_name: 'Writer', sentence: `Writer says ${id}.`, work_item_id: `job-${id}` },
    created_at: '2026-10-07T10:00:00.000Z',
    ...over,
  }
}

let answer: { status: number; body: unknown }
let fetchMock: ReturnType<typeof vi.fn>
let container: HTMLDivElement
let root: Root
const onOpen = vi.fn()

beforeEach(() => {
  hoisted.botNotices = []
  hoisted.markAsRead.mockClear()
  onOpen.mockReset()
  answer = {
    status: 200,
    body: {
      notices: [notice('n3'), notice('n2', { type: 'work_failed', metadata: { teammate_id: 'writer', sentence: 'I couldn’t finish the brief.', work_item_id: 'job-n2' } }), notice('n1', { is_read: true })],
      unread: 2,
    },
  }
  fetchMock = vi.fn(async (url: string) =>
    url === BOT_NOTICES_MARK_ALL_URL
      ? ({ ok: true, status: 200, json: async () => ({ success: true, read: 2 }) } as unknown as Response)
      : ({ ok: answer.status === 200, status: answer.status, json: async () => answer.body } as unknown as Response),
  )
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(reachable = true) {
  await act(async () => {
    root.render(h(Notices, { teammateId: 'writer', name: 'Writer', reachable, onOpen }))
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function wait(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

const rows = () => [...container.querySelectorAll<HTMLElement>('[data-bot-page-notice]')]
const count = () => container.querySelector('[data-bot-page-section="notices"] h2')!.textContent

describe('Notices on a bot’s page', () => {
  it('lists its notices newest first, the unread marked and counted, a failed run’s with the alert', async () => {
    await render()
    expect(fetchMock).toHaveBeenCalledWith(`/api/account/notifications/bot?teammate=writer&limit=${PAGE_NOTICES_LIMIT}`, { cache: 'no-store' })
    expect(rows().map((r) => r.getAttribute('data-bot-page-notice'))).toEqual(['n3', 'n2', 'n1'])
    expect(rows().map((r) => r.hasAttribute('data-bot-page-notice-unread'))).toEqual([true, true, false])
    expect(rows()[0].textContent).toContain('Writer says n3.')
    expect(rows()[1].textContent).toContain('I couldn’t finish the brief.')
    expect(rows()[1].textContent).toContain('couldn’t finish')
    expect(rows()[1].querySelector('svg')).not.toBeNull()
    expect(count()).toBe('Notices2')
  })

  it('a click reads it and opens its item', async () => {
    await render()
    act(() => rows()[1].querySelector('button')!.click())
    expect(hoisted.markAsRead).toHaveBeenCalledWith('n2')
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'n2' }), 'job-n2')
    // Read here at once.
    expect(rows()[1].hasAttribute('data-bot-page-notice-unread')).toBe(false)
    expect(count()).toBe('Notices1')
  })

  it('opening its item elsewhere reads it: shown at once, then read again', async () => {
    await render()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // The activity PATCH `opened` read it; the window's channel hears the UPDATE.
    hoisted.botNotices = [notice('n3', { is_read: true })]
    await render()
    expect(rows()[0].hasAttribute('data-bot-page-notice-unread')).toBe(false)
    expect(count()).toBe('Notices1')
    await wait(BOT_NOTICES_REREAD_MS + 50)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a new notice of its own reads the list again; another bot’s never does', async () => {
    await render()
    hoisted.botNotices = [notice('x', { metadata: { teammate_id: 'researcher', sentence: 'Other bot.' } })]
    await render()
    await wait(BOT_NOTICES_REREAD_MS + 50)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    answer = { status: 200, body: { notices: [notice('n4'), notice('n3')], unread: 2 } }
    hoisted.botNotices = [...hoisted.botNotices, notice('n4')]
    await render()
    await wait(BOT_NOTICES_REREAD_MS + 50)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(rows().map((r) => r.getAttribute('data-bot-page-notice'))).toEqual(['n4', 'n3'])
  })

  it('one face: on the agent’s page, a new notice of one of its workspace’s area faces reads the list again', async () => {
    const { publishNoticeFaces, __resetNoticeFacesForTests } = await import('@/lib/bots/notice-faces')
    publishNoticeFaces([
      { id: 'writer', workspace_id: 'w1', name: 'Joseph', bot_character: 'chat', is_system: true, system_key: 'assistant' },
      { id: 'mail', workspace_id: 'w1', name: 'Mail', bot_character: 'mail', is_system: true, system_key: 'mail' },
    ])
    try {
      await render()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      hoisted.botNotices = [notice('m1', { metadata: { teammate_id: 'mail', sentence: 'I drafted two replies.' } })]
      await render()
      await wait(BOT_NOTICES_REREAD_MS + 50)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      __resetNoticeFacesForTests()
    }
  })

  it('a bot you can’t reach: nothing drawn, nothing asked', async () => {
    await render(false)
    expect(container.querySelector('[data-bot-page-section="notices"]')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a refused read (not yours) is an empty list', async () => {
    answer = { status: 404, body: { error: 'Teammate not found' } }
    await render()
    expect(container.querySelector('[data-bot-page-empty]')!.textContent).toBe('No notices from Writer.')
  })
})

describe('Notices on a bot’s page: Mark all read, Show more, and a click that stays read', () => {
  const lists = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/account/notifications/bot?')).map(([url]) => String(url))

  it('“Mark all read” reads every one of this bot’s, for you only: shown at once, then read again', async () => {
    await render()
    const button = container.querySelector<HTMLButtonElement>('[data-bot-page-notices-mark-all]')!
    expect(button.textContent).toBe('Mark all read')
    answer = { status: 200, body: { notices: [notice('n3', { is_read: true }), notice('n1', { is_read: true })], unread: 0 } }
    await act(async () => button.click())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    const post = fetchMock.mock.calls.find(([url]) => url === BOT_NOTICES_MARK_ALL_URL)!
    expect(post[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ teammate: 'writer' }) })
    expect(rows().every((r) => !r.hasAttribute('data-bot-page-notice-unread'))).toBe(true)
    expect(count()).toBe('Notices')
    // Nothing unread: no button.
    expect(container.querySelector('[data-bot-page-notices-mark-all]')).toBeNull()
    expect(lists()).toHaveLength(2)
  })

  it('a full page offers “Show more”, which asks for more', async () => {
    answer = { status: 200, body: { notices: Array.from({ length: PAGE_NOTICES_LIMIT }, (_, i) => notice(`m${i}`)), unread: 40 } }
    await render()
    expect(rows()).toHaveLength(PAGE_NOTICES_LIMIT)
    await act(async () => container.querySelector<HTMLButtonElement>('[data-bot-page-notices-more]')!.click())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(lists().at(-1)).toBe(`/api/account/notifications/bot?teammate=writer&limit=${PAGE_NOTICES_LIMIT * 2}`)
    // What it held stays on screen while more load (no flash of the skeleton).
    expect(container.querySelector('[data-bot-page-notices-loading]')).toBeNull()
  })

  it('a notice clicked stays read though a read begun before its PATCH landed still says unread', async () => {
    await render()
    act(() => rows()[0].querySelector('button')!.click())
    expect(rows()[0].hasAttribute('data-bot-page-notice-unread')).toBe(false)
    // Another of its notices moves; the read again still has n3 unread (the PATCH not landed).
    hoisted.botNotices = [notice('n9')]
    await render()
    await wait(BOT_NOTICES_REREAD_MS + 50)
    expect(lists()).toHaveLength(2)
    expect(rows()[0].getAttribute('data-bot-page-notice')).toBe('n3')
    expect(rows()[0].hasAttribute('data-bot-page-notice-unread')).toBe(false)
  })
})
