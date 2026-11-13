// @vitest-environment jsdom
/**
 * "Make a task" in the thread pane's header: a task titled "Follow up:
 * <subject>" (else the sender), linked 'about' the thread's index row through
 * the one task path (POST /api/account/actions with `about`). A thread that
 * isn't indexed has nothing to link to, so no button. The REAL pane is
 * mounted; fetch is stubbed. Made-up people and companies.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))
vi.mock('next/dynamic', () => ({ default: () => () => null }))
vi.mock('@/components/read-aloud/listen-target', () => ({ ListenTarget: () => null }))
vi.mock('@/lib/labels/use-scoped-labels', () => ({
  useScopedLabels: () => ({ labels: [], grouped: [], loading: false }),
}))

import { EmailThreadDetail } from '../email-thread-detail'

const INDEX_ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const message = (id: string, over: Record<string, unknown>) => ({
  id,
  threadId: 'thr-1',
  to: [{ name: null, email: 'me@fernhill.example' }],
  cc: [],
  subject: 'Contract redlines',
  date: '2026-11-10T15:00:00Z',
  bodyHtml: null,
  bodyText: 'See attached.',
  isUnread: false,
  isStarred: false,
  isDraft: false,
  hasAttachments: false,
  attachments: [],
  from: { name: 'Dana Whitfield', email: 'dana@harborline.example' },
  ...over,
})
const threadWith = (over: Record<string, unknown>) => ({
  threadId: 'thr-1',
  indexId: INDEX_ID,
  subject: 'Contract redlines',
  messages: [message('m-1', {})],
  drafts: [],
  contact: null,
  metadata: { needs_reply: false, auto_classified: null, linked_capture_id: null },
  ...over,
})

const respond = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, clone() { return this } }) as unknown as Response

let container: HTMLDivElement
let root: Root
let thread: Record<string, unknown>
let posts: Array<{ url: string; body: unknown }>
const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))))
async function render() {
  await act(async () => root.render(h(EmailThreadDetail, { threadId: 'thr-1' } as never)))
  await flush()
  await flush()
}
const makeTaskButton = () => container.querySelector<HTMLButtonElement>('button[data-make-task]')

beforeEach(() => {
  posts = []
  thread = threadWith({})
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/account/actions') {
        posts.push({ url, body: JSON.parse(String(init?.body)) })
        return respond(200, { action: { id: 'a-1' } })
      }
      return url.endsWith('/labels') ? respond(200, { labels: [] }) : respond(200, thread)
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
  vi.clearAllMocks()
})

describe('EmailThreadDetail — make a task', () => {
  it('makes "Follow up: <subject>", linked about the thread', async () => {
    await render()
    await act(async () => makeTaskButton()!.click())
    await flush()
    expect(posts).toEqual([
      { url: '/api/account/actions', body: { title: 'Follow up: Contract redlines', about: { type: 'email_thread', id: INDEX_ID } } },
    ])
    expect(toasts.success).toHaveBeenCalledWith('Task made', expect.objectContaining({ description: 'Follow up: Contract redlines' }))
  })

  it('falls back to the sender when the thread has no subject', async () => {
    thread = threadWith({ subject: '', messages: [message('m-1', { subject: '' })] })
    await render()
    await act(async () => makeTaskButton()!.click())
    await flush()
    expect(posts[0].body).toMatchObject({ title: 'Follow up: Dana Whitfield' })
  })

  it('offers nothing on a thread the index does not hold (nothing to link to)', async () => {
    thread = threadWith({ indexId: null })
    await render()
    expect(makeTaskButton()).toBeNull()
  })
})
