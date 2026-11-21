/**
 * Sharing an email thread with a PERSON by an @-mention (migration 673,
 * decision 1): who may share, who may read, what is frozen, what is read live.
 * The database is the in-memory stand-in; the owner's mailbox and the two
 * provider reads are fakes (no network). Made-up people (Ana, Ben, Sam, Dana,
 * Harbor) and addresses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import {
  findMemberShareId,
  readSharedEmailThreadForMember,
  revokeEmailThreadShare,
  shareEmailThreadWithMembers,
  type MemberShareDeps,
} from '../member-share'
import type { EmailShareMessage } from '../types'
import type { ShareMailbox } from '../provider'

const WS = '11111111-1111-4111-8111-111111111111'
const OTHER_WS = '11111111-1111-4111-8111-222222222222'
const ANA_USER = '22222222-2222-4222-8222-aaaaaaaaaaaa'
const BEN_USER = '22222222-2222-4222-8222-bbbbbbbbbbbb'
const SAM_USER = '22222222-2222-4222-8222-cccccccccccc'
const DANA_USER = '22222222-2222-4222-8222-dddddddddddd'
const M_ANA = '33333333-3333-4333-8333-aaaaaaaaaaaa'
const M_BEN = '33333333-3333-4333-8333-bbbbbbbbbbbb'
const M_SAM = '33333333-3333-4333-8333-cccccccccccc'
const M_DANA = '33333333-3333-4333-8333-dddddddddddd'
const ACCOUNT = '44444444-4444-4444-8444-000000000001'
const INDEX = '55555555-5555-4555-8555-000000000001' // Ana's thread
const BEN_INDEX = '55555555-5555-4555-8555-000000000002' // Ben's thread

const SUBJECT = 'Harbor renewal terms'

type Tables = Record<string, Array<Record<string, unknown>>>
let tables: Tables
let svc: SupabaseClient
let threadNow: string[]
let mailboxUp: boolean
let deps: MemberShareDeps

function message(id: string, threadId = 'thr-1', over: Partial<EmailShareMessage> = {}): EmailShareMessage & { threadId: string } {
  return {
    id,
    threadId,
    from: { name: 'Dana Whitfield', email: 'dana@harbor.example' },
    to: [{ name: null, email: 'ana@example.com' }],
    cc: [],
    date: '2026-11-10T15:00:00.000Z',
    subject: SUBJECT,
    bodyHtml: '<p>Our counter is 12% off list.</p>',
    bodyText: 'Our counter is 12% off list.',
    attachments: [],
    blockedImages: 1,
    ...over,
  }
}
let messages: Record<string, EmailShareMessage & { threadId: string }>

beforeEach(() => {
  tables = {
    member: [
      { id: M_ANA, user_id: ANA_USER, workspace_id: WS, display_name: 'Ana' },
      { id: M_BEN, user_id: BEN_USER, workspace_id: WS, display_name: 'Ben' },
      { id: M_DANA, user_id: DANA_USER, workspace_id: WS, display_name: 'Dana' },
      { id: M_SAM, user_id: SAM_USER, workspace_id: OTHER_WS, display_name: 'Sam' },
    ],
    email_thread_index: [
      { id: INDEX, user_id: ANA_USER, workspace_id: WS, account_id: ACCOUNT, provider: 'google', provider_thread_id: 'thr-1' },
      { id: BEN_INDEX, user_id: BEN_USER, workspace_id: WS, account_id: ACCOUNT, provider: 'google', provider_thread_id: 'thr-ben' },
    ],
    email_thread_share: [],
  }
  svc = memoryDb(tables)
  threadNow = ['m1', 'm2']
  mailboxUp = true
  messages = {
    m1: message('m1'),
    m2: message('m2', 'thr-1', { bodyText: 'Sounds good.', bodyHtml: null, blockedImages: 0 }),
    m3: message('m3', 'thr-1', { bodyText: 'A later, private reply.' }),
  }
  const mailbox: ShareMailbox = { provider: 'google', token: 'tok-ana' }
  deps = {
    mailbox: vi.fn(async (ownerId: string, accountId: string, workspaceId: string) =>
      mailboxUp && ownerId === ANA_USER && accountId === ACCOUNT && workspaceId === WS ? mailbox : null,
    ),
    provider: {
      threadIds: vi.fn(async (_m, threadId: string) => (threadId === 'thr-1' ? [...threadNow] : null)),
      message: vi.fn(async (_m, id: string, threadId: string, opts?: { images?: boolean }) => {
        const m = messages[id]
        if (!m || m.threadId !== threadId) return null
        const { threadId: _t, ...rest } = m
        return opts?.images ? { ...rest, blockedImages: 0 } : rest
      }),
    },
  }
})

describe('shareEmailThreadWithMembers', () => {
  it('shares only the owner’s own thread, with workspace members, never the owner or an outsider', async () => {
    const result = await shareEmailThreadWithMembers(
      svc,
      { workspaceId: WS, ownerUserId: ANA_USER, threadIndexId: INDEX, memberIds: [M_BEN, M_ANA, M_SAM], source: { type: 'comment' } },
      deps,
    )
    // Ben only: Ana is the owner, Sam is in another workspace.
    expect(result.shared.map((s) => s.granteeMemberId)).toEqual([M_BEN])
    expect(tables.email_thread_share).toHaveLength(1)
    expect(tables.email_thread_share[0]).toMatchObject({
      workspace_id: WS,
      owner_user_id: ANA_USER,
      account_id: ACCOUNT,
      provider: 'google',
      provider_thread_id: 'thr-1',
      thread_index_id: INDEX,
      message_ids: ['m1', 'm2'],
      grantee_member_id: M_BEN,
      source: 'mention',
      source_type: 'comment',
    })
  })

  it('never shares a thread that is not the author’s own', async () => {
    const result = await shareEmailThreadWithMembers(
      svc,
      { workspaceId: WS, ownerUserId: ANA_USER, threadIndexId: BEN_INDEX, memberIds: [M_BEN] },
      deps,
    )
    expect(result.shared).toEqual([])
    expect(tables.email_thread_share).toHaveLength(0)
  })

  it('a member of another workspace is never a grantee', async () => {
    const result = await shareEmailThreadWithMembers(svc, { workspaceId: WS, ownerUserId: ANA_USER, threadIndexId: INDEX, memberIds: [M_SAM] }, deps)
    expect(result.shared).toEqual([])
    expect(tables.email_thread_share).toHaveLength(0)
  })

  it('a re-mention refreshes the frozen ids in place (one live row per grantee)', async () => {
    await shareEmailThreadWithMembers(svc, { workspaceId: WS, ownerUserId: ANA_USER, threadIndexId: INDEX, memberIds: [M_BEN] }, deps)
    const firstId = tables.email_thread_share[0].id
    threadNow = ['m1', 'm2', 'm3']
    const again = await shareEmailThreadWithMembers(svc, { workspaceId: WS, ownerUserId: ANA_USER, threadIndexId: INDEX, memberIds: [M_BEN] }, deps)
    expect(again.shared).toEqual([{ id: firstId, granteeMemberId: M_BEN }])
    expect(tables.email_thread_share).toHaveLength(1)
    expect(tables.email_thread_share[0].message_ids).toEqual(['m1', 'm2', 'm3'])
  })

  it('shares nothing (never throws) when the owner’s mailbox is disconnected', async () => {
    mailboxUp = false
    const result = await shareEmailThreadWithMembers(svc, { workspaceId: WS, ownerUserId: ANA_USER, threadIndexId: INDEX, memberIds: [M_BEN] }, deps)
    expect(result.shared).toEqual([])
    expect(tables.email_thread_share).toHaveLength(0)
  })
})

async function shareToBen(): Promise<string> {
  const result = await shareEmailThreadWithMembers(svc, { workspaceId: WS, ownerUserId: ANA_USER, threadIndexId: INDEX, memberIds: [M_BEN] }, deps)
  return result.shared[0].id
}

describe('readSharedEmailThreadForMember', () => {
  it('a grantee reads the thread, and only its frozen messages are read', async () => {
    const shareId = await shareToBen()
    // A later reply arrives after the freeze: it must never be read.
    threadNow = ['m1', 'm2', 'm3']
    const result = await readSharedEmailThreadForMember(svc, { shareId, callerUserId: BEN_USER, workspaceId: WS }, deps)
    expect(result.state).toBe('available')
    if (result.state !== 'available') return
    expect(result.mine).toBe(false)
    expect(result.thread.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(result.thread.subject).toBe(SUBJECT)
    const readIds = vi.mocked(deps.provider.message).mock.calls.map((c) => c[1])
    expect(readIds).toEqual(['m1', 'm2'])
    expect(readIds).not.toContain('m3')
  })

  it('a non-grantee member of the same workspace gets not-found', async () => {
    const shareId = await shareToBen()
    const result = await readSharedEmailThreadForMember(svc, { shareId, callerUserId: DANA_USER, workspaceId: WS }, deps)
    expect(result.state).toBe('not_found')
  })

  it('a revoked share gets not-found', async () => {
    const shareId = await shareToBen()
    await revokeEmailThreadShare(svc, { shareId, ownerUserId: ANA_USER, workspaceId: WS })
    const result = await readSharedEmailThreadForMember(svc, { shareId, callerUserId: BEN_USER, workspaceId: WS }, deps)
    expect(result.state).toBe('not_found')
  })

  it('a grantee from another workspace gets not-found (its member is not in the share’s workspace)', async () => {
    // A share that names Sam (an OTHER_WS member) as grantee in WS: Sam still cannot read it.
    tables.email_thread_share.push({
      id: '66666666-6666-4666-8666-000000000001',
      workspace_id: WS,
      owner_user_id: ANA_USER,
      account_id: ACCOUNT,
      provider: 'google',
      provider_thread_id: 'thr-1',
      thread_index_id: INDEX,
      message_ids: ['m1', 'm2'],
      grantee_member_id: M_SAM,
      source: 'mention',
      revoked_at: null,
    })
    const result = await readSharedEmailThreadForMember(
      svc,
      { shareId: '66666666-6666-4666-8666-000000000001', callerUserId: SAM_USER, workspaceId: WS },
      deps,
    )
    expect(result.state).toBe('not_found')
  })

  it('a disconnected mailbox reads as not available (never a partial leak)', async () => {
    const shareId = await shareToBen()
    mailboxUp = false
    const result = await readSharedEmailThreadForMember(svc, { shareId, callerUserId: BEN_USER, workspaceId: WS }, deps)
    expect(result.state).toBe('unavailable')
  })

  it('the owner reads their own share', async () => {
    const shareId = await shareToBen()
    const result = await readSharedEmailThreadForMember(svc, { shareId, callerUserId: ANA_USER, workspaceId: WS }, deps)
    expect(result.state).toBe('available')
    if (result.state === 'available') expect(result.mine).toBe(true)
  })

  it('a grantee can read by the thread index row id (the chip only knows the mention)', async () => {
    await shareToBen()
    const result = await readSharedEmailThreadForMember(svc, { threadIndexId: INDEX, callerUserId: BEN_USER, workspaceId: WS }, deps)
    expect(result.state).toBe('available')
  })
})

describe('findMemberShareId', () => {
  it('returns the grantee’s active share id for a thread index row, and nothing for a non-grantee', async () => {
    const shareId = await shareToBen()
    expect(await findMemberShareId(svc, { threadIndexId: INDEX, callerUserId: BEN_USER, workspaceId: WS })).toBe(shareId)
    expect(await findMemberShareId(svc, { threadIndexId: INDEX, callerUserId: DANA_USER, workspaceId: WS })).toBeNull()
  })
})

describe('revokeEmailThreadShare', () => {
  it('the owner un-shares; a non-owner gets 404 and the row stays', async () => {
    const shareId = await shareToBen()
    const notOwner = await revokeEmailThreadShare(svc, { shareId, ownerUserId: BEN_USER, workspaceId: WS })
    expect(notOwner).toEqual({ ok: false, status: 404 })
    expect(tables.email_thread_share[0].revoked_at ?? null).toBeNull()
    const ok = await revokeEmailThreadShare(svc, { shareId, ownerUserId: ANA_USER, workspaceId: WS })
    expect(ok).toEqual({ ok: true })
    expect(tables.email_thread_share[0].revoked_at).toBeTruthy()
  })
})
