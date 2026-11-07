// @vitest-environment jsdom
/**
 * Starring, archiving or trashing a search result the index doesn't have
 * (`indexed: false`) indexes it first (POST /threads/materialize), so the
 * thread route finds its row; an indexed row goes straight to the action.
 *
 * The REAL list is mounted; only fetch and the row are stand-ins.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Handler = (e: { stopPropagation: () => void }) => void
vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => null }))
vi.mock('../email-thread-item', () => ({
  EmailThreadItem: ({ thread, onToggleStar, onTrash }: { thread: { provider_thread_id: string }; onToggleStar: Handler; onTrash: Handler }) =>
    h('div', { 'data-row': thread.provider_thread_id },
      h('button', { 'data-star': thread.provider_thread_id, onClick: () => onToggleStar({ stopPropagation: () => {} }) }),
      h('button', { 'data-trash': thread.provider_thread_id, onClick: () => onTrash({ stopPropagation: () => {} }) })),
}))

import { EmailThreadList } from '../email-thread-list'
import { resetInflightGets } from '@/lib/email/inflight-get'

class FakeIntersectionObserver {
  observe() {}
  disconnect() {}
}

let container: HTMLDivElement
let root: Root
let calls: Array<{ url: string; body?: string }>

beforeEach(() => {
  vi.useFakeTimers()
  resetInflightGets()
  calls = []
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? String(init.body) : undefined })
    if (url.startsWith('/api/account/email/threads?')) {
      return { ok: true, json: async () => ({
        threads: [
          { id: 'live:acct-g:thr-old', provider_thread_id: 'thr-old', account_id: 'acct-g', subject: 'Old', live: true, indexed: false },
          { id: 'idx-new', provider_thread_id: 'thr-new', account_id: 'acct-g', subject: 'New', live: true, indexed: true },
        ],
        has_more: false,
      }) } as unknown as Response
    }
    if (url === '/api/account/email/threads/materialize') return { ok: true, json: async () => ({ id: 'idx-old' }) } as unknown as Response
    return { ok: true, json: async () => ({}) } as unknown as Response
  }))
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

async function mount() {
  await act(async () => root.render(h(EmailThreadList, { onThreadSelect: () => {}, selectedThreadId: null, folder: 'inbox', search: 'meeting' })))
  await act(async () => { await vi.advanceTimersByTimeAsync(400) })
}
const click = (sel: string) => act(async () => { (container.querySelector(sel) as HTMLButtonElement).click(); await vi.advanceTimersByTimeAsync(10) })
const actions = () => calls.filter((c) => !c.url.startsWith('/api/account/email/threads?')).map((c) => c.url)

describe('EmailThreadList — acting on a search result the index lacks', () => {
  it('indexes it first, then stars it', async () => {
    await mount()
    await click('[data-star="thr-old"]')
    expect(actions()).toEqual(['/api/account/email/threads/materialize', '/api/account/email/threads/thr-old/star'])
    expect(JSON.parse(calls.find((c) => c.url.endsWith('/materialize'))!.body!)).toEqual({ threadId: 'thr-old', accountId: 'acct-g' })
  })

  it('indexes it first, then trashes it', async () => {
    await mount()
    await click('[data-trash="thr-old"]')
    expect(actions()).toEqual(['/api/account/email/threads/materialize', '/api/account/email/threads/thr-old/trash'])
  })

  it('an indexed row goes straight to the action', async () => {
    await mount()
    await click('[data-star="thr-new"]')
    expect(actions()).toEqual(['/api/account/email/threads/thr-new/star'])
  })
})
