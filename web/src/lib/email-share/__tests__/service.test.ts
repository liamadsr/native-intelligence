/**
 * Sharing an email thread into team chat, read live (migration 646): who may
 * share, who may read, what is frozen, what is stored. The database is the
 * in-memory stand-in; team chat's read and post rules (474's
 * team_chat_can_read / team_chat_can_post, asked as the caller) and the
 * owner's mailbox are fakes. Made-up people and companies.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import {
  clearShareCardCache,
  createEmailShare,
  listShareTargets,
  listThreadShares,
  readShareCard,
  readSharedAttachment,
  readSharedThread,
  revokeEmailShare,
  type EmailShareDeps,
  type ShareCaller,
} from '../service'
import type { EmailShareMessage } from '../types'
import type { ShareMailbox } from '../provider'

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))

const WS = '10000000-0000-4000-8000-000000000001'
const OTHER_WS = '10000000-0000-4000-8000-000000000002'
const OWNER = '20000000-0000-4000-8000-000000000001'
const READER = '20000000-0000-4000-8000-000000000002'
const OUTSIDER = '20000000-0000-4000-8000-000000000003'
const GUEST = '20000000-0000-4000-8000-000000000004'
const M_OWNER = '30000000-0000-4000-8000-000000000001'
const M_READER = '30000000-0000-4000-8000-000000000002'
const M_OUTSIDER = '30000000-0000-4000-8000-000000000003'
const M_GUEST = '30000000-0000-4000-8000-000000000004'
const SALES = '40000000-0000-4000-8000-000000000001'
const PRIVATE = '40000000-0000-4000-8000-000000000002'
const MEETING = '40000000-0000-4000-8000-000000000003'
const ELSEWHERE = '40000000-0000-4000-8000-000000000004'
const DM_GUEST = '40000000-0000-4000-8000-000000000005'
const ACCOUNT = '50000000-0000-4000-8000-000000000001'
const INDEX = '60000000-0000-4000-8000-000000000001'
const READER_INDEX = '60000000-0000-4000-8000-000000000002'
const TEAM = '70000000-0000-4000-8000-000000000001'

const SUBJECT = 'Northwind renewal terms'
const BODY = 'Our counter is 12% off list, through March.'

type Tables = Record<string, Array<Record<string, unknown>>>
let tables: Tables
/** Which channels each person may read / post in (474's rules, as asked through their own client). */
let readable: Record<string, Set<string>>
let postable: Record<string, Set<string>>
/** The owner's mailbox: the thread's messages now, and whether the token still works. */
let threadNow: string[]
let mailboxUp: boolean
let messages: Record<string, EmailShareMessage & { threadId: string }>
let deps: EmailShareDeps

function message(id: string, over: Partial<EmailShareMessage> = {}): EmailShareMessage & { threadId: string } {
  return {
    id,
    threadId: 'thr-1',
    from: { name: 'Dana Whitfield', email: 'dana@harborline.example' },
    to: [{ name: null, email: 'avery@northwind.example' }],
    cc: [],
    date: '2026-11-10T15:00:00.000Z',
    subject: SUBJECT,
    bodyHtml: `<p>${BODY}</p>`,
    bodyText: BODY,
    attachments: [{ key: '2', name: 'terms.pdf', size: 1200, mimeType: 'application/pdf' }],
    ...over,
  }
}

function caller(userId: string, memberId: string, workspaceId = WS): ShareCaller {
  const db = memoryDb(tables)
  const supabase = {
    from: db.from.bind(db),
    rpc: vi.fn(async (fn: string, args: { ch: string }) => {
      const set = fn === 'team_chat_can_post' ? postable[userId] : readable[userId]
      return { data: !!set?.has(args.ch), error: null }
    }),
  } as unknown as SupabaseClient
  return { supabase, userId, workspaceId, memberId }
}

const owner = () => caller(OWNER, M_OWNER)
const reader = () => caller(READER, M_READER)
const outsider = () => caller(OUTSIDER, M_OUTSIDER)

beforeEach(() => {
  clearShareCardCache()
  tables = {
    member: [
      { id: M_OWNER, user_id: OWNER, workspace_id: WS, display_name: 'Avery Stone', role: 'member' },
      { id: M_READER, user_id: READER, workspace_id: WS, display_name: 'Blake Rivera', role: 'member' },
      { id: M_OUTSIDER, user_id: OUTSIDER, workspace_id: WS, display_name: 'Casey Ng', role: 'member' },
      { id: M_GUEST, user_id: GUEST, workspace_id: WS, display_name: 'Drew Lin', role: 'guest' },
    ],
    team_member: [{ team_id: TEAM, member_id: M_OWNER }, { team_id: TEAM, member_id: M_READER }],
    team_chat_channel: [
      { id: SALES, workspace_id: WS, kind: 'channel', name: 'sales', team_id: TEAM, dm_key: null, archived_at: null },
      { id: PRIVATE, workspace_id: WS, kind: 'channel', name: 'leadership', team_id: null, dm_key: null, archived_at: null },
      { id: MEETING, workspace_id: WS, kind: 'meeting', name: 'Weekly sync', team_id: null, dm_key: null, archived_at: null },
      { id: ELSEWHERE, workspace_id: OTHER_WS, kind: 'channel', name: 'general', team_id: null, dm_key: null, archived_at: null },
      { id: DM_GUEST, workspace_id: WS, kind: 'dm', name: null, team_id: null, dm_key: [M_OWNER, M_GUEST].sort().join(':'), archived_at: null },
    ],
    team_chat_message: [],
    email_share: [],
    connected_account: [{ id: ACCOUNT, user_id: OWNER, provider: 'google', capability: 'email' }],
    email_thread_index: [
      { id: INDEX, user_id: OWNER, workspace_id: WS, account_id: ACCOUNT, provider: 'google', provider_thread_id: 'thr-1', from_email: 'dana@harborline.example' },
      { id: READER_INDEX, user_id: READER, workspace_id: WS, account_id: null, provider: 'google', provider_thread_id: 'thr-9', from_email: 'ops@contoso.example' },
    ],
  }
  readable = { [OWNER]: new Set([SALES, PRIVATE, MEETING, DM_GUEST]), [READER]: new Set([SALES]), [OUTSIDER]: new Set() }
  postable = { [OWNER]: new Set([SALES, MEETING, DM_GUEST]), [READER]: new Set([SALES]), [OUTSIDER]: new Set() }
  threadNow = ['m1', 'm2']
  mailboxUp = true
  messages = { m1: message('m1'), m2: message('m2', { bodyText: 'Sounds good.', bodyHtml: null }), m3: message('m3', { bodyText: 'A private follow-up.' }) }
  const mailbox: ShareMailbox = { provider: 'google', token: 'tok-owner' }
  deps = {
    svc: memoryDb(tables),
    mailbox: vi.fn(async (ownerId: string, accountId: string, workspaceId: string) =>
      mailboxUp && ownerId === OWNER && accountId === ACCOUNT && workspaceId === WS ? mailbox : null,
    ),
    provider: {
      threadIds: vi.fn(async (_m, threadId: string) => (threadId === 'thr-1' ? [...threadNow] : null)),
      message: vi.fn(async (_m, id: string, threadId: string) => {
        const m = messages[id]
        if (!m || m.threadId !== threadId) return null
        const { threadId: _t, ...rest } = m
        return rest
      }),
      summary: vi.fn(async (_m, id: string, threadId: string) => {
        const m = messages[id]
        return m && m.threadId === threadId ? { subject: m.subject, from: m.from.email, firstLine: (m.bodyText ?? '').split('\n')[0] } : null
      }),
      attachment: vi.fn(async (_m, id: string, threadId: string, key: string) => {
        const m = messages[id]
        const a = m && m.threadId === threadId ? m.attachments.find((x) => x.key === key) : undefined
        return a ? { name: a.name, mimeType: a.mimeType, size: a.size, body: new Uint8Array([1, 2, 3]) } : null
      }),
    },
  }
})

async function shareToSales(note?: string) {
  const result = await createEmailShare(deps, owner(), { indexId: INDEX, channelId: SALES, note })
  if (!result.ok) throw new Error(`share failed: ${result.code}`)
  // What the reads ask of the mailbox from here on.
  vi.mocked(deps.mailbox).mockClear()
  return result
}

describe('sharing', () => {
  it('the owner shares their thread into a channel they can post in: ids frozen, a message as them carries it', async () => {
    const result = await shareToSales('Can someone check the discount?')
    expect(result.label).toBe('#sales')
    expect(result.messageCount).toBe(2)
    const [share] = tables.email_share
    expect(share).toMatchObject({
      workspace_id: WS,
      owner_user_id: OWNER,
      account_id: ACCOUNT,
      provider: 'google',
      provider_thread_id: 'thr-1',
      thread_index_id: INDEX,
      message_ids: ['m1', 'm2'],
      channel_id: SALES,
      team_chat_message_id: result.message.id,
      shared_by_member_id: M_OWNER,
    })
    expect(tables.team_chat_message[0]).toMatchObject({
      channel_id: SALES,
      author_kind: 'member',
      author_member_id: M_OWNER,
      body: 'Can someone check the discount?',
      mentions: [],
      mentions_agent: false,
      email_share_id: share.id,
    })
  })

  it('without a note, the message says only "Shared an email"', async () => {
    await shareToSales()
    expect(tables.team_chat_message[0].body).toBe('Shared an email')
  })

  it('shares by the provider thread id too (the thread view), and into a DM', async () => {
    const result = await createEmailShare(deps, owner(), { threadId: 'thr-1', accountId: ACCOUNT, channelId: DM_GUEST })
    expect(result).toMatchObject({ ok: true, label: 'Drew Lin' })
  })

  it('stores no mail: no subject, body, snippet, name or address in the share or its message', async () => {
    await shareToSales()
    const stored = JSON.stringify([tables.email_share, tables.team_chat_message])
    for (const text of [SUBJECT, BODY, 'Dana', 'dana@harborline.example', 'terms.pdf', 'avery@northwind.example']) {
      expect(stored).not.toContain(text)
    }
  })

  it('only the owner shares: another member naming the thread gets "not found", and nothing is written', async () => {
    readable[READER].add(PRIVATE)
    postable[READER].add(PRIVATE)
    expect(await createEmailShare(deps, reader(), { indexId: INDEX, channelId: SALES })).toMatchObject({ ok: false, status: 404 })
    expect(await createEmailShare(deps, reader(), { threadId: 'thr-1', channelId: SALES })).toMatchObject({ ok: false, status: 404 })
    expect(await createEmailShare(deps, reader(), { threadId: 'thr-1', accountId: ACCOUNT, channelId: SALES })).toMatchObject({ ok: false, status: 404 })
    expect(tables.email_share).toHaveLength(0)
    expect(tables.team_chat_message).toHaveLength(0)
    expect(deps.provider.threadIds).not.toHaveBeenCalled()
  })

  it('only into a channel or DM the owner may post in, in this workspace', async () => {
    expect(await createEmailShare(deps, owner(), { indexId: INDEX, channelId: PRIVATE })).toMatchObject({ ok: false, status: 403 })
    expect(await createEmailShare(deps, owner(), { indexId: INDEX, channelId: ELSEWHERE })).toMatchObject({ ok: false, status: 404 })
    expect(await createEmailShare(deps, owner(), { indexId: INDEX, channelId: MEETING })).toMatchObject({ ok: false, status: 400 })
    expect(await createEmailShare(deps, owner(), { indexId: INDEX, channelId: 'not-a-uuid' })).toMatchObject({ ok: false, status: 400 })
    expect(tables.email_share).toHaveLength(0)
  })

  it('a disconnected mailbox, a legacy thread with no mailbox, or a thread the mailbox no longer has: nothing shared', async () => {
    mailboxUp = false
    expect(await createEmailShare(deps, owner(), { indexId: INDEX, channelId: SALES })).toMatchObject({ ok: false, status: 409 })
    mailboxUp = true
    threadNow = []
    expect(await createEmailShare(deps, owner(), { indexId: INDEX, channelId: SALES })).toMatchObject({ ok: false, status: 410, code: 'unavailable' })
    tables.email_thread_index[0].account_id = null
    expect(await createEmailShare(deps, owner(), { indexId: INDEX, channelId: SALES })).toMatchObject({ ok: false, status: 409 })
    expect(tables.email_share).toHaveLength(0)
  })
})

describe('reading', () => {
  it('a member who can read the channel reads the frozen messages, live', async () => {
    const { shareId } = await shareToSales()
    const view = await readSharedThread(deps, reader(), shareId)
    expect(view).toMatchObject({ id: shareId, subject: SUBJECT, mine: false, missing: 0 })
    expect('messages' in view && view.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(deps.mailbox).toHaveBeenCalledWith(OWNER, ACCOUNT, WS)
  })

  it('freezes the thread: a reply after the share is not readable through it', async () => {
    const { shareId } = await shareToSales()
    threadNow = ['m1', 'm2', 'm3']
    const view = await readSharedThread(deps, reader(), shareId)
    expect('messages' in view && view.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(deps.provider.message).not.toHaveBeenCalledWith(expect.anything(), 'm3', expect.anything())
    expect(await readSharedAttachment(deps, reader(), shareId, 'm3', '2')).toMatchObject({ ok: false, status: 404 })
  })

  it('anyone who cannot read the channel, or is in another workspace, gets 404, and the mailbox is never asked', async () => {
    const { shareId } = await shareToSales()
    expect(await readSharedThread(deps, outsider(), shareId)).toMatchObject({ ok: false, status: 404 })
    expect(await readShareCard(deps, outsider(), shareId)).toMatchObject({ ok: false, status: 404 })
    expect(await readSharedThread(deps, caller(READER, M_READER, OTHER_WS), shareId)).toMatchObject({ ok: false, status: 404 })
    expect(await readSharedThread(deps, reader(), '90000000-0000-4000-8000-000000000009')).toMatchObject({ ok: false, status: 404 })
    expect(deps.mailbox).not.toHaveBeenCalled()
  })

  it('a revoked share gives no access: 410 revoked, the card says so, and the mailbox is never asked', async () => {
    const { shareId } = await shareToSales()
    expect(await revokeEmailShare(deps, owner(), shareId)).toEqual({ ok: true })
    expect(await readSharedThread(deps, reader(), shareId)).toMatchObject({ ok: false, status: 410, code: 'revoked' })
    expect(await readSharedAttachment(deps, reader(), shareId, 'm1', '2')).toMatchObject({ ok: false, status: 410, code: 'revoked' })
    expect(await readShareCard(deps, reader(), shareId)).toMatchObject({ state: 'revoked', subject: null, sender: null })
    expect(deps.mailbox).not.toHaveBeenCalled()
  })

  it('a disconnected mailbox: "no longer available" for the thread and the card', async () => {
    const { shareId } = await shareToSales()
    mailboxUp = false
    expect(await readSharedThread(deps, reader(), shareId)).toMatchObject({ ok: false, status: 410, code: 'unavailable', error: 'This email is no longer available' })
    expect(await readShareCard(deps, reader(), shareId)).toMatchObject({ state: 'unavailable', subject: null })
  })

  it('an owner who left the workspace: no longer available', async () => {
    const { shareId } = await shareToSales()
    tables.member = tables.member.filter((m) => m.user_id !== OWNER)
    expect(await readSharedThread(deps, reader(), shareId)).toMatchObject({ ok: false, status: 410, code: 'unavailable' })
  })

  it('a message gone from the mailbox is left out and counted; all gone: no longer available', async () => {
    const { shareId } = await shareToSales()
    delete messages.m2
    expect(await readSharedThread(deps, reader(), shareId)).toMatchObject({ missing: 1 })
    delete messages.m1
    expect(await readSharedThread(deps, reader(), shareId)).toMatchObject({ ok: false, status: 410, code: 'unavailable' })
  })

  it('a frozen id moved to another thread is not read through the share', async () => {
    const { shareId } = await shareToSales()
    messages.m2 = { ...messages.m2, threadId: 'thr-other' }
    expect(await readSharedThread(deps, reader(), shareId)).toMatchObject({ missing: 1 })
  })

  it('the card: the sender from the index, subject and first line live, a few seconds cached in process only', async () => {
    const { shareId } = await shareToSales()
    const card = await readShareCard(deps, reader(), shareId, 1_000)
    expect(card).toEqual({ id: shareId, state: 'live', mine: false, sender: 'dana@harborline.example', subject: SUBJECT, firstLine: 'Sounds good.', messageCount: 2 })
    await readShareCard(deps, reader(), shareId, 2_000)
    expect(deps.provider.summary).toHaveBeenCalledTimes(1)
    await readShareCard(deps, reader(), shareId, 10_000)
    expect(deps.provider.summary).toHaveBeenCalledTimes(2)
    expect(await readShareCard(deps, owner(), shareId, 10_500)).toMatchObject({ mine: true })
  })
})

describe('attachments', () => {
  it('stream only for one of the share’s messages, by a key that message lists', async () => {
    const { shareId } = await shareToSales()
    expect(await readSharedAttachment(deps, reader(), shareId, 'm1', '2')).toMatchObject({ name: 'terms.pdf', mimeType: 'application/pdf' })
  })

  it('a forged key, a message outside the share, or a reader outside the channel is refused', async () => {
    const { shareId } = await shareToSales()
    expect(await readSharedAttachment(deps, reader(), shareId, 'm1', '9')).toMatchObject({ ok: false, status: 404 })
    expect(await readSharedAttachment(deps, reader(), shareId, 'm1', '')).toMatchObject({ ok: false, status: 404 })
    expect(await readSharedAttachment(deps, reader(), shareId, 'm3', '2')).toMatchObject({ ok: false, status: 404 })
    expect(await readSharedAttachment(deps, reader(), shareId, 'other-thread-msg', '2')).toMatchObject({ ok: false, status: 404 })
    expect(await readSharedAttachment(deps, outsider(), shareId, 'm1', '2')).toMatchObject({ ok: false, status: 404 })
    expect(deps.provider.attachment).toHaveBeenCalledTimes(1)
  })
})

describe('un-sharing and the owner’s chips', () => {
  it('only the owner un-shares; the chips list the live shares and drop a revoked one', async () => {
    const { shareId } = await shareToSales()
    const second = await createEmailShare(deps, owner(), { threadId: 'thr-1', channelId: DM_GUEST })
    expect(second.ok).toBe(true)
    const chips = await listThreadShares(deps, owner(), { threadId: 'thr-1' })
    expect(chips.map((c) => c.label)).toEqual(['#sales', 'Drew Lin'])
    // Another member can't un-share it, nor list it.
    expect(await revokeEmailShare(deps, reader(), shareId)).toMatchObject({ ok: false, status: 404 })
    expect(await listThreadShares(deps, reader(), { threadId: 'thr-1' })).toEqual([])
    expect(await listThreadShares(deps, reader(), { indexId: INDEX })).toEqual([])
    expect(await revokeEmailShare(deps, owner(), shareId)).toEqual({ ok: true })
    // Again: already done.
    expect(await revokeEmailShare(deps, owner(), shareId)).toEqual({ ok: true })
    expect((await listThreadShares(deps, owner(), { indexId: INDEX })).map((c) => c.label)).toEqual(['Drew Lin'])
    // The chat message stays (its card says "No longer shared"), the note kept.
    expect(tables.team_chat_message).toHaveLength(2)
  })

  it('undo is un-share: access ends at once', async () => {
    const { shareId } = await shareToSales('Have a look')
    expect('messages' in (await readSharedThread(deps, reader(), shareId))).toBe(true)
    await revokeEmailShare(deps, owner(), shareId)
    expect(await readSharedThread(deps, reader(), shareId)).toMatchObject({ ok: false, code: 'revoked' })
    expect(tables.team_chat_message[0].body).toBe('Have a look')
  })
})

describe('the picker', () => {
  it('lists the channels and DMs the owner may read here (no meeting chats, no other workspace), and warns where guests read', async () => {
    const db = memoryDb(tables)
    const targets = await listShareTargets(deps, { ...owner(), supabase: db })
    expect(targets).toEqual([
      { id: PRIVATE, kind: 'channel', label: '#leadership', outside: true },
      { id: SALES, kind: 'channel', label: '#sales', outside: false },
      { id: DM_GUEST, kind: 'dm', label: 'Drew Lin', outside: true },
    ])
  })
})
