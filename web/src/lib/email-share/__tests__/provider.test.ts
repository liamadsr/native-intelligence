/**
 * The live mailbox reads a share makes (migration 646), against stubbed Gmail
 * and Graph answers: drafts are never frozen, a message must still be the
 * shared thread's, an attachment only by a key its message lists, Graph asked
 * for immutable ids, bodies sanitized. Made-up people and companies.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  firstLine,
  liveSharedAttachment,
  liveSharedMessage,
  liveSharedSummary,
  liveThreadMessageIds,
  parseAddressList,
  ShareProviderBusyError,
  type FetchLike,
} from '../provider'

const GMAIL = { provider: 'google' as const, token: 'tok-g' }
const GRAPH = { provider: 'microsoft' as const, token: 'tok-m' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64url')

function stub(routes: Array<[RegExp, (url: string, init?: RequestInit) => Response]>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fn: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    const hit = routes.find(([re]) => re.test(url))
    return hit ? hit[1](url, init) : json({ error: 'nope' }, 404)
  })
  return { fn, calls }
}

const gmailMessage = (over: Record<string, unknown> = {}) => ({
  id: 'g1',
  threadId: 'gt-1',
  internalDate: '1762786800000',
  labelIds: ['INBOX'],
  snippet: 'Our counter is 12% off list &amp; through March.',
  payload: {
    partId: '',
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'From', value: 'Dana Whitfield <dana@harborline.example>' },
      { name: 'To', value: '"Stone, Avery" <avery@northwind.example>, ops@northwind.example' },
      { name: 'Subject', value: 'Renewal terms' },
    ],
    parts: [
      {
        partId: '0',
        mimeType: 'multipart/alternative',
        parts: [
          { partId: '0.0', mimeType: 'text/plain', body: { data: b64('Our counter is 12% off list.') } },
          { partId: '0.1', mimeType: 'text/html', body: { data: b64('<p onclick="x()">Our counter<script>alert(1)</script></p><a href="javascript:alert(1)">x</a>') } },
        ],
      },
      { partId: '1', mimeType: 'application/pdf', filename: 'terms.pdf', body: { attachmentId: 'ATT-volatile', size: 1200 } },
    ],
  },
  ...over,
})

describe('the thread’s message ids, at share time', () => {
  it('Gmail: oldest first, drafts left out', async () => {
    const { fn } = stub([
      [
        /threads\/gt-1\?format=minimal/,
        () =>
          json({
            messages: [
              { id: 'b', internalDate: '2', labelIds: ['INBOX'] },
              { id: 'a', internalDate: '1', labelIds: ['INBOX'] },
              { id: 'd', internalDate: '3', labelIds: ['DRAFT'] },
            ],
          }),
      ],
    ])
    expect(await liveThreadMessageIds(GMAIL, 'gt-1', fn)).toEqual(['a', 'b'])
  })

  it('Graph: freezes the NEWEST messages, as Gmail does (newest first from Graph, then oldest first)', async () => {
    const { fn, calls } = stub([[/\/me\/messages\?\$filter=/, () => json({ value: [{ id: 'x3' }, { id: 'x2' }, { id: 'x1' }] })]])
    expect(await liveThreadMessageIds(GRAPH, 'conv-1', fn)).toEqual(['x1', 'x2', 'x3'])
    expect(calls[0].url).toContain('$orderby=receivedDateTime desc&$top=100')
  })

  it('Graph: immutable ids, drafts left out; a failed read is null', async () => {
    const { fn, calls } = stub([[/\/me\/messages\?\$filter=/, () => json({ value: [{ id: 'x1', isDraft: false }, { id: 'x2', isDraft: true }] })]])
    expect(await liveThreadMessageIds(GRAPH, "conv'1", fn)).toEqual(['x1'])
    expect(calls[0].headers.Prefer).toBe('IdType="ImmutableId"')
    expect(calls[0].url).toContain(encodeURIComponent("conversationId eq 'conv''1'"))
    expect(await liveThreadMessageIds(GMAIL, 'gone', stub([]).fn)).toBeNull()
  })
})

describe('one shared message', () => {
  it('Gmail: read-only fields, the body sanitized, attachments keyed by part id', async () => {
    const { fn } = stub([[/messages\/g1\?format=full/, () => json(gmailMessage())]])
    const m = await liveSharedMessage(GMAIL, 'g1', 'gt-1', fn)
    expect(m).toMatchObject({
      id: 'g1',
      from: { name: 'Dana Whitfield', email: 'dana@harborline.example' },
      to: [
        { name: 'Stone, Avery', email: 'avery@northwind.example' },
        { name: null, email: 'ops@northwind.example' },
      ],
      subject: 'Renewal terms',
      bodyText: 'Our counter is 12% off list.',
      attachments: [{ key: '1', name: 'terms.pdf', size: 1200, mimeType: 'application/pdf' }],
    })
    expect(m!.bodyHtml).not.toMatch(/script|onclick|javascript:/)
    expect(m!.bodyHtml).toContain('Our counter')
  })

  it('a message no longer in the shared thread (or now a draft) is null', async () => {
    const moved = stub([[/messages\/g1/, () => json(gmailMessage({ threadId: 'gt-other' }))]])
    expect(await liveSharedMessage(GMAIL, 'g1', 'gt-1', moved.fn)).toBeNull()
    const draft = stub([[/messages\/g1/, () => json(gmailMessage({ labelIds: ['DRAFT'] }))]])
    expect(await liveSharedMessage(GMAIL, 'g1', 'gt-1', draft.fn)).toBeNull()
    const graphMoved = stub([[/messages\/x1\?/, () => json({ id: 'x1', conversationId: 'other' })]])
    expect(await liveSharedMessage(GRAPH, 'x1', 'conv-1', graphMoved.fn)).toBeNull()
  })

  it('Graph: the html body sanitized and its text, file attachments only (inline images left out)', async () => {
    const { fn, calls } = stub([
      [
        /messages\/x1\?/,
        () =>
          json({
            id: 'x1',
            conversationId: 'conv-1',
            subject: 'Renewal terms',
            receivedDateTime: '2026-11-10T15:00:00Z',
            from: { emailAddress: { name: 'Dana Whitfield', address: 'dana@harborline.example' } },
            toRecipients: [{ emailAddress: { name: 'Avery Stone', address: 'avery@northwind.example' } }],
            ccRecipients: [],
            body: { contentType: 'html', content: '<div>Counter&nbsp;offer<img src="x" onerror="steal()"></div>' },
            attachments: [
              { id: 'A1', name: 'terms.pdf', size: 1200, contentType: 'application/pdf', isInline: false },
              { id: 'A2', name: 'logo.png', size: 10, contentType: 'image/png', isInline: true },
            ],
          }),
      ],
    ])
    const m = await liveSharedMessage(GRAPH, 'x1', 'conv-1', fn)
    expect(calls[0].headers.Prefer).toBe('IdType="ImmutableId"')
    expect(m!.bodyHtml).not.toContain('onerror')
    expect(m!.bodyText).toBe('Counter offer')
    expect(m!.attachments).toEqual([{ key: 'A1', name: 'terms.pdf', size: 1200, mimeType: 'application/pdf' }])
  })

  it('the card’s summary: subject, sender, first line', async () => {
    const { fn } = stub([[/messages\/g1\?format=metadata/, () => json(gmailMessage())]])
    expect(await liveSharedSummary(GMAIL, 'g1', 'gt-1', fn)).toEqual({
      subject: 'Renewal terms',
      from: 'dana@harborline.example',
      firstLine: 'Our counter is 12% off list & through March.',
    })
    expect(firstLine('\n  first  words \nsecond')).toBe('first words')
  })
})

describe('one attachment', () => {
  it('Gmail: by the part id the read listed, the volatile attachment id looked up fresh', async () => {
    const { fn, calls } = stub([
      [/messages\/g1\?format=full/, () => json(gmailMessage())],
      [/messages\/g1\/attachments\/ATT-volatile/, () => json({ data: Buffer.from('%PDF-1.7').toString('base64url') })],
    ])
    const file = await liveSharedAttachment(GMAIL, 'g1', 'gt-1', '1', fn)
    expect(file).toMatchObject({ name: 'terms.pdf', mimeType: 'application/pdf', size: 8 })
    expect(Buffer.from(file!.body as Uint8Array).toString()).toBe('%PDF-1.7')
    expect(calls).toHaveLength(2)
  })

  it('a forged key (a body part, or none) or a message outside the thread is null, and nothing is fetched', async () => {
    const { fn, calls } = stub([[/messages\/g1\?format=full/, () => json(gmailMessage())]])
    expect(await liveSharedAttachment(GMAIL, 'g1', 'gt-1', '0.1', fn)).toBeNull()
    expect(await liveSharedAttachment(GMAIL, 'g1', 'gt-1', '7', fn)).toBeNull()
    expect(await liveSharedAttachment(GMAIL, 'g1', 'gt-2', '1', fn)).toBeNull()
    expect(calls.every((c) => !c.url.includes('/attachments/'))).toBe(true)
  })

  it('Graph: a file the message lists streams from $value; another id is refused', async () => {
    const graph = stub([
      [/messages\/x1\?\$select=id,conversationId,isDraft&\$expand/, () => json({ id: 'x1', conversationId: 'conv-1', attachments: [{ id: 'A1', name: 'terms.pdf', size: 8, contentType: 'application/pdf' }] })],
      [/attachments\/A1\/\$value/, () => new Response('%PDF-1.7', { status: 200 })],
    ])
    const file = await liveSharedAttachment(GRAPH, 'x1', 'conv-1', 'A1', graph.fn)
    expect(file).toMatchObject({ name: 'terms.pdf', mimeType: 'application/pdf' })
    expect(await new Response(file!.body as ReadableStream).text()).toBe('%PDF-1.7')
    expect(await liveSharedAttachment(GRAPH, 'x1', 'conv-1', 'A9', graph.fn)).toBeNull()
  })
})

describe('not found vs. busy', () => {
  it('404, and Graph’s 400 for an id it can’t read, are null: the mail is gone', async () => {
    expect(await liveSharedMessage(GMAIL, 'g1', 'gt-1', stub([[/./, () => json({}, 404)]]).fn)).toBeNull()
    expect(await liveSharedMessage(GRAPH, 'x1', 'conv-1', stub([[/./, () => json({ error: { code: 'ErrorInvalidIdMalformed' } }, 400)]]).fn)).toBeNull()
    expect(await liveSharedSummary(GRAPH, 'x1', 'conv-1', stub([[/./, () => json({}, 404)]]).fn)).toBeNull()
  })

  it('429, 5xx, a 401 mid-refresh, a network error or a garbled answer throw busy: never "no longer available"', async () => {
    for (const status of [429, 500, 503, 401]) {
      const { fn } = stub([[/./, () => json({}, status)]])
      await expect(liveSharedMessage(GMAIL, 'g1', 'gt-1', fn), String(status)).rejects.toBeInstanceOf(ShareProviderBusyError)
      await expect(liveSharedSummary(GRAPH, 'x1', 'conv-1', fn), String(status)).rejects.toBeInstanceOf(ShareProviderBusyError)
      await expect(liveThreadMessageIds(GRAPH, 'conv-1', fn), String(status)).rejects.toBeInstanceOf(ShareProviderBusyError)
      await expect(liveSharedAttachment(GMAIL, 'g1', 'gt-1', '1', fn), String(status)).rejects.toBeInstanceOf(ShareProviderBusyError)
    }
    const down: FetchLike = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(liveSharedMessage(GMAIL, 'g1', 'gt-1', down)).rejects.toBeInstanceOf(ShareProviderBusyError)
    const garbled = stub([[/./, () => new Response('<html>oops</html>', { status: 200 })]])
    await expect(liveSharedMessage(GMAIL, 'g1', 'gt-1', garbled.fn)).rejects.toBeInstanceOf(ShareProviderBusyError)
  })

  it('the busy error names the provider and status only', async () => {
    const err = await liveSharedMessage(GMAIL, 'g1', 'gt-1', stub([[/./, () => json({ error: 'Renewal terms for dana@harborline.example' }, 503)]]).fn).catch((e) => e)
    expect(err).toBeInstanceOf(ShareProviderBusyError)
    expect(err.message).toBe('google mailbox busy (503)')
  })
})

describe('remote images in a shared body', () => {
  const html = '<p>Hi</p><img src="https://track.example/p.gif" alt="logo"><img src="data:image/png;base64,iVBORw0KGgo=" alt="inline">'
  const withHtml = () => stub([[/messages\/g1\?format=full/, () => json(gmailMessage({ payload: { partId: '', mimeType: 'text/html', headers: [], body: { data: b64(html) } } }))]]).fn

  it('are left out and counted by default, the alt and data: images kept', async () => {
    const m = await liveSharedMessage(GMAIL, 'g1', 'gt-1', withHtml())
    expect(m!.blockedImages).toBe(1)
    expect(m!.bodyHtml).not.toContain('track.example')
    expect(m!.bodyHtml).toContain('alt="logo"')
    expect(m!.bodyHtml).toContain('data:image/png')
  })

  it('come when asked for', async () => {
    const m = await liveSharedMessage(GMAIL, 'g1', 'gt-1', withHtml(), { images: true })
    expect(m!.blockedImages).toBe(0)
    expect(m!.bodyHtml).toContain('https://track.example/p.gif')
  })
})

describe('address lists', () => {
  it('split on commas outside quotes and brackets', () => {
    expect(parseAddressList('"Ruiz, Ana" <ana@contoso.example>, <ben@contoso.example>, carla@contoso.example')).toEqual([
      { name: 'Ruiz, Ana', email: 'ana@contoso.example' },
      { name: null, email: 'ben@contoso.example' },
      { name: null, email: 'carla@contoso.example' },
    ])
  })
})
