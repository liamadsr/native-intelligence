// @vitest-environment jsdom
/**
 * Send later on a draft in the thread pane, beside its Send: the draft is
 * scheduled by its thread and message id (what the pane shows as its
 * recipients and subject goes along for the Scheduled folder), and the toast
 * says when. The REAL pane; fetch stubbed. Made-up people and companies.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))
vi.mock('next/dynamic', () => ({ default: () => () => null }))
vi.mock('@/components/read-aloud/listen-target', () => ({ ListenTarget: () => null }))
vi.mock('@/lib/labels/use-scoped-labels', () => ({ useScopedLabels: () => ({ labels: [], grouped: [], loading: false }) }))

import { EmailThreadDetail } from '../email-thread-detail'

const message = (id: string, over: Record<string, unknown>) => ({
  id,
  threadId: 'thr-1',
  to: [{ name: null, email: 'dana@harborline.example' }],
  cc: [],
  subject: 'Re: Q4 renewal',
  date: '2026-11-10T15:00:00Z',
  bodyHtml: null,
  bodyText: 'Tuesday works.',
  isUnread: false,
  isStarred: false,
  isDraft: false,
  hasAttachments: false,
  attachments: [],
  from: { name: 'Dana Whitfield', email: 'dana@harborline.example' },
  ...over,
})
const THREAD = {
  threadId: 'thr-1',
  indexId: null,
  subject: 'Re: Q4 renewal',
  messages: [message('m-dana', {}), message('m-draft', { isDraft: true, from: { name: 'Me', email: 'me@fernhill.example' } })],
  drafts: [],
  contact: null,
  metadata: { needs_reply: false, auto_classified: null, linked_capture_id: null },
}

let container: HTMLDivElement
let root: Root
let posts: Array<Record<string, unknown>>
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))))

beforeEach(() => {
  posts = []
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/account/email/scheduled') {
        const body = JSON.parse(String(init?.body))
        posts.push(body)
        return new Response(JSON.stringify({ scheduled: { id: 'sched-1', send_at: body.send_at, status: 'scheduled' } }))
      }
      return new Response(JSON.stringify(url.endsWith('/labels') ? { labels: [] } : THREAD))
    }),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('EmailThreadDetail — Send later on a draft', () => {
  it('schedules the draft by its thread and message id, with what the pane shows, and says when', async () => {
    await act(async () => root.render(h(EmailThreadDetail, { threadId: 'thr-1' } as never)))
    await flush()
    await flush()
    const buttons = document.body.querySelectorAll<HTMLButtonElement>('[data-send-later]')
    expect(buttons).toHaveLength(1)
    await act(async () => buttons[0].click())
    await flush()
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-send-later-preset="tomorrow"]')!.click())
    await flush()
    expect(posts).toEqual([
      expect.objectContaining({ thread_id: 'thr-1', draft_id: 'm-draft', shown: { to: ['dana@harborline.example'], subject: 'Re: Q4 renewal' } }),
    ])
    expect(posts[0]).not.toHaveProperty('edits')
    expect(toasts.success).toHaveBeenCalledWith(expect.stringMatching(/^Scheduled for Tomorrow, 8:00 AM$/), expect.anything())
  })
})
