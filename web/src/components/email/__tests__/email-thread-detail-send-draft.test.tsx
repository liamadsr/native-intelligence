// @vitest-environment jsdom
/**
 * Sending a draft from the thread pane: an agent's reply (or any draft) sits in
 * the thread as a message the provider marks a draft. The pane marks it, opens
 * it, and puts Send on it (and only on it; a draft is not replied to). Send
 * posts it by its message id and thread, shows it sending (one send, however
 * many clicks), then says so, tells the parent, and reloads the thread, where
 * it is now a sent message. A draft that left the mailbox says so and reloads;
 * a failed send keeps the draft to try again. A send that settles after the
 * user moved to another thread never puts the old thread back on screen.
 * Edit opens the draft in an editor (recipients, subject, text) to change
 * before sending; Send there posts the edits, Cancel leaves the draft as it
 * was, and a failed send keeps the edits. A draft carrying files has no Edit.
 * Discard asks first, then deletes the draft by its message id and thread: the
 * pane shows the thread without it, or, when the draft was all there was, the
 * parent closes it. One draft action at a time: a draft being sent can't be
 * discarded. The REAL pane is mounted; fetch and the toasts are stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))
vi.mock('next/dynamic', () => ({ default: () => () => null }))
// Read aloud has its own test (email-thread-detail-listen); nothing here reads.
vi.mock('@/components/read-aloud/listen-target', () => ({ ListenTarget: () => null }))
vi.mock('@/lib/labels/use-scoped-labels', () => ({
  useScopedLabels: () => ({ labels: [], grouped: [], loading: false }),
}))

import { EmailThreadDetail } from '../email-thread-detail'

const message = (id: string, threadId: string, over: Record<string, unknown>) => ({
  id,
  threadId,
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
const thread = (threadId: string, messages: unknown[]) => ({
  threadId,
  indexId: null,
  subject: 'Exploratory Meeting',
  messages,
  drafts: [],
  contact: null,
  metadata: { needs_reply: false, auto_classified: null, linked_capture_id: null },
})
const simon = message('m-simon', 'thr-1', {
  from: { name: 'Simon Åkerlund', email: 'simon@harborline.io' },
  bodyText: 'Sorry, 11 am does not work any more.',
})
const reply = (id: string, isDraft: boolean) =>
  message(id, 'thr-1', {
    from: { name: 'Liam Alizadeh', email: 'liam@dial8.ai' },
    to: [{ name: null, email: 'simon@harborline.io' }],
    bodyText: 'No worries at all. Let’s target next week instead.',
    isDraft,
  })

let THREADS: Record<string, unknown>
let gets: string[]
let posts: Array<{ url: string; body: unknown }>
let answerSend: ((status: number, body?: unknown) => void) | null
const respond = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response
const fetchMock = vi.fn((url: string, init?: RequestInit) => {
  if (init?.method === 'POST') {
    posts.push({ url, body: JSON.parse(String(init.body)) })
    return new Promise<Response>((resolve) => {
      answerSend = (status, body = {}) => resolve(respond(status, body))
    })
  }
  gets.push(url)
  if (url.endsWith('/labels')) return Promise.resolve(respond(200, { labels: [] }))
  const id = url.split('/threads/')[1]
  return Promise.resolve(THREADS[id] ? respond(200, THREADS[id]) : respond(404, {}))
})

let container: HTMLDivElement
let root: Root
const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))))
async function render(props: Record<string, unknown>) {
  await act(async () => root.render(h(EmailThreadDetail, props as never)))
  await flush()
  await flush()
}
const buttons = (text: string) =>
  [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === text)
const sendButton = () => buttons('Send')[0] ?? buttons('Sending…')[0] ?? null
const draftPills = () => [...container.querySelectorAll('span')].filter((s) => s.textContent === 'Draft')
const threadLoads = (id: string) => gets.filter((u) => u === `/api/account/email/threads/${id}`).length
async function answer(status: number, body?: unknown) {
  await act(async () => answerSend!(status, body))
  await flush()
  await flush()
}
const subjectField = () => container.querySelector<HTMLInputElement>('input[aria-label="Subject"]')
const messageField = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')
/** The To field's input, then the Cc field's (once shown). */
const recipientFields = () => [...container.querySelectorAll<HTMLInputElement>('input:not([aria-label])')]
/** The addresses in the recipient fields, as chips. */
const chips = () =>
  [...container.querySelectorAll('span')].filter((s) => s.querySelector('button') && s.textContent?.includes('@'))
async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function pressEnter(field: HTMLElement, mods: KeyboardEventInit = {}) {
  await act(async () => void field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...mods })))
}
async function click(button: HTMLElement) {
  await act(async () => button.click())
}

beforeEach(() => {
  THREADS = {
    'thr-1': thread('thr-1', [simon, reply('m-draft', true)]),
    'thr-2': thread('thr-2', [message('m-other', 'thr-2', { from: { name: 'Ada', email: 'ada@x.com' }, bodyText: 'Another thread.' })]),
  }
  gets = []
  posts = []
  answerSend = null
  toasts.success.mockClear()
  toasts.error.mockClear()
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

describe('EmailThreadDetail — send a draft', () => {
  it('marks the draft, opens it, and puts Send on it alone; a draft is not replied to', async () => {
    await render({ threadId: 'thr-1', onReplyRequest: () => {} })
    expect(draftPills()).toHaveLength(1)
    expect(buttons('Send')).toHaveLength(1)
    expect(container.textContent).toContain('Let’s target next week instead.')
    // Simon's message keeps its reply button; the draft has none.
    expect(container.querySelectorAll('button[title="Reply with AI"]')).toHaveLength(1)
  })

  it('a thread with no draft has no Send', async () => {
    THREADS['thr-1'] = thread('thr-1', [simon, reply('m-sent', false)])
    await render({ threadId: 'thr-1' })
    expect(draftPills()).toHaveLength(0)
    expect(sendButton()).toBeNull()
  })

  it('sends the draft by its message id and thread, shows it sending, then says so and shows it sent', async () => {
    const onDraftSent = vi.fn()
    await render({ threadId: 'thr-1', onDraftSent })
    await act(async () => sendButton()!.click())
    expect(posts).toEqual([{ url: '/api/account/email/draft/send', body: { thread_id: 'thr-1', draft_id: 'm-draft' } }])
    expect(sendButton()!.textContent).toBe('Sending…')
    expect(sendButton()!.disabled).toBe(true)

    THREADS['thr-1'] = thread('thr-1', [simon, reply('m-sent', false)])
    const loadsBefore = threadLoads('thr-1')
    await answer(200, { thread_id: 'thr-1', message_id: 'm-sent' })
    expect(toasts.success).toHaveBeenCalledWith('Email sent')
    expect(onDraftSent).toHaveBeenCalledWith('thr-1')
    expect(threadLoads('thr-1')).toBe(loadsBefore + 1)
    expect(draftPills()).toHaveLength(0)
    expect(sendButton()).toBeNull()
    expect(container.textContent).toContain('Let’s target next week instead.')
  })

  it('a second click while it is sending sends nothing more', async () => {
    await render({ threadId: 'thr-1' })
    const send = sendButton()!
    await act(async () => {
      send.click()
      send.click()
    })
    expect(posts).toHaveLength(1)
    await answer(200)
  })

  it('a draft that left the mailbox says why and shows the thread as it is now; the parent is not told it was sent', async () => {
    const onDraftSent = vi.fn()
    await render({ threadId: 'thr-1', onDraftSent })
    await act(async () => sendButton()!.click())
    THREADS['thr-1'] = thread('thr-1', [simon])
    await answer(404, { error: 'This draft is no longer in your mailbox.' })
    expect(toasts.error).toHaveBeenCalledWith('This draft is no longer in your mailbox.')
    expect(onDraftSent).not.toHaveBeenCalled()
    expect(sendButton()).toBeNull()
  })

  it('a failed send keeps the draft on screen to try again', async () => {
    const onDraftSent = vi.fn()
    await render({ threadId: 'thr-1', onDraftSent })
    await act(async () => sendButton()!.click())
    const loadsBefore = threadLoads('thr-1')
    await answer(500, { error: 'Could not send the email' })
    expect(toasts.error).toHaveBeenCalledWith('Could not send the email')
    expect(onDraftSent).not.toHaveBeenCalled()
    expect(threadLoads('thr-1')).toBe(loadsBefore)
    expect(sendButton()!.textContent).toBe('Send')
    expect(sendButton()!.disabled).toBe(false)
  })

  it('a send that settles after the user moved on never puts the old thread back on screen', async () => {
    const onDraftSent = vi.fn()
    await render({ threadId: 'thr-1', onDraftSent })
    await act(async () => sendButton()!.click())
    await render({ threadId: 'thr-2', onDraftSent })
    expect(container.textContent).toContain('Another thread.')
    const loadsBefore = threadLoads('thr-1')
    await answer(200)
    expect(onDraftSent).toHaveBeenCalledWith('thr-1')
    expect(threadLoads('thr-1')).toBe(loadsBefore)
    expect(container.textContent).toContain('Another thread.')
    expect(container.textContent).not.toContain('Let’s target next week instead.')
  })
})

describe('EmailThreadDetail — edit a draft before sending', () => {
  const DRAFT_TEXT = 'No worries at all. Let’s target next week instead.'

  it('Edit opens the draft as it is; Cancel leaves it as it was, and the next Edit starts from the draft again', async () => {
    await render({ threadId: 'thr-1' })
    await click(buttons('Edit')[0])
    expect(chips().map((c) => c.textContent)).toEqual(['simon@harborline.io'])
    expect(subjectField()!.value).toBe('Exploratory Meeting')
    expect(messageField()!.value).toBe(DRAFT_TEXT)
    expect(buttons('Edit')).toHaveLength(0)

    await type(messageField()!, 'Something else entirely.')
    // The draft's header doesn't fold the editor away mid-edit.
    const draftHeader = [...container.querySelectorAll<HTMLElement>('.cursor-pointer')].find((el) => el.textContent?.includes('Draft'))!
    await click(draftHeader)
    expect(messageField()!.value).toBe('Something else entirely.')

    await click(buttons('Cancel')[0])
    expect(messageField()).toBeNull()
    expect(container.textContent).toContain(DRAFT_TEXT)
    expect(posts).toEqual([])
    await click(buttons('Edit')[0])
    expect(messageField()!.value).toBe(DRAFT_TEXT)
  })

  it('Send posts the edits with the draft, and the thread then shows the email sent', async () => {
    const onDraftSent = vi.fn()
    await render({ threadId: 'thr-1', onDraftSent })
    await click(buttons('Edit')[0])
    await type(subjectField()!, 'Re: Next week')
    await type(messageField()!, 'Hi Simon,\n\nTuesday at 2 pm works.')
    await click(buttons('Cc')[0])
    await type(recipientFields()[1], 'ops@harborline.io')
    await pressEnter(recipientFields()[1])
    expect(chips().map((c) => c.textContent)).toEqual(['simon@harborline.io', 'ops@harborline.io'])

    await click(sendButton()!)
    expect(posts).toEqual([
      {
        url: '/api/account/email/draft/send',
        body: {
          thread_id: 'thr-1',
          draft_id: 'm-draft',
          edits: { to: ['simon@harborline.io'], cc: ['ops@harborline.io'], subject: 'Re: Next week', body: 'Hi Simon,\n\nTuesday at 2 pm works.' },
        },
      },
    ])
    expect(sendButton()!.textContent).toBe('Sending…')
    expect(sendButton()!.disabled).toBe(true)
    expect(buttons('Cancel')[0].disabled).toBe(true)

    THREADS['thr-1'] = thread('thr-1', [simon, { ...reply('m-sent', false), bodyText: 'Hi Simon,\n\nTuesday at 2 pm works.' }])
    await answer(200, { thread_id: 'thr-1', message_id: 'm-sent' })
    expect(toasts.success).toHaveBeenCalledWith('Email sent')
    expect(onDraftSent).toHaveBeenCalledWith('thr-1')
    expect(messageField()).toBeNull()
    expect(draftPills()).toHaveLength(0)
    expect(container.textContent).toContain('Tuesday at 2 pm works.')
  })

  it('a failed send keeps the editor and the edits, to send again', async () => {
    await render({ threadId: 'thr-1' })
    await click(buttons('Edit')[0])
    await type(messageField()!, 'Edited, and kept.')
    await click(sendButton()!)
    await answer(500, { error: 'Could not send the email' })
    expect(toasts.error).toHaveBeenCalledWith('Could not send the email')
    expect(messageField()!.value).toBe('Edited, and kept.')
    expect(sendButton()!.disabled).toBe(false)

    await click(sendButton()!)
    expect(posts).toHaveLength(2)
    expect((posts[1].body as { edits: { body: string } }).edits.body).toBe('Edited, and kept.')
    await answer(200)
  })

  it('Cmd or Ctrl+Enter in the message sends; in a recipient field Enter adds the address and sends nothing', async () => {
    await render({ threadId: 'thr-1' })
    await click(buttons('Edit')[0])
    await type(recipientFields()[0], 'ada@harborline.io')
    await pressEnter(recipientFields()[0], { metaKey: true })
    expect(chips().map((c) => c.textContent)).toEqual(['simon@harborline.io', 'ada@harborline.io'])
    expect(posts).toEqual([])

    await pressEnter(messageField()!, { ctrlKey: true })
    expect(posts).toHaveLength(1)
    expect((posts[0].body as { edits: { to: string[] } }).edits.to).toEqual(['simon@harborline.io', 'ada@harborline.io'])
    await answer(200)
  })

  it('Send is off without a recipient, and names an address it can’t send to', async () => {
    THREADS['thr-1'] = thread('thr-1', [simon, { ...reply('m-draft', true), to: [{ name: null, email: 'simon@harborline' }] }])
    await render({ threadId: 'thr-1' })
    await click(buttons('Edit')[0])
    expect(container.textContent).toContain('Check this address: simon@harborline')
    expect(sendButton()!.disabled).toBe(true)
    await pressEnter(messageField()!, { metaKey: true })
    expect(posts).toEqual([])

    await click(chips()[0].querySelector('button')!)
    expect(container.textContent).not.toContain('Check this address')
    expect(sendButton()!.disabled).toBe(true)

    await type(recipientFields()[0], 'simon@harborline.io')
    await pressEnter(recipientFields()[0])
    expect(sendButton()!.disabled).toBe(false)
  })

  it('a draft carrying files is sent as it is: it has Send and no Edit', async () => {
    THREADS['thr-1'] = thread('thr-1', [
      simon,
      { ...reply('m-draft', true), hasAttachments: true, attachments: [{ name: 'deck.pdf', size: 2048, mimeType: 'application/pdf' }] },
    ])
    await render({ threadId: 'thr-1' })
    expect(buttons('Send')).toHaveLength(1)
    expect(buttons('Edit')).toHaveLength(0)
  })

  it('an HTML draft starts from its text, and says so when its formatting would be lost', async () => {
    THREADS['thr-1'] = thread('thr-1', [
      simon,
      { ...reply('m-draft', true), bodyText: null, bodyHtml: '<div>Hi Simon,</div><div><br></div><div><b>Tuesday</b> works.</div>' },
    ])
    await render({ threadId: 'thr-1' })
    await click(buttons('Edit')[0])
    expect(messageField()!.value).toBe('Hi Simon,\n\nTuesday works.')
    expect(container.textContent).toContain('Sent as plain text')
  })
})

describe('EmailThreadDetail — discard a draft', () => {
  const DRAFT_TEXT = 'No worries at all. Let’s target next week instead.'
  const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')
  const dialogButton = (text: string) =>
    [...(dialog()?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === text) ?? null
  const discardButton = () => buttons('Discard')[0] ?? buttons('Discarding…')[0] ?? null
  async function discardConfirmed() {
    await click(discardButton()!)
    await click(dialogButton('Discard')!)
  }

  it('asks first; Cancel leaves the draft as it is', async () => {
    await render({ threadId: 'thr-1' })
    await click(discardButton()!)
    expect(dialog()!.textContent).toContain('Discard this draft?')
    expect(dialog()!.textContent).toContain("It's deleted from your mailbox and can't be sent.")
    await click(dialogButton('Cancel')!)
    expect(dialog()).toBeNull()
    expect(posts).toEqual([])
    expect(draftPills()).toHaveLength(1)
  })

  it('confirmed, it discards the draft by its message id and thread, then shows the thread without it', async () => {
    const onDraftDiscarded = vi.fn()
    await render({ threadId: 'thr-1', onDraftDiscarded })
    await discardConfirmed()
    expect(posts).toEqual([{ url: '/api/account/email/draft/discard', body: { thread_id: 'thr-1', draft_id: 'm-draft' } }])
    expect(discardButton()!.textContent).toBe('Discarding…')
    expect(discardButton()!.disabled).toBe(true)
    expect(sendButton()!.disabled).toBe(true)

    THREADS['thr-1'] = thread('thr-1', [simon])
    const loadsBefore = threadLoads('thr-1')
    await answer(200, { thread_id: 'thr-1', thread_remains: true })
    expect(toasts.success).toHaveBeenCalledWith('Draft discarded')
    expect(onDraftDiscarded).toHaveBeenCalledWith('thr-1', true)
    expect(threadLoads('thr-1')).toBe(loadsBefore + 1)
    expect(draftPills()).toHaveLength(0)
    expect(container.textContent).not.toContain(DRAFT_TEXT)
  })

  it('a thread that was nothing but the draft: the parent is told, and the pane does not load it again', async () => {
    const onDraftDiscarded = vi.fn()
    await render({ threadId: 'thr-1', onDraftDiscarded })
    await discardConfirmed()
    const loadsBefore = threadLoads('thr-1')
    await answer(200, { thread_id: 'thr-1', thread_remains: false })
    expect(onDraftDiscarded).toHaveBeenCalledWith('thr-1', false)
    expect(threadLoads('thr-1')).toBe(loadsBefore)
  })

  it('a draft that left the mailbox says why and shows the thread as it is now; the parent is not told', async () => {
    const onDraftDiscarded = vi.fn()
    await render({ threadId: 'thr-1', onDraftDiscarded })
    await discardConfirmed()
    THREADS['thr-1'] = thread('thr-1', [simon])
    await answer(404, { error: 'This draft is no longer in your mailbox.' })
    expect(toasts.error).toHaveBeenCalledWith('This draft is no longer in your mailbox.')
    expect(onDraftDiscarded).not.toHaveBeenCalled()
    expect(draftPills()).toHaveLength(0)
  })

  it('a failed discard keeps the draft to try again', async () => {
    await render({ threadId: 'thr-1' })
    await discardConfirmed()
    const loadsBefore = threadLoads('thr-1')
    await answer(500, { error: 'Could not discard the draft' })
    expect(toasts.error).toHaveBeenCalledWith('Could not discard the draft')
    expect(threadLoads('thr-1')).toBe(loadsBefore)
    expect(draftPills()).toHaveLength(1)
    expect(discardButton()!.textContent).toBe('Discard')
    expect(discardButton()!.disabled).toBe(false)
  })

  it('one draft action at a time: a draft being sent can’t be discarded', async () => {
    await render({ threadId: 'thr-1' })
    await click(sendButton()!)
    expect(discardButton()!.disabled).toBe(true)
    await answer(200)
  })

  it('a discard confirmed from a dialog opened before a send began changes nothing more', async () => {
    await render({ threadId: 'thr-1' })
    await click(discardButton()!)
    await click(sendButton()!)
    await click(dialogButton('Discard')!)
    expect(posts.map((p) => p.url)).toEqual(['/api/account/email/draft/send'])
    await answer(200)
  })
})

describe('opening on a draft (a For you draft card, "Review draft": focusDraftId)', () => {
  it('scrolls the draft into view and rings it, once; a message that is no draft is never the target', async () => {
    const scrolled: string[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.getAttribute('data-email-message-id') ?? '')
    }
    try {
      await render({ threadId: 'thr-1', focusDraftId: 'm-draft' })
      expect(scrolled).toEqual(['m-draft'])
      expect(container.querySelector('[data-email-message-id="m-draft"]')!.className).toContain('ring-2')
      expect(container.querySelector('[data-email-message-id="m-simon"]')!.className).not.toContain('ring-2')
      scrolled.length = 0
      await render({ threadId: 'thr-1', focusDraftId: 'm-simon' })
      expect(scrolled).toEqual([])
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })
})
