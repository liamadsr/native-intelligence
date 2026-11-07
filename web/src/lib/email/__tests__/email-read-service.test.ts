/**
 * readEmailThread: a thread as the model reads it (read_email, and the chat's
 * email reply context). Always live, from the thread's own mailbox: Dial8
 * keeps no copy of mail. What a reply needs from it on every path: each message's Cc (a reply
 * to all includes them) and whether it is an unsent draft (never the message a
 * reply answers), and the participants drawn from From, To and Cc. Provider
 * ids go into URLs encoded: Graph conversation ids carry + and /.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const state = vi.hoisted(() => ({
  local: [] as Array<Record<string, unknown>>,
  filters: [] as Array<[string, unknown]>,
  selections: [] as string[],
  tokens: {} as Record<string, { token: string } | null>,
  mailboxCalls: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {}
      chain.select = (columns: string) => { state.selections.push(columns); return chain }
      chain.eq = (col: string, val: unknown) => {
        state.filters.push([col, val])
        return chain
      }
      chain.order = async () => ({ data: state.local, error: null })
      chain.single = async () => ({ data: state.local[0] || null, error: null })
      return chain
    },
  }),
}))
vi.mock('../thread-mailbox', () => ({
  mailboxesForThread: async function* (_userId: string, _threadId: string, opts: Record<string, unknown>) {
    state.mailboxCalls.push(opts)
    for (const provider of ['google', 'microsoft'] as const) {
      const t = state.tokens[provider]
      if (t) yield { provider, token: t.token, email: null, accountId: null }
    }
  },
}))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidToken: async (_userId: string, provider: string) => state.tokens[provider] ?? null,
}))

import { readEmailThread, readEmailMessage, readRecentSentMessages } from '../email-read-service'
import { mailboxAddresses } from '../reply-policy'

let urls: string[]
const respond = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response
const b64 = (text: string) => Buffer.from(text).toString('base64url')

beforeEach(() => {
  state.local = []
  state.filters = []
  state.selections = []
  state.tokens = {}
  state.mailboxCalls = []
  urls = []
})
afterEach(() => vi.unstubAllGlobals())

describe('readEmailThread — live, from the thread\'s own mailbox', () => {
  it('reads nothing stored: no table is queried for the thread', async () => {
    state.tokens.google = { token: 'g-tok' }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return respond({ messages: [] }) }))
    expect(await readEmailThread('user-1', 'thr-1', 'ws-1')).toBeNull()
    expect(state.selections).toEqual([])
    expect(urls).toHaveLength(1)
  })

  it('passes the thread\'s own account to the mailbox resolver', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond({ messages: [] })))
    await readEmailThread('user-1', 'thr-1', 'ws-1', { accountId: 'acct-2', provider: 'microsoft' })
    expect(state.mailboxCalls.at(-1)).toEqual({ workspaceId: 'ws-1', accountId: 'acct-2', provider: 'microsoft' })
  })

  it('tries the next mailbox when the first does not hold the thread', async () => {
    state.tokens.google = { token: 'g-tok' }
    state.tokens.microsoft = { token: 'ms-tok' }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      if (url.includes('gmail')) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
      return respond({ value: [{ id: 'o-1', from: { emailAddress: { address: 'a@x.com' } }, toRecipients: [], receivedDateTime: '2026-10-01T00:00:00Z', body: { contentType: 'text', content: 'hi' } }] })
    }))
    const thread = await readEmailThread('user-1', 'thr-1')
    expect(thread?.messages[0].messageId).toBe('o-1')
    expect(urls.map((u) => (u.includes('gmail') ? 'gmail' : 'graph'))).toEqual(['gmail', 'graph'])
  })
})

describe('readEmailMessage — live', () => {
  it('reads one Outlook message by its encoded id, Reply-To and the original timestamp kept', async () => {
    state.tokens.microsoft = { token: 'ms-tok' }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      return respond({
        id: 'notice+1', from: { emailAddress: { address: 'no-reply@service.example' } },
        replyTo: [{ emailAddress: { name: 'Person', address: 'person@example.com' } }],
        toRecipients: [{ emailAddress: { address: 'liam@dial8.ai' } }],
        receivedDateTime: '2026-10-03T12:30:00Z', body: { contentType: 'text', content: 'Please reply to me.' },
        attachments: [{ name: 'logo.png', isInline: true }, { name: 'brief.pdf', isInline: false }], hasAttachments: true,
      })
    }))
    expect(await readEmailMessage('user-1', 'notice+1', 'ws-1')).toMatchObject({ messageId: 'notice+1',
      from: 'no-reply@service.example', replyTo: 'Person <person@example.com>', dateISO: '2026-10-03T12:30:00.000Z',
      bodyComplete: true, attachmentNames: ['brief.pdf'] })
    expect(urls[0]).toContain('/me/messages/notice%2B1?')
    expect(state.selections).toEqual([])
  })
})

describe('readRecentSentMessages — live sent mail for the tone pass (2026-10-17)', () => {
  it('Gmail: lists in:sent after the cutoff, reads each message, drops drafts, newest first; nothing stored', async () => {
    const msg = (id: string, at: string, labels: string[] = ['SENT']) => ({
      id, threadId: `t-${id}`, internalDate: String(Date.parse(at)), labelIds: labels,
      payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Liam <liam@dial8.ai>' }, { name: 'Subject', value: `S ${id}` }], body: { data: b64(`Body ${id}`) } },
    })
    const byId: Record<string, unknown> = {
      m1: msg('m1', '2026-10-08T09:00:00Z'),
      m2: msg('m2', '2026-10-08T12:00:00Z'),
      m3: msg('m3', '2026-10-08T13:00:00Z', ['DRAFT']),
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      if (url.includes('/messages?q=')) return respond({ messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] })
      return respond(byId[url.split('/messages/')[1].split('?')[0]])
    }))
    const out = await readRecentSentMessages({ provider: 'google', token: 'g-tok' }, { since: '2026-10-01T00:00:00Z', limit: 15 })
    expect(out.map((m) => m.messageId)).toEqual(['m2', 'm1'])
    expect(out[0]).toMatchObject({ subject: 'S m2', bodyText: 'Body m2' })
    expect(decodeURIComponent(urls[0])).toContain(`q=in:sent after:${Date.parse('2026-10-01T00:00:00Z') / 1000}`)
    expect(urls[0]).toContain('maxResults=15')
    expect(state.selections).toEqual([])
  })

  it('Graph: the Sent Items folder, filtered and ordered by sentDateTime, plain-text bodies; capped at 25', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers })
      return respond({ value: [{ id: 'o1', from: { emailAddress: { address: 'liam@dial8.ai' } }, subject: 'Hi', receivedDateTime: '2026-10-08T10:00:00Z', body: { contentType: 'text', content: 'Cheers' }, isDraft: false }] })
    }))
    const out = await readRecentSentMessages({ provider: 'microsoft', token: 'ms-tok' }, { since: '2026-10-01T00:00:00Z', limit: 99 })
    expect(out).toEqual([expect.objectContaining({ messageId: 'o1', bodyText: 'Cheers' })])
    expect(calls[0].url).toContain('/me/mailFolders/sentitems/messages?')
    expect(decodeURIComponent(calls[0].url)).toContain('sentDateTime ge 2026-10-01T00:00:00.000Z')
    expect(calls[0].url).toContain('$orderby=sentDateTime desc')
    expect(calls[0].url).toContain('$top=25')
    expect(calls[0].headers.Prefer).toBe('outlook.body-content-type="text"')
  })

  it('never throws: a failed read, a bad cutoff or no limit is nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response))
    expect(await readRecentSentMessages({ provider: 'google', token: 'x' }, { since: '2026-10-01T00:00:00Z', limit: 5 })).toEqual([])
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
    expect(await readRecentSentMessages({ provider: 'microsoft', token: 'x' }, { since: '2026-10-01T00:00:00Z', limit: 5 })).toEqual([])
    expect(await readRecentSentMessages({ provider: 'google', token: 'x' }, { since: 'not a date', limit: 5 })).toEqual([])
    expect(await readRecentSentMessages({ provider: 'google', token: 'x' }, { since: '2026-10-01T00:00:00Z', limit: 0 })).toEqual([])
  })
})

describe('readEmailThread — from Gmail', () => {
  it('reads the thread by its encoded id; Cc and the DRAFT label per message; participants from To and Cc', async () => {
    state.tokens.google = { token: 'g-tok' }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        const headers = (list: Array<[string, string]>) => list.map(([name, value]) => ({ name, value }))
        return respond({
          messages: [
            {
              id: 'm-1',
              labelIds: ['INBOX'],
              internalDate: '1790000000000',
              payload: {
                mimeType: 'text/plain',
                headers: headers([
                  ['From', 'Simon <simon@harborline.io>'],
                  ['rEpLy-To', 'Replies <replies@harborline.io>'],
                  ['To', '"Alizadeh, Liam" <liam@dial8.ai>'],
                  ['Cc', 'ops@harborline.io, Ada <ada@harborline.io>'],
                  ['Subject', 'Exploratory Meeting'],
                ]),
                body: { data: b64('Does Tuesday work?') },
              },
            },
            {
              id: 'm-2',
              labelIds: ['DRAFT'],
              internalDate: '1790000100000',
              payload: {
                mimeType: 'text/plain',
                headers: headers([['From', 'liam@dial8.ai'], ['To', 'simon@harborline.io']]),
                body: { data: b64('Tuesday works.') },
              },
            },
          ].reverse(),
        })
      }),
    )
    const thread = await readEmailThread('user-1', 'thr/1')
    expect(urls).toEqual(['https://gmail.googleapis.com/gmail/v1/users/me/threads/thr%2F1?format=full'])
    expect(thread!.messages.map((m) => [m.messageId, m.cc, m.isDraft])).toEqual([
      ['m-1', 'ops@harborline.io, Ada <ada@harborline.io>', false],
      ['m-2', '', true],
    ])
    expect(thread!.participantEmails.sort()).toEqual(['ada@harborline.io', 'liam@dial8.ai', 'ops@harborline.io', 'simon@harborline.io'])
    expect(thread!.messages[0]).toMatchObject({ replyTo: 'Replies <replies@harborline.io>',
      dateISO: new Date(1790000000000).toISOString(), bodyComplete: true })
    expect(thread!.messages[1].replyTo).toBeUndefined()
    expect(thread!.complete).toBe(true)
  })

  it('marks snippet-only Gmail bodies incomplete', async () => {
    state.tokens.google = { token: 'g-tok' }
    vi.stubGlobal('fetch', vi.fn(async () => respond({ messages: [{ id: 'partial', internalDate: '1790000000000',
      snippet: 'Only a preview of the message', payload: { headers: [] } }] })))
    const thread = await readEmailThread('user-1', 'thread')
    expect(thread!.messages[0]).toMatchObject({ bodyText: 'Only a preview of the message', bodyComplete: false })
  })
})

describe('readEmailThread — automated-mail headers (src/lib/email/automated-sender.ts)', () => {
  it('Gmail: names the automated header a message carries as a reason, never its text', async () => {
    state.tokens.google = { token: 'g-tok' }
    vi.stubGlobal('fetch', vi.fn(async () => respond({ messages: [
      { id: 'list', internalDate: '1790000000000', payload: { headers: [{ name: 'From', value: 'news@x.com' }, { name: 'list-unsubscribe', value: '<https://x.com/u>' }] } },
      { id: 'person', internalDate: '1790000001000', payload: { headers: [{ name: 'From', value: 'jane@x.com' }, { name: 'Auto-Submitted', value: 'no' }] } },
    ] })))
    const thread = await readEmailThread('user-1', 'thread')
    expect(thread!.messages[0].automatedBy).toBe('mailing_list')
    expect(thread!.messages[1]).not.toHaveProperty('automatedBy')
  })

  it('Outlook: asks for internetMessageHeaders and reads an out-of-office from them', async () => {
    state.tokens.microsoft = { token: 'ms-tok' }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      return respond({ value: [{ id: 'oof', receivedDateTime: '2026-10-03T12:00:00Z', from: { emailAddress: { address: 'jane@x.com' } },
        body: { contentType: 'text', content: 'Away' }, internetMessageHeaders: [{ name: 'Auto-Submitted', value: 'auto-replied' }] }] })
    }))
    const thread = await readEmailThread('user-1', 'thread')
    expect(new URL(urls[0]).searchParams.get('$select')!.split(',')).toContain('internetMessageHeaders')
    expect(thread!.messages[0].automatedBy).toBe('auto_submitted')
  })
})

describe('readEmailThread — from Outlook', () => {
  it('filters on the conversation id escaped and encoded; Cc and isDraft per message', async () => {
    state.tokens.microsoft = { token: 'ms-tok' }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        return respond({
          value: [
            {
              id: 'AAMk+1',
              from: { emailAddress: { name: 'Simon', address: 'simon@harborline.io' } },
              replyTo: [{ emailAddress: { name: 'Replies', address: 'replies@harborline.io' } }, { emailAddress: { address: 'backup@harborline.io' } }],
              toRecipients: [{ emailAddress: { name: 'Liam', address: 'liam@dial8.ai' } }],
              ccRecipients: [{ emailAddress: { address: 'ops@harborline.io' } }],
              subject: 'Exploratory Meeting',
              receivedDateTime: '2026-09-24T05:02:00Z',
              body: { contentType: 'text', content: 'Does Tuesday work?' },
              isDraft: false,
            },
            {
              id: 'AAMk+2',
              from: { emailAddress: { address: 'liam@dial8.ai' } },
              toRecipients: [{ emailAddress: { address: 'simon@harborline.io' } }],
              subject: 'RE: Exploratory Meeting',
              receivedDateTime: '2026-09-24T06:00:00Z',
              body: { contentType: 'html', content: '<p>Tuesday works.</p>' },
              isDraft: true,
            },
          ].reverse(),
        })
      }),
    )
    const thread = await readEmailThread('user-1', "AAQk+ab/c='d")
    const url = new URL(urls[0])
    expect(url.searchParams.get('$filter')).toBe("conversationId eq 'AAQk+ab/c=''d'")
    expect(urls[0]).toContain('%2B')
    expect(url.searchParams.get('$select')).toContain('ccRecipients')
    expect(url.searchParams.get('$select')).toContain('isDraft')
    expect(url.searchParams.get('$select')).toContain('replyTo')
    expect(thread!.messages.map((m) => [m.messageId, m.to, m.cc, m.isDraft])).toEqual([
      ['AAMk+1', 'Liam <liam@dial8.ai>', 'ops@harborline.io', false],
      ['AAMk+2', 'simon@harborline.io', '', true],
    ])
    expect(thread!.participantEmails.sort()).toEqual(['liam@dial8.ai', 'ops@harborline.io', 'simon@harborline.io'])
    expect(thread!.messages[0]).toMatchObject({ replyTo: 'Replies <replies@harborline.io>, backup@harborline.io',
      dateISO: '2026-09-24T05:02:00.000Z', bodyComplete: true })
    expect(thread!.messages[1].replyTo).toBeUndefined()
    expect(thread!.complete).toBe(true)
  })

  it('marks an Outlook thread page incomplete when more messages remain', async () => {
    state.tokens.microsoft = { token: 'ms-tok' }
    vi.stubGlobal('fetch', vi.fn(async () => respond({ '@odata.nextLink': 'https://graph.microsoft.com/next',
      value: [{ id: 'page-1', receivedDateTime: '2026-10-03T12:00:00Z', body: null, replyTo: [] }] })))
    const thread = await readEmailThread('user-1', 'thread')
    expect(thread!.complete).toBe(false)
    expect(thread!.messages[0].bodyComplete).toBe(false)
    expect(thread!.messages[0].replyTo).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('quotes Graph names consistently for From, Reply-To and recipients', async () => {
    state.tokens.microsoft = { token: 'ms-tok' }
    vi.stubGlobal('fetch', vi.fn(async () => respond({ value: [{ id: 'named', receivedDateTime: '2026-10-03T12:00:00Z',
      from: { emailAddress: { name: 'Doe, Jane', address: 'jane@example.com' } },
      replyTo: [{ emailAddress: { name: 'Pat "PJ" Smith', address: 'pat@example.com' } }],
      toRecipients: [{ emailAddress: { name: 'Lee, Sam', address: 'sam@example.com' } }], body: { contentType: 'text', content: 'Hello' } }] })))
    const message = (await readEmailThread('user-1', 'thread'))!.messages[0]
    expect(message.from).toBe('"Doe, Jane" <jane@example.com>')
    expect(message.replyTo).toBe('"Pat \\"PJ\\" Smith" <pat@example.com>')
    expect(mailboxAddresses(message.from)).toEqual(['jane@example.com'])
    expect(mailboxAddresses(message.replyTo!)).toEqual(['pat@example.com'])
    expect(mailboxAddresses(message.to)).toEqual(['sam@example.com'])
  })
})
