/**
 * A host's held and booked time (../claims.ts, migration 554) is busy time
 * for every reader of the busy path (../busy.ts listCountedEvents): find_times
 * never offers a time held for an offer or booked from one, a hold counts
 * until it expires, an offer's own holds (or a booking's own claim) can be
 * left out while it is being picked from (or moved), and a claims read that
 * fails is unknown, never free. And ../slot-check.ts: whether given times
 * are free right now, strictly.
 */
import { describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { listCountedEvents } from '../busy'
import { CLAIMS_READ_MAX, claimsExcept, readHostClaims } from '../claims'
import { DEFAULT_WEEKLY } from '../engine'
import { findTimes } from '../find-times'
import { checkSpansFree } from '../slot-check'

const USER = 'user-ada'
const WS = 'ws-fernhill'
const ZONE = 'America/New_York'
const NOW = Date.parse('2026-11-16T13:00:00.000Z') // Mon 8:00 AM EST

const claim = (over: Record<string, unknown>) => ({ id: `c-${Math.random()}`, workspace_id: WS, host_user_id: USER, kind: 'booking', claim_key: 'b-1', booking_id: 'b-1', offer_id: null, expires_at: null, ...over })

function base(claims: Record<string, unknown>[]) {
  return {
    connected_account: [{ id: 'acc-g', user_id: USER, provider: 'google', account_email: 'ada@example.com', capability: 'calendar', is_enabled: true }],
    connected_account_workspace: [{ account_id: 'acc-g', workspace_id: WS }],
    calendar_sub_preference: [],
    host_time_claim: claims,
  }
}

function busyDeps(t: ReturnType<typeof base>) {
  return {
    supabase: memoryDb(t),
    token: vi.fn(async (accountId: string) => ({ token: `tok-${accountId}`, email: null, accountId })),
    googleCalendars: vi.fn(async () => [{ id: 'primary', summary: 'Ada', primary: true, accessRole: 'owner' }]),
    microsoftCalendars: vi.fn(async () => []),
    listEvents: vi.fn(async () => []),
  }
}

describe('readHostClaims', () => {
  it("the host's bookings and live holds overlapping the window; an expired hold and another host's claims never", async () => {
    const db = memoryDb({
      host_time_claim: [
        claim({ id: 'booked', starts_at: '2026-11-17T15:00:00.000Z', ends_at: '2026-11-17T15:30:00.000Z' }),
        claim({ id: 'held', kind: 'hold', claim_key: 'o-1', offer_id: 'o-1', booking_id: null, starts_at: '2026-11-18T15:00:00.000Z', ends_at: '2026-11-18T15:30:00.000Z', expires_at: '2026-11-17T00:00:00.000Z' }),
        claim({ id: 'lapsed', kind: 'hold', claim_key: 'o-2', offer_id: 'o-2', booking_id: null, starts_at: '2026-11-18T16:00:00.000Z', ends_at: '2026-11-18T16:30:00.000Z', expires_at: '2026-11-16T12:00:00.000Z' }),
        claim({ id: 'outside', starts_at: '2026-12-01T15:00:00.000Z', ends_at: '2026-12-01T15:30:00.000Z' }),
        claim({ id: 'theirs', host_user_id: 'user-bo', starts_at: '2026-11-17T15:00:00.000Z', ends_at: '2026-11-17T16:00:00.000Z' }),
      ],
    })
    const claims = await readHostClaims(db, USER, { timeMin: '2026-11-16T05:00:00.000Z', timeMax: '2026-11-23T05:00:00.000Z' }, NOW)
    expect(claims.map((c) => c.id)).toEqual(['booked', 'held'])
    expect(claimsExcept(claims, { offerId: 'o-1' }).map((c) => c.id)).toEqual(['booked'])
    expect(claimsExcept(claims, { bookingId: 'b-1' }).map((c) => c.id)).toEqual(['held'])
  })

  it('a failed read throws (never free because unread)', async () => {
    const failing = { from: () => ({ select: () => ({ eq: () => ({ lt: () => ({ gt: () => ({ limit: async () => ({ data: null, error: { message: 'statement timeout' } }) }) }) }) }) }) } as never
    await expect(readHostClaims(failing, USER, { timeMin: 'a', timeMax: 'b' })).rejects.toThrow('Held times could not be read: statement timeout')
  })

  it('a read that fills its page throws, never a partial list', async () => {
    const rows = Array.from({ length: CLAIMS_READ_MAX }, (_, i) => ({ id: `c${i}`, starts_at: 'a', ends_at: 'b', kind: 'booking', offer_id: null, booking_id: `b${i}`, expires_at: null }))
    const full = { from: () => ({ select: () => ({ eq: () => ({ lt: () => ({ gt: () => ({ limit: async () => ({ data: rows, error: null }) }) }) }) }) }) } as never
    await expect(readHostClaims(full, USER, { timeMin: 'a', timeMax: 'b' })).rejects.toThrow('Held times could not all be read')
  })
})

describe('the busy path reads the claims once, for every reader', () => {
  it('listCountedEvents adds them as titleless busy events, leaving out what the caller excepts', async () => {
    const t = base([
      claim({ id: 'booked', starts_at: '2026-11-17T15:00:00.000Z', ends_at: '2026-11-17T15:30:00.000Z' }),
      claim({ id: 'held', kind: 'hold', claim_key: 'o-1', offer_id: 'o-1', booking_id: null, starts_at: '2026-11-18T15:00:00.000Z', ends_at: '2026-11-18T15:30:00.000Z', expires_at: '2099-01-01T00:00:00.000Z' }),
    ])
    const d = busyDeps(t)
    const range = { timeMin: '2026-11-16T05:00:00.000Z', timeMax: '2026-11-23T05:00:00.000Z', workspaceId: WS }
    const events = await listCountedEvents(USER, range, d)
    expect(events).toEqual([
      { id: 'claim:booked', title: 'Busy', start: '2026-11-17T15:00:00.000Z', end: '2026-11-17T15:30:00.000Z', status: 'confirmed' },
      { id: 'claim:held', title: 'Busy', start: '2026-11-18T15:00:00.000Z', end: '2026-11-18T15:30:00.000Z', status: 'confirmed' },
    ])
    expect((await listCountedEvents(USER, { ...range, exceptClaims: { offerId: 'o-1' } }, d)).map((e) => e.id)).toEqual(['claim:booked'])
  })

  it('a failed claims read throws, so find_times says unknown', async () => {
    const d = { ...busyDeps(base([])), claims: vi.fn(async () => { throw new Error('Held times could not be read: down') }) }
    const found = await findTimes(
      { userId: USER, workspaceId: WS, schedule: { timeZone: ZONE, weekly: DEFAULT_WEEKLY }, from: NOW, to: NOW + 2 * 86_400_000, durationMinutes: 30, now: NOW },
      { listEvents: (u, o) => listCountedEvents(u, o, d) },
    )
    expect(found).toEqual({ known: false, reason: 'Held times could not be read: down' })
  })

  it("find_times never offers a held or booked time", async () => {
    // Tuesday 9:00 to 6:00 EST is free on the calendar; 9 to 12 is booked, 12 to 6 held for an offer.
    const t = base([
      claim({ id: 'booked', starts_at: '2026-11-17T14:00:00.000Z', ends_at: '2026-11-17T17:00:00.000Z' }),
      claim({ id: 'held', kind: 'hold', claim_key: 'o-1', offer_id: 'o-1', booking_id: null, starts_at: '2026-11-17T17:00:00.000Z', ends_at: '2026-11-17T23:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z' }),
    ])
    const d = busyDeps(t)
    const from = Date.parse('2026-11-17T05:00:00.000Z')
    const to = Date.parse('2026-11-18T05:00:00.000Z')
    const found = await findTimes({ userId: USER, workspaceId: WS, schedule: { timeZone: ZONE, weekly: DEFAULT_WEEKLY }, from, to, durationMinutes: 30, bufferMinutes: 0, now: NOW }, { listEvents: (u, o) => listCountedEvents(u, o, d) })
    expect(found).toEqual({ known: true, free: [], suggested: [] })
    // Once the hold expires, its afternoon is free again.
    t.host_time_claim[1].expires_at = '2020-01-01T00:00:00.000Z'
    const after = await findTimes({ userId: USER, workspaceId: WS, schedule: { timeZone: ZONE, weekly: DEFAULT_WEEKLY }, from, to, durationMinutes: 30, bufferMinutes: 0, now: NOW }, { listEvents: (u, o) => listCountedEvents(u, o, d) })
    expect(after.known && after.free).toEqual([{ start: Date.parse('2026-11-17T17:00:00.000Z'), end: Date.parse('2026-11-17T23:00:00.000Z') }])
  })
})

describe('checkSpansFree', () => {
  const span = (startIso: string, minutes = 30) => ({ start: Date.parse(startIso), end: Date.parse(startIso) + minutes * 60_000 })

  it('busy where a timed event overlaps or an all-day one takes the local day; free elsewhere; an excepted event is left out', async () => {
    const listEvents = vi.fn(async () => [
      { id: 'e-1', title: 'Standup', start: '2026-11-17T15:00:00.000Z', end: '2026-11-17T15:30:00.000Z' },
      { id: 'e-2', title: 'Offsite', start: '2026-11-19T00:00:00.000Z', end: '2026-11-20T00:00:00.000Z', isAllDay: true },
      { id: 'e-own', title: 'Intro call', start: '2026-11-18T15:00:00.000Z', end: '2026-11-18T15:30:00.000Z' },
    ])
    const result = await checkSpansFree(
      { userId: USER, workspaceId: WS, timeZone: ZONE, spans: [span('2026-11-17T15:15:00.000Z'), span('2026-11-17T16:00:00.000Z'), span('2026-11-19T15:00:00.000Z'), span('2026-11-18T15:00:00.000Z')], exceptEventId: 'e-own', exceptClaims: { offerId: 'o-1' } },
      { listEvents, hasCalendar: async () => true },
    )
    expect(result).toEqual({ known: true, busy: [true, false, true, false] })
    expect(listEvents).toHaveBeenCalledWith(USER, expect.objectContaining({ strict: true, workspaceId: WS, exceptClaims: { offerId: 'o-1' } }))
  })

  it('unknown when no calendar is connected or a read fails', async () => {
    expect(await checkSpansFree({ userId: USER, timeZone: ZONE, spans: [span('2026-11-17T15:00:00.000Z')] }, { hasCalendar: async () => false })).toEqual({ known: false, reason: 'no calendar is connected' })
    expect(
      await checkSpansFree({ userId: USER, timeZone: ZONE, spans: [span('2026-11-17T15:00:00.000Z')] }, { hasCalendar: async () => true, listEvents: async () => { throw new Error('A calendar account needs signing in again') } }),
    ).toEqual({ known: false, reason: 'A calendar account needs signing in again' })
  })
})
