/**
 * A meeting guest's public routes (src/app/m/[token]/{join,lobby,token,
 * notice,leave}) and a member's entry (enter): no session for a guest; what
 * vouches for a caller is the link's token (by its hash, made by the server
 * from the link's nonce) and their signed cookie, checked before any read.
 * The guest asks and waits (the cookie set, scoped to the link's path), the
 * lobby says when they were let in, whether the notice is owed and how many
 * members are in the call, a token is minted only for a guest admitted into
 * the live call (identity guest-<id>, never a member id; listen-only while
 * notes or a recording are on that the server has no go of theirs for, and
 * nothing the client sends changes that), the notice records the go before
 * publishing is allowed, a removed guest gets none, a bad or old link answers
 * the same as any other, a body too large is refused unread, and every limit
 * holds. A member is joined only by a same-origin POST, never by opening the
 * link.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { TokenVerifier } from 'livekit-server-sdk'
import { memoryDb } from '@/test/memory-db'
import { KEY, LIVEKIT_ENV, SECRET } from '@/lib/team-calls/__tests__/signing'

const WS = '11111111-1111-4111-8111-111111111111'
const MEETING = '22222222-2222-4222-8222-222222222222'
const CH = '33333333-3333-4333-8333-333333333333'
const CALL = '44444444-4444-4444-8444-444444444444'
const GUEST = '55555555-5555-4555-8555-555555555555'
const HOST = '66666666-6666-4666-8666-666666666666'

const h = vi.hoisted(() => ({
  afters: [] as Array<() => Promise<unknown>>,
  svc: null as unknown as SupabaseClient,
  rpcs: [] as Array<[string, Record<string, unknown>]>,
  rpc: {} as Record<string, (args: Record<string, unknown>) => { data: unknown; error: unknown }>,
  rooms: { open: new Set<string>(), allowed: [] as string[] },
  user: null as string | null,
}))

vi.mock('server-only', () => ({}))
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (task: () => Promise<unknown>) => {
    h.afters.push(task)
  },
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => h.svc }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user ? { id: h.user } : null } }) },
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcs.push([`person:${name}`, args])
      return h.rpc[`person:${name}`]?.(args) ?? { data: null, error: { message: 'no' } }
    },
  }),
}))
vi.mock('@/lib/team-calls/livekit', async (orig) => ({
  ...(await orig<typeof import('@/lib/team-calls/livekit')>()),
  openTeamCallRooms: async (_c: unknown, names: string[]) => new Set(names.filter((n) => h.rooms.open.has(n))),
  createTeamCallRoom: async (_c: unknown, room: string) => void h.rooms.open.add(room),
  allowGuestPublish: async (_c: unknown, _room: string, guestId: string) => void h.rooms.allowed.push(guestId),
}))

import { meetingToken, signGuestCookie, tokenDigest, MEETING_GUEST_COOKIE } from '@/lib/meeting-links/link'
import { meetingMemoryLimiter } from '@/lib/meeting-links/limits'
import { POST as join } from '../join/route'
import { GET as lobby } from '../lobby/route'
import { POST as tokenRoute } from '../token/route'
import { POST as notice } from '../notice/route'
import { POST as leave } from '../leave/route'
import * as enterRoute from '../enter/route'
import { readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'

const NONCE = 'route-nonce-aaaaaaaaaaaaaaaaaaaaaaa'
const USER = '99999999-0000-4000-8000-000000000001'

let tables: Record<string, Array<Record<string, unknown>>>
let TOKEN: string
const params = () => ({ params: Promise.resolve({ token: TOKEN }) })
let addr = 0

function req(method: 'GET' | 'POST', path: string, opts: { body?: unknown; cookie?: string | null; origin?: string | null; ip?: string; extra?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { host: 'nativeintelligence.dev', 'x-forwarded-for': opts.ip ?? `198.51.100.${addr}` }
  if (opts.origin !== null) headers['sec-fetch-site'] = opts.origin ?? 'same-origin'
  if (opts.cookie) headers.cookie = `${MEETING_GUEST_COOKIE}=${encodeURIComponent(opts.cookie)}`
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  if (opts.extra) Object.assign(headers, opts.extra)
  return new NextRequest(`https://nativeintelligence.dev/m/${TOKEN}/${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
}

const cookieFor = (guestId = GUEST, closes = new Date(Date.now() + 3_600_000)) => signGuestCookie(TOKEN, guestId, closes).value

function meetingRow(over: Record<string, unknown> = {}) {
  return {
    id: MEETING,
    workspace_id: WS,
    channel_id: CH,
    host_member_id: HOST,
    title: 'Design review',
    starts_at: null,
    opens_at: new Date(Date.now() - 60_000).toISOString(),
    closes_at: new Date(Date.now() + 86_400_000).toISOString(),
    revoked_at: null,
    token_hash: tokenDigest(TOKEN),
    token_nonce: NONCE,
    ...over,
  }
}

beforeEach(() => {
  Object.assign(process.env, LIVEKIT_ENV, { MEETING_LINK_SECRET: 'route-test-secret' })
  TOKEN = meetingToken(MEETING, NONCE)
  addr++
  h.user = null
  h.afters = []
  h.rpcs = []
  h.rooms = { open: new Set(), allowed: [] }
  tables = {
    meeting: [meetingRow()],
    team_chat_channel: [{ id: CH, archived_at: null }],
    meeting_guest: [],
    team_call: [],
    notification: [],
    member: [{ id: HOST, display_name: 'Rosa Lind' }],
  }
  h.rpc = {
    meeting_rate_hit: () => ({ data: true, error: null }),
    meeting_guest_request: () => ({ data: [{ outcome: 'waiting', guest_id: GUEST, host_member_id: HOST, members_in_call: 0, call_id: null }], error: null }),
    meeting_guest_poll: (a) => {
      const g = tables.meeting_guest.find((x) => x.id === a.target_guest)
      if (!g || a.token_digest !== tokenDigest(TOKEN)) return { data: [], error: null }
      return { data: [{ state: g.state, call_id: g.call_id ?? null, room: null, notes: false, recording: 'off', open: true, needs_notice: false, members_in_call: 0 }], error: null }
    },
    // 574's meeting_guest_ack: an admitted guest's go to what is on in their live call.
    meeting_guest_ack: (a) => {
      const g = tables.meeting_guest.find((x) => x.id === a.target_guest)
      const c = tables.team_call.find((x) => x.id === g?.call_id && x.status === 'live')
      if (!g || g.state !== 'admitted' || !c || a.token_digest !== tokenDigest(TOKEN)) return { data: [], error: null }
      g.notes_ack_round = Math.max(Number(g.notes_ack_round ?? 0), Number(c.notes_round ?? 0))
      if (c.recording === 'on' || c.recording === 'starting') g.recording_ack_at = new Date(Date.now() + 1000).toISOString()
      return { data: [{ call_id: c.id, room: c.room }], error: null }
    },
    meeting_guest_leave: () => ({ data: 'left', error: null }),
  }
  h.svc = Object.assign(memoryDb(tables), {
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcs.push([name, args])
      return h.rpc[name]?.(args) ?? { data: null, error: null }
    },
  }) as unknown as SupabaseClient
})
afterEach(() => {
  delete process.env.MEETING_LINK_SECRET
})

describe('asking to join', () => {
  it('waits, with a signed cookie scoped to this meeting’s path, http-only and strict; the host is told when nobody is in the call', async () => {
    const res = await join(req('POST', 'join', { body: { name: '  Dana   Lee ' } }), params())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ state: 'waiting' })
    const set = res.headers.get('set-cookie') ?? ''
    expect(set).toContain(`${MEETING_GUEST_COOKIE}=`)
    expect(set).toContain(`Path=/m/${TOKEN}`)
    expect(set.toLowerCase()).toContain('httponly')
    expect(set.toLowerCase()).toContain('samesite=strict')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const asked = h.rpcs.find((r) => r[0] === 'meeting_guest_request')![1]
    expect(asked).toMatchObject({ target_meeting: MEETING, guest_name: 'Dana Lee', max_waiting: 10 })
    expect(String(asked.key)).toHaveLength(32)
    expect(String(asked.key)).not.toContain('198.51')
    expect(h.afters).toHaveLength(1)
    await h.afters[0]()
    expect(tables.notification).toHaveLength(1)
    expect(tables.notification[0]).toMatchObject({ type: 'meeting_waiting', recipient_id: HOST, target_type: 'team_chat_channel', target_id: CH, title: 'Dana Lee is waiting to join Design review' })
  })

  it('someone already in the call to let them in: no notice', async () => {
    h.rpc.meeting_guest_request = () => ({ data: [{ outcome: 'waiting', guest_id: GUEST, host_member_id: HOST, members_in_call: 2, call_id: CALL }], error: null })
    await join(req('POST', 'join', { body: { name: 'Dana' } }), params())
    expect(h.afters).toHaveLength(0)
  })

  it('a second notice while the first is unread renames it, never a second one', async () => {
    tables.notification.push({ id: 'n1', type: 'meeting_waiting', recipient_id: HOST, target_id: CH, is_read: false, created_at: new Date().toISOString(), title: 'Lee is waiting to join Design review' })
    await join(req('POST', 'join', { body: { name: 'Dana' } }), params())
    await h.afters[0]()
    expect(tables.notification).toHaveLength(1)
    expect(tables.notification[0].title).toBe('Dana is waiting to join Design review')
  })

  it('asking again with their cookie (a reload) keeps their place', async () => {
    tables.meeting_guest.push({ id: GUEST, state: 'waiting' })
    const res = await join(req('POST', 'join', { body: { name: 'Dana' }, cookie: cookieFor() }), params())
    expect(await res.json()).toEqual({ state: 'waiting' })
    expect(h.rpcs.some((r) => r[0] === 'meeting_guest_request')).toBe(false)
  })

  it('a name of the wrong shape is refused before anything is written', async () => {
    for (const name of ['', 'a'.repeat(61), 'http://evil.example', '1234', '<b>x</b>']) {
      const res = await join(req('POST', 'join', { body: { name } }), params())
      expect(res.status, name).toBe(400)
      expect((await res.json()).code).toBe('BAD_NAME')
    }
    expect(h.rpcs.some((r) => r[0] === 'meeting_guest_request')).toBe(false)
  })

  it('a full lobby and an early link each say so; a bad, unknown, revoked, expired or archived link all answer the same', async () => {
    h.rpc.meeting_guest_request = () => ({ data: [{ outcome: 'full' }], error: null })
    expect((await (await join(req('POST', 'join', { body: { name: 'Dana' } }), params())).json()).code).toBe('LOBBY_FULL')
    tables.meeting[0] = meetingRow({ opens_at: new Date(Date.now() + 600_000).toISOString() })
    expect((await (await join(req('POST', 'join', { body: { name: 'Dana' } }), params())).json()).code).toBe('MEETING_EARLY')

    const answers: Array<[string, unknown]> = []
    const variants: Array<() => void> = [
      () => (TOKEN = 'not-a-token'),
      () => (TOKEN = meetingToken('99999999-9999-4999-8999-999999999999', NONCE)),
      // The link was replaced (New link): the old token's nonce is not the meeting's any more.
      () => (tables.meeting[0] = meetingRow({ token_nonce: 'route-nonce-bbbbbbbbbbbbbbbbbbbbbbb' })),
      () => (tables.meeting[0] = meetingRow({ revoked_at: new Date().toISOString() })),
      () => (tables.meeting[0] = meetingRow({ closes_at: new Date(Date.now() - 1000).toISOString() })),
      () => (tables.team_chat_channel[0] = { id: CH, archived_at: new Date().toISOString() }),
    ]
    for (const v of variants) {
      TOKEN = meetingToken(MEETING, NONCE)
      tables.meeting[0] = meetingRow()
      tables.team_chat_channel[0] = { id: CH, archived_at: null }
      v()
      const res = await join(req('POST', 'join', { body: { name: 'Dana' } }), params())
      answers.push([String(res.status), await res.json()])
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1)
    expect(answers[0]).toEqual(['404', { error: 'This link is no longer active', code: 'MEETING_INACTIVE' }])
  })

  it('over a limit (per address, per link, opening or asking): too many tries', async () => {
    h.rpc.meeting_rate_hit = (a) => ({ data: a.bucket_name !== 'join:addr', error: null })
    const res = await join(req('POST', 'join', { body: { name: 'Dana' } }), params())
    expect(res.status).toBe(429)
    h.rpc.meeting_rate_hit = (a) => ({ data: a.bucket_name !== 'lookup:link', error: null })
    expect((await join(req('POST', 'join', { body: { name: 'Dana' } }), params())).status).toBe(429)
    expect(h.rpcs.filter((r) => r[0] === 'meeting_guest_request')).toHaveLength(0)
  })

  it('a token the server did not make (a hash a member wrote themself) never opens a meeting; an unknown link is never counted per link', async () => {
    const chosen = 'A'.repeat(32)
    tables.meeting[0] = meetingRow({ token_hash: tokenDigest(chosen) })
    TOKEN = chosen
    expect((await join(req('POST', 'join', { body: { name: 'Dana' } }), params())).status).toBe(404)
    expect(h.rpcs.filter((r) => r[0] === 'meeting_rate_hit').map((r) => r[1].bucket_name)).toEqual(['lookup:addr'])
  })

  it('a body over 4 KB is refused before it is read, before anything is looked up', async () => {
    const res = await join(req('POST', 'join', { body: { name: 'Dana', pad: 'x'.repeat(5000) } }), params())
    expect(res.status).toBe(413)
    expect(h.rpcs).toHaveLength(0)
    const lying = await join(req('POST', 'join', { body: { name: 'Dana', pad: 'x'.repeat(5000) }, extra: { 'content-length': '20' } }), params())
    expect(lying.status).toBe(413)
    expect((await leave(req('POST', 'leave', { cookie: cookieFor(), body: { pad: 'x'.repeat(5000) } }), params())).status).toBe(413)
    expect(h.rpcs).toHaveLength(0)
  })

  it('only from the meeting’s own page (another site’s form is refused)', async () => {
    expect((await join(req('POST', 'join', { body: { name: 'Dana' }, origin: 'cross-site' }), params())).status).toBe(403)
  })

  it('while calling is off, the link is not active', async () => {
    delete process.env.LIVEKIT_URL
    expect((await join(req('POST', 'join', { body: { name: 'Dana' } }), params())).status).toBe(404)
    Object.assign(process.env, LIVEKIT_ENV)
  })
})

describe('the lobby', () => {
  it('without a cookie, or a tampered, expired or another link’s one: 401, and nothing read', async () => {
    tables.meeting_guest.push({ id: GUEST, state: 'waiting' })
    const good = cookieFor()
    const [id, exp, mac] = good.split('.')
    // Tampered at its first character, which is always another signature. Its last
    // one is "A" one time in sixteen, so "ends in A" left the cookie as it was that often.
    const tampered = `${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`
    const bad = [null, `${id}.${exp}.${tampered}`, `${id}.${Date.now() - 1}.${mac}`,signGuestCookie(meetingToken('99999999-9999-4999-8999-999999999999', NONCE), GUEST, new Date(Date.now() + 60_000)).value]
    for (const cookie of bad) {
      const res = await lobby(req('GET', 'lobby', { cookie }), params())
      expect(res.status).toBe(401)
    }
    expect(h.rpcs).toHaveLength(0)
  })

  it('answers the guest’s state, whether the notice is owed and the members in the call, in one read', async () => {
    tables.meeting_guest.push({ id: GUEST, state: 'waiting' })
    const res = await lobby(req('GET', 'lobby', { cookie: cookieFor() }), params())
    expect(await res.json()).toEqual({ state: 'waiting', notes: false, recording: 'off', open: true, needsNotice: false, membersInCall: 0 })
    expect(h.rpcs.map((r) => r[0])).toEqual(['meeting_guest_poll'])
    expect(h.rpcs[0][1]).toEqual({ target_guest: GUEST, token_digest: tokenDigest(TOKEN) })
  })

  it('in the call: the notice owed after notes came on, and no member left (the host has left)', async () => {
    tables.meeting_guest.push({ id: GUEST, state: 'admitted' })
    h.rpc.meeting_guest_poll = () => ({ data: [{ state: 'admitted', call_id: CALL, room: 'r', notes: true, recording: 'off', open: true, needs_notice: true, members_in_call: 0 }], error: null })
    expect(await (await lobby(req('GET', 'lobby', { cookie: cookieFor() }), params())).json()).toMatchObject({ notes: true, needsNotice: true, membersInCall: 0 })
  })

  it('a guest the link does not know: 401, the cookie cleared', async () => {
    const res = await lobby(req('GET', 'lobby', { cookie: cookieFor() }), params())
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toContain(`Path=/m/${TOKEN}`)
  })

  it('polling too fast is limited in memory, per guest', async () => {
    tables.meeting_guest.push({ id: '77777777-7777-4777-8777-777777777777', state: 'waiting' })
    const cookie = cookieFor('77777777-7777-4777-8777-777777777777')
    let limited = 0
    for (let i = 0; i < 45; i++) if ((await lobby(req('GET', 'lobby', { cookie }), params())).status === 429) limited++
    expect(limited).toBe(5)
    expect(meetingMemoryLimiter.size).toBeGreaterThan(0)
  })
})

describe('a guest’s token', () => {
  const room = `tc-${CALL}`
  beforeEach(() => {
    tables.team_call.push({ id: CALL, room, status: 'live', started_at: new Date().toISOString(), channel_id: CH, notes: false, notes_round: 0, recording: 'off', recording_started_at: null })
    h.rooms.open.add(room)
  })

  it('an admitted guest gets one: identity guest-<id>, their name, marked a guest, the room', async () => {
    tables.meeting_guest.push({ id: GUEST, meeting_id: MEETING, name: 'Dana Lee', state: 'admitted', call_id: CALL, notes_ack_round: 0, recording_ack_at: null })
    const res = await tokenRoute(req('POST', 'token', { cookie: cookieFor() }), params())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.join).toMatchObject({ room, callId: CALL, url: LIVEKIT_ENV.LIVEKIT_URL, canPublish: true })
    const claims = await new TokenVerifier(KEY, SECRET).verify(json.join.token)
    expect(claims.sub).toBe(`guest-${GUEST}`)
    expect(claims.name).toBe('Dana Lee')
    expect(JSON.parse(String(claims.metadata))).toEqual({ guest: true })
    expect(claims.video).toMatchObject({ room, roomJoin: true, canPublish: true, canPublishData: false, canUpdateOwnMetadata: false })
    expect(claims.video?.roomAdmin).toBeFalsy()
  })

  it('notes on in a round they have not said go to: listen-only, whatever the page claims; the notice records the go, then lifts it', async () => {
    Object.assign(tables.team_call[0], { notes: true, notes_round: 1 })
    tables.meeting_guest.push({ id: GUEST, meeting_id: MEETING, name: 'Dana', state: 'admitted', call_id: CALL, notes_ack_round: 0, recording_ack_at: null })
    const res = await tokenRoute(req('POST', 'token', { cookie: cookieFor() }), params())
    const json = await res.json()
    expect(json.join.canPublish).toBe(false)
    expect((await new TokenVerifier(KEY, SECRET).verify(json.join.token)).video?.canPublish).toBe(false)
    // Round 1's client said "seen"; the server no longer listens to that.
    const claimed = await tokenRoute(req('POST', 'token', { cookie: cookieFor(), body: { seen: { notes: true, recording: true } } }), params())
    expect((await claimed.json()).join.canPublish).toBe(false)
    expect((await notice(req('POST', 'notice', { cookie: cookieFor() }), params())).status).toBe(200)
    const order = h.rpcs.map((r) => r[0])
    expect(order).toContain('meeting_guest_ack')
    expect(h.rpcs.find((r) => r[0] === 'meeting_guest_ack')![1]).toEqual({ target_guest: GUEST, token_digest: tokenDigest(TOKEN) })
    expect(h.rooms.allowed).toEqual([GUEST])
    expect(tables.meeting_guest[0].notes_ack_round).toBe(1)
    expect((await (await tokenRoute(req('POST', 'token', { cookie: cookieFor() }), params())).json()).join.canPublish).toBe(true)
    // Notes off and on again: a new round, the go owed again.
    tables.team_call[0].notes_round = 2
    expect((await (await tokenRoute(req('POST', 'token', { cookie: cookieFor() }), params())).json()).join.canPublish).toBe(false)
  })

  it('a recording started that they have not said go to: listen-only until the notice', async () => {
    Object.assign(tables.team_call[0], { recording: 'on', recording_started_at: new Date(Date.now() - 1000).toISOString() })
    tables.meeting_guest.push({ id: GUEST, meeting_id: MEETING, name: 'Dana', state: 'admitted', call_id: CALL, notes_ack_round: 0, recording_ack_at: null })
    expect((await (await tokenRoute(req('POST', 'token', { cookie: cookieFor() }), params())).json()).join.canPublish).toBe(false)
    expect((await notice(req('POST', 'notice', { cookie: cookieFor() }), params())).status).toBe(200)
    expect((await (await tokenRoute(req('POST', 'token', { cookie: cookieFor() }), params())).json()).join.canPublish).toBe(true)
  })

  it('the notice for a guest the server has no admitted call for: 409, publishing never allowed', async () => {
    Object.assign(tables.team_call[0], { notes: true, notes_round: 1, status: 'ended' })
    tables.meeting_guest.push({ id: GUEST, meeting_id: MEETING, name: 'Dana', state: 'admitted', call_id: CALL, notes_ack_round: 0, recording_ack_at: null })
    expect((await notice(req('POST', 'notice', { cookie: cookieFor() }), params())).status).toBe(409)
    expect(h.rooms.allowed).toEqual([])
    expect(tables.meeting_guest[0].notes_ack_round).toBe(0)
  })

  it('waiting, declined, removed or left: none (a removal stops any renewal)', async () => {
    for (const state of ['waiting', 'declined', 'removed', 'left']) {
      tables.meeting_guest.splice(0, tables.meeting_guest.length, { id: GUEST, meeting_id: MEETING, name: 'Dana', state, call_id: state === 'removed' ? CALL : null, notes_ack_round: 0, recording_ack_at: null })
      const res = await tokenRoute(req('POST', 'token', { cookie: cookieFor() }), params())
      expect(res.status, state).toBe(409)
      expect((await notice(req('POST', 'notice', { cookie: cookieFor() }), params())).status, state).toBe(409)
    }
    expect(h.rooms.allowed).toEqual([])
  })

  it('a call that ended, or a revoked link: none', async () => {
    tables.meeting_guest.push({ id: GUEST, meeting_id: MEETING, name: 'Dana', state: 'admitted', call_id: CALL })
    tables.team_call[0].status = 'ended'
    expect((await tokenRoute(req('POST', 'token', { cookie: cookieFor() }), params())).status).toBe(409)
    tables.team_call[0].status = 'live'
    tables.meeting[0] = meetingRow({ revoked_at: new Date().toISOString() })
    expect((await tokenRoute(req('POST', 'token', { cookie: cookieFor() }), params())).status).toBe(404)
  })

  it('without a valid cookie: 401', async () => {
    tables.meeting_guest.push({ id: GUEST, meeting_id: MEETING, name: 'Dana', state: 'admitted', call_id: CALL })
    expect((await tokenRoute(req('POST', 'token', {}), params())).status).toBe(401)
    expect((await tokenRoute(req('POST', 'token', { cookie: cookieFor('88888888-8888-4888-8888-888888888888') }), params())).status).toBe(401)
  })

  it('the call recorder taking the notes changes nothing for a guest: listen-only until they say go', async () => {
    Object.assign(process.env, { TEAM_CALL_RECORDER: 'on', CAPTURE_FEED_SECRET: 'capture-feed-secret-of-its-own-0123456789' })
    const OTHER_GUEST = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e'
    try {
      Object.assign(tables.team_call[0], { notes: true, notes_round: 1 })
      tables.meeting_guest.push({ id: OTHER_GUEST, meeting_id: MEETING, name: 'Dana', state: 'admitted', call_id: CALL, notes_ack_round: 0, recording_ack_at: null })
      // (Their go then lifts it, as the test above shows.) A guest of its own: the token limit is per guest.
      expect((await (await tokenRoute(req('POST', 'token', { cookie: cookieFor(OTHER_GUEST) }), params())).json()).join.canPublish).toBe(false)
    } finally {
      delete process.env.TEAM_CALL_RECORDER
      delete process.env.CAPTURE_FEED_SECRET
    }
  })
})

describe('leaving', () => {
  it('goes, and the cookie with it', async () => {
    const res = await leave(req('POST', 'leave', { cookie: cookieFor() }), params())
    expect(await res.json()).toEqual({ state: 'left' })
    expect(h.rpcs.find((r) => r[0] === 'meeting_guest_leave')![1]).toEqual({ target_guest: GUEST, token_digest: tokenDigest(TOKEN) })
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/)
  })
})

describe('a member opening the link', () => {
  const enter = enterRoute.POST

  it('a plain GET joins nobody: the entry is a POST only, and the page never joins', () => {
    expect(Object.keys(enterRoute)).not.toContain('GET')
    const page = readFileSync(joinPath(__dirname, '..', 'page.tsx'), 'utf8')
    expect(page).not.toMatch(/joinMeetingByDigest|meeting_join/)
    expect(page).toContain('method="post"')
  })

  it('a member of the workspace, same-origin POST: joined, taken to the conversation; not counted per link', async () => {
    h.user = USER
    tables.member.push({ id: 'm-1', user_id: USER, workspace_id: WS })
    h.rpc['person:meeting_join'] = () => ({ data: [{ meeting_id: MEETING, channel_id: CH, workspace_id: WS, title: 'Design review' }], error: null })
    const res = await enter(req('POST', 'enter', { extra: { cookie: `workspace_id=${WS}` } }), params())
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`/account?meeting=${CH}`)
    expect(h.rpcs.find((r) => r[0] === 'person:meeting_join')![1]).toEqual({ token_digest: tokenDigest(TOKEN) })
    expect(h.rpcs.filter((r) => r[0] === 'meeting_rate_hit').map((r) => r[1].bucket_name)).toEqual(['lookup:addr'])
  })

  it('another workspace current: switched on the way', async () => {
    h.user = USER
    tables.member.push({ id: 'm-1', user_id: USER, workspace_id: WS })
    h.rpc['person:meeting_join'] = () => ({ data: [{ meeting_id: MEETING, channel_id: CH, workspace_id: WS, title: 'Design review' }], error: null })
    const res = await enter(req('POST', 'enter', { extra: { cookie: 'workspace_id=other-ws' } }), params())
    expect(res.headers.get('location')).toBe(`/account?meeting=${CH}&switch_to=${WS}`)
  })

  it('signed in but not a member: back to the page, never joined, counted per link like anyone', async () => {
    h.user = USER
    const res = await enter(req('POST', 'enter'), params())
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`/m/${TOKEN}`)
    expect(h.rpcs.some((r) => r[0] === 'person:meeting_join')).toBe(false)
    expect(h.rpcs.filter((r) => r[0] === 'meeting_rate_hit').map((r) => r[1].bucket_name)).toEqual(['lookup:addr', 'lookup:link'])
  })

  it('not signed in, another site’s form, or a body too large: never joined', async () => {
    expect((await enter(req('POST', 'enter'), params())).headers.get('location')).toBe(`/m/${TOKEN}`)
    h.user = USER
    tables.member.push({ id: 'm-1', user_id: USER, workspace_id: WS })
    expect((await enter(req('POST', 'enter', { origin: 'cross-site' }), params())).status).toBe(403)
    expect((await enter(req('POST', 'enter', { body: { pad: 'x'.repeat(5000) } }), params())).status).toBe(413)
    expect(h.rpcs.some((r) => r[0] === 'person:meeting_join')).toBe(false)
  })
})
