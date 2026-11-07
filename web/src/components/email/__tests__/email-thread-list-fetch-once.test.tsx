// @vitest-environment jsdom
/**
 * Opening Mail asks for the list ONCE. The load effect and the debounced
 * search effect both fired on mount (the search one with an empty search, a
 * duplicate in production too), and React's dev double mount doubled the
 * load; the list now asks once, and one request per URL is in flight
 * (inflight-get.ts). A search asks after its debounce, with the search, and a
 * slower answer to an older search never replaces a newer one. A search row
 * carries the provider's header (no headers call) and pages on by the
 * provider's cursor.
 *
 * The REAL list is mounted; only fetch and the row are stand-ins.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, StrictMode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => null }))
vi.mock('../email-thread-item', () => ({
  EmailThreadItem: ({ thread }: { thread: { provider_thread_id: string; subject?: string | null } }) =>
    h('div', { 'data-row': thread.provider_thread_id, 'data-subject': thread.subject ?? '' }),
}))

import { EmailThreadList } from '../email-thread-list'
import { resetInflightGets } from '@/lib/email/inflight-get'
import { resetHeaderCache } from '@/lib/email/header-cache'

class FakeIntersectionObserver {
  static last: FakeIntersectionObserver | null = null
  constructor(private cb: (entries: { isIntersecting: boolean }[]) => void) {
    FakeIntersectionObserver.last = this
  }
  observe() {}
  disconnect() {}
  fire() {
    this.cb([{ isIntersecting: true }])
  }
}

let container: HTMLDivElement
let root: Root
let listCalls: URLSearchParams[]
let headerCalls: number
// A search's answer can be held back to land after a later one.
let hold: Partial<Record<string, Promise<void>>> = {}

beforeEach(() => {
  vi.useFakeTimers()
  resetInflightGets()
  resetHeaderCache()
  listCalls = []
  headerCalls = 0
  hold = {}
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/threads/headers')) {
        headerCalls++
        return { ok: true, json: async () => ({ headers: {} }) } as unknown as Response
      }
      const params = new URL(url, 'http://x').searchParams
      listCalls.push(params)
      const search = params.get('search') ?? ''
      if (hold[search]) await hold[search]
      if (!search) {
        return { ok: true, json: async () => ({ threads: [{ id: 'i1', provider_thread_id: 'thr-index', provider_message_id: 'm1' }], has_more: false }) } as unknown as Response
      }
      const cursor = params.get('cursor')
      const threads = cursor === 'c2'
        ? [{ id: 'live:a:thr-old2', provider_thread_id: 'thr-old2', subject: `${search} 2`, live: true }]
        : [{ id: 'live:a:thr-old', provider_thread_id: `thr-${search}`, subject: search, live: true }]
      return { ok: true, json: async () => ({ threads, has_more: !cursor, cursor: cursor ? null : 'c2' }) } as unknown as Response
    }),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const props = { onThreadSelect: () => {}, selectedThreadId: null, folder: 'inbox' }
const render = (search = '', strict = false) =>
  act(async () => {
    const list = h(EmailThreadList, { ...props, search })
    root.render(strict ? h(StrictMode, null, list) : list)
  })
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(400) })
const rows = () => [...container.querySelectorAll('[data-row]')].map((r) => r.getAttribute('data-row'))

describe('EmailThreadList — one request per need', () => {
  it('opening Mail asks for the list once', async () => {
    await render()
    await settle()
    expect(listCalls).toHaveLength(1)
    expect(listCalls[0].get('search')).toBeNull()
  })

  it('once under React StrictMode too (the dev double mount)', async () => {
    await render('', true)
    await settle()
    expect(listCalls).toHaveLength(1)
  })

  it('a search asks once after its debounce, with the search; its rows need no headers call', async () => {
    await render()
    await settle()
    headerCalls = 0
    await render('m')
    await render('me')
    await render('meeting')
    await settle()
    expect(listCalls.map((p) => p.get('search'))).toEqual([null, 'meeting'])
    expect(rows()).toEqual(['thr-meeting'])
    expect(headerCalls).toBe(0)
  })

  it('a slower answer to an older search never replaces the newer one', async () => {
    let release!: () => void
    hold.meeting = new Promise<void>((r) => { release = r })
    await render('meeting')
    await settle()
    await render('meeting invite')
    await settle()
    expect(rows()).toEqual(['thr-meeting invite'])
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(10) })
    expect(rows()).toEqual(['thr-meeting invite'])
  })

  it('a search pages on with the provider cursor', async () => {
    await render('meeting')
    await settle()
    await act(async () => FakeIntersectionObserver.last!.fire())
    await settle()
    const next = listCalls.at(-1)!
    expect(next.get('cursor')).toBe('c2')
    expect(next.get('page')).toBe('2')
    expect(rows()).toEqual(['thr-meeting', 'thr-old2'])
  })
})
