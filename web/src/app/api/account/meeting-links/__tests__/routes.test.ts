/**
 * The members' meeting routes (src/app/api/account/meeting-links/*): a link
 * made as the person (they are its host; the token made by the server from
 * a random nonce per link, only its hash and the nonce sent), a
 * conversation's meeting with its link, the host's New link, a member
 * joining by a link inside the app, admitting, declining and removing a
 * guest (a removal drains the eject outbox at once), the host revoking and
 * ending; nothing at all while calling is off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { LIVEKIT_ENV } from '@/lib/team-calls/__tests__/signing'

const WS = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const ME = '33333333-3333-4333-8333-333333333333'
const MEETING = '44444444-4444-4444-8444-444444444444'
const CH = '55555555-5555-4555-8555-555555555555'
const GUEST = '66666666-6666-4666-8666-666666666666'
const CALL = '77777777-7777-4777-8777-777777777777'

const h = vi.hoisted(() => ({
  afters: [] as Array<() => Promise<unknown>>,
  db: null as unknown as SupabaseClient,
  svc: null as unknown as SupabaseClient,
  rpcs: [] as Array<[string, Record<string, unknown>]>,
  rpc: {} as Record<string, { data: unknown; error: unknown }>,
  drained: 0,
  closed: [] as string[],
  calendar: [] as Array<[string, unknown]>,
  calendarFails: false,
}))

vi.mock('server-only', () => ({}))
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (task: () => Promise<unknown>) => void h.afters.push(task),
}))
vi.mock('@/lib/api-auth', () => ({
  requireUser: async () => ({ supabase: h.db, user: { id: USER } }),
  requireWorkspace: async () => ({ supabase: h.db, user: { id: USER }, workspaceId: WS }),
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => h.svc }))
vi.mock('@/lib/team-calls/eject', async (orig) => ({
  ...(await orig<typeof import('@/lib/team-calls/eject')>()),
  drainTeamCallEjections: async () => {
    h.drained++
    return { done: 1, failed: 0 }
  },
}))
vi.mock('@/lib/team-calls/livekit', async (orig) => ({
  ...(await orig<typeof import('@/lib/team-calls/livekit')>()),
  closeTeamCallRoom: async (_c: unknown, room: string) => void h.closed.push(room),
}))
vi.mock('@/lib/meeting-links/calendar-events', async (orig) => ({
  ...(await orig<typeof import('@/lib/meeting-links/calendar-events')>()),
  addMeetingToCalendar: async (_svc: unknown, args: unknown) => {
    h.calendar.push(['add', args])
    if (h.calendarFails) throw new Error('calendar down')
    return { written: 'app' }
  },
  meetingCalendarChanged: async (_svc: unknown, id: string, change: unknown) => {
    h.calendar.push(['changed', { id, change }])
    return 'updated'
  },
}))
vi.mock('@/lib/meeting-links/mine', () => ({
  listMyMeetings: async (_db: unknown, _svc: unknown, args: unknown) => [{ id: 'm-1', args }],
}))
vi.mock('@/lib/time-offers/host-calendar', async (orig) => ({
  ...(await orig<typeof import('@/lib/time-offers/host-calendar')>()),
  writableCalendarAccounts: async () => [{ id: 'acct-google', provider: 'google', label: 'rosa@example.com' }],
}))
vi.mock('@/lib/team-calls/notes-store', async (orig) => ({
  ...(await orig<typeof import('@/lib/team-calls/notes-store')>()),
  requestNotesFinish: async () => true,
}))

import { GET as getMeeting, POST as createMeeting } from '../route'
import { POST as joinLink } from '../join/route'
import { POST as answerGuest } from '../guests/[id]/route'
import { POST as revoke } from '../[id]/revoke/route'
import { POST as end } from '../[id]/end/route'
import { POST as newLink } from '../[id]/new-link/route'
import { meetingToken, tokenDigest } from '@/lib/meeting-links/link'

const NONCE = 'members-nonce-aaaaaaaaaaaaaaaaaaaa'

let tables: Record<string, Array<Record<string, unknown>>>
const post = (body?: unknown) => new NextRequest('https://nativeintelligence.dev/api/account/meeting-links', { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const idParams = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  Object.assign(process.env, LIVEKIT_ENV, { MEETING_LINK_SECRET: 'members-test-secret' })
  h.afters = []
  h.rpcs = []
  h.rpc = {}
  h.drained = 0
  h.closed = []
  h.calendar = []
  h.calendarFails = false
  tables = {
    member: [{ id: ME, user_id: USER, workspace_id: WS, display_name: 'Rosa Lind' }],
    meeting: [{ id: MEETING, workspace_id: WS, channel_id: CH, host_member_id: ME, title: 'Design review', starts_at: null, ends_at: null, opens_at: '2026-11-11T00:00:00.000Z', closes_at: '2026-12-11T00:00:00.000Z', revoked_at: null, token_nonce: NONCE }],
    team_call: [{ id: CALL, channel_id: CH, room: `tc-${CALL}`, status: 'live' }],
  }
  const rpc = async (name: string, args: Record<string, unknown>) => {
    h.rpcs.push([name, args])
    return h.rpc[name] ?? { data: null, error: null }
  }
  h.db = Object.assign(memoryDb(tables), { rpc }) as unknown as SupabaseClient
  h.svc = Object.assign(memoryDb(tables), { rpc }) as unknown as SupabaseClient
})
afterEach(() => {
  delete process.env.MEETING_LINK_SECRET
})

describe('making a link', () => {
  it('as the person: the server picks the id, sends only the token’s hash, and answers the link', async () => {
    h.rpc.meeting_create = { data: [{ meeting_id: 'set-below', channel_id: CH, opens_at: 'a', closes_at: 'b' }], error: null }
    const res = await createMeeting(post({ title: '  Design review ', startsAt: '2026-11-12T15:00:00.000Z', minutes: 45 }))
    const [name, args] = h.rpcs[0]
    expect(name).toBe('meeting_create')
    expect(args).toMatchObject({ ws: WS, meeting_title: 'Design review', starts: '2026-11-12T15:00:00.000Z', minutes: 45 })
    expect(String(args.token_nonce)).toMatch(/^[A-Za-z0-9_-]{32}$/)
    const token = meetingToken(String(args.meeting_ref), String(args.token_nonce))
    expect(args.token_digest).toBe(tokenDigest(token))
    expect(JSON.stringify(args)).not.toContain(token)
    const json = await res.json()
    expect(json.meeting.channelId).toBe(CH)
    expect(json.meeting.url).toMatch(/\/m\/[A-Za-z0-9_-]{32}$/)
  })

  it('a bad title or length says why; the database’s own refusal reads as a sentence', async () => {
    expect((await (await createMeeting(post({ title: '' }))).json()).error).toBe('Give the meeting a title of up to 80 characters.')
    expect((await (await createMeeting(post({ title: 'x', startsAt: '2026-11-12T15:00:00Z', minutes: 2 }))).json()).error).toBe('A meeting is 5 minutes to 8 hours long.')
    h.rpc.meeting_create = { data: null, error: { code: '22023', message: 'meetings: that time has passed' } }
    const res = await createMeeting(post({ title: 'Late', startsAt: '2020-01-01T00:00:00Z' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('That time has passed.')
  })

  it('while calling is off: not available', async () => {
    delete process.env.LIVEKIT_URL
    expect((await createMeeting(post({ title: 'x' }))).status).toBe(404)
    Object.assign(process.env, LIVEKIT_ENV)
  })
})

describe('a conversation’s meeting', () => {
  it('its link, made again from its id and nonce (never stored)', async () => {
    const res = await getMeeting(new NextRequest(`https://nativeintelligence.dev/api/account/meeting-links?channel=${CH}`))
    const json = await res.json()
    expect(json.meeting).toMatchObject({ id: MEETING, title: 'Design review', host_member_id: ME })
    expect(json.meeting.url).toBe(`https://nativeintelligence.dev/m/${meetingToken(MEETING, NONCE)}`)
    expect(json.meeting.workspace_id).toBeUndefined()
  })
})

describe('a new link', () => {
  it('the host replaces it: a fresh nonce, only its hash and the nonce sent, the new link answered', async () => {
    h.rpc.meeting_new_link = { data: true, error: null }
    const res = await newLink(post(), idParams(MEETING))
    expect(res.status).toBe(200)
    const [name, args] = h.rpcs[0]
    expect(name).toBe('meeting_new_link')
    expect(args.target_meeting).toBe(MEETING)
    expect(args.token_nonce).not.toBe(NONCE)
    const token = meetingToken(MEETING, String(args.token_nonce))
    expect(args.token_digest).toBe(tokenDigest(token))
    expect(token).not.toBe(meetingToken(MEETING, NONCE))
    expect((await res.json()).url).toBe(`https://nativeintelligence.dev/m/${token}`)
  })

  it('anyone but the host (574 refuses): 403; a bad id: 404', async () => {
    h.rpc.meeting_new_link = { data: null, error: { code: '42501', message: 'meetings: only the host can make a new link' } }
    expect((await newLink(post(), idParams(MEETING))).status).toBe(403)
    expect((await newLink(post(), idParams('nope'))).status).toBe(404)
  })
})

describe('joining by a link inside the app', () => {
  it('by its hash, as the person; a link that is not theirs or not active is a plain 404', async () => {
    h.rpc.meeting_join = { data: [{ meeting_id: MEETING, channel_id: CH, workspace_id: WS, title: 'Design review' }], error: null }
    const token = meetingToken(MEETING, NONCE)
    const res = await joinLink(post({ token }))
    expect(await res.json()).toMatchObject({ channelId: CH, title: 'Design review' })
    expect(h.rpcs[0]).toEqual(['meeting_join', { token_digest: tokenDigest(token) }])
    h.rpc.meeting_join = { data: null, error: { code: '42501', message: 'meetings: no such link' } }
    expect((await joinLink(post({ token }))).status).toBe(404)
    expect((await joinLink(post({ token: 'short' }))).status).toBe(404)
  })
})

describe('a guest', () => {
  it('admitted or declined by someone in the call (574 decides who may)', async () => {
    h.rpc.meeting_guest_decide = { data: [{ state: 'admitted', call_id: CALL }], error: null }
    const res = await answerGuest(post({ action: 'admit' }), idParams(GUEST))
    expect(await res.json()).toEqual({ state: 'admitted' })
    expect(h.rpcs[0]).toEqual(['meeting_guest_decide', { target_guest: GUEST, admit: true }])
    h.rpc.meeting_guest_decide = { data: null, error: { code: '42501', message: 'meetings: only someone in the call can let a guest in' } }
    expect((await answerGuest(post({ action: 'decline' }), idParams(GUEST))).status).toBe(403)
  })

  it('removed: out of the room at once (the outbox drained after the answer)', async () => {
    h.rpc.meeting_guest_remove = { data: [{ state: 'removed', ejected: true }], error: null }
    expect(await (await answerGuest(post({ action: 'remove' }), idParams(GUEST))).json()).toEqual({ state: 'removed' })
    expect(h.afters).toHaveLength(1)
    await h.afters[0]()
    expect(h.drained).toBe(1)
    expect((await answerGuest(post({ action: 'kick' }), idParams(GUEST))).status).toBe(400)
  })
})

describe('the host', () => {
  it('revokes the link (guests in the call are taken out)', async () => {
    h.rpc.meeting_revoke = { data: [{ revoked: true, call_id: CALL, room: `tc-${CALL}` }], error: null }
    expect(await (await revoke(post(), idParams(MEETING))).json()).toEqual({ revoked: true })
    await h.afters[0]()
    expect(h.drained).toBe(1)
  })

  it('ends the call for everyone: ended, its room closed; nobody else may', async () => {
    h.rpc.team_call_end = { data: [], error: null }
    expect(await (await end(post(), idParams(MEETING))).json()).toEqual({ ended: true })
    expect(h.rpcs.find((r) => r[0] === 'team_call_end')![1]).toMatchObject({ target_call: CALL, end_reason: 'finished' })
    for (const a of h.afters) await a()
    expect(h.closed).toEqual([`tc-${CALL}`])
    tables.meeting[0].host_member_id = 'someone-else'
    expect((await end(post(), idParams(MEETING))).status).toBe(403)
  })
})

describe('meetings people can find (the follow-up)', () => {
  const ACCT = '88888888-8888-4888-8888-888888888888'
  it('a scheduled link goes on the host’s calendar after the answer (the one they picked); an unscheduled one never does', async () => {
    h.rpc.meeting_create = { data: [{ meeting_id: 'set-below', channel_id: CH, opens_at: 'a', closes_at: 'b' }], error: null }
    const res = await createMeeting(post({ title: 'Design review', startsAt: '2026-11-12T15:00:00.000Z', minutes: 45, calendarAccountId: ACCT }))
    const json = await res.json()
    expect(json.meeting).toMatchObject({ startsAt: '2026-11-12T15:00:00.000Z', endsAt: '2026-11-12T15:45:00.000Z' })
    expect(h.calendar).toEqual([])
    await Promise.all(h.afters.map((a) => a()))
    expect(h.calendar).toEqual([['add', { meeting: { id: json.meeting.meetingId, title: 'Design review', startsAt: '2026-11-12T15:00:00.000Z', endsAt: '2026-11-12T15:45:00.000Z', url: json.meeting.url }, userId: USER, workspaceId: WS, accountId: ACCT }]])
    h.afters = []
    h.calendar = []
    await createMeeting(post({ title: 'Any time' }))
    await Promise.all(h.afters.map((a) => a()))
    expect(h.calendar).toEqual([])
  })

  it('a calendar that fails never fails making the link (it is after the answer)', async () => {
    h.calendarFails = true
    h.rpc.meeting_create = { data: [{ meeting_id: 'x', channel_id: CH, opens_at: 'a', closes_at: 'b' }], error: null }
    const res = await createMeeting(post({ title: 'Design review', startsAt: '2026-11-12T15:00:00.000Z', minutes: 30 }))
    expect(res.status).toBe(200)
    expect((await res.json()).meeting.channelId).toBe(CH)
  })

  it('a new link and a revoke tell the meeting’s calendar event (after the answer)', async () => {
    h.rpc.meeting_new_link = { data: true, error: null }
    const res = await newLink(post(), idParams(MEETING))
    const { url } = await res.json()
    h.rpc.meeting_revoke = { data: [{ revoked: true, call_id: null, room: null }], error: null }
    await revoke(post(), idParams(MEETING))
    await Promise.all(h.afters.map((a) => a()))
    expect(h.calendar).toEqual([
      ['changed', { id: MEETING, change: { kind: 'relinked', url } }],
      ['changed', { id: MEETING, change: { kind: 'revoked' } }],
    ])
  })

  it('the section’s list (?view=mine) and the dialog’s calendars (?view=calendars)', async () => {
    const mine = await getMeeting(new NextRequest('https://nativeintelligence.dev/api/account/meeting-links?view=mine'))
    expect(await mine.json()).toEqual({ meetings: [{ id: 'm-1', args: { workspaceId: WS, userId: USER } }] })
    const cals = await getMeeting(new NextRequest('https://nativeintelligence.dev/api/account/meeting-links?view=calendars'))
    expect(await cals.json()).toEqual({ calendars: [{ id: 'acct-google', provider: 'google', label: 'rosa@example.com' }] })
  })
})

