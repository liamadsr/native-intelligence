// @vitest-environment jsdom
/**
 * The composer on its own (email-composer.tsx): files, Save draft (threaded),
 * Send later (a reply names its thread and message), Undo send, and Draft
 * with AI (filled from the thread's AI draft, which the send then replaces,
 * or asked of the chat and filled in when it lands). The rich-text field is
 * a textarea here (compose-editor has its own test); fetch is stubbed and
 * nothing is sent anywhere. Made-up people and addresses only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, forwardRef, useImperativeHandle, useRef } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
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
      focus: () => {},
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
// Send later's picker is its own test (send-later.test.tsx): here a button that picks tomorrow.
vi.mock('../send-later-button', () => ({
  SendLaterButton: (p: { onSchedule: (at: Date) => void; disabled?: boolean }) =>
    h('button', { 'data-fake-send-later': '', disabled: p.disabled, onClick: () => p.onSchedule(new Date(Date.now() + 86_400_000)) }, 'Send later'),
}))

import { EmailComposer, type EmailComposerProps } from '../email-composer'
import { clearComposeDraft, readComposeDraft } from '@/lib/email/compose-drafts'

const SOURCE = {
  id: 'm-sam',
  from: { name: 'Sam Rivera', email: 'sam@harborline.example' },
  to: [{ name: 'Jordan Vale', email: 'jordan@northwind.example' }],
  cc: [],
  subject: 'Pilot scope',
  date: '2026-09-09T09:05:00Z',
  bodyHtml: null,
  bodyText: 'Two open questions.',
}
const OWN = new Set(['jordan@northwind.example'])
const KEY = 'thread:thr-1'

const respond = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response

let container: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))))
const $ = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel)
const posted = (url: string) => fetchMock.mock.calls.filter(([u]) => u === url).map(([, init]) => JSON.parse(init.body))

function props(over: Partial<EmailComposerProps> = {}): EmailComposerProps {
  return {
    mode: 'reply',
    source: SOURCE,
    threadId: 'thr-1',
    accountId: 'acct-1',
    ownAddresses: OWN,
    draftKey: KEY,
    onClose: vi.fn(),
    undoMs: 0,
    ...over,
  }
}
async function render(p: EmailComposerProps) {
  await act(async () => root.render(h(EmailComposer, p)))
  await flush()
}
async function type(text: string) {
  const area = $<HTMLTextAreaElement>('[data-fake-editor]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, text)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function attach(name: string, bytes: number, type = 'application/pdf') {
  const input = $<HTMLInputElement>('[data-compose-file-input]')!
  const file = new File([new Uint8Array(bytes).fill(65)], name, { type })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
  // FileReader is async.
  for (let i = 0; i < 5; i++) await flush()
}
const click = (sel: string) => act(async () => $<HTMLButtonElement>(sel)!.click())

beforeEach(() => {
  window.localStorage.clear()
  clearComposeDraft(KEY)
  toast.mockReset()
  toast.success.mockReset()
  toast.error.mockReset()
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/account/email/send') return respond(200, { message_id: 'sent-1', thread_id: 'thr-1' })
    if (url === '/api/account/email/save-draft') return respond(200, { draft_id: 'd-1', thread_id: 'thr-1' })
    if (url === '/api/account/email/scheduled') return respond(200, { scheduled: { id: 's-1', send_at: new Date(Date.now() + 86_400_000).toISOString() } })
    return respond(200, {})
  })
  vi.stubGlobal('fetch', fetchMock)
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

describe('files', () => {
  it('an attached file is a chip, goes with the send, and can be taken off', async () => {
    await render(props())
    await type('Plan attached.')
    await attach('plan.pdf', 12)
    expect($('[data-compose-file="plan.pdf"]')?.textContent).toContain('plan.pdf')
    await click('[data-compose-send]')
    await flush()
    const [body] = posted('/api/account/email/send')
    expect(body.attachments).toEqual([{ name: 'plan.pdf', mime_type: 'application/pdf', content_base64: btoa('A'.repeat(12)) }])
  })

  it('a file over 3 MB is refused before it is read', async () => {
    await render(props())
    await attach('huge.mov', 3 * 1024 * 1024 + 1, 'video/quicktime')
    expect(toast.error).toHaveBeenCalledWith('“huge.mov” is over 3 MB')
    expect($('[data-compose-files]')).toBeNull()
  })

  it('a file alone is enough to send', async () => {
    await render(props())
    await attach('notes.txt', 4, 'text/plain')
    await click('[data-compose-send]')
    await flush()
    expect(posted('/api/account/email/send')).toHaveLength(1)
  })
})

describe('Save draft', () => {
  it('saves a threaded reply draft in the thread’s mailbox, then closes and forgets the local copy', async () => {
    const onSavedToMailbox = vi.fn()
    await render(props({ onSavedToMailbox }))
    await type('Thinking it over.')
    await act(async () => void (await new Promise((r) => setTimeout(r, 450))))
    expect(readComposeDraft(KEY)?.html).toBe('<p>Thinking it over.</p>')
    await click('[data-compose-save]')
    await flush()
    expect(posted('/api/account/email/save-draft')).toEqual([
      expect.objectContaining({
        to: ['sam@harborline.example'],
        subject: 'Re: Pilot scope',
        thread_id: 'thr-1',
        in_reply_to_message_id: 'm-sam',
        account_id: 'acct-1',
      }),
    ])
    expect(toast.success).toHaveBeenCalledWith('Draft saved')
    expect(onSavedToMailbox).toHaveBeenCalled()
    expect(readComposeDraft(KEY)).toBeNull()
  })
})

describe('Send later', () => {
  it('a reply is scheduled from its mailbox, naming its thread and message', async () => {
    const onSavedToMailbox = vi.fn()
    await render(props({ onSavedToMailbox }))
    await type('See you then.')
    await click('[data-fake-send-later]')
    await flush()
    const [body] = posted('/api/account/email/scheduled')
    expect(body).toMatchObject({ account_id: 'acct-1', to: ['sam@harborline.example'], subject: 'Re: Pilot scope', reply_thread_id: 'thr-1', in_reply_to_message_id: 'm-sam' })
    expect(typeof body.send_at).toBe('string')
    expect(posted('/api/account/email/send')).toHaveLength(0)
    expect(onSavedToMailbox).toHaveBeenCalled()
  })
})

describe('Undo send', () => {
  it('Send closes the composer at once and waits; Undo stops it and opens it again', async () => {
    const onSent = vi.fn()
    const onReopen = vi.fn()
    await render(props({ onSent, onReopen, undoMs: 200 }))
    await type('Wait, one more thing')
    await click('[data-compose-send]')
    expect(onSent).toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith('Sending…', expect.objectContaining({ duration: 200, action: expect.objectContaining({ label: 'Undo' }) }))
    const undo = toast.mock.calls[0][1].action.onClick as () => void
    await act(async () => undo())
    expect(onReopen).toHaveBeenCalled()
    await act(async () => void (await new Promise((r) => setTimeout(r, 300))))
    expect(posted('/api/account/email/send')).toHaveLength(0)
    // What was written is still there to open again.
    expect(readComposeDraft(KEY)?.html).toBe('<p>Wait, one more thing</p>')
  })

  it('not undone, it goes when the time is up, and the local copy goes with it', async () => {
    const onDelivered = vi.fn()
    await render(props({ onDelivered, undoMs: 50 }))
    await type('Sending for real')
    await click('[data-compose-send]')
    expect(posted('/api/account/email/send')).toHaveLength(0)
    await act(async () => void (await new Promise((r) => setTimeout(r, 120))))
    await flush()
    expect(posted('/api/account/email/send')).toHaveLength(1)
    expect(onDelivered).toHaveBeenCalled()
    expect(readComposeDraft(KEY)).toBeNull()
  })

  it('a send that fails says why, offers to open it again, and keeps what was written', async () => {
    fetchMock.mockImplementation(async () => respond(500, { error: 'Gmail send error: 500' }))
    const onReopen = vi.fn()
    await render(props({ onReopen }))
    await type('Retry me')
    await click('[data-compose-send]')
    await flush()
    expect(toast.error).toHaveBeenCalledWith('Gmail send error: 500', expect.objectContaining({ action: expect.objectContaining({ label: 'Open' }) }))
    expect(readComposeDraft(KEY)?.html).toBe('<p>Retry me</p>')
  })
})

describe('Draft with AI', () => {
  const AI = { id: 'm-ai', to: [{ email: 'sam@harborline.example' }], cc: [{ email: 'priya@harborline.example' }], subject: 'Re: Pilot scope', bodyHtml: null, bodyText: 'Thursday works for the walkthrough.' }

  it('fills the composer from the thread’s AI draft; the person sends it, replacing that draft', async () => {
    await render(props({ aiDraft: AI }))
    expect($('[data-compose-ai]')?.textContent).toBe('Use AI draft')
    await click('[data-compose-ai]')
    expect($<HTMLTextAreaElement>('[data-fake-editor]')!.value).toBe('Thursday works for the walkthrough.')
    expect($('[data-compose-from-ai]')).not.toBeNull()
    // Nothing goes until the person sends it.
    expect(posted('/api/account/email/send')).toHaveLength(0)
    await click('[data-compose-send]')
    await flush()
    const [body] = posted('/api/account/email/send')
    expect(body).toMatchObject({ to: ['sam@harborline.example'], cc: ['priya@harborline.example'], provider_draft_id: 'm-ai', in_reply_to_message_id: 'm-sam' })
  })

  it('with none on the thread, asks the chat, and fills in what it drafts when it lands', async () => {
    const onRequestAiDraft = vi.fn()
    await render(props({ onRequestAiDraft }))
    await click('[data-compose-ai]')
    expect(onRequestAiDraft).toHaveBeenCalledTimes(1)
    expect($('[data-compose-ai-waiting]')).not.toBeNull()
    await render(props({ onRequestAiDraft, aiDraft: AI }))
    expect($<HTMLTextAreaElement>('[data-fake-editor]')!.value).toBe('Thursday works for the walkthrough.')
    expect($('[data-compose-ai-waiting]')).toBeNull()
  })

  it('no AI on offer without a draft or a chat to ask; never on a forward', async () => {
    await render(props())
    expect($('[data-compose-ai]')).toBeNull()
    await render(props({ mode: 'forward', aiDraft: AI }))
    expect($('[data-compose-ai]')).toBeNull()
  })
})
