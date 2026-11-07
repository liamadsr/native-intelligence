/**
 * A search result the index doesn't have is indexed on demand
 * (materialize-thread.ts), through the sync's own writer, so the thread routes
 * work on it: only for a mailbox this workspace may read, never twice, and
 * with each provider's indexer. The POST route maps the outcome.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

let fake: FakeSupabase
vi.mock('@/lib/admin', () => ({ getServiceClient: () => fake }))
vi.mock('@/lib/oauth/token-manager', () => ({ getValidToken: vi.fn(), getAllValidTokens: vi.fn(), getValidTokenForAccount: vi.fn() }))

import { materializeSearchHit } from '../materialize-thread'

const WS = 'ws-1'
const readable = vi.fn(async () => [
  { id: 'acct-g', provider: 'google' as const, account_email: 'me@gmail.com' },
  { id: 'acct-o', provider: 'microsoft' as const, account_email: 'me@work.com' },
])
const mailbox = vi.fn(async (_u: string, accountId: string) =>
  accountId === 'acct-g'
    ? { provider: 'google' as const, token: 'g', email: 'me@gmail.com', accountId }
    : accountId === 'acct-o'
      ? { provider: 'microsoft' as const, token: 'o', email: 'me@work.com', accountId }
      : null,
)
const writeRow = (target: { userId: string; workspaceId: string; threadId: string; accountId?: string | null }) => {
  fake.seed('email_thread_index', [{ id: `idx-${target.threadId}`, user_id: target.userId, workspace_id: target.workspaceId, account_id: target.accountId, provider_thread_id: target.threadId }])
  return 'indexed' as const
}
const indexGmail = vi.fn(async (_db: unknown, target: Parameters<typeof writeRow>[0]) => writeRow(target))
const indexOutlook = vi.fn(async (_db: unknown, target: Parameters<typeof writeRow>[0]) => writeRow(target))
const deps = () => ({ admin: fake as never, readable: readable as never, mailbox, indexGmail: indexGmail as never, indexOutlook: indexOutlook as never })

beforeEach(() => {
  fake = makeFakeSupabase()
  vi.clearAllMocks()
})

describe('materializeSearchHit', () => {
  it('indexes a Gmail hit with the mailbox token and address, through the sync writer', async () => {
    const out = await materializeSearchHit({ userId: 'u1', workspaceId: WS, accountId: 'acct-g', threadId: 'thr-old' }, deps())
    expect(out).toEqual({ ok: true, id: 'idx-thr-old', created: true })
    expect(indexGmail).toHaveBeenCalledWith(fake, { accessToken: 'g', userEmail: 'me@gmail.com', userId: 'u1', workspaceId: WS, threadId: 'thr-old', accountId: 'acct-g' }, { logWriteErrors: true })
    expect(indexOutlook).not.toHaveBeenCalled()
  })

  it('an Outlook hit goes through the Outlook indexer', async () => {
    const out = await materializeSearchHit({ userId: 'u1', workspaceId: WS, accountId: 'acct-o', threadId: 'conv-1' }, deps())
    expect(out).toMatchObject({ ok: true, created: true })
    expect(indexOutlook).toHaveBeenCalledTimes(1)
  })

  it('a thread indexed here already answers with its row and writes nothing', async () => {
    fake.seed('email_thread_index', [{ id: 'idx-1', user_id: 'u1', workspace_id: WS, account_id: 'acct-g', provider_thread_id: 'thr-1' }])
    expect(await materializeSearchHit({ userId: 'u1', workspaceId: WS, accountId: 'acct-g', threadId: 'thr-1' }, deps())).toEqual({ ok: true, id: 'idx-1', created: false })
    expect(indexGmail).not.toHaveBeenCalled()
  })

  it("refuses a mailbox this workspace can't read, before any token is asked for", async () => {
    expect(await materializeSearchHit({ userId: 'u1', workspaceId: WS, accountId: 'acct-elsewhere', threadId: 't' }, deps())).toEqual({ ok: false, reason: 'not_readable' })
    expect(mailbox).not.toHaveBeenCalled()
  })

  it("passes on what the provider says: gone, or unreadable when the indexer throws", async () => {
    indexGmail.mockResolvedValueOnce('gone' as never)
    expect(await materializeSearchHit({ userId: 'u1', workspaceId: WS, accountId: 'acct-g', threadId: 't' }, deps())).toEqual({ ok: false, reason: 'gone' })
    indexGmail.mockRejectedValueOnce(new Error('boom'))
    expect(await materializeSearchHit({ userId: 'u1', workspaceId: WS, accountId: 'acct-g', threadId: 't' }, deps())).toEqual({ ok: false, reason: 'unreadable' })
  })
})
