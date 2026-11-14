/**
 * Share links (migration 646's email_share_link): Copy link makes (or hands
 * back) the owner's link, frozen at copy time; it grants nothing until its
 * OWNER pastes it in a chat, which makes a share there; anyone else's paste
 * makes nothing; revoking it ends every share made from it; its page shows
 * the owner their thread, a teammate the thread through a chat they can
 * read, and anyone else nothing. The database is the in-memory stand-in,
 * team chat's read rule and the owner's mailbox are fakes. Made-up people.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import {
  createShareLink,
  listMessageShares,
  listThreadShares,
  newShareLinkToken,
  resolveShareLink,
  revokeShareLink,
  type EmailShareDeps,
  type ShareCaller,
} from '../service'
import { bindEmailShareLinks, type BindDeps } from '../bind'
import { emailShareLinkTokens, isEmailShareLinkUrl } from '../links'
import { firstLink } from '@/lib/team-chat/link-preview'
import type { EmailShareMessage } from '../types'

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

const WS = '10000000-0000-4000-8000-000000000001'
const OTHER_WS = '10000000-0000-4000-8000-000000000002'
const OWNER = '20000000-0000-4000-8000-000000000001'
const READER = '20000000-0000-4000-8000-000000000002'
const OUTSIDER = '20000000-0000-4000-8000-000000000003'
const STRANGER = '20000000-0000-4000-8000-000000000009'
const M_OWNER = '30000000-0000-4000-8000-000000000001'
const M_READER = '30000000-0000-4000-8000-000000000002'
const M_OUTSIDER = '30000000-0000-4000-8000-000000000003'
const SALES = '40000000-0000-4000-8000-000000000001'
const DM = '40000000-0000-4000-8000-000000000002'
const MEETING = '40000000-0000-4000-8000-000000000003'
const ACCOUNT = '50000000-0000-4000-8000-000000000001'
const INDEX = '60000000-0000-4000-8000-000000000001'
const MSG = (n: number) => `80000000-0000-4000-8000-00000000000${n}`
const ORIGIN = 'https://app.northwind.example'

type Tables = Record<string, Array<Record<string, unknown>>>
let tables: Tables
let readable: Record<string, Set<string>>
let threadNow: string[]
let mailboxUp: boolean
let deps: EmailShareDeps
let bindDeps: BindDeps
let tokens: string[]

const message = (id: string): EmailShareMessage => ({
  id,
  from: { name: 'Dana Whitfield', email: 'dana@harborline.example' },
  to: [],
  cc: [],
  date: '2026-11-10T15:00:00.000Z',
  subject: 'Northwind renewal terms',
  bodyHtml: null,
  bodyText: 'Our counter is 12% off list.',
  attachments: [],
})

function caller(userId: string, memberId: string, workspaceId = WS): ShareCaller {
  const db = memoryDb(tables)
  const supabase = {
    from: db.from.bind(db),
    rpc: vi.fn(async (_fn: string, args: { ch: string }) => ({ data: !!readable[userId]?.has(args.ch), error: null })),
  } as unknown as SupabaseClient
  return { supabase, userId, workspaceId, memberId }
}
const owner = () => caller(OWNER, M_OWNER)
const reader = () => caller(READER, M_READER)

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN)
  tables = {
    member: [
      { id: M_OWNER, user_id: OWNER, workspace_id: WS, display_name: 'Avery Stone', role: 'member' },
      { id: M_READER, user_id: READER, workspace_id: WS, display_name: 'Blake Rivera', role: 'member' },
      { id: M_OUTSIDER, user_id: OUTSIDER, workspace_id: WS, display_name: 'Casey Ng', role: 'member' },
    ],
    team_chat_channel: [
      { id: SALES, workspace_id: WS, kind: 'channel', name: 'sales', team_id: null, dm_key: null, archived_at: null },
      { id: DM, workspace_id: WS, kind: 'dm', name: null, team_id: null, dm_key: [M_OWNER, M_READER].sort().join(':'), archived_at: null },
      { id: MEETING, workspace_id: WS, kind: 'meeting', name: 'Weekly sync', team_id: null, dm_key: null, archived_at: null },
    ],
    team_chat_message: [],
    email_share: [],
    email_share_link: [],
    connected_account: [{ id: ACCOUNT, user_id: OWNER, provider: 'google', capability: 'email' }],
    email_thread_index: [{ id: INDEX, user_id: OWNER, workspace_id: WS, account_id: ACCOUNT, provider: 'google', provider_thread_id: 'thr-1' }],
  }
  readable = { [OWNER]: new Set([SALES, DM, MEETING]), [READER]: new Set([SALES]), [OUTSIDER]: new Set() }
  threadNow = ['m1', 'm2']
  mailboxUp = true
  tokens = ['TokenOne_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'TokenTwo_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']
  const svc = memoryDb(tables)
  deps = {
    svc,
    mailbox: vi.fn(async (o: string, a: string, w: string) => (mailboxUp && o === OWNER && a === ACCOUNT && w === WS ? { provider: 'google' as const, token: 'tok' } : null)),
    provider: {
      threadIds: vi.fn(async () => [...threadNow]),
      message: vi.fn(async (_m, id: string) => (['m1', 'm2', 'm3'].includes(id) ? message(id) : null)),
      summary: vi.fn(async () => null),
      attachment: vi.fn(async () => null),
    },
  }
  bindDeps = { svc, mailboxReadable: vi.fn(async (o: string, a: string, w: string) => mailboxUp && o === OWNER && a === ACCOUNT && w === WS) }
})

const nextToken = () => tokens.shift()!

async function copy() {
  const r = await createShareLink(deps, owner(), { indexId: INDEX }, nextToken)
  if (!r.ok) throw new Error(r.code)
  return r
}

/** A message posted as `memberId`, then handed to the binder as the post route does. */
async function post(channelId: string, body: string, author: { userId: string; memberId: string } = { userId: OWNER, memberId: M_OWNER }, id = MSG(tables.team_chat_message.length + 1)) {
  const msg = { id, channel_id: channelId, workspace_id: WS, author_member_id: author.memberId, body, email_share_id: null as string | null }
  tables.team_chat_message.push(msg)
  const channel = tables.team_chat_channel.find((c) => c.id === channelId) as { id: string; kind: string; workspace_id: string }
  const bound = await bindEmailShareLinks(bindDeps, { workspaceId: WS, authorUserId: author.userId, authorMemberId: author.memberId, channel, message: msg })
  return { msg, bound }
}

describe('the link', () => {
  it('a new token is 256 bits of base64url', () => {
    const t = newShareLinkToken()
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newShareLinkToken()).not.toBe(t)
  })

  it('Copy link: the owner’s link, frozen now, at <app>/mail/s/<token>; the same messages hand back the same link', async () => {
    const first = await copy()
    expect(first).toMatchObject({ reused: false, url: `${ORIGIN}/mail/s/TokenOne_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` })
    expect(tables.email_share_link[0]).toMatchObject({ owner_user_id: OWNER, workspace_id: WS, account_id: ACCOUNT, provider_thread_id: 'thr-1', message_ids: ['m1', 'm2'] })
    const again = await copy()
    expect(again).toMatchObject({ reused: true, linkId: first.linkId, url: first.url })
    expect(tables.email_share_link).toHaveLength(1)
    // A reply since: a new link, frozen with it.
    threadNow = ['m1', 'm2', 'm3']
    const later = await copy()
    expect(later).toMatchObject({ reused: false })
    expect(later.linkId).not.toBe(first.linkId)
  })

  it('stores no mail: ids and the token only', async () => {
    await copy()
    expect(JSON.stringify(tables.email_share_link)).not.toMatch(/renewal|Dana|harborline|counter/i)
  })

  it('only the owner makes one', async () => {
    expect(await createShareLink(deps, reader(), { indexId: INDEX }, nextToken)).toMatchObject({ ok: false, status: 403, code: 'not_owner' })
    expect(await createShareLink(deps, reader(), { threadId: 'thr-1' }, nextToken)).toMatchObject({ ok: false, status: 404 })
    expect(tables.email_share_link).toHaveLength(0)
  })

  it('is found in words on any host of ours, whole; never unfurled', () => {
    const t = 'TokenOne_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    expect(emailShareLinkTokens(`look ${ORIGIN}/mail/s/${t}. and http://localhost:3000/mail/s/${t} again`)).toEqual([t])
    expect(emailShareLinkTokens('/mail/s/' + t)).toEqual([])
    expect(emailShareLinkTokens(`${ORIGIN}/mail/s/short`)).toEqual([])
    expect(isEmailShareLinkUrl(`${ORIGIN}/mail/s/${t}`)).toBe(true)
    expect(firstLink(`${ORIGIN}/mail/s/${t}`)).toBeNull()
    expect(firstLink(`${ORIGIN}/mail/s/${t} and https://news.example.test/story`)).toBe('https://news.example.test/story')
  })
})

describe('pasting it in a chat', () => {
  it('by its owner: a share in that chat, bound to the message, with the link’s frozen ids; the message carries it', async () => {
    const link = await copy()
    threadNow = ['m1', 'm2', 'm3']
    const { msg, bound } = await post(SALES, `Can someone check this? ${link.url}`)
    expect(bound.shareIds).toHaveLength(1)
    expect(tables.email_share[0]).toMatchObject({
      owner_user_id: OWNER,
      channel_id: SALES,
      team_chat_message_id: msg.id,
      message_ids: ['m1', 'm2'],
      link_id: link.linkId,
      shared_by_member_id: M_OWNER,
    })
    expect(msg.email_share_id).toBe(bound.shareIds[0])
    expect(bound.emailShareId).toBe(bound.shareIds[0])
  })

  it('by anyone else: nothing, the link stays plain text', async () => {
    const link = await copy()
    const { msg, bound } = await post(SALES, `found this ${link.url}`, { userId: READER, memberId: M_READER })
    expect(bound).toEqual({ shareIds: [], emailShareId: null })
    expect(tables.email_share).toHaveLength(0)
    expect(msg.email_share_id).toBeNull()
  })

  it('in two chats: two shares, one in each', async () => {
    const link = await copy()
    await post(SALES, link.url)
    await post(DM, link.url)
    expect(tables.email_share.map((s) => s.channel_id)).toEqual([SALES, DM])
    expect(new Set(tables.email_share.map((s) => s.link_id))).toEqual(new Set([link.linkId]))
  })

  it('twice (a retried send): the same share', async () => {
    const link = await copy()
    const { msg } = await post(SALES, link.url)
    const channel = tables.team_chat_channel[0] as { id: string; kind: string; workspace_id: string }
    const again = await bindEmailShareLinks(bindDeps, { workspaceId: WS, authorUserId: OWNER, authorMemberId: M_OWNER, channel, message: msg })
    expect(tables.email_share).toHaveLength(1)
    expect(again.shareIds).toEqual([tables.email_share[0].id])
  })

  it('a revoked link, a meeting chat, another workspace or a disconnected mailbox: nothing', async () => {
    const link = await copy()
    await post(MEETING, link.url)
    mailboxUp = false
    await post(SALES, link.url)
    mailboxUp = true
    const channel = tables.team_chat_channel[0] as { id: string; kind: string; workspace_id: string }
    await bindEmailShareLinks(bindDeps, { workspaceId: OTHER_WS, authorUserId: OWNER, authorMemberId: M_OWNER, channel: { ...channel, workspace_id: OTHER_WS }, message: { id: MSG(9), body: link.url } })
    expect(await revokeShareLink(deps, owner(), link.linkId)).toMatchObject({ ok: true })
    await post(SALES, link.url)
    expect(tables.email_share).toHaveLength(0)
  })

  it('several links in one message: a share for each, the message carrying the first; its readers list them', async () => {
    const one = await copy()
    tables.email_thread_index.push({ id: '60000000-0000-4000-8000-000000000002', user_id: OWNER, workspace_id: WS, account_id: ACCOUNT, provider: 'google', provider_thread_id: 'thr-2' })
    const two = await createShareLink(deps, owner(), { threadId: 'thr-2' }, nextToken)
    if (!two.ok) throw new Error(two.code)
    const { msg, bound } = await post(SALES, `${one.url} and ${two.url}`)
    expect(bound.shareIds).toHaveLength(2)
    expect(msg.email_share_id).toBe(bound.shareIds[0])
    expect(await listMessageShares(deps, reader(), msg.id)).toEqual(bound.shareIds)
    expect(await listMessageShares(deps, caller(OUTSIDER, M_OUTSIDER), msg.id)).toEqual([])
  })
})

describe('revoking it', () => {
  it('ends every share made from it, and the chips drop it; only the owner revokes', async () => {
    const link = await copy()
    await post(SALES, link.url)
    await post(DM, link.url)
    expect((await listThreadShares(deps, owner(), { indexId: INDEX })).map((c) => `${c.kind}:${c.label}`)).toEqual(['share:#sales', 'share:Blake Rivera', 'link:Link'])
    expect(await revokeShareLink(deps, reader(), link.linkId)).toMatchObject({ ok: false, status: 404 })
    expect(await revokeShareLink(deps, owner(), link.linkId)).toEqual({ ok: true, revokedShares: 2 })
    expect(tables.email_share.every((s) => !!s.revoked_at)).toBe(true)
    expect(tables.email_share_link[0].revoked_at).toBeTruthy()
    expect(await listThreadShares(deps, owner(), { indexId: INDEX })).toEqual([])
  })
})

describe('opening it directly', () => {
  it('the owner sees their thread (its frozen messages)', async () => {
    const link = await copy()
    const page = await resolveShareLink(deps, { supabase: owner().supabase, userId: OWNER }, link.token)
    expect(page).toMatchObject({ state: 'owner', revoked: false, thread: { subject: 'Northwind renewal terms', missing: 0 } })
    expect(page.state === 'owner' && page.thread?.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('a teammate who can read a chat it was pasted in sees the thread; one who can’t, nothing', async () => {
    const link = await copy()
    expect(await resolveShareLink(deps, { supabase: reader().supabase, userId: READER }, link.token)).toEqual({ state: 'outside' })
    await post(DM, link.url) // not theirs to read
    expect(await resolveShareLink(deps, { supabase: reader().supabase, userId: READER }, link.token)).toEqual({ state: 'outside' })
    await post(SALES, link.url)
    const page = await resolveShareLink(deps, { supabase: reader().supabase, userId: READER }, link.token)
    expect(page).toMatchObject({ state: 'shared', thread: { mine: false, subject: 'Northwind renewal terms' } })
    expect(await resolveShareLink(deps, { supabase: caller(OUTSIDER, M_OUTSIDER).supabase, userId: OUTSIDER }, link.token)).toEqual({ state: 'outside' })
  })

  it('anyone outside the workspace, an unknown token, or a revoked link (for a teammate): nothing, and no mailbox read', async () => {
    const link = await copy()
    await post(SALES, link.url)
    vi.mocked(deps.mailbox).mockClear()
    expect(await resolveShareLink(deps, { supabase: caller(STRANGER, 'm-x', OTHER_WS).supabase, userId: STRANGER }, link.token)).toEqual({ state: 'outside' })
    expect(await resolveShareLink(deps, { supabase: reader().supabase, userId: READER }, 'NoSuchToken_cccccccccccccccccccccccccccccc')).toEqual({ state: 'outside' })
    expect(await resolveShareLink(deps, { supabase: reader().supabase, userId: READER }, 'bad token')).toEqual({ state: 'outside' })
    expect(deps.mailbox).not.toHaveBeenCalled()
    await revokeShareLink(deps, owner(), link.linkId)
    expect(await resolveShareLink(deps, { supabase: reader().supabase, userId: READER }, link.token)).toEqual({ state: 'outside' })
    expect(await resolveShareLink(deps, { supabase: owner().supabase, userId: OWNER }, link.token)).toMatchObject({ state: 'owner', revoked: true })
  })
})
