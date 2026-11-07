/**
 * Agent links (migration 435): a request, an accept, an ignore and an end,
 * followed through real rows, and what People reads.
 */
import { describe, expect, it } from 'vitest'
import { memoryDb } from './memory-db'
import { acceptLink, endLink, endLinkForWorkspace, halfSummary, ignoreLink, listLinkCandidates, listLinks, outsideLinksAllowed, requestLink } from '../store'
import { GUESTS_PER_OWNER, normalizeChannels, unboundChannels } from '@/lib/guests/store'
import { AGENT_LINK_PENDING_MAX } from '../views'

const LIAM = '00000000-0000-4000-8000-00000000001a'
const MARCO = '00000000-0000-4000-8000-00000000002b'
const DANA = '00000000-0000-4000-8000-00000000003c'
const ACME = '00000000-0000-4000-8000-0000000000ac'
const NORTHWIND = '00000000-0000-4000-8000-0000000000bd'

type Row = Record<string, unknown>
const openPair = (a: Row, b: Row) =>
  ['requested', 'active'].includes(a.state as string) &&
  ['requested', 'active'].includes(b.state as string) &&
  a.target_user_id != null &&
  b.target_user_id != null &&
  [a.requester_user_id, a.target_user_id].sort().join() === [b.requester_user_id, b.target_user_id].sort().join()
const ownerPeer = (a: Row, b: Row) => a.state !== 'removed' && b.state !== 'removed' && a.peer_user_id != null && a.owner_user_id === b.owner_user_id && a.peer_user_id === b.peer_user_id

function world(opts: { northwindOutside?: boolean } = {}) {
  const db = memoryDb({ unique: { 'agent_link:open_pair': openPair, 'agent_guest:owner_peer': ownerPeer } })
  db.table('workspace').push({ id: ACME, name: 'Acme', settings: {} }, { id: NORTHWIND, name: 'Northwind', settings: opts.northwindOutside === false ? { outside_agent_links: false } : {} })
  db.table('member').push(
    { user_id: LIAM, workspace_id: ACME, display_name: 'Liam A' },
    { user_id: MARCO, workspace_id: ACME, display_name: 'Marco Ruiz' },
    { user_id: DANA, workspace_id: NORTHWIND, display_name: 'Dana Kim' },
  )
  return db
}

const half = (db: ReturnType<typeof world>, owner: string) => db.table('agent_guest').filter((g) => g.owner_user_id === owner)

describe('requestLink', () => {
  it('asks a teammate: the requester’s half is invited with their agent, and nothing is active yet', async () => {
    const db = world()
    const result = await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, peerUserId: MARCO, displayName: 'Marco', preset: 'colleague' })
    expect(result.ok).toBe(true)
    const [mine] = half(db, LIAM)
    expect(mine).toMatchObject({ channels: ['dial8'], peer_user_id: MARCO, state: 'invited', peer_bound_at: null })
    expect(db.table('agent_link')[0]).toMatchObject({ state: 'requested', target_user_id: MARCO, outside: false, requester_guest_id: mine.id })
  })

  it('refuses yourself, a non-teammate by id, and a second request either way', async () => {
    const db = world()
    expect(await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, peerUserId: LIAM, displayName: 'Me', preset: 'colleague' })).toEqual({ ok: false, reason: 'self' })
    expect(await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, peerUserId: DANA, displayName: 'Dana', preset: 'colleague' })).toEqual({ ok: false, reason: 'not_member' })
    await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, peerUserId: MARCO, displayName: 'Marco', preset: 'colleague' })
    expect(await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, peerUserId: MARCO, displayName: 'Marco', preset: 'colleague' })).toEqual({ ok: false, reason: 'already_linked' })
    expect(await requestLink(db.supabase, { requesterUserId: MARCO, workspaceId: ACME, peerUserId: LIAM, displayName: 'Liam', preset: 'colleague' })).toEqual({ ok: false, reason: 'they_asked' })
  })

  it('an email answers the same whether or not it’s anyone, and asking it again is already asked', async () => {
    const db = world()
    const unknown = await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, email: 'Nobody@Example.com', displayName: 'Nobody', preset: 'colleague' })
    const known = await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, email: 'dana@northwind.test', displayName: 'Dana', preset: 'colleague', resolveEmail: async () => DANA })
    expect(unknown.ok && known.ok).toBe(true)
    expect(db.table('agent_link').map((l) => [l.target_email, l.target_user_id, l.outside])).toEqual([
      ['nobody@example.com', null, true],
      ['dana@northwind.test', DANA, true],
    ])
    expect(await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, email: 'nobody@example.com', displayName: 'Nobody', preset: 'colleague' })).toEqual({ ok: false, reason: 'already_linked' })
    // Until it's accepted, People shows the typed name and no user.
    const views = await listLinks(db.supabase, LIAM, ACME)
    expect(views.map((v) => [v.peer.name, v.peer.userId, v.peer.workspaceName]).sort()).toEqual([
      ['Dana', null, null],
      ['Nobody', null, null],
    ])
  })

  it('a plain connect link needs no user or email', async () => {
    const db = world()
    const result = await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, connectTokenHash: 'h'.repeat(64), displayName: 'Someone', preset: 'colleague' })
    expect(result.ok).toBe(true)
    expect(db.table('agent_link')[0]).toMatchObject({ target_user_id: null, target_email: null, connect_token_hash: 'h'.repeat(64), outside: true })
  })

  it('outside links stop when the requester’s workspace turned them off', async () => {
    const db = world()
    db.table('workspace')[0].settings = { outside_agent_links: false }
    expect(await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, email: 'dana@northwind.test', displayName: 'Dana', preset: 'colleague' })).toEqual({ ok: false, reason: 'outside_off' })
  })

  it(`holds at most ${AGENT_LINK_PENDING_MAX} waiting requests`, async () => {
    const db = world()
    for (let i = 0; i < AGENT_LINK_PENDING_MAX; i++) {
      expect((await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, email: `p${i}@x.test`, displayName: `P${i}`, preset: 'colleague' })).ok).toBe(true)
    }
    expect(await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, email: 'one-more@x.test', displayName: 'More', preset: 'colleague' })).toEqual({ ok: false, reason: 'too_many_pending' })
  })
  it('a full People list refuses an email the same whether or not it’s anyone', async () => {
    const db = world()
    for (let i = 0; i < GUESTS_PER_OWNER; i++) db.table('agent_guest').push({ id: `g${i}`, owner_user_id: LIAM, workspace_id: ACME, state: 'active', channels: ['sms'] })
    const unknown = await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, email: 'nobody@example.com', displayName: 'Nobody', preset: 'colleague' })
    const known = await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, email: 'dana@northwind.test', displayName: 'Dana', preset: 'colleague', resolveEmail: async () => DANA })
    expect([unknown, known]).toEqual([
      { ok: false, reason: 'too_many' },
      { ok: false, reason: 'too_many' },
    ])
  })
})

describe('acceptLink', () => {
  it('binds both halves and the link goes active, each half with its own owner’s tools', async () => {
    const db = world()
    await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, peerUserId: MARCO, displayName: 'Marco', preset: 'colleague' })
    const linkId = db.table('agent_link')[0].id as string
    const result = await acceptLink(db.supabase, { linkId, userId: MARCO, workspaceId: ACME, preset: 'household' })
    expect(result.ok).toBe(true)
    const [liams] = half(db, LIAM)
    const [marcos] = half(db, MARCO)
    expect(liams).toMatchObject({ state: 'active', peer_user_id: MARCO, preset: 'colleague' })
    expect(marcos).toMatchObject({ state: 'active', peer_user_id: LIAM, channels: ['dial8'], preset: 'household', display_name: 'Liam A' })
    expect(liams.peer_bound_at).toBeTruthy()
    expect(marcos.peer_bound_at).toBeTruthy()
    expect(db.table('agent_link')[0]).toMatchObject({ state: 'active', target_guest_id: marcos.id, target_workspace_id: ACME, outside: false })

    const [view] = await listLinks(db.supabase, LIAM, ACME)
    expect(view).toMatchObject({ state: 'active', direction: 'outgoing', myHalfGuestId: liams.id, peer: { name: 'Marco Ruiz', userId: MARCO, sameWorkspace: true, workspaceName: 'Acme' } })
    expect(view.theirHalf?.summary).toBe(halfSummary(marcos.tools as string[]))
  })

  it('only the person asked, only while it waits, and not past its time', async () => {
    const db = world()
    await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, peerUserId: MARCO, displayName: 'Marco', preset: 'colleague' })
    const linkId = db.table('agent_link')[0].id as string
    expect(await acceptLink(db.supabase, { linkId, userId: LIAM, workspaceId: ACME, preset: 'colleague' })).toEqual({ ok: false, reason: 'not_found' })
    expect(await acceptLink(db.supabase, { linkId, userId: MARCO, workspaceId: NORTHWIND, preset: 'colleague' })).toEqual({ ok: false, reason: 'not_member' })
    db.table('agent_link')[0].expires_at = new Date(Date.now() - 1000).toISOString()
    expect(await acceptLink(db.supabase, { linkId, userId: MARCO, workspaceId: ACME, preset: 'colleague' })).toEqual({ ok: false, reason: 'expired' })
    expect(db.table('agent_link')[0].state).toBe('expired')
    expect(half(db, LIAM)[0].state).toBe('removed')
  })

  it('refuses an outside link the answering workspace turned off', async () => {
    const db = world({ northwindOutside: false })
    await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, email: 'dana@northwind.test', displayName: 'Dana', preset: 'colleague', resolveEmail: async () => DANA })
    const linkId = db.table('agent_link')[0].id as string
    expect(await acceptLink(db.supabase, { linkId, userId: DANA, workspaceId: NORTHWIND, preset: 'colleague' })).toEqual({ ok: false, reason: 'outside_off' })
  })

  it('keeps the tools of a half the person already had for them (one set per person)', async () => {
    const db = world()
    db.table('agent_guest').push({ id: 'g-marco-liam', owner_user_id: MARCO, workspace_id: ACME, display_name: 'Liam', phone_e164: '+14155550101', channels: ['sms'], peer_user_id: LIAM, preset: 'custom', tools: ['get_free_busy', 'message_owner'], ask_tools: [], ask_before: ['payments', 'deletes'], state: 'active', phone_bound_at: '2026-10-24T00:00:00Z' })
    await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, peerUserId: MARCO, displayName: 'Marco', preset: 'colleague' })
    await acceptLink(db.supabase, { linkId: db.table('agent_link')[0].id as string, userId: MARCO, workspaceId: ACME, preset: 'household' })
    expect(half(db, MARCO)).toHaveLength(1)
    expect(half(db, MARCO)[0]).toMatchObject({ channels: ['sms', 'dial8'], tools: ['get_free_busy', 'message_owner'], preset: 'custom' })
  })
})

describe('ignoreLink and endLink', () => {
  async function linked() {
    const db = world()
    await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, peerUserId: MARCO, displayName: 'Marco', preset: 'colleague' })
    const linkId = db.table('agent_link')[0].id as string
    await acceptLink(db.supabase, { linkId, userId: MARCO, workspaceId: ACME, preset: 'colleague' })
    return { db, linkId }
  }

  it('ignore declines it and takes the requester’s half away', async () => {
    const db = world()
    await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, peerUserId: MARCO, displayName: 'Marco', preset: 'colleague' })
    const linkId = db.table('agent_link')[0].id as string
    expect(await ignoreLink(db.supabase, { linkId, userId: LIAM })).toEqual({ ok: false, reason: 'not_found' })
    expect((await ignoreLink(db.supabase, { linkId, userId: MARCO })).ok).toBe(true)
    expect(db.table('agent_link')[0].state).toBe('declined')
    expect(half(db, LIAM)[0].state).toBe('removed')
    expect(await listLinks(db.supabase, LIAM, ACME)).toEqual([])
  })

  it('either person ends it for both: their agent comes off each half, other channels stay, open exchanges close', async () => {
    const { db, linkId } = await linked()
    const marcos = half(db, MARCO)[0]
    marcos.channels = ['sms', 'dial8']
    marcos.phone_e164 = '+14155550101'
    db.table('agent_link_exchange').push({ id: 'x1', link_id: linkId, state: 'open' })
    expect((await endLink(db.supabase, { linkId, userId: MARCO })).ok).toBe(true)
    expect(db.table('agent_link')[0]).toMatchObject({ state: 'ended', ended_by_user_id: MARCO })
    expect(db.table('agent_link_exchange')[0].state).toBe('done')
    expect(half(db, LIAM)[0].state).toBe('removed')
    expect(half(db, MARCO)[0]).toMatchObject({ state: 'active', channels: ['sms'], peer_bound_at: null })
    expect(await endLink(db.supabase, { linkId, userId: LIAM })).toEqual({ ok: false, reason: 'wrong_state' })
  })

  it('only someone on it, unless an admin ends it for the workspace', async () => {
    const { db, linkId } = await linked()
    expect(await endLink(db.supabase, { linkId, userId: DANA })).toEqual({ ok: false, reason: 'not_found' })
    expect((await endLinkForWorkspace(db.supabase, { linkId, byUserId: DANA })).ok).toBe(true)
    expect(db.table('agent_link')[0]).toMatchObject({ state: 'ended', ended_by_user_id: DANA })
  })

  it('the person asked can’t withdraw a request; the requester can', async () => {
    const db = world()
    await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, peerUserId: MARCO, displayName: 'Marco', preset: 'colleague' })
    const linkId = db.table('agent_link')[0].id as string
    expect(await endLink(db.supabase, { linkId, userId: MARCO })).toEqual({ ok: false, reason: 'wrong_state' })
    expect((await endLink(db.supabase, { linkId, userId: LIAM })).ok).toBe(true)
  })
})

describe('what People reads', () => {
  it('candidates are teammates here, not me, not linked or asked', async () => {
    const db = world()
    db.table('member').push({ user_id: DANA, workspace_id: ACME, display_name: 'Dana Kim' })
    await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, peerUserId: MARCO, displayName: 'Marco', preset: 'colleague' })
    const links = await listLinks(db.supabase, LIAM, ACME)
    expect(await listLinkCandidates(db.supabase, LIAM, ACME, links)).toEqual([{ userId: DANA, name: 'Dana Kim', agentName: null }])
  })

  it('an incoming request shows who and from where', async () => {
    const db = world()
    await requestLink(db.supabase, { requesterUserId: DANA, workspaceId: NORTHWIND, email: 'liam@acme.test', displayName: 'Liam', preset: 'colleague', resolveEmail: async () => LIAM })
    const [view] = await listLinks(db.supabase, LIAM, ACME)
    expect(view).toMatchObject({ direction: 'incoming', state: 'requested', myHalfGuestId: null, theirHalf: null, peer: { name: 'Dana Kim', userId: DANA, workspaceName: 'Northwind', sameWorkspace: false } })
  })

  it('the admin switch is on unless set to false', () => {
    expect(outsideLinksAllowed(null)).toBe(true)
    expect(outsideLinksAllowed({})).toBe(true)
    expect(outsideLinksAllowed({ outside_agent_links: false })).toBe(false)
  })

  it('a half’s line names what it holds, past the always-on tools', () => {
    expect(halfSummary(['message_owner', 'ask_owner_agent'])).toBe('Only leave messages')
    expect(halfSummary(['get_free_busy', 'message_owner'])).toBe('Free/busy')
  })
})

describe('the dial8 channel in the guest store', () => {
  it('is a known channel, never bound by an invite', () => {
    expect(normalizeChannels(['dial8', 'sms', 'nope'])).toEqual(['sms', 'dial8'])
    expect(unboundChannels({ channels: ['dial8'], phoneBoundAt: null, slackUserId: null })).toEqual([])
  })
})

describe('someone already on the list', () => {
  it('becomes the half when "Their agent" is turned on, keeping their tools', async () => {
    const db = world()
    db.table('agent_guest').push({ id: 'g-sam', owner_user_id: LIAM, workspace_id: ACME, display_name: 'Marco', phone_e164: '+14155550101', channels: ['sms'], peer_user_id: null, peer_bound_at: null, preset: 'custom', tools: ['get_free_busy'], ask_tools: [], ask_before: [], state: 'active' })
    const result = await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, peerUserId: MARCO, displayName: 'Marco', preset: 'household', guestId: 'g-sam' })
    expect(result.ok).toBe(true)
    expect(half(db, LIAM)).toHaveLength(1)
    expect(half(db, LIAM)[0]).toMatchObject({ channels: ['sms', 'dial8'], peer_user_id: MARCO, tools: ['get_free_busy'], state: 'active', peer_bound_at: null })
  })

  it('never someone else’s row, or a row already for another user', async () => {
    const db = world()
    db.table('agent_guest').push({ id: 'g-other', owner_user_id: MARCO, workspace_id: ACME, display_name: 'X', channels: ['sms'], state: 'active', tools: [] })
    db.table('agent_guest').push({ id: 'g-dana', owner_user_id: LIAM, workspace_id: ACME, display_name: 'Dana', channels: ['sms'], peer_user_id: DANA, state: 'active', tools: [] })
    expect(await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, peerUserId: MARCO, displayName: 'Marco', preset: 'colleague', guestId: 'g-other' })).toEqual({ ok: false, reason: 'not_found' })
    expect(await requestLink(db.supabase, { requesterUserId: LIAM, workspaceId: ACME, peerUserId: MARCO, displayName: 'Marco', preset: 'colleague', guestId: 'g-dana' })).toEqual({ ok: false, reason: 'not_found' })
  })
})
