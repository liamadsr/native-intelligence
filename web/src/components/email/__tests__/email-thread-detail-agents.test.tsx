// @vitest-environment jsdom
/**
 * The thread pane's Agents section (plan 2.4, page 6; row 12): under the
 * messages, closed by default (it loads nothing until opened), and open it is
 * the entity tab keyed on the thread's index row. A thread that is not indexed
 * has no section. The open state carries to the next thread. The REAL pane is
 * mounted; the tab itself is stubbed at the dynamic import.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/dynamic', () => ({
  default: () => (props: Record<string, unknown>) => h('div', { 'data-entity-activity': JSON.stringify(props) }),
}))
vi.mock('@/lib/labels/use-scoped-labels', () => ({
  useScopedLabels: () => ({ labels: [], grouped: [], loading: false }),
}))

import { EmailThreadDetail } from '../email-thread-detail'

const INDEX_ID = '7a1f0000-0000-4000-8000-000000000001'
const thread = (threadId: string, indexId: string | null) => ({
  threadId,
  indexId,
  subject: 'Q3 planning',
  messages: [
    {
      id: `${threadId}-m1`,
      threadId,
      from: { name: 'Sarah Chen', email: 'sarah@acme.com' },
      to: [{ name: 'Liam', email: 'liam@dial8.ai' }],
      cc: [],
      subject: 'Q3 planning',
      date: '2026-09-26T16:12:00Z',
      bodyHtml: null,
      bodyText: 'Tuesday works.',
      isUnread: false,
      isStarred: false,
      hasAttachments: false,
      attachments: [],
    },
  ],
  drafts: [],
  contact: null,
  metadata: { needs_reply: false, auto_classified: null, linked_capture_id: null },
})

const THREADS: Record<string, unknown> = {
  t1: thread('t1', INDEX_ID),
  t2: thread('t2', '7a1f0000-0000-4000-8000-000000000002'),
  unindexed: thread('unindexed', null),
}
const fetchMock = vi.fn(async (url: string) => {
  if (url.endsWith('/labels')) return { ok: true, json: async () => ({ labels: [] }) } as unknown as Response
  const id = url.split('/threads/')[1]
  if (id && THREADS[id]) return { ok: true, json: async () => THREADS[id] } as unknown as Response
  return { ok: false, json: async () => ({}) } as unknown as Response
})

let container: HTMLDivElement
let root: Root
const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))))
async function renderThread(threadId: string) {
  await act(async () => root.render(h(EmailThreadDetail, { key: threadId, threadId })))
  await flush()
  await flush()
}
const section = () => container.querySelector('section[aria-label="Thread agents"]')
const toggle = () => section()?.querySelector<HTMLButtonElement>('button[aria-expanded]') ?? null
const mounted = () => {
  const el = container.querySelector('[data-entity-activity]')
  return el ? JSON.parse(el.getAttribute('data-entity-activity')!) : null
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('EmailThreadDetail — Agents', () => {
  it('a thread that is not indexed has no section', async () => {
    await renderThread('unindexed')
    expect(container.textContent).toContain('Tuesday works.')
    expect(section()).toBeNull()
  })

  it('is closed at first and loads nothing; opened, it is the tab keyed on the thread’s index row', async () => {
    await renderThread('t1')
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
    expect(mounted()).toBeNull()
    await act(async () => toggle()!.click())
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
    expect(mounted()).toEqual({ entityType: 'email_thread', entityId: INDEX_ID })
  })

  it('stays open for the next thread, keyed on that thread; closing closes it for the next one too', async () => {
    await renderThread('t2')
    expect(mounted()).toEqual({ entityType: 'email_thread', entityId: '7a1f0000-0000-4000-8000-000000000002' })
    await act(async () => toggle()!.click())
    expect(mounted()).toBeNull()
    await renderThread('t1')
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('EmailThreadDetail — history loading', () => {
  it('never shows the previous thread when the next history target cannot load', async () => {
    await act(async () => root.render(h(EmailThreadDetail, { threadId: 't1' })))
    await flush()
    expect(container.textContent).toContain('Tuesday works.')
    await act(async () => root.render(h(EmailThreadDetail, { threadId: 'missing' })))
    await flush()
    expect(container.textContent).not.toContain('Tuesday works.')
    expect(container.textContent).toContain('Couldn’t load this email.')
    const requestsBeforeRetry = fetchMock.mock.calls.length
    const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Try again')!
    await act(async () => retry.click())
    await flush()
    expect(fetchMock.mock.calls.length).toBe(requestsBeforeRetry + 1)
    expect(fetchMock).toHaveBeenLastCalledWith('/api/account/email/threads/missing')
  })

  it('ignores an old thread response after a rapid history change', async () => {
    let finishOld!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/threads/slow')
      ? new Promise<Response>((resolve) => { finishOld = resolve })
      : fetchMock(url)))
    await act(async () => root.render(h(EmailThreadDetail, { threadId: 'slow' })))
    await act(async () => root.render(h(EmailThreadDetail, { threadId: 't2' })))
    await flush()
    await act(async () => finishOld({ ok: true, json: async () => ({ ...thread('slow', null), subject: 'Stale response' }) } as Response))
    expect(container.textContent).toContain('Q3 planning')
    expect(container.textContent).not.toContain('Stale response')
  })
})
