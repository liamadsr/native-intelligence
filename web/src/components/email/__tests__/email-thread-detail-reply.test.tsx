// @vitest-environment jsdom
/**
 * Reply with the assistant from the thread pane. Reply All in the header asks
 * for a reply to everyone on the thread; a message's own Reply asks for a
 * reply to that message, by its id and its sender's address. Each hands the
 * request up (the tab fires the chat handoff, src/lib/email/reply-in-chat.ts).
 * A draft has no Reply of its own, and without a chat to hand to there is no
 * Reply All. The REAL pane is mounted; fetch is stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('next/dynamic', () => ({ default: () => () => null }))
// Read aloud has its own test (email-thread-detail-listen); nothing here reads.
vi.mock('@/components/read-aloud/listen-target', () => ({ ListenTarget: () => null }))
vi.mock('@/lib/labels/use-scoped-labels', () => ({
  useScopedLabels: () => ({ labels: [], grouped: [], loading: false }),
}))

import { EmailThreadDetail } from '../email-thread-detail'

const message = (id: string, over: Record<string, unknown>) => ({
  id,
  threadId: 'thr-1',
  to: [{ name: null, email: 'liam@dial8.ai' }],
  cc: [],
  subject: 'Exploratory Meeting',
  date: '2026-09-24T05:02:00Z',
  bodyHtml: null,
  isUnread: false,
  isStarred: false,
  isDraft: false,
  hasAttachments: false,
  attachments: [],
  ...over,
})
const THREAD = {
  threadId: 'thr-1',
  indexId: null,
  subject: 'Exploratory Meeting',
  messages: [
    message('m-simon', { from: { name: 'Simon Åkerlund', email: 'simon@harborline.io' }, bodyText: 'Does Tuesday work?' }),
    message('m-draft', {
      from: { name: 'Liam Alizadeh', email: 'liam@dial8.ai' },
      to: [{ name: null, email: 'simon@harborline.io' }],
      bodyText: 'Tuesday works.',
      isDraft: true,
    }),
  ],
  drafts: [],
  contact: null,
  metadata: { needs_reply: false, auto_classified: null, linked_capture_id: null },
}

const respond = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response

let container: HTMLDivElement
let root: Root
const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))))
async function render(props: Record<string, unknown>) {
  await act(async () => root.render(h(EmailThreadDetail, props as never)))
  await flush()
  await flush()
}
const replyAll = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Reply All') ?? null
const messageReplies = () => [...container.querySelectorAll<HTMLButtonElement>('button[title="Reply with AI"]')]

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => (url.endsWith('/labels') ? respond(200, { labels: [] }) : respond(200, THREAD))),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('EmailThreadDetail — reply with the assistant', () => {
  it('Reply All asks for a reply to everyone on the thread', async () => {
    const onReplyRequest = vi.fn()
    await render({ threadId: 'thr-1', onReplyRequest })
    await act(async () => replyAll()!.click())
    expect(onReplyRequest).toHaveBeenCalledTimes(1)
    expect(onReplyRequest).toHaveBeenCalledWith({ threadId: 'thr-1' })
  })

  it('a message’s Reply asks for a reply to that message, by its id and its sender’s address; a draft has none', async () => {
    const onReplyRequest = vi.fn()
    await render({ threadId: 'thr-1', onReplyRequest })
    expect(messageReplies()).toHaveLength(1)
    await act(async () => messageReplies()[0].click())
    expect(onReplyRequest).toHaveBeenCalledWith({
      threadId: 'thr-1',
      message: { id: 'm-simon', fromEmail: 'simon@harborline.io' },
    })
  })

  it('without a chat to hand to, there is no Reply at all', async () => {
    await render({ threadId: 'thr-1' })
    expect(replyAll()).toBeNull()
    expect(messageReplies()).toHaveLength(0)
  })
})

describe('EmailThreadDetail — session replay never records mail', () => {
  it('its root carries ph-no-capture, so subjects, bodies and drafts are under it (it also renders alone, in the contact panel)', async () => {
    await render({ threadId: 'thr-1' })
    const root = container.firstElementChild as HTMLElement
    expect(root.classList.contains('ph-no-capture')).toBe(true)
    for (const text of ['Exploratory Meeting', 'Does Tuesday work?', 'Tuesday works.']) {
      const node = [...container.querySelectorAll<HTMLElement>('*')].find((el) => el.children.length === 0 && el.textContent?.includes(text))
      expect(node, text).toBeDefined()
      expect(node!.closest('.ph-no-capture')).toBe(root)
    }
  })
})
