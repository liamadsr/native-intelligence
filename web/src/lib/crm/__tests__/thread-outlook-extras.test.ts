/**
 * An Outlook thread read fills in what the list query doesn't carry: a
 * meeting request's invitation, and the attachment list of a message that
 * says it has attachments. The requests are the recorded shapes; people and
 * meetings are made up.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

let fake: FakeSupabase
vi.mock('@/lib/admin', () => ({ getServiceClient: () => fake }))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidToken: vi.fn(async () => null),
  getValidTokenForAccount: vi.fn(async (accountId: string) => (accountId === 'acct-m' ? { token: 'm-tok', email: 'sam@harborlabs.example', accountId } : null)),
}))

import { fetchFullEmailThreadForClient } from '@/lib/crm/email-client'

const WS = 'f6000000-0000-4000-8000-000000000001'
const person = (name: string, address: string) => ({ emailAddress: { name, address } })
const message = (id: string, extra: Record<string, unknown>) => ({
  id,
  conversationId: 'conv-1',
  from: person('Marcus Oyelaran', 'marcus@northwind.example'),
  toRecipients: [person('Sam Rivera', 'sam@harborlabs.example')],
  subject: 'Quarterly review',
  receivedDateTime: '2026-11-20T05:02:00Z',
  body: { contentType: 'text', content: 'See you there' },
  isRead: true,
  isDraft: false,
  parentFolderId: 'folder-inbox',
  hasAttachments: false,
  ...extra,
})

let urls: string[] = []
let listed: Array<Record<string, unknown>> = []
const fetchMock = vi.fn(async (input: unknown) => {
  const url = decodeURIComponent(String(input))
  urls.push(url)
  const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json }) as unknown as Response
  if (url.startsWith('https://graph.microsoft.com/v1.0/me/mailFolders/deleteditems')) return ok({ id: 'folder-deleted' })
  if (url.startsWith('https://graph.microsoft.com/v1.0/me/messages?')) return ok({ value: listed })
  if (url.includes('/me/messages/o-request?$expand=microsoft.graph.eventMessage/event')) {
    return ok({
      id: 'o-request',
      meetingMessageType: 'meetingRequest',
      event: {
        id: 'evt-1',
        subject: 'Quarterly review',
        isAllDay: false,
        iCalUId: 'UID-77',
        start: { dateTime: '2026-12-03T18:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-12-03T19:00:00.0000000', timeZone: 'UTC' },
        organizer: person('Marcus Oyelaran', 'marcus@northwind.example'),
        attendees: [{ type: 'required', status: { response: 'none' }, ...person('Sam Rivera', 'sam@harborlabs.example') }],
      },
    })
  }
  if (url.includes('/me/messages/o-ics/attachments?')) return ok({ value: [{ id: 'a1', name: 'invite.ics', size: 2210, contentType: 'application/ics', isInline: false }] })
  return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
})

beforeEach(() => {
  urls = []
  fake = makeFakeSupabase()
  fake.seed('email_thread_index', [
    { id: 'idx-m', workspace_id: WS, user_id: 'u1', provider: 'microsoft', account_id: 'acct-m', provider_thread_id: 'conv-1', is_unread: false },
  ])
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockClear()
})
afterEach(() => vi.unstubAllGlobals())

describe('an Outlook thread read', () => {
  it('gives a native meeting request its invitation, and a message with attachments its file list', async () => {
    listed = [
      message('o-plain', {}),
      message('o-request', { '@odata.type': '#microsoft.graph.eventMessage' }),
      message('o-ics', { hasAttachments: true }),
    ]
    const thread = await fetchFullEmailThreadForClient('u1', WS, 'conv-1')
    const byId = Object.fromEntries(thread.messages.map((m) => [m.id, m]))
    expect(byId['o-plain'].invite).toBeUndefined()
    expect(byId['o-plain'].attachments).toEqual([])
    expect(byId['o-request'].invite).toMatchObject({ method: 'REQUEST', uid: 'UID-77', title: 'Quarterly review', start: '2026-12-03T18:00:00.000Z' })
    expect(byId['o-ics'].attachments).toEqual([{ name: 'invite.ics', size: 2210, mimeType: 'application/ics' }])
    // One extra read each, and only for the two messages that need one.
    const extra = urls.filter((u) => u.includes('/me/messages/'))
    expect(extra).toHaveLength(2)
    expect(extra.some((u) => u.includes('/me/messages/o-plain'))).toBe(false)
  })

  it('uses the attachments the list query did return, without asking again', async () => {
    listed = [message('o-ics', { hasAttachments: true, attachments: [{ name: 'agenda.pdf', size: 48211, contentType: 'application/pdf' }] })]
    const thread = await fetchFullEmailThreadForClient('u1', WS, 'conv-1')
    expect(thread.messages[0].attachments).toEqual([{ name: 'agenda.pdf', size: 48211, mimeType: 'application/pdf' }])
    expect(urls.filter((u) => u.includes('/attachments'))).toEqual([])
  })

  it('still opens the thread when the extra reads fail', async () => {
    listed = [message('o-other', { '@odata.type': '#microsoft.graph.eventMessage', hasAttachments: true })]
    const thread = await fetchFullEmailThreadForClient('u1', WS, 'conv-1')
    expect(thread.messages).toHaveLength(1)
    expect(thread.messages[0].invite).toBeUndefined()
    expect(thread.messages[0].attachments).toEqual([])
  })
})
