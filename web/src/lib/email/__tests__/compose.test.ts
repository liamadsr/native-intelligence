/**
 * The composer's recipients, subjects and send request (src/lib/email/compose.ts).
 * Made-up people and addresses only.
 */
import { describe, expect, it } from 'vitest'
import {
  composeProblem,
  composeRecipients,
  composeSendBody,
  composeStart,
  editorHtmlToEmail,
  editorIsEmpty,
  forwardQuoteHtml,
  forwardSubject,
  noReplyRecipients,
  replySubject,
  type ComposeSource,
} from '../compose'

const ME = new Set(['jordan@example.com', 'jordan@side.example'])
const source = (over: Partial<ComposeSource> = {}): ComposeSource => ({
  id: 'm-1',
  from: { name: 'Sam Rivera', email: 'Sam@Harborline.example' },
  to: [
    { name: 'Jordan Vale', email: 'jordan@example.com' },
    { name: 'Lee Park', email: 'lee@harborline.example' },
  ],
  cc: [
    { name: 'Priya Natarajan', email: 'priya@harborline.example' },
    { name: null, email: 'jordan@side.example' },
  ],
  subject: 'Pilot scope',
  date: '2026-09-09T15:00:00Z',
  bodyHtml: null,
  bodyText: 'Here is the scope.\nThoughts?',
  ...over,
})

describe('subjects', () => {
  it('Re: and Fwd: once', () => {
    expect(replySubject('Pilot scope')).toBe('Re: Pilot scope')
    expect(replySubject('Re: Pilot scope')).toBe('Re: Pilot scope')
    expect(replySubject('RE:Pilot scope')).toBe('RE:Pilot scope')
    expect(replySubject('  ')).toBe('Re:')
    expect(forwardSubject('Pilot scope')).toBe('Fwd: Pilot scope')
    expect(forwardSubject('Fwd: Pilot scope')).toBe('Fwd: Pilot scope')
    expect(forwardSubject('FW: Pilot scope')).toBe('FW: Pilot scope')
    // A reply's subject is forwarded as it is, prefixed.
    expect(forwardSubject('Re: Pilot scope')).toBe('Fwd: Re: Pilot scope')
  })
})

describe('composeRecipients', () => {
  it('Reply: the sender, lowercased', () => {
    expect(composeRecipients('reply', source(), ME)).toEqual({ to: ['sam@harborline.example'], cc: [] })
  })

  it('Reply: the Reply-To when the message names one', () => {
    const s = source({ replyTo: [{ name: 'Support', email: 'help@harborline.example' }] })
    expect(composeRecipients('reply', s, ME).to).toEqual(['help@harborline.example'])
  })

  it('Reply all: the sender and its To, its Cc as Cc, never the person’s own addresses', () => {
    expect(composeRecipients('replyAll', source(), ME)).toEqual({
      to: ['sam@harborline.example', 'lee@harborline.example'],
      cc: ['priya@harborline.example'],
    })
  })

  it('Reply all: someone on both To and Cc is on To only', () => {
    const s = source({ cc: [{ name: null, email: 'lee@harborline.example' }] })
    expect(composeRecipients('replyAll', s, ME)).toEqual({ to: ['sam@harborline.example', 'lee@harborline.example'], cc: [] })
  })

  it('replying to one’s own message goes on to whoever it was sent to', () => {
    const mine = source({ from: { name: 'Jordan Vale', email: 'jordan@example.com' }, to: [{ name: null, email: 'sam@harborline.example' }], cc: [] })
    expect(composeRecipients('reply', mine, ME)).toEqual({ to: ['sam@harborline.example'], cc: [] })
    expect(composeRecipients('replyAll', mine, ME)).toEqual({ to: ['sam@harborline.example'], cc: [] })
  })

  it('a note to oneself replies to oneself', () => {
    const note = source({ from: { name: null, email: 'jordan@example.com' }, to: [{ name: null, email: 'jordan@example.com' }], cc: [] })
    expect(composeRecipients('reply', note, ME).to).toEqual(['jordan@example.com'])
  })

  it('leaves out what is not an address', () => {
    const s = source({ from: { name: 'Undisclosed', email: 'undisclosed-recipients:;' } })
    expect(composeRecipients('reply', s, ME).to).toEqual([])
  })
})

describe('composeStart', () => {
  it('a reply threads on its message; a forward starts with no one; a new email with nothing', () => {
    expect(composeStart('reply', source(), ME)).toMatchObject({ mode: 'reply', subject: 'Re: Pilot scope', inReplyTo: 'm-1' })
    expect(composeStart('forward', source(), ME)).toEqual({ mode: 'forward', to: [], cc: [], bcc: [], subject: 'Fwd: Pilot scope', inReplyTo: null })
    expect(composeStart('new', null, ME)).toEqual({ mode: 'new', to: [], cc: [], bcc: [], subject: '', inReplyTo: null })
  })
})

describe('noReplyRecipients', () => {
  it('names a reply’s addresses that take no replies', () => {
    expect(noReplyRecipients(['noreply@shop.example', 'sam@harborline.example'])).toEqual(['noreply@shop.example'])
  })
})

describe('forwardQuoteHtml', () => {
  it('a Forwarded message header, then the message, its HTML through the sanitizer', () => {
    const html = forwardQuoteHtml(source({ bodyHtml: '<p>Scope <script>x()</script></p>' }), (h) => h.replace(/<script.*?<\/script>/g, ''))
    expect(html).toContain('---------- Forwarded message ---------')
    expect(html).toContain('From: Sam Rivera &lt;Sam@Harborline.example&gt;')
    expect(html).toContain('Subject: Pilot scope')
    expect(html).toContain('To: Jordan Vale &lt;jordan@example.com&gt;, Lee Park &lt;lee@harborline.example&gt;')
    expect(html).toContain('Cc: Priya Natarajan')
    expect(html).toContain('<p>Scope </p>')
    expect(html).not.toContain('script')
  })

  it('a text-only message is escaped, its lines kept', () => {
    const html = forwardQuoteHtml(source({ bodyText: 'a < b\nc' }), (h) => h)
    expect(html).toContain('a &lt; b<br>c')
  })
})

describe('editor HTML', () => {
  it('paragraphs as mail clients write them', () => {
    expect(editorHtmlToEmail('<p>Hi</p><p></p><p><strong>Bold</strong></p>')).toBe(
      '<div style="font-family: sans-serif; line-height: 1.5;"><div>Hi</div><div><br></div><div><strong>Bold</strong></div></div>',
    )
  })

  it('empty is empty paragraphs only', () => {
    expect(editorIsEmpty('<p></p>')).toBe(true)
    expect(editorIsEmpty('<p> </p><p></p>')).toBe(true)
    expect(editorIsEmpty('<p>x</p>')).toBe(false)
  })
})

describe('composeProblem', () => {
  const ok = { to: ['sam@harborline.example'], cc: [], bcc: [], subject: 'Re: x' }
  it('needs a recipient, real addresses, and a subject for a new email', () => {
    expect(composeProblem(ok, 10, 'reply')).toBeNull()
    expect(composeProblem({ ...ok, to: [] }, 10, 'reply')).toBe('Add a recipient')
    // Bcc alone is enough.
    expect(composeProblem({ ...ok, to: [], bcc: ['lee@harborline.example'] }, 10, 'reply')).toBeNull()
    expect(composeProblem({ ...ok, cc: ['not an address'] }, 10, 'reply')).toContain('isn’t an email address')
    expect(composeProblem({ ...ok, subject: '' }, 10, 'new')).toBe('Add a subject')
    expect(composeProblem({ ...ok, to: Array.from({ length: 51 }, (_, i) => `p${i}@harborline.example`) }, 10, 'new')).toContain('At most')
  })
})

describe('composeSendBody', () => {
  const base = {
    to: ['sam@harborline.example'],
    cc: [] as string[],
    bcc: [] as string[],
    subject: 'Re: Pilot scope',
    editorHtml: '<p>Looks good.</p>',
    threadId: 'thr-1',
    inReplyTo: 'm-1',
    accountId: 'acct-1',
  }

  it('a reply threads on its thread and message, from the thread’s mailbox', () => {
    const body = composeSendBody({ ...base, mode: 'reply' })
    expect(body).toMatchObject({
      to: ['sam@harborline.example'],
      subject: 'Re: Pilot scope',
      thread_id: 'thr-1',
      in_reply_to_message_id: 'm-1',
      account_id: 'acct-1',
    })
    expect(body.cc).toBeUndefined()
    expect(body.bcc).toBeUndefined()
    expect(body.body_html).toContain('<div>Looks good.</div>')
    expect(body.body_text.trim()).toBe('Looks good.')
  })

  it('a forward starts its own thread, the message below the note', () => {
    const body = composeSendBody({ ...base, mode: 'forward', subject: 'Fwd: Pilot scope', quoteHtml: '<div class="ni_forward">FWD</div>' })
    expect(body.thread_id).toBeUndefined()
    expect(body.in_reply_to_message_id).toBeUndefined()
    expect(body.body_html.endsWith('<br><div class="ni_forward">FWD</div>')).toBe(true)
  })

  it('Cc and Bcc go when given; a draft it replaces is named', () => {
    const body = composeSendBody({ ...base, mode: 'replyAll', cc: ['priya@harborline.example'], bcc: ['lee@harborline.example'], replacesDraftId: 'd-1' })
    expect(body.cc).toEqual(['priya@harborline.example'])
    expect(body.bcc).toEqual(['lee@harborline.example'])
    expect(body.provider_draft_id).toBe('d-1')
  })
})
