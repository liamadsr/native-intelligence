/**
 * Sharing mail from a mention (migration 673, decision 1), the one helper
 * documents, descriptions and comments share: a mail chip beside a teammate
 * chip in the SAME text shares the author's OWN thread with that teammate,
 * view only, for the pairs new to the save. Removing the mention never
 * revokes. The database is the in-memory stand-in; the owner's mailbox and the
 * freeze read are fakes (no network). Made-up people (Ana, Ben, Sam).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import type { MentionRef } from '@/lib/entity-links/mentionable'
import type { MemberShareDeps } from '../member-share'
import type { ShareMailbox } from '../provider'

const WS = '11111111-1111-4111-8111-111111111111'
const OTHER_WS = '11111111-1111-4111-8111-222222222222'
const ANA_USER = '22222222-2222-4222-8222-aaaaaaaaaaaa'
const BEN_USER = '22222222-2222-4222-8222-bbbbbbbbbbbb'
const SAM_USER = '22222222-2222-4222-8222-cccccccccccc'
const M_ANA = '33333333-3333-4333-8333-aaaaaaaaaaaa'
const M_BEN = '33333333-3333-4333-8333-bbbbbbbbbbbb'
const M_SAM = '33333333-3333-4333-8333-cccccccccccc'
const ACCOUNT = '44444444-4444-4444-8444-000000000001'
const INDEX = '55555555-5555-4555-8555-000000000001' // Ana's thread
const BEN_INDEX = '55555555-5555-4555-8555-000000000002' // Ben's thread
const DOC = '77777777-7777-4777-8777-000000000001'
const BEN_CONTACT = '88888888-8888-4888-8888-00000000000b' // a teammate (member_id = M_BEN)
const SAM_CONTACT = '88888888-8888-4888-8888-00000000000c' // a teammate (member_id = M_SAM)
const PLAIN_CONTACT = '88888888-8888-4888-8888-00000000000d' // not a teammate (no member_id)

const hoisted = vi.hoisted(() => ({ svc: null as unknown as SupabaseClient }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.svc }))

import { shareMentionedMail } from '../share-on-mention'

type Tables = Record<string, Array<Record<string, unknown>>>
let tables: Tables
let svc: SupabaseClient
let deps: MemberShareDeps

const mail = (id: string): MentionRef => ({ type: 'email_thread', id })
const person = (contactId: string): MentionRef => ({ type: 'contact', id: contactId })
const shares = () => tables.email_thread_share

beforeEach(() => {
  tables = {
    member: [
      { id: M_ANA, user_id: ANA_USER, workspace_id: WS, display_name: 'Ana' },
      { id: M_BEN, user_id: BEN_USER, workspace_id: WS, display_name: 'Ben' },
      { id: M_SAM, user_id: SAM_USER, workspace_id: WS, display_name: 'Sam' },
    ],
    contact: [
      { id: BEN_CONTACT, workspace_id: WS, member_id: M_BEN },
      { id: SAM_CONTACT, workspace_id: WS, member_id: M_SAM },
      { id: PLAIN_CONTACT, workspace_id: WS, member_id: null },
    ],
    email_thread_index: [
      { id: INDEX, user_id: ANA_USER, workspace_id: WS, account_id: ACCOUNT, provider: 'google', provider_thread_id: 'thr-1' },
      { id: BEN_INDEX, user_id: BEN_USER, workspace_id: WS, account_id: ACCOUNT, provider: 'google', provider_thread_id: 'thr-ben' },
    ],
    email_thread_share: [],
  }
  svc = memoryDb(tables)
  hoisted.svc = svc
  const mailbox: ShareMailbox = { provider: 'google', token: 'tok-ana' }
  deps = {
    mailbox: vi.fn(async (ownerId: string, accountId: string, workspaceId: string) =>
      ownerId === ANA_USER && accountId === ACCOUNT && workspaceId === WS ? mailbox : null,
    ),
    provider: {
      threadIds: vi.fn(async (_m, threadId: string) => (threadId === 'thr-1' ? ['m1', 'm2'] : null)),
      message: vi.fn(async () => null),
      attachment: vi.fn(async () => null),
    },
  }
})

const base = { workspaceId: WS, authorUserId: ANA_USER, authorMemberId: M_ANA, source: { type: 'document' as const, id: DOC } }

describe('shareMentionedMail — documents and descriptions', () => {
  it('a mail chip beside a teammate chip shares with that teammate only', async () => {
    await shareMentionedMail(svc, { ...base, mentions: [mail(INDEX), person(BEN_CONTACT)], previousMentions: null }, deps)
    expect(shares()).toHaveLength(1)
    expect(shares()[0]).toMatchObject({
      owner_user_id: ANA_USER,
      thread_index_id: INDEX,
      grantee_member_id: M_BEN,
      message_ids: ['m1', 'm2'],
      source: 'mention',
      source_type: 'document',
      source_id: DOC,
    })
  })

  it('a mail chip alone shares with no one', async () => {
    await shareMentionedMail(svc, { ...base, mentions: [mail(INDEX)], previousMentions: null }, deps)
    expect(shares()).toHaveLength(0)
    expect(deps.provider.threadIds).not.toHaveBeenCalled()
  })

  it('a teammate chip alone shares nothing', async () => {
    await shareMentionedMail(svc, { ...base, mentions: [person(BEN_CONTACT)], previousMentions: null }, deps)
    expect(shares()).toHaveLength(0)
    expect(deps.provider.threadIds).not.toHaveBeenCalled()
  })

  it('a mail chip of a thread that is NOT the author’s shares nothing', async () => {
    await shareMentionedMail(svc, { ...base, mentions: [mail(BEN_INDEX), person(SAM_CONTACT)], previousMentions: null }, deps)
    expect(shares()).toHaveLength(0)
  })

  it('a contact chip that is not a teammate (no member_id) gets nothing', async () => {
    await shareMentionedMail(svc, { ...base, mentions: [mail(INDEX), person(PLAIN_CONTACT)], previousMentions: null }, deps)
    expect(shares()).toHaveLength(0)
    expect(deps.provider.threadIds).not.toHaveBeenCalled()
  })

  it('an unchanged re-save makes no share (and no provider freeze call)', async () => {
    const mentions = [mail(INDEX), person(BEN_CONTACT)]
    await shareMentionedMail(svc, { ...base, mentions, previousMentions: null }, deps)
    expect(shares()).toHaveLength(1)
    vi.mocked(deps.provider.threadIds).mockClear()
    // The same text saved again: the (INDEX, Ben) pair is not new.
    await shareMentionedMail(svc, { ...base, mentions, previousMentions: mentions }, deps)
    expect(shares()).toHaveLength(1)
    expect(deps.provider.threadIds).not.toHaveBeenCalled()
  })

  it('adding a second teammate later shares with the new one only (one call, the new pair)', async () => {
    await shareMentionedMail(svc, { ...base, mentions: [mail(INDEX), person(BEN_CONTACT)], previousMentions: null }, deps)
    expect(shares()).toHaveLength(1)
    vi.mocked(deps.provider.threadIds).mockClear()
    await shareMentionedMail(
      svc,
      { ...base, mentions: [mail(INDEX), person(BEN_CONTACT), person(SAM_CONTACT)], previousMentions: [mail(INDEX), person(BEN_CONTACT)] },
      deps,
    )
    // One freeze call (one new pair), and Sam's row added; Ben's stays, not duplicated.
    expect(deps.provider.threadIds).toHaveBeenCalledTimes(1)
    expect(shares()).toHaveLength(2)
    expect(shares().map((s) => s.grantee_member_id).sort()).toEqual([M_BEN, M_SAM].sort())
  })

  it('removing the mail chip revokes nothing', async () => {
    await shareMentionedMail(svc, { ...base, mentions: [mail(INDEX), person(BEN_CONTACT)], previousMentions: null }, deps)
    expect(shares()).toHaveLength(1)
    // The next save drops the mail chip (keeps the teammate): no mail chip, so nothing runs.
    await shareMentionedMail(svc, { ...base, mentions: [person(BEN_CONTACT)], previousMentions: [mail(INDEX), person(BEN_CONTACT)] }, deps)
    expect(shares()).toHaveLength(1)
    expect(shares()[0].revoked_at ?? null).toBeNull()
  })

  it('a null author user id shares nothing', async () => {
    await shareMentionedMail(svc, { ...base, authorUserId: null, mentions: [mail(INDEX), person(BEN_CONTACT)], previousMentions: null }, deps)
    expect(shares()).toHaveLength(0)
  })
})

describe('shareMentionedMail — comments (resolved member ids)', () => {
  it('shares each mentioned thread with the given teammates, never the author', async () => {
    await shareMentionedMail(
      svc,
      { workspaceId: WS, authorUserId: ANA_USER, authorMemberId: M_ANA, mentions: [mail(INDEX)], resolvedMemberIds: [M_BEN, M_ANA], source: { type: 'comment' } },
      deps,
    )
    expect(shares()).toHaveLength(1)
    expect(shares()[0]).toMatchObject({ grantee_member_id: M_BEN, thread_index_id: INDEX, source: 'mention', source_type: 'comment' })
    expect(shares()[0].source_id ?? null).toBeNull()
  })
})
