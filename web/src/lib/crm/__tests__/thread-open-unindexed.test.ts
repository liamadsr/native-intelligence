/**
 * A search result the index doesn't have (older than its 30 days, or not
 * indexed yet) still opens: Mail names the hit's mailbox, the thread is
 * indexed through the sync's writer (ids, flags, addresses; never a subject
 * or body), one copy per workspace the mailbox is linked to, and then read
 * live like any indexed thread. Only a mailbox this workspace may read is
 * used; a named mailbox that isn't one is refused, never swapped for the
 * person's first token.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

let fake: FakeSupabase
vi.mock('@/lib/admin', () => ({ getServiceClient: () => fake }))
const { legacyToken, owned } = vi.hoisted(() => ({
  legacyToken: vi.fn(async () => ({ token: 'first-token', email: 'me@gmail.com' })),
  owned: vi.fn(async (_u: string, accountId: string) =>
    accountId === 'acct-g' || accountId === 'acct-elsewhere' ? { provider: 'google' as const, token: `tok-${accountId}`, email: null, accountId } : null,
  ),
}))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidToken: legacyToken,
  getAllValidTokens: vi.fn(async () => []),
  getValidTokenForAccount: vi.fn(async (accountId: string) => (accountId === 'acct-g' ? { token: 'tok-acct-g', email: 'me@gmail.com', accountId } : null)),
}))
vi.mock('@/lib/email/account-scope', () => ({
  readableWorkspaceEmailAccounts: async () => [{ id: 'acct-g', provider: 'google', account_email: 'me@gmail.com' }],
  // The mailbox is linked to this workspace and one more: both get their copy.
  threadCopyWorkspaceIds: async () => ['f6000000-0000-4000-8000-000000000001', 'ws-other'],
}))
vi.mock('@/lib/email/thread-mailbox', () => ({ ownedMailbox: owned }))

import { fetchFullEmailThreadForClient } from '@/lib/crm/email-client'

const WS = 'f6000000-0000-4000-8000-000000000001'
let auth: string[] = []

beforeEach(() => {
  fake = makeFakeSupabase()
  auth = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    auth.push(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ''))
    if (String(url).startsWith('https://gmail.googleapis.com/gmail/v1/users/me/threads/thr-old')) {
      return {
        ok: true,
        json: async () => ({
          id: 'thr-old',
          messages: [{
            id: 'm-old',
            internalDate: '1740000000000',
            labelIds: ['INBOX'],
            payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'Meeting recap' }, { name: 'From', value: 'Sam <s@x.com>' }, { name: 'To', value: 'me@gmail.com' }], body: { data: Buffer.from('Notes').toString('base64url') } },
          }],
        }),
      } as unknown as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('fetchFullEmailThreadForClient for a thread the index does not have', () => {
  it('indexes it from the mailbox Mail names (ids, flags, addresses only), then reads it live', async () => {
    const thread = await fetchFullEmailThreadForClient('user-1', WS, 'thr-old', { accountId: 'acct-g' })
    expect(thread.subject).toBe('Meeting recap')
    const rows = fake.rows('email_thread_index')
    expect(rows.map((r) => r.workspace_id).sort()).toEqual([WS, 'ws-other'].sort())
    const here = rows.find((r) => r.workspace_id === WS)!
    expect(thread.indexId).toBe(here.id)
    expect(here).toMatchObject({ user_id: 'user-1', account_id: 'acct-g', provider: 'google', provider_thread_id: 'thr-old', provider_message_id: 'm-old', from_email: 's@x.com', folder: 'inbox' })
    expect(here.participant_emails).toEqual(expect.arrayContaining(['s@x.com', 'me@gmail.com']))
    // No stored mail: nothing a sender wrote.
    expect(JSON.stringify(rows)).not.toMatch(/Meeting recap|Notes/)
    expect(auth.every((a) => a === 'Bearer tok-acct-g')).toBe(true)
    expect(legacyToken).not.toHaveBeenCalled()
  })

  it('a thread indexed already is read, not written again', async () => {
    fake.seed('email_thread_index', [{ id: 'idx-1', workspace_id: WS, user_id: 'user-1', provider: 'google', account_id: 'acct-g', provider_thread_id: 'thr-old', is_unread: false }])
    const thread = await fetchFullEmailThreadForClient('user-1', WS, 'thr-old', { accountId: 'acct-g' })
    expect(thread.indexId).toBe('idx-1')
    expect(fake.rows('email_thread_index')).toHaveLength(1)
  })

  it("refuses a named mailbox this workspace can't read, without trying another", async () => {
    await expect(fetchFullEmailThreadForClient('user-1', WS, 'thr-old', { accountId: 'acct-elsewhere' })).rejects.toThrow('Mailbox not found')
    expect(owned).not.toHaveBeenCalledWith('user-1', 'acct-elsewhere')
    expect(auth).toEqual([])
    expect(legacyToken).not.toHaveBeenCalled()
  })
})
