/**
 * A draft the email tools create is indexed at once, as a row Mail lists and a
 * work item's "Review draft" resolves: in the tool's workspace, with the
 * account that holds it (Mail's thread list scopes by the workspace's linked
 * accounts, so a row without one is never listed), keyed like the sync keys a
 * thread so its next pass updates the row instead of adding one. The upsert
 * this replaces named a conflict target the table has no index for, and
 * failed on every call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

let fake: FakeSupabase
vi.mock('@/lib/admin', () => ({ getServiceClient: () => fake }))

const tokens: Record<string, { token: string; email: string | null } | null> = {}
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidToken: vi.fn(async (_u: string, provider: string) => tokens[provider] ?? null),
  getValidTokenForCapability: vi.fn(),
  getAllValidTokens: vi.fn(),
  getValidTokenForAccount: vi.fn(async (accountId: string) => (accountId === 'acct-other' ? { token: 'o-tok', email: 'other@x.com' } : null)),
}))

import { createEmailDraft } from '@/lib/integrations/email'

const WS = 'f6000000-0000-4000-8000-000000000001'
let created: Array<{ id: string; threadId: string }> = []
const fetchMock = vi.fn(async (url: string) => {
  if (url.endsWith('/drafts')) {
    const next = created.shift()!
    return { ok: true, status: 200, json: async () => ({ id: `r-${next.id}`, message: { id: next.id, threadId: next.threadId } }) }
  }
  return { ok: false, status: 404, json: async () => ({}) }
})

beforeEach(() => {
  fake = makeFakeSupabase()
  fake.seed('connected_account', [
    { id: 'acct-ni', user_id: 'user-1', provider: 'google', capability: 'email', account_email: 'liam@dial8.ai' },
    { id: 'acct-other', user_id: 'user-1', provider: 'google', capability: 'email', account_email: 'other@x.com' },
  ])
  tokens.google = { token: 'g-tok', email: 'liam@dial8.ai' }
  tokens.microsoft = null
  created = []
  vi.stubGlobal('fetch', fetchMock)
})

const draft = { to: ['etienne@corvanne.com'], subject: 'Heads-up', body: 'Hi Etienne,\n\nContext ahead of the call.' }

describe('createEmailDraft — the draft is indexed where Mail and the work item find it', () => {
  it('a new draft: one row in the tool’s workspace, with the account that holds it, the provider ids, in Drafts', async () => {
    created.push({ id: '1a0e8b6b5baa5eb0', threadId: '1a0e8b6b5baa5eb0' })
    const result = await createEmailDraft('user-1', draft, WS)
    expect(result.id).toBe('1a0e8b6b5baa5eb0')
    const rows = fake.rows('email_thread_index')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      workspace_id: WS,
      user_id: 'user-1',
      account_id: 'acct-ni',
      provider: 'google',
      provider_thread_id: '1a0e8b6b5baa5eb0',
      provider_message_id: '1a0e8b6b5baa5eb0',
      participant_emails: ['etienne@corvanne.com'],
      folder: 'drafts',
      is_draft: true,
    })
    // No stored mail: the draft's subject and text stay in the mailbox and its review row.
    for (const col of ['subject', 'snippet', 'to_emails', 'cc_emails']) expect(rows[0]).not.toHaveProperty(col)
  })

  it('a reply draft on a thread the sync already indexed updates that row (no second row), keeping its folder and subject', async () => {
    fake.seed('email_thread_index', [
      { id: 'idx-1', workspace_id: WS, user_id: 'user-1', account_id: 'acct-ni', provider: 'google', provider_thread_id: 'thr-9', provider_message_id: 'm-last', subject: 'Pricing', folder: 'inbox', is_draft: false },
    ])
    created.push({ id: 'm-draft', threadId: 'thr-9' })
    await createEmailDraft('user-1', { ...draft, subject: 'Re: Pricing', thread_id: 'thr-9' }, WS)
    const rows = fake.rows('email_thread_index')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'idx-1', provider_message_id: 'm-draft', is_draft: true, account_id: 'acct-ni', folder: 'inbox', subject: 'Pricing' })
  })

  it('from a named account: that account’s id', async () => {
    created.push({ id: 'm-2', threadId: 'm-2' })
    await createEmailDraft('user-1', draft, WS, 'other@x.com')
    expect(fake.rows('email_thread_index')[0]).toMatchObject({ account_id: 'acct-other', provider_message_id: 'm-2' })
  })

  it('a token with no matching connected account still indexes (account unknown), and no workspace means no index write', async () => {
    tokens.google = { token: 'g-tok', email: 'nobody@x.com' }
    created.push({ id: 'm-3', threadId: 'm-3' })
    await createEmailDraft('user-1', draft, WS)
    expect(fake.rows('email_thread_index')[0]).toMatchObject({ account_id: null, provider_message_id: 'm-3' })
    created.push({ id: 'm-4', threadId: 'm-4' })
    await createEmailDraft('user-1', draft)
    expect(fake.rows('email_thread_index')).toHaveLength(1)
  })

  it('an index write that fails never fails the draft: the provider result comes back, the next sync indexes it', async () => {
    fake.failNextInsert('email_thread_index', { message: 'boom' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    created.push({ id: 'm-5', threadId: 'm-5' })
    await expect(createEmailDraft('user-1', draft, WS)).resolves.toMatchObject({ id: 'm-5' })
    expect(fake.rows('email_thread_index')).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith('[email] draft index write failed:', 'boom')
    warn.mockRestore()
  })
})

describe('createEmailDraft — a mailbox linked to several workspaces', () => {
  const WS2 = 'f6000000-0000-4000-8000-000000000002'

  it('the draft is indexed into every workspace the mailbox is linked to, so it shows wherever the mailbox does', async () => {
    fake.seed('connected_account_workspace', [
      { account_id: 'acct-ni', workspace_id: WS },
      { account_id: 'acct-ni', workspace_id: WS2 },
    ])
    fake.seed('email_thread_index', [
      { id: 'idx-1', workspace_id: WS, user_id: 'user-1', account_id: 'acct-ni', provider: 'google', provider_thread_id: 'thr-9', subject: 'Pricing', folder: 'inbox', is_draft: false },
    ])
    created.push({ id: 'm-draft', threadId: 'thr-9' })
    await createEmailDraft('user-1', { ...draft, thread_id: 'thr-9' }, WS2)
    const byWs = Object.fromEntries(fake.rows('email_thread_index').map((r) => [r.workspace_id, r]))
    expect(Object.keys(byWs).sort()).toEqual([WS, WS2].sort())
    expect(byWs[WS]).toMatchObject({ id: 'idx-1', provider_message_id: 'm-draft', is_draft: true, subject: 'Pricing' })
    expect(byWs[WS2]).toMatchObject({ provider_message_id: 'm-draft', is_draft: true, folder: 'drafts' })
  })
})
