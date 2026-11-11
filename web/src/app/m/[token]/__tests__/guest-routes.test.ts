/**
 * A meeting guest's public routes (src/app/m/[token]/{join,lobby,token,
 * notice,leave}): no session; what vouches for a caller is the link's token
 * (by its hash) and their signed cookie, checked before any read. The guest
 * asks and waits (the cookie set, scoped to the link's path), the lobby says
 * when they were let in, a token is minted only for a guest admitted into the
 * live call (identity guest-<id>, never a member id; listen-only while notes
 * are on that their page did not show them), a removed guest gets none, a bad
 * or old link answers the same as any other, and every limit holds.
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
}))

vi.mock('server-only', () => ({}))
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (task: () => Promise<unknown>) => {
    h.afters.push(task)
  },
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => h.svc }))
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

let tables: Record<string, Array<Record<string, unknown>>>
let TOKEN: string
const params = () => ({ params: Promise.resolve({ token: TOKEN }) })
let addr = 0

function req(method: 'GET' | 'POST', path: string, opts: { body?: unknown; cookie?: string | null; origin?: string | null; ip?: string } = {}) {
  const headers: Record<string, string> = { host: 'nativeintelligence.dev', 'x-forwarded-for': opts.ip ?? `198.51.100.${addr}` }
  if (opts.origin !== null) headers['sec-fetch-site'] = opts.origin ?? 'same-origin'
  if (opts.cookie) headers.cookie = `${MEETING_GUEST_COOKIE}=${encodeURIComponent(opts.cookie)}`
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
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
    ...over,
  }
}

beforeEach(() => {
  Object.assign(process.env, LIVEKIT_ENV, { MEETING_LINK_SECRET: 'route-test-secret' })
  TOKEN = meetingToken(MEETING)
  addr++
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
      return { data: [{ state: g.state, call_id: g.call_id ?? null, room: null, notes: false, recording: 'off', open: true }], error: null }
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

  it('a full lobby, a removed guest’s address, an early link each say so; a bad, unknown, revoked, expired or archived link all answer the same', async () => {
    h.rpc.meeting_guest_request = () => ({ data: [{ outcome: 'full' }], error: null })
    expect((await (await join(req('POST', 'join', { body: { name: 'Dana' } }), params())).json()).code).toBe('LOBBY_FULL')
    h.rpc.meeting_guest_request = () => ({ data: [{ outcome: 'refused' }], error: null })
    expect((await (await join(req('POST', 'join', { body: { name: 'Dana' } }), params())).json()).code).toBe('MEETING_REFUSED')
    tables.meeting[0] = meetingRow({ opens_at: new Date(Date.now() + 600_000).toISOString() })
    expect((await (await join(req('POST', 'join', { body: { name: 'Dana' } }), params())).json()).code).toBe('MEETING_EARLY')

    const answers: Array<[string, unknown]> = []
    const variants: Array<() => void> = [
      () => (TOKEN = 'not-a-token'),
      () => (TOKEN = meetingToken('99999999-9999-4999-8999-999999999999')),
      () => (tables.meeting[0] = meetingRow({ revoked_at: new Date().toISOString() })),
      () => (tables.meeting[0] = meetingRow({ closes_at: new Date(Date.now() - 1000).toISOString() })),
      () => (tables.team_chat_channel[0] = { id: CH, archived_at: new Date().toISOString() }),
    ]
    for (const v of variants) {
      TOKEN = meetingToken(MEETING)
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
    const bad = [null, `${id}.${exp}.${mac.slice(0, -1)}A`, `${id}.${Date.now() - 1}.${mac}`, signGuestCookie(meetingToken('99999999-9999-4999-8999-999999999999'), GUEST, new Date(Date.now() + 60_000)).value]
    for (const cookie of bad) {
      const res = await lobby(req('GET', 'lobby', { cookie }), params())
      expect(res.status).toBe(401)
    }
    expect(h.rpcs).toHaveLength(0)
  })

  it('answers the guest’s state, in one read', async () => {
    tables.meeting_guest.push({ id: GUEST, state: 'waiting' })
    const res = await lobby(req('GET', 'lobby', { cookie: cookieFor() }), params())
    expect(await res.json()).toEqual({ state: 'waiting', notes: false, recording: 'off', open: true })
    expect(h.rpcs.map((r) => r[0])).toEqual(['meeting_guest_poll'])
    expect(h.rpcs[0][1]).toEqual({ target_guest: GUEST, token_digest: tokenDigest(TOKEN) })
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
    tables.team_call.push({ id: CALL, room, status: 'live', started_at: new Date().toISOString(), channel_id: CH, notes: false, recording: 'off' })
    h.rooms.open.add(room)
  })

  it('an admitted guest gets one: identity guest-<id>, their name, marked a guest, the room', async () => {
    tables.meeting_guest.push({ id: GUEST, meeting_id: MEETING, name: 'Dana Lee', state: 'admitted', call_id: CALL })
    const res = await tokenRoute(req('POST', 'token', { cookie: cookieFor(), body: { seen: { notes: false, recording: false } } }), params())
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

  it('notes on that their page did not show them: listen-only; the notice lifts it', async () => {
    tables.team_call[0].notes = true
    tables.meeting_guest.push({ id: GUEST, meeting_id: MEETING, name: 'Dana', state: 'admitted', call_id: CALL })
    const res = await tokenRoute(req('POST', 'token', { cookie: cookieFor(), body: { seen: { notes: false, recording: false } } }), params())
    const json = await res.json()
    expect(json.join.canPublish).toBe(false)
    expect((await new TokenVerifier(KEY, SECRET).verify(json.join.token)).video?.canPublish).toBe(false)
    const shown = await tokenRoute(req('POST', 'token', { cookie: cookieFor(), body: { seen: { notes: true, recording: false } } }), params())
    expect((await shown.json()).join.canPublish).toBe(true)
    expect((await notice(req('POST', 'notice', { cookie: cookieFor() }), params())).status).toBe(200)
    expect(h.rooms.allowed).toEqual([GUEST])
  })

  it('waiting, declined, removed or left: none (a removal stops any renewal)', async () => {
    for (const state of ['waiting', 'declined', 'removed', 'left']) {
      tables.meeting_guest.splice(0, tables.meeting_guest.length, { id: GUEST, meeting_id: MEETING, name: 'Dana', state, call_id: state === 'removed' ? CALL : null })
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
})

describe('leaving', () => {
  it('goes, and the cookie with it', async () => {
    const res = await leave(req('POST', 'leave', { cookie: cookieFor() }), params())
    expect(await res.json()).toEqual({ state: 'left' })
    expect(h.rpcs.find((r) => r[0] === 'meeting_guest_leave')![1]).toEqual({ target_guest: GUEST, token_digest: tokenDigest(TOKEN) })
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/)
  })
})
