// @vitest-environment jsdom
/**
 * The chat's email draft card: what the agent's `create_email_draft` leaves in
 * the user's mailbox, with Send, Edit and discard on it.
 *
 * Send hands the draft to the same endpoint Mail's thread view uses
 * (POST /api/account/email/draft/send, by the draft's thread and draft ids), so
 * the mailbox that holds the thread sends it. The card used to send a fresh
 * copy through /api/account/email/send, which always used the user's first
 * connected account: a draft the agent made in another mailbox (a work inbox,
 * beside a personal one) failed with Gmail's 404 "Requested entity was not
 * found", while Send in Mail worked. Pinned here:
 *  - a draft the tool reported (both ids) is sent through the drafts endpoint,
 *    untouched as it is, and never through the generic send route;
 *  - edits ride along only when there are some (body, subject, Cc, Bcc), and
 *    recipients go as bare addresses;
 *  - a draft the mailbox no longer holds (sent, edited or discarded elsewhere)
 *    is reported, and nothing is sent as a new message in its place;
 *  - with no draft at the mailbox to send, the card still sends what it shows
 *    as a new message;
 *  - the card takes the draft's own thread and subject from the tool's result.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ComponentProps } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { toast } from 'sonner'
import { EmailDraftCard, extractDraftFromToolResult } from '../email-draft-card'

type Draft = ComponentProps<typeof EmailDraftCard>['draft']

const DRAFT: Draft = {
  to: ['boardy@boardy.ai'],
  subject: 'Re: Intro to a product designer who prototypes in code?',
  body: "Hi Boardy,\n\nYes, I'd welcome an intro.\n\nBest,\nLiam",
  draft_id: 'm-draft',
  thread_id: 'thr-1',
  in_reply_to_message_id: 'm-last',
}

interface Call {
  url: string
  body: Record<string, unknown>
}
let calls: Call[] = []
let respond: (url: string) => { status: number; body: unknown }
let container: HTMLDivElement
let root: Root

const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
  const { status, body } = respond(url)
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
})

function render(draft: Draft = DRAFT, onSent?: () => void) {
  act(() => {
    root.render(h(EmailDraftCard, { draft, onSent }))
  })
}

const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement

async function click(el: HTMLElement) {
  await act(async () => {
    el.click()
  })
}

/** Type into a React-controlled field. */
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const urls = () => calls.map((c) => c.url)

beforeEach(() => {
  calls = []
  respond = () => ({ status: 200, body: { thread_id: 'thr-1', message_id: 'm-sent' } })
  fetchMock.mockClear()
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('EmailDraftCard — session replay never records mail', () => {
  it('its root carries ph-no-capture (the subject and body are under it)', () => {
    render()
    const card = container.firstElementChild as HTMLElement
    expect(card.classList.contains('ph-no-capture')).toBe(true)
    expect(card.textContent).toContain(DRAFT.subject)
  })
})

describe('EmailDraftCard — Send on a draft in the mailbox', () => {
  it('sends the draft through the drafts endpoint by its thread and draft ids, as it is, and never through the generic send route', async () => {
    const onSent = vi.fn()
    render(DRAFT, onSent)
    await click(button('Send'))

    expect(calls).toEqual([
      { url: '/api/account/email/draft/send', body: { thread_id: 'thr-1', draft_id: 'm-draft' } },
    ])
    expect(urls()).not.toContain('/api/account/email/send')
    expect(toast.success).toHaveBeenCalledWith('Email sent')
    expect(onSent).toHaveBeenCalledTimes(1)
    // Sent: the badge is up and the actions are gone.
    expect(container.textContent).toContain('Sent')
    expect(button('Send')).toBeUndefined()
  })

  it('an edited body goes along as edits, with the recipients and subject as they are', async () => {
    render()
    await click(button('Edit'))
    await type(container.querySelector('textarea')!, 'Hi Boardy,\n\nYes please.')
    await click(button('Send'))

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/account/email/draft/send')
    expect(calls[0].body).toEqual({
      thread_id: 'thr-1',
      draft_id: 'm-draft',
      edits: {
        to: ['boardy@boardy.ai'],
        cc: [],
        bcc: [],
        subject: DRAFT.subject,
        body: 'Hi Boardy,\n\nYes please.',
      },
    })
  })

  it('an edit survives "Done editing": the edited body is still what is sent', async () => {
    render()
    await click(button('Edit'))
    await type(container.querySelector('textarea')!, 'Hi Boardy,\n\nYes please.')
    await click(button('Done editing'))
    await click(button('Send'))

    expect(calls[0].body.edits).toMatchObject({ body: 'Hi Boardy,\n\nYes please.' })
  })

  it('an edited subject goes along too', async () => {
    render()
    await click(button('Edit'))
    await type(container.querySelector('input')!, 'Re: Intro, yes')
    await click(button('Send'))
    expect(calls[0].body.edits).toMatchObject({ subject: 'Re: Intro, yes', body: DRAFT.body })
  })

  it('a Cc and a Bcc typed into the card go along as edits, as bare addresses', async () => {
    render()
    await click(button('Cc'))
    await click(button('Bcc'))
    const [cc, bcc] = [...container.querySelectorAll('input')]
    await type(cc, 'ops@dial8.ai, Sam Lee <sam@dial8.ai>')
    await type(bcc, 'crm@dial8.ai')
    await click(button('Send'))

    expect(calls[0].body).toEqual({
      thread_id: 'thr-1',
      draft_id: 'm-draft',
      edits: {
        to: ['boardy@boardy.ai'],
        cc: ['ops@dial8.ai', 'sam@dial8.ai'],
        bcc: ['crm@dial8.ai'],
        subject: DRAFT.subject,
        body: DRAFT.body,
      },
    })
  })

  it('a Cc the draft came with, left as it is, is not an edit', async () => {
    render({ ...DRAFT, cc: ['ops@dial8.ai'] })
    await click(button('Send'))
    expect(calls[0].body).toEqual({ thread_id: 'thr-1', draft_id: 'm-draft' })
  })

  it('a Cc the draft came with, then cleared, goes as an empty Cc', async () => {
    render({ ...DRAFT, cc: ['ops@dial8.ai'] })
    await type(container.querySelector('input')!, '')
    await click(button('Send'))
    expect(calls[0].body.edits).toMatchObject({ cc: [] })
  })

  it('a recipient written with a name is sent as its bare address', async () => {
    render({ ...DRAFT, to: ['Boardy <boardy@boardy.ai>'] })
    await click(button('Edit'))
    await type(container.querySelector('textarea')!, 'Yes.')
    await click(button('Send'))
    expect(calls[0].body.edits).toMatchObject({ to: ['boardy@boardy.ai'] })
  })

  it('a mailbox that no longer holds the draft is reported, and no new message is sent in its place', async () => {
    const gone = 'This draft is no longer in your mailbox. It may have been sent, edited or discarded elsewhere.'
    respond = () => ({ status: 404, body: { error: gone } })
    const onSent = vi.fn()
    render(DRAFT, onSent)
    await click(button('Send'))

    expect(toast.error).toHaveBeenCalledWith(gone)
    expect(toast.success).not.toHaveBeenCalled()
    expect(onSent).not.toHaveBeenCalled()
    // One call, to the drafts endpoint: no second try through another route.
    expect(urls()).toEqual(['/api/account/email/draft/send'])
    // Still a draft: Send is back, nothing marks it sent.
    expect(button('Send')).toBeDefined()
    expect(button('Send').disabled).toBe(false)
    expect(container.textContent).not.toContain('Sent')
  })

  it('a failed request is reported without marking the draft sent', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    render()
    await click(button('Send'))
    expect(toast.error).toHaveBeenCalledWith('Failed to send email')
    expect(button('Send')).toBeDefined()
  })

  it('a second click while it sends does not send twice', async () => {
    let release: () => void = () => {}
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, status: 200, json: async () => ({}) } as unknown as Response)
        }),
    )
    render()
    act(() => {
      button('Send').click()
    })
    act(() => {
      button('Send')?.click()
    })
    await act(async () => release())
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('EmailDraftCard — no draft at the mailbox to send', () => {
  it('sends what the card shows as a new message through the generic route, as before', async () => {
    const { draft_id: _draftId, ...noDraft } = DRAFT
    render(noDraft)
    await click(button('Send'))

    expect(urls()).toEqual(['/api/account/email/send'])
    expect(calls[0].body).toMatchObject({
      to: ['boardy@boardy.ai'],
      subject: DRAFT.subject,
      body_text: DRAFT.body,
      thread_id: 'thr-1',
      in_reply_to_message_id: 'm-last',
    })
    expect(String(calls[0].body.body_html)).toContain('Yes, I&#39;d welcome an intro.')
    expect(toast.success).toHaveBeenCalledWith('Email sent')
  })

  it('a Cc the draft came with, then cleared, is not sent', async () => {
    const { draft_id: _draftId, ...noDraft } = DRAFT
    render({ ...noDraft, cc: ['boss@dial8.ai'] })
    await type(container.querySelector('input')!, '')
    await click(button('Send'))
    expect(calls[0].body.cc).toEqual([])
  })

  it('a draft with no thread to name it on is sent the same way', async () => {
    const { thread_id: _threadId, ...noThread } = DRAFT
    render(noThread)
    await click(button('Send'))
    expect(urls()).toEqual(['/api/account/email/send'])
    expect(calls[0].body).toMatchObject({ provider_draft_id: 'm-draft' })
  })
})

describe('EmailDraftCard — discard', () => {
  const discardButton = () => container.querySelector('button.hover\\:text-destructive') as HTMLButtonElement

  it('a refused discard keeps the card and says so', async () => {
    respond = () => ({ status: 500, body: { error: 'Failed to delete draft' } })
    render()
    await click(discardButton())

    expect(urls()).toEqual(['/api/account/email/draft/delete'])
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain(DRAFT.subject)
  })

  it('a draft the mailbox kept is not reported as discarded', async () => {
    respond = () => ({ status: 200, body: { success: true, mailbox_deleted: false } })
    render()
    await click(discardButton())

    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(container.textContent).toBe('')
  })

  it('a discarded draft leaves with a success toast', async () => {
    respond = () => ({ status: 200, body: { success: true, mailbox_deleted: true } })
    render()
    await click(discardButton())

    expect(toast.success).toHaveBeenCalledWith('Draft discarded')
    expect(container.textContent).toBe('')
  })
})

describe('extractDraftFromToolResult', () => {
  const args = {
    to: ['boardy@boardy.ai'],
    subject: 'Intro',
    body: 'Hi',
    thread_id: 'thr-asked-for',
    in_reply_to: 'm-last',
  }

  it("takes the draft's own thread, id and subject from the tool's result", () => {
    expect(
      extractDraftFromToolResult(args, {
        success: true,
        draft_id: 'm-draft',
        thread_id: 'thr-real',
        subject: 'Re: Intro',
      }),
    ).toMatchObject({
      draft_id: 'm-draft',
      thread_id: 'thr-real',
      subject: 'Re: Intro',
      in_reply_to_message_id: 'm-last',
    })
  })

  it('a new email has a thread of its own in the result, though the model named none', () => {
    const { thread_id: _t, ...newEmail } = args
    expect(extractDraftFromToolResult(newEmail, { success: true, draft_id: 'm-new', thread_id: 'm-new' })).toMatchObject({
      draft_id: 'm-new',
      thread_id: 'm-new',
    })
  })

  it('falls back to what the model asked for when the result says nothing', () => {
    expect(extractDraftFromToolResult(args, undefined)).toMatchObject({
      thread_id: 'thr-asked-for',
      subject: 'Intro',
      draft_id: undefined,
    })
    expect(extractDraftFromToolResult(args, { success: false, error: 'No email provider connected.' })).toMatchObject({
      thread_id: 'thr-asked-for',
      draft_id: undefined,
    })
  })

  it('is nothing without recipients', () => {
    expect(extractDraftFromToolResult(undefined, {})).toBeNull()
    expect(extractDraftFromToolResult({ ...args, to: [] }, {})).toBeNull()
    expect(extractDraftFromToolResult({ ...args, to: 'boardy@boardy.ai' }, {})).toBeNull()
  })
})
