/**
 * A meeting link as a booked meeting's place (src/lib/meeting-links/bookings.ts,
 * migration 585): a booking from a link or offer that meets on a call here
 * gets its meeting made and tied to it in one step (585's
 * meeting_create_for_booking: only a hash and a nonce sent), and a retry gets
 * the one it has (its own nonce, so the same link); a booking that doesn't
 * meet here, or a server where calling isn't set up, gets none; a failed read
 * or write throws (finishBooking falls back); after a cancellation the eject
 * outbox is drained only for a booking that had a meeting; and the option
 * itself is stored only where calling is set up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { LIVEKIT_ENV } from '@/lib/team-calls/__tests__/signing'

const h = vi.hoisted(() => ({ drained: 0 }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/team-calls/eject', async (orig) => ({
  ...(await orig<typeof import('@/lib/team-calls/eject')>()),
  drainTeamCallEjections: async () => {
    h.drained++
    return { done: 1, failed: 0 }
  },
}))

import { bookingCallsAvailable, bookingMeetingCancelled, bookingMeetingUrl, bookingMeetsHere, type BookingForMeeting } from '../bookings'
import { meetingToken, tokenDigest } from '../link'
import { columnsOf } from '@/lib/booking-links/links'
import { requestOf } from '@/lib/time-offers/send'

const WS = '11111111-1111-4111-8111-111111111111'
const HOST_USER = '22222222-2222-4222-8222-222222222222'
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

const booking = (over: Partial<BookingForMeeting> = {}): BookingForMeeting => ({ id: BOOKING, offerId: null, linkId: LINK, ...over })

beforeEach(() => {
  Object.assign(process.env, LIVEKIT_ENV, { MEETING_LINK_SECRET: 'bookings-test-secret', NEXT_PUBLIC_APP_URL: 'https://app.example' })
  h.drained = 0
  tables = {
    booking_link: [{ id: LINK, call_here: true }],
    time_offer: [{ id: OFFER, call_here: false }],
    meeting: [],
  }
  rpcs = []
  // 585's meeting_create_for_booking as the database answers it: made once per booking, then the one it has.
  rpcAnswer = (name, args) => {
    if (name !== 'meeting_create_for_booking') return { data: null, error: null }
    const had = tables.meeting.find((m) => m.booking_id === args.booking_ref)
    if (had) return { data: [{ made_id: had.id, made_nonce: had.token_nonce, created: false }], error: null }
    tables.meeting.push({ id: args.meeting_ref, token_hash: args.digest, token_nonce: args.nonce, booking_id: args.booking_ref })
    return { data: [{ made_id: args.meeting_ref, made_nonce: args.nonce, created: true }], error: null }
  }
})
afterEach(() => {
  delete process.env.MEETING_LINK_SECRET
  vi.unstubAllEnvs()
})

describe('a booking that meets on a call here', () => {
  it('gets its meeting in one step: only the token’s hash and the nonce sent, the link made from them', async () => {
    const url = await bookingMeetingUrl(svc(), booking())
    expect(rpcs).toHaveLength(1)
    const [name, args] = rpcs[0]
    expect(name).toBe('meeting_create_for_booking')
    expect(args.booking_ref).toBe(BOOKING)
    const token = meetingToken(String(args.meeting_ref), String(args.nonce))
    expect(args.digest).toBe(tokenDigest(token))
    expect(JSON.stringify(args)).not.toContain(token)
    expect(url).toBe(`https://app.example/m/${token}`)
    expect(tables.meeting).toEqual([expect.objectContaining({ booking_id: BOOKING })])
  })

  it('a retry gets the meeting it has: the same link, nothing new', async () => {
    const s = svc()
    const first = await bookingMeetingUrl(s, booking())
    const again = await bookingMeetingUrl(s, booking())
    expect(again).toBe(first)
    expect(tables.meeting).toHaveLength(1)
  })

  it('an offer’s choice is read from the offer', async () => {
    tables.time_offer[0].call_here = true
    expect(await bookingMeetsHere(svc(), { linkId: null, offerId: OFFER })).toBe(true)
    tables.time_offer[0].call_here = false
    expect(await bookingMeetingUrl(svc(), booking({ linkId: null, offerId: OFFER }))).toBeNull()
    expect(rpcs).toHaveLength(0)
  })

  it('none when the database makes none (a host gone, a booking too long)', async () => {
    rpcAnswer = () => ({ data: [], error: null })
    expect(await bookingMeetingUrl(svc(), booking())).toBeNull()
  })

  it('a failed read or write throws (finishBooking falls back to the provider’s video link)', async () => {
    rpcAnswer = () => ({ data: null, error: { message: 'down' } })
    await expect(bookingMeetingUrl(svc(), booking())).rejects.toThrow(/down/)
    const broken = Object.assign(memoryDb(tables), {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'read down' } }) }) }) }),
    }) as unknown as SupabaseClient
    await expect(bookingMeetingUrl(broken, booking())).rejects.toThrow(/read down/)
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

  it('a time offer request carries what was asked (the plan keeps it only with calling set up: accept.test.ts)', () => {
    const req = requestOf({ workspaceId: WS, userId: HOST_USER }, { recipient: { name: 'Dana' }, title: 'Intro', slots: ['2026-11-20T15:00:00Z', '2026-11-20T16:00:00Z'], duration_minutes: 30, call_here: true } as Parameters<typeof requestOf>[1])
    expect(req.callHere).toBe(true)
  })
})

describe('after a cancellation (585’s trigger revoked the link)', () => {
  it('a booking with a meeting: anyone still in its call is taken out now', async () => {
    tables.meeting.push({ id: 'm-1', booking_id: BOOKING })
    expect(await bookingMeetingCancelled(svc(), BOOKING)).toBe(true)
    expect(h.drained).toBe(1)
  })

  it('one without, or calling not set up: nothing', async () => {
    expect(await bookingMeetingCancelled(svc(), BOOKING)).toBe(false)
    tables.meeting.push({ id: 'm-1', booking_id: BOOKING })
    delete process.env.LIVEKIT_URL
    expect(await bookingMeetingCancelled(svc(), BOOKING)).toBe(false)
    expect(h.drained).toBe(0)
  })
})
