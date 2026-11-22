// @vitest-environment jsdom
/**
 * Writing a reply yourself, in the thread. The thread ends in a "Reply…"
 * row; it (and R, A, F, and each message's Reply and Forward) opens the
 * composer under the last message, addressed and subjected from the message
 * it answers. Send posts the reply to the thread's own mailbox, threaded on
 * that message. A draft has no Reply of its own. The REAL pane and composer
 * are mounted; the rich-text field is a plain textarea here (its own test
 * covers the editor); fetch is stubbed and nothing is sent anywhere.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, forwardRef, useImperativeHandle, useRef } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('next/dynamic', () => ({ default: () => () => null }))
// Read aloud has its own test (email-thread-detail-listen); nothing here reads.
vi.mock('@/components/read-aloud/listen-target', () => ({ ListenTarget: () => null }))
vi.mock('@/lib/labels/use-scoped-labels', () => ({
  useScopedLabels: () => ({ labels: [], grouped: [], loading: false }),
}))
vi.mock('../compose-editor', () => ({
  safeLinkHref: (v: string) => v,
  sanitizeComposeHtml: (v: string) => v,
  ComposeEditor: forwardRef(function FakeEditor(props: { initialHtml: string; onChange?: (html: string) => void }, ref) {
    const el = useRef<HTMLTextAreaElement>(null)
    useImperativeHandle(ref, () => ({
      getHTML: () => (el.current?.value ? `<p>${el.current.value}</p>` : '<p></p>'),
      setHTML: (html: string) => {
        if (el.current) el.current.value = html.replace(/<[^>]+>/g, '')
      },
      focus: () => el.current?.focus(),
      toggleBold: () => {},
      toggleItalic: () => {},
      toggleBulletList: () => {},
      toggleOrderedList: () => {},
      setLink: () => {},
      isActive: () => false,
      currentLink: () => '',
    }))
    return h('textarea', {
      ref: el,
      'data-fake-editor': '',
      defaultValue: props.initialHtml.replace(/<[^>]+>/g, ''),
      onChange: (e: { target: { value: string } }) => props.onChange?.(`<p>${e.target.value}</p>`),
    })
  }),
}))

import { EmailThreadDetail, type ThreadKeyActions } from '../email-thread-detail'

const message = (id: string, over: Record<string, unknown>) => ({
  id,
  threadId: 'thr-1',
  to: [{ name: 'Jordan Vale', email: 'jordan@example.com' }],
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
  accountId: 'acct-1',
  mailboxEmail: 'jordan@example.com',
  indexId: null,
  subject: 'Exploratory Meeting',
  messages: [
    message('m-sam', {
      from: { name: 'Sam Rivera', email: 'sam@harborline.example' },
      cc: [{ name: 'Priya Natarajan', email: 'priya@harborline.example' }],
      bodyText: 'Does Tuesday work?',
    }),
    message('m-draft', {
      from: { name: 'Jordan Vale', email: 'jordan@example.com' },
      to: [{ name: null, email: 'sam@harborline.example' }],
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
let fetchMock: ReturnType<typeof vi.fn>
const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))))
async function render(props: Record<string, unknown>) {
  await act(async () => root.render(h(EmailThreadDetail, { ownAddresses: ['jordan@example.com'], ...props } as never)))
  await flush()
  await flush()
}
const $ = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel)
const composer = () => $('[data-email-composer]')
const chips = (sel: string) => [...($(sel)?.querySelectorAll('span') ?? [])].map((s) => s.textContent?.trim()).filter(Boolean)
const sendCalls = () => fetchMock.mock.calls.filter(([url]) => url === '/api/account/email/send')
async function type(text: string) {
  const area = $<HTMLTextAreaElement>('[data-fake-editor]')!
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(area, text)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  window.localStorage.clear()
  toast.success.mockReset()
  toast.error.mockReset()
  fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/labels')) return respond(200, { labels: [] })
    if (url === '/api/account/email/send') return respond(200, { message_id: 'sent-1', thread_id: 'thr-1' })
    if (url.startsWith('/api/account/email/scheduled')) return respond(200, { scheduled: [] })
    return respond(200, THREAD)
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('EmailThreadDetail — writing a reply yourself', () => {
  it('the thread ends in a Reply… row; it opens the composer to the sender, Re: the subject', async () => {
    await render({ threadId: 'thr-1' })
    expect(composer()).toBeNull()
    await act(async () => $<HTMLButtonElement>('[data-reply-row]')!.click())
    expect(composer()?.getAttribute('data-email-composer')).toBe('reply')
    expect(chips('[data-compose-to]')).toEqual(['sam@harborline.example'])
    expect($('[data-compose-cc]')).toBeNull()
    expect($('[data-compose-subject]')?.textContent).toBe('Re: Exploratory Meeting')
    // The row gives way to the composer.
    expect($('[data-reply-row]')).toBeNull()
  })

  it('Send posts the reply from the thread’s mailbox, threaded on the message it answers', async () => {
    const onDraftSent = vi.fn()
    await render({ threadId: 'thr-1', onDraftSent })
    await act(async () => $<HTMLButtonElement>('[data-reply-row]')!.click())
    await type('Tuesday at 10 works.')
    await act(async () => $<HTMLButtonElement>('[data-compose-send]')!.click())
    await flush()
    expect(sendCalls()).toHaveLength(1)
    const body = JSON.parse(sendCalls()[0][1].body)
    expect(body).toMatchObject({
      to: ['sam@harborline.example'],
      subject: 'Re: Exploratory Meeting',
      thread_id: 'thr-1',
      in_reply_to_message_id: 'm-sam',
      account_id: 'acct-1',
    })
    expect(body.cc).toBeUndefined()
    expect(body.body_html).toContain('Tuesday at 10 works.')
    expect(body.body_text).toContain('Tuesday at 10 works.')
    expect(toast.success).toHaveBeenCalledWith('Sent')
    expect(composer()).toBeNull()
  })

  it('an empty message is not sent', async () => {
    await render({ threadId: 'thr-1' })
    await act(async () => $<HTMLButtonElement>('[data-reply-row]')!.click())
    await act(async () => $<HTMLButtonElement>('[data-compose-send]')!.click())
    expect(sendCalls()).toHaveLength(0)
    expect(toast.error).toHaveBeenCalledWith('Write a message first')
  })

  it('a card’s Forward opens the composer to no one, Fwd: the subject; a draft has no Reply or Forward', async () => {
    await render({ threadId: 'thr-1' })
    // The older message is collapsed to one line: open it, then forward it.
    expect(container.querySelectorAll('[data-email-message-collapsed]')).toHaveLength(1)
    await act(async () => $<HTMLButtonElement>('[data-email-message-collapsed]')!.click())
    expect(container.querySelectorAll('[data-message-reply]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-message-forward]')).toHaveLength(1)
    await act(async () => $<HTMLButtonElement>('[data-message-forward]')!.click())
    expect(composer()?.getAttribute('data-email-composer')).toBe('forward')
    expect(chips('[data-compose-to]')).toEqual([])
    expect($<HTMLInputElement>('input[aria-label="Subject"]')?.value).toBe('Fwd: Exploratory Meeting')
    expect($('[data-compose-forwarded]')?.textContent).toContain('Sam Rivera')
  })

  it('R, A and F open the composer as Reply, Reply all (with the Cc) and Forward', async () => {
    const keyActionsRef: { current: ThreadKeyActions | null } = { current: null }
    await render({ threadId: 'thr-1', keyActionsRef })
    await act(async () => keyActionsRef.current!.replyAll())
    expect(composer()?.getAttribute('data-email-composer')).toBe('replyAll')
    // Me (the mailbox's own address) is never on a reply all.
    expect(chips('[data-compose-to]')).toEqual(['sam@harborline.example'])
    expect(chips('[data-compose-cc]')).toEqual(['priya@harborline.example'])
    await act(async () => keyActionsRef.current!.forward())
    expect(composer()?.getAttribute('data-email-composer')).toBe('forward')
    await act(async () => keyActionsRef.current!.reply())
    expect(composer()?.getAttribute('data-email-composer')).toBe('reply')
  })

  it('Esc closes the composer and keeps what was written for next time', async () => {
    await render({ threadId: 'thr-1' })
    await act(async () => $<HTMLButtonElement>('[data-reply-row]')!.click())
    await type('Half a thought')
    await act(async () => {
      $('[data-fake-editor]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(composer()).toBeNull()
    await act(async () => $<HTMLButtonElement>('[data-reply-row]')!.click())
    expect($<HTMLTextAreaElement>('[data-fake-editor]')!.value).toBe('Half a thought')
  })

  it('⌘Enter sends', async () => {
    await render({ threadId: 'thr-1' })
    await act(async () => $<HTMLButtonElement>('[data-reply-row]')!.click())
    await type('On it.')
    await act(async () => {
      $('[data-fake-editor]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
    })
    await flush()
    expect(sendCalls()).toHaveLength(1)
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
