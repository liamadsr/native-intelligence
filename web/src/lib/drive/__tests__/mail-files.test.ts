import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/email/account-scope', () => ({ readableWorkspaceEmailAccounts: vi.fn(async () => []) }))
vi.mock('@/lib/email/thread-mailbox', () => ({ ownedMailbox: vi.fn(async () => null) }))
vi.mock('@/lib/email/live-thread-search', () => ({ graphExcludedFolderIds: vi.fn(async () => new Set(['junk-folder'])) }))

import { decodeMailFilesCursor, gmailFilesOf, gmailFilesQuery, graphFilesUrl, listMailFiles, mailFileHref } from '../mail-files'

const G = '11111111-1111-4111-8111-111111111111'
const M = '22222222-2222-4222-8222-222222222222'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('gmailFilesOf', () => {
  it('lists the files a message carries, nested or not, and leaves inline pictures out', () => {
    const files = gmailFilesOf({
      headers: [],
      parts: [
        { mimeType: 'text/plain', body: { size: 10 } },
        { filename: 'plan.pdf', mimeType: 'application/pdf', body: { size: 2048, attachmentId: 'a1' } },
        {
          mimeType: 'multipart/related',
          parts: [
            { filename: 'logo.png', mimeType: 'image/png', body: { size: 900, attachmentId: 'a2' }, headers: [{ name: 'Content-Disposition', value: 'inline; filename="logo.png"' }] },
            { filename: 'photo.jpg', mimeType: 'image/jpeg', body: { size: 5000, attachmentId: 'a3' }, headers: [{ name: 'Content-Disposition', value: 'attachment' }] },
          ],
        },
      ],
    })
    expect(files).toEqual([
      { name: 'plan.pdf', mimeType: 'application/pdf', size: 2048 },
      { name: 'photo.jpg', mimeType: 'image/jpeg', size: 5000 },
    ])
  })
})

describe('the provider queries', () => {
  it('asks Gmail for messages with files, out of spam and trash, with the person’s words', () => {
    expect(gmailFilesQuery('')).toBe('has:attachment -in:spam -in:trash')
    expect(gmailFilesQuery('  budget   q3 ')).toBe('has:attachment -in:spam -in:trash budget q3')
  })

  it('asks Graph for the newest messages with files, or searches the words', () => {
    const list = new URL(graphFilesUrl('', 20))
    expect(list.searchParams.get('$filter')).toContain('hasAttachments eq true')
    expect(list.searchParams.get('$orderby')).toBe('receivedDateTime desc')
    const search = new URL(graphFilesUrl('say "hi"', 20))
    expect(search.searchParams.get('$search')).toBe('"say hi"')
    expect(search.searchParams.get('$filter')).toBeNull()
  })

  it('opens a file through the owner’s attachment route', () => {
    expect(mailFileHref('t/1', 'm1', 'a b.pdf')).toBe('/api/account/email/threads/t%2F1/attachment?message=m1&name=a%20b.pdf')
  })
})

describe('listMailFiles', () => {
  it('reads each of the person’s own mailboxes live, newest first, and pages on with a cursor', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages?')) return json({ messages: [{ id: 'g1' }], nextPageToken: 'gtok' })
      if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages/g1?'))
        return json({
          id: 'g1',
          threadId: 'gt1',
          internalDate: String(Date.parse('2026-11-20T10:00:00Z')),
          payload: {
            headers: [
              { name: 'Subject', value: 'Q3 plan' },
              { name: 'From', value: 'Ada Park <ada@example.com>' },
            ],
            parts: [{ filename: 'plan.pdf', mimeType: 'application/pdf', body: { size: 2048, attachmentId: 'x' } }],
          },
        })
      if (url.startsWith('https://graph.microsoft.com/v1.0/me/messages?'))
        return json({
          value: [
            {
              id: 'o1',
              conversationId: 'oc1',
              subject: 'Costs',
              receivedDateTime: '2026-11-21T09:00:00Z',
              hasAttachments: true,
              from: { emailAddress: { name: 'Bo', address: 'Bo@Example.com' } },
              attachments: [
                { name: 'costs.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 900, '@odata.type': '#microsoft.graph.fileAttachment' },
                { name: 'sig.png', contentType: 'image/png', size: 10, isInline: true, '@odata.type': '#microsoft.graph.fileAttachment' },
                { name: 'Fwd message', size: 10, '@odata.type': '#microsoft.graph.itemAttachment' },
              ],
            },
            { id: 'o2', conversationId: 'oc2', hasAttachments: true, parentFolderId: 'junk-folder', attachments: [{ name: 'spam.zip', '@odata.type': '#microsoft.graph.fileAttachment' }] },
          ],
        })
      return json({}, 404)
    })
    const page = await listMailFiles(
      'u1',
      'ws1',
      {},
      {
        accounts: async () => [
          { id: G, provider: 'google', account_email: 'me@example.com' },
          { id: M, provider: 'microsoft', account_email: 'me@example.org' },
        ],
        mailbox: async (_u, id) => ({ provider: id === G ? 'google' : 'microsoft', token: 't', email: null, accountId: id }),
        fetch: fetchMock as unknown as typeof fetch,
      },
    )
    expect(page.mailboxes).toBe(2)
    expect(page.files.map((f) => [f.name, f.subject, f.fromEmail])).toEqual([
      ['costs.xlsx', 'Costs', 'bo@example.com'],
      ['plan.pdf', 'Q3 plan', 'ada@example.com'],
    ])
    expect(page.files[1].href).toBe(mailFileHref('gt1', 'g1', 'plan.pdf'))
    expect(decodeMailFilesCursor(page.cursor)).toEqual({ [G]: 'gtok' })
  })

  it('reads nobody else’s mailbox: none linked, nothing listed; a cursor it did not write, nothing', async () => {
    const fetchMock = vi.fn()
    const none = await listMailFiles('u1', 'ws1', {}, { accounts: async () => [], fetch: fetchMock as unknown as typeof fetch })
    expect(none).toEqual({ files: [], cursor: null, mailboxes: 0 })
    const forged = await listMailFiles('u1', 'ws1', { cursor: 'not-a-cursor' }, { accounts: async () => [{ id: G, provider: 'google', account_email: null }], fetch: fetchMock as unknown as typeof fetch })
    expect(forged.files).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a mailbox that fails adds nothing, and the rest still list', async () => {
    const page = await listMailFiles(
      'u1',
      'ws1',
      {},
      {
        accounts: async () => [{ id: G, provider: 'google', account_email: null }],
        mailbox: async () => ({ provider: 'google', token: 't', email: null, accountId: G }),
        fetch: (async () => json({ error: 'x' }, 500)) as unknown as typeof fetch,
      },
    )
    expect(page.files).toEqual([])
    expect(page.cursor).toBeNull()
  })
})
