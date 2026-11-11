/**
 * A meeting link as a booked meeting's place (src/lib/meeting-links/bookings.ts,
 * migration 576): a booking from a link or offer that meets on a call here
 * gets one meeting, its host the booking's host, its title, start and length
 * the booking's; a retry finds the same meeting; a booking that doesn't meet
 * here, one too long for a meeting, a host no longer in the workspace, or a
 * server where calling isn't set up gets none; a move or a cancellation
 * reaches 576's meeting_booking_changed; and the option itself is stored only
 * where calling is set up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { LIVEKIT_ENV } from '@/lib/team-calls/__tests__/signing'

vi.mock('server-only', () => ({}))

import { bookingCallsAvailable, bookingMeetingChanged, bookingMeetingUrl, bookingMeetsHere, type BookingForMeeting } from '../bookings'
import { meetingToken, tokenDigest } from '../link'
import { columnsOf } from '@/lib/booking-links/links'
import { requestOf } from '@/lib/time-offers/send'

const WS = '11111111-1111-4111-8111-111111111111'
const HOST_USER = '22222222-2222-4222-8222-222222222222'
const HOST_MEMBER = '33333333-3333-4333-8333-333333333333'
const LINK = '44444444-4444-4444-8444-444444444444'
const OFFER = '55555555-5555-4555-8555-555555555555'
const BOOKING = '66666666-6666-4666-8666-666666666666'

let tables: Record<string, Array<Record<string, unknown>>>
let rpcs: Array<[string, Record<string, unknown>]>
let rpcAnswer: (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }

function svc(): SupabaseClient {
  return Object.assign(memoryDb(tables), {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push([name, args])
      return rpcAnswer(name, args)
    },
  }) as unknown as SupabaseClient
}

const booking = (over: Partial<BookingForMeeting> = {}): BookingForMeeting => ({
  id: BOOKING,
  workspaceId: WS,
  hostUserId: HOST_USER,
  title: 'Intro call',
  startsAt: '2026-11-20T15:00:00.000Z',
  endsAt: '2026-11-20T15:45:00.000Z',
  offerId: null,
  linkId: LINK,
  ...over,
})

beforeEach(() => {
  Object.assign(process.env, LIVEKIT_ENV, { MEETING_LINK_SECRET: 'bookings-test-secret', NEXT_PUBLIC_APP_URL: 'https://app.example' })
  tables = {
    booking_link: [{ id: LINK, call_here: true }],
    time_offer: [{ id: OFFER, call_here: false }],
    member: [{ id: HOST_MEMBER, user_id: HOST_USER, workspace_id: WS }],
    meeting: [],
  }
  rpcs = []
  rpcAnswer = (name, args) => {
    if (name === 'meeting_create_for') {
      tables.meeting.push({ id: args.meeting_ref, token_hash: args.token_digest, token_nonce: args.token_nonce, booking_id: null })
      return { data: [{ meeting_id: args.meeting_ref, channel_id: 'ch-1', opens_at: 'a', closes_at: 'b' }], error: null }
    }
    if (name === 'meeting_booking_changed') return { data: [{ meeting_id: 'm-1', call_id: null, room: null }], error: null }
    return { data: null, error: null }
  }
})
afterEach(() => {
  delete process.env.MEETING_LINK_SECRET
  vi.unstubAllEnvs()
})

describe('a booking that meets on a call here', () => {
  it('gets one meeting: its host the booking’s host, its title, start and length; the link only the token’s hash stored', async () => {
    const url = await bookingMeetingUrl(svc(), booking())
    const [name, args] = rpcs[0]
    expect(name).toBe('meeting_create_for')
    expect(args).toMatchObject({ host_member: HOST_MEMBER, ws: WS, meeting_title: 'Intro call', starts: '2026-11-20T15:00:00.000Z', minutes: 45 })
    const token = meetingToken(String(args.meeting_ref), String(args.token_nonce))
    expect(args.token_digest).toBe(tokenDigest(token))
    expect(url).toBe(`https://app.example/m/${token}`)
    expect(tables.meeting[0].booking_id).toBe(BOOKING)
  })

  it('a retry finds the meeting it made: the same link, nothing new', async () => {
    const s = svc()
    const first = await bookingMeetingUrl(s, booking())
    const again = await bookingMeetingUrl(s, booking())
    expect(again).toBe(first)
    expect(rpcs.filter((r) => r[0] === 'meeting_create_for')).toHaveLength(1)
  })

  it('an offer’s choice is read from the offer', async () => {
    tables.time_offer[0].call_here = true
    expect(await bookingMeetsHere(svc(), { linkId: null, offerId: OFFER })).toBe(true)
    tables.time_offer[0].call_here = false
    expect(await bookingMeetingUrl(svc(), booking({ linkId: null, offerId: OFFER }))).toBeNull()
    expect(rpcs).toHaveLength(0)
  })

  it('none for a booking too long for a meeting, or a host no longer in the workspace (the provider’s link stays)', async () => {
    expect(await bookingMeetingUrl(svc(), booking({ endsAt: '2026-11-21T01:00:00.000Z' }))).toBeNull()
    tables.member = []
    expect(await bookingMeetingUrl(svc(), booking())).toBeNull()
    expect(rpcs).toHaveLength(0)
  })

  it('a failed read throws (the booking’s attempt is tried again)', async () => {
    const broken = Object.assign(memoryDb(tables), {
      from: (t: string) => (t === 'booking_link' ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'down' } }) }) }) } : memoryDb(tables).from(t)),
    }) as unknown as SupabaseClient
    await expect(bookingMeetingUrl(broken, booking())).rejects.toThrow(/down/)
  })
})

describe('where calling is not set up', () => {
  it('no meeting is ever made, whatever the link says, and the option isn’t available', async () => {
    delete process.env.LIVEKIT_URL
    expect(bookingCallsAvailable()).toBe(false)
    expect(await bookingMeetsHere(svc(), { linkId: LINK, offerId: null })).toBe(false)
    expect(await bookingMeetingUrl(svc(), booking())).toBeNull()
    expect(rpcs).toHaveLength(0)
  })

  it('a booking link asked to meet here is stored without it; with calling set up, with it', () => {
    const asked = columnsOf({ title: 'Intro', call_here: true } as Parameters<typeof columnsOf>[0])
    delete process.env.LIVEKIT_URL
    const unset = columnsOf({ title: 'Intro', call_here: true } as Parameters<typeof columnsOf>[0])
    expect('columns' in asked && asked.columns.call_here).toBe(true)
    expect('columns' in unset && unset.columns.call_here).toBe(false)
  })

  it('a time offer carries the choice into its plan only with calling set up (the request keeps what was asked)', () => {
    const req = requestOf({ workspaceId: WS, userId: HOST_USER }, { recipient: { name: 'Dana' }, title: 'Intro', slots: ['2026-11-20T15:00:00Z', '2026-11-20T16:00:00Z'], duration_minutes: 30, call_here: true } as Parameters<typeof requestOf>[1])
    expect(req.callHere).toBe(true)
  })
})

describe('the booking changed', () => {
  it('moved: the meeting’s new start and length', async () => {
    expect(await bookingMeetingChanged(svc(), { bookingId: BOOKING, startsAt: '2026-11-21T16:00:00.000Z', endsAt: '2026-11-21T16:30:00.000Z' })).toBe(true)
    expect(rpcs[0]).toEqual(['meeting_booking_changed', { target_booking: BOOKING, starts: '2026-11-21T16:00:00.000Z', minutes: 30, cancelled: false }])
  })

  it('cancelled: the link revoked', async () => {
    await bookingMeetingChanged(svc(), { bookingId: BOOKING, cancelled: true })
    expect(rpcs[0]).toEqual(['meeting_booking_changed', { target_booking: BOOKING, starts: null, minutes: null, cancelled: true }])
  })

  it('no meeting for it, or a failure: false, never a throw', async () => {
    rpcAnswer = () => ({ data: [], error: null })
    expect(await bookingMeetingChanged(svc(), { bookingId: BOOKING, cancelled: true })).toBe(false)
    rpcAnswer = () => ({ data: null, error: { message: 'down' } })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await bookingMeetingChanged(svc(), { bookingId: BOOKING, cancelled: true })).toBe(false)
  })
})
