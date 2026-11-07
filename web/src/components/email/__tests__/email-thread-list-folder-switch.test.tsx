// @vitest-environment jsdom
/**
 * Switching folders replaces the whole list. The rows are keyed by
 * provider_thread_id, and a key that appears twice makes React lose one of the
 * two rows: it is never removed, so its DOM outlives every later list. On prod
 * the Inbox page carried eight threads twice (one index row per workspace the
 * mailbox is linked to), and those eight stayed on screen above the drafts
 * after switching to Drafts. Page 2 can repeat a page-1 thread too, when new
 * mail shifts the offset between the two fetches.
 *
 * The REAL list is mounted; only fetch and the row are stand-ins.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => null }))
vi.mock('../email-thread-item', () => ({
  EmailThreadItem: ({ thread }: { thread: { provider_thread_id: string; folder: string } }) =>
    h('div', { 'data-row': thread.provider_thread_id, 'data-folder': thread.folder }),
}))

import { EmailThreadList } from '../email-thread-list'

type Row = { id: string; provider_thread_id: string; folder: string }
const row = (id: string, ptid: string, folder: string): Row => ({ id, provider_thread_id: ptid, folder })

// What the threads route answers, per folder and page.
let pages: Record<string, Row[][]> = {}

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

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const params = new URL(url, 'http://x').searchParams
      const folderPages = pages[params.get('folder') ?? ''] ?? []
      const page = Number(params.get('page'))
      return {
        ok: true,
        json: async () => ({ threads: folderPages[page - 1] ?? [], has_more: page < folderPages.length }),
      } as unknown as Response
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

const props = { onThreadSelect: () => {}, selectedThreadId: null }
const render = (folder: string) => act(async () => root.render(h(EmailThreadList, { ...props, folder })))
// Lets the immediate fetch and the 300ms search-effect fetch both land.
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(400) })
const rendered = () =>
  [...container.querySelectorAll('[data-row]')].map((r) => `${r.getAttribute('data-folder')}:${r.getAttribute('data-row')}`)

describe('EmailThreadList — switching folders', () => {
  it('shows only the new folder, even when the old one listed a thread twice', async () => {
    pages = {
      inbox: [[row('a1', 'thr-a', 'inbox'), row('b1', 'thr-b', 'inbox'), row('a2', 'thr-a', 'inbox'), row('c1', 'thr-c', 'inbox')]],
      drafts: [[row('d1', 'thr-d', 'drafts'), row('e1', 'thr-e', 'drafts')]],
    }
    await render('inbox')
    await settle()
    expect(rendered()).toEqual(['inbox:thr-a', 'inbox:thr-b', 'inbox:thr-c'])

    await render('drafts')
    await settle()
    expect(rendered()).toEqual(['drafts:thr-d', 'drafts:thr-e'])
  })

  it('a next page that repeats a thread already listed does not list it twice', async () => {
    pages = {
      inbox: [
        [row('a1', 'thr-a', 'inbox'), row('b1', 'thr-b', 'inbox')],
        [row('b1', 'thr-b', 'inbox'), row('c1', 'thr-c', 'inbox')],
      ],
      drafts: [[row('d1', 'thr-d', 'drafts')]],
    }
    await render('inbox')
    await settle()
    await act(async () => FakeIntersectionObserver.last!.fire())
    await settle()
    expect(rendered()).toEqual(['inbox:thr-a', 'inbox:thr-b', 'inbox:thr-c'])

    await render('drafts')
    await settle()
    expect(rendered()).toEqual(['drafts:thr-d'])
  })
})
