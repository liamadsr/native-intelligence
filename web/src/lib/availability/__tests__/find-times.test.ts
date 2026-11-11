/**
 * findTimes (../find-times.ts): the person's free time in a range, through
 * the engine. Unknown (never empty) when a calendar can't be read; never
 * before now; clipped to the range; every offered time on a quarter hour;
 * events marked free and invites declined never busy.
 */
import { describe, expect, it, vi } from 'vitest'
import type { CalendarEvent } from '@/lib/integrations/calendar'
import { DEFAULT_WEEKLY, type AvailabilitySchedule } from '../engine'
import { capWindows, FIND_TIMES_MAX_DAYS, FREE_WINDOWS_MAX, findTimes, type FindTimesInput } from '../find-times'

const NY = 'America/New_York'
const SCHEDULE: AvailabilitySchedule = { timeZone: NY, weekly: DEFAULT_WEEKLY }
const at = (value: string) => Date.parse(value)
const iso = (ms: number) => new Date(ms).toISOString()
// Monday Nov 2 2026, 7:00 in New York (EST).
const MON_7AM = at('2026-11-02T12:00:00.000Z')

const event = (start: string, end: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({ id: `e-${start}`, title: 'Busy', start, end, attendees: [], ...extra })

function input(extra: Partial<FindTimesInput> = {}): FindTimesInput {
  return { userId: 'user-ada', workspaceId: 'ws-fernhill', schedule: SCHEDULE, from: MON_7AM, to: at('2026-11-03T05:00:00.000Z'), durationMinutes: 30, now: MON_7AM, ...extra }
}

describe('findTimes', () => {
  it('reads every counted calendar strictly, a day either side of the range', async () => {
    const listEvents = vi.fn(async () => [])
    const out = await findTimes(input(), { listEvents })
    expect(listEvents).toHaveBeenCalledWith('user-ada', { timeMin: '2026-11-01T12:00:00.000Z', timeMax: '2026-11-04T05:00:00.000Z', maxResults: 1000, workspaceId: 'ws-fernhill', strict: true })
    expect(out).toEqual({
      known: true,
      free: [{ start: at('2026-11-02T14:00:00.000Z'), end: at('2026-11-02T23:00:00.000Z') }],
      suggested: [{ start: at('2026-11-02T15:00:00.000Z'), end: at('2026-11-02T15:30:00.000Z') }],
    })
  })

  it('a calendar that cannot be read: unknown, with the reason, never an empty answer', async () => {
    const out = await findTimes(input(), { listEvents: vi.fn(async () => Promise.reject(new Error('A calendar account needs signing in again'))) })
    expect(out).toEqual({ known: false, reason: 'A calendar account needs signing in again' })
    const odd = await findTimes(input(), { listEvents: vi.fn(async () => Promise.reject('boom')) })
    expect(odd).toEqual({ known: false, reason: 'a calendar could not be read' })
  })

  it('never before now, and now rounded up to the next quarter hour', async () => {
    // Now is 10:07 Monday; the range began at midnight.
    const now = at('2026-11-02T15:07:00.000Z')
    const listEvents = vi.fn(async () => [])
    const out = await findTimes(input({ from: at('2026-11-02T05:00:00.000Z'), now }), { listEvents })
    expect(out.known && out.free.map((s) => [iso(s.start), iso(s.end)])).toEqual([['2026-11-02T15:15:00.000Z', '2026-11-02T23:00:00.000Z']])
    expect(out.known && out.suggested.map((s) => iso(s.start))).toEqual(['2026-11-02T15:15:00.000Z'])
    // The read starts a day before the first time it could offer.
    expect((listEvents.mock.calls[0] as unknown[])[1]).toMatchObject({ timeMin: '2026-11-01T15:15:00.000Z' })
  })

  it('a range already over is known and empty, with no read', async () => {
    const listEvents = vi.fn(async () => [])
    expect(await findTimes(input({ from: at('2026-11-01T05:00:00.000Z'), to: at('2026-11-02T05:00:00.000Z') }), { listEvents })).toEqual({ known: true, free: [], suggested: [] })
    expect(listEvents).not.toHaveBeenCalled()
  })

  it('clipped to the range inside the working hours', async () => {
    // 11:00 to 3:00 Monday.
    const out = await findTimes(input({ from: at('2026-11-02T16:00:00.000Z'), to: at('2026-11-02T20:00:00.000Z') }), { listEvents: vi.fn(async () => []) })
    expect(out.known && out.free.map((s) => [iso(s.start), iso(s.end)])).toEqual([['2026-11-02T16:00:00.000Z', '2026-11-02T20:00:00.000Z']])
    // No start from 10:00 to noon before 11:00 is gone: 11:00 is in the band.
    expect(out.known && out.suggested.map((s) => iso(s.start))).toEqual(['2026-11-02T16:00:00.000Z'])
  })

  it('busy time out, with the buffer; events marked free, declined and cancelled stay free', async () => {
    const listEvents = vi.fn(async () => [
      // 10:00 to 11:00.
      event('2026-11-02T15:00:00.000Z', '2026-11-02T16:00:00.000Z'),
      // 1:00 to 2:00, marked free; 2:00 to 3:00 declined; 3:00 to 4:00 cancelled.
      event('2026-11-02T18:00:00.000Z', '2026-11-02T19:00:00.000Z', { transparent: true }),
      event('2026-11-02T19:00:00.000Z', '2026-11-02T20:00:00.000Z', { myResponse: 'declined' }),
      event('2026-11-02T20:00:00.000Z', '2026-11-02T21:00:00.000Z', { status: 'cancelled' }),
      // 4:00 to 5:00, tentatively accepted: busy.
      event('2026-11-02T21:00:00.000Z', '2026-11-02T22:00:00.000Z', { myResponse: 'tentative' }),
    ])
    const out = await findTimes(input({ bufferMinutes: 10 }), { listEvents })
    expect(out.known && out.free.map((s) => [iso(s.start), iso(s.end)])).toEqual([
      ['2026-11-02T14:00:00.000Z', '2026-11-02T14:50:00.000Z'],
      ['2026-11-02T16:10:00.000Z', '2026-11-02T20:50:00.000Z'],
      ['2026-11-02T22:10:00.000Z', '2026-11-02T23:00:00.000Z'],
    ])
    // 5:10 to 6:00 is 50 minutes: kept for a 30-minute meeting, dropped for an hour.
    const hour = await findTimes(input({ bufferMinutes: 10, durationMinutes: 60 }), { listEvents })
    expect(hour.known && hour.free.map((s) => iso(s.start))).toEqual(['2026-11-02T16:10:00.000Z'])
  })

  it('an all-day event (UTC midnights) takes its own day only', async () => {
    const listEvents = vi.fn(async () => [event('2026-11-03', '2026-11-04', { isAllDay: true })])
    const out = await findTimes(input({ to: at('2026-11-05T05:00:00.000Z') }), { listEvents })
    expect(out.known && out.free.map((s) => iso(s.start).slice(0, 10))).toEqual(['2026-11-02', '2026-11-04'])
  })

  it('every time offered starts on a quarter hour, one per day', async () => {
    const listEvents = vi.fn(async () => [
      // 9:00 to 10:07 and 10:52 to 3:03 each day this week.
      ...['02', '03', '04', '05', '06'].flatMap((d) => [event(`2026-11-${d}T14:00:00.000Z`, `2026-11-${d}T15:07:00.000Z`), event(`2026-11-${d}T15:52:00.000Z`, `2026-11-${d}T20:03:00.000Z`)]),
    ])
    const out = await findTimes(input({ to: at('2026-11-09T05:00:00.000Z'), bufferMinutes: 0 }), { listEvents })
    if (!out.known) throw new Error('expected a known answer')
    expect(out.suggested).toHaveLength(3)
    for (const s of out.suggested) expect(s.start % (15 * 60_000), iso(s.start)).toBe(0)
    // 10:07 to 10:52 holds 10:15; it is in the 10:00 to noon band.
    expect(out.suggested.map((s) => iso(s.start))).toEqual(['2026-11-02T15:15:00.000Z', '2026-11-03T15:15:00.000Z', '2026-11-04T15:15:00.000Z'])
  })

  it('a long range: every local day it touches, the free list capped', async () => {
    const hours = { timeZone: NY, weekly: [0, 1, 2, 3, 4, 5, 6].map(() => [{ start: '08:00', end: '09:00' }, { start: '10:00', end: '11:00' }, { start: '12:00', end: '13:00' }]) }
    const out = await findTimes(input({ schedule: hours, to: MON_7AM + FIND_TIMES_MAX_DAYS * 86_400_000 }), { listEvents: vi.fn(async () => []) })
    if (!out.known) throw new Error('expected a known answer')
    expect(out.free).toHaveLength(FREE_WINDOWS_MAX)
    expect(iso(out.free[0].start)).toBe('2026-11-02T13:00:00.000Z')
    // Cut, and said so: where the list stops (more free time follows).
    expect(out.freeUntil).toBe(out.free[FREE_WINDOWS_MAX - 1].end)
  })

  it('says nothing about a cut when every window fits', async () => {
    const out = await findTimes({ userId: 'u1', schedule: SCHEDULE, from: MON_7AM, to: MON_7AM + 86_400_000, durationMinutes: 30, now: MON_7AM }, { listEvents: async () => [] })
    expect(out.known && out.freeUntil).toBeUndefined()
    expect(capWindows([{ start: 1, end: 2 }])).toEqual({ free: [{ start: 1, end: 2 }] })
  })
})
