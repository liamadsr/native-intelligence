/**
 * A booking link's open times (../times.ts): each host's hours minus their
 * busy time, the link's buffers, notice, window, grid and daily cap; one
 * host, every host (all attend) or any one of them (each time remembering
 * who can take it), and the least booked of those for an `any` booking.
 * Unknown is never free: one host's calendar that can't be read leaves the
 * whole link with no times. Tue Jan 7 2031, New York (EST, UTC-5) and
 * Chicago (CST, UTC-6); the people are made up.
 */
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_WEEKLY, type AvailabilitySchedule, type DayRange } from '@/lib/availability/engine'
import { capPerDay, chooseHost, gridStarts, linkSlots, readLinkTimes, widenBusy, type HostTime, type LinkRules } from '../times'
import type { BookingLink } from '../types'

const NY = 'America/New_York'
const CHICAGO = 'America/Chicago'
const AVA = 'user-ava'
const BEN = 'user-ben'
const at = (value: string) => Date.parse(value)
const iso = (ms: number) => new Date(ms).toISOString()
const clock = (ms: number, zone = NY) => new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date(ms))

const weekdays = (ranges: DayRange[]): DayRange[][] => [[], ranges, ranges, ranges, ranges, ranges, []]
const hours = (timeZone: string, ranges: DayRange[] = [{ start: '09:00', end: '17:00' }]): AvailabilitySchedule => ({ timeZone, weekly: weekdays(ranges) })
const host = (userId: string, schedule: AvailabilitySchedule, busy: Array<[string, string]> = []): HostTime => ({ userId, schedule, busy: busy.map(([start, end]) => ({ start, end })) })

const RULES: LinkRules = { durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, noticeMinutes: 0, windowDays: 30, stepMinutes: null, dailyCap: null, hostMode: 'one' }
// Monday night: the whole of Tuesday is ahead.
const NOW = at('2031-01-07T02:00:00Z')
const TUE = { from: at('2031-01-07T05:00:00Z'), to: at('2031-01-08T05:00:00Z') }

describe('one host', () => {
  it('their hours on the link’s grid, minus their busy time, soonest first', () => {
    const slots = linkSlots({ link: RULES, hosts: [host(AVA, hours(NY), [['2031-01-07T15:00:00Z', '2031-01-07T16:00:00Z']])], timeZone: NY, now: NOW, ...TUE })
    expect(slots.map((s) => clock(s.start))).toEqual(['09:00', '09:30', ...['11', '12', '13', '14', '15', '16'].flatMap((h) => [`${h}:00`, `${h}:30`])])
    expect(slots.every((s) => s.end - s.start === 30 * 60_000 && s.hostIds.join() === AVA)).toBe(true)
  })

  it('the buffers keep time clear before and after what is busy', () => {
    const link = { ...RULES, bufferBeforeMinutes: 15, bufferAfterMinutes: 15 }
    const slots = linkSlots({ link, hosts: [host(AVA, hours(NY), [['2031-01-07T15:00:00Z', '2031-01-07T16:00:00Z']])], timeZone: NY, now: NOW, ...TUE })
    // 9:30 would end at 10:00, inside the buffer before 10; 11:00 starts inside the buffer after 11.
    expect(slots.slice(0, 3).map((s) => clock(s.start))).toEqual(['09:00', '11:30', '12:00'])
    expect(widenBusy([{ start: '2031-01-07T15:00:00.000Z', end: '2031-01-07T16:00:00.000Z' }, { start: '2031-01-07T05:00:00.000Z', end: '2031-01-08T05:00:00.000Z', allDay: true }], 10, 20)).toEqual([
      { start: '2031-01-07T14:40:00.000Z', end: '2031-01-07T16:10:00.000Z' },
      { start: '2031-01-07T05:00:00.000Z', end: '2031-01-08T05:00:00.000Z', allDay: true },
    ])
  })

  it('nothing sooner than the notice, nothing later than the window', () => {
    const now = at('2031-01-07T14:10:00Z') // 9:10 in New York
    const slots = linkSlots({ link: { ...RULES, noticeMinutes: 60 }, hosts: [host(AVA, hours(NY))], timeZone: NY, now, ...TUE })
    expect(clock(slots[0].start)).toBe('10:30')
    // A one-day window from 9:10 Tuesday: Wednesday's last start is 9:00.
    const week = linkSlots({ link: { ...RULES, windowDays: 1 }, hosts: [host(AVA, hours(NY))], timeZone: NY, now, from: TUE.from, to: TUE.from + 3 * 86_400_000 })
    expect(iso(week.at(-1)!.start)).toBe('2031-01-08T14:00:00.000Z')
  })

  it('the step sets the grid from local midnight; the length stays', () => {
    const slots = linkSlots({ link: { ...RULES, durationMinutes: 45, stepMinutes: 15 }, hosts: [host(AVA, hours(NY, [{ start: '09:10', end: '10:30' }]))], timeZone: NY, now: NOW, ...TUE })
    expect(slots.map((s) => clock(s.start))).toEqual(['09:15', '09:30', '09:45'])
    expect(gridStarts([{ start: at('2031-01-07T14:07:00Z'), end: at('2031-01-07T15:00:00Z') }], 20, 20, NY).map((s) => clock(s))).toEqual(['09:20', '09:40'])
  })

  it('the grid is each day’s own wall clock: a 45-minute step keeps 9:00 and 10:30 across a daylight-saving change', () => {
    // Sun Nov 2 2031: New York falls back at 2:00, so the day has 25 hours.
    const day = { start: at('2031-11-02T04:00:00Z'), end: at('2031-11-03T05:00:00Z') }
    const starts = gridStarts([day], 45, 45, NY).map((s) => clock(s))
    expect(starts).toContain('09:00')
    expect(starts).toContain('10:30')
    expect(starts).not.toContain('09:30')
  })

  it('a step that doesn’t divide the day starts again at each midnight, as a booking’s own re-read of that day does', () => {
    // 22:00 Tuesday to 02:00 Wednesday, a 25-minute grid.
    const window = { start: at('2031-01-08T03:00:00Z'), end: at('2031-01-08T07:00:00Z') }
    const starts = gridStarts([window], 25, 25, NY)
    const afterMidnight = starts.filter((s) => s >= at('2031-01-08T05:00:00Z')).map((s) => clock(s))
    expect(afterMidnight.slice(0, 3)).toEqual(['00:00', '00:25', '00:50'])
    // The same day read on its own (a booking's re-read from 00:25) agrees.
    expect(gridStarts([{ start: at('2031-01-08T05:25:00Z'), end: window.end }], 25, 25, NY).map((s) => clock(s))[0]).toBe('00:25')
  })

  it('caps each day, never the range: a dense grid still offers the later days', () => {
    const allDay = [0, 1, 2, 3, 4, 5, 6].map(() => [{ start: '00:00', end: '24:00' }])
    const slots = linkSlots({ link: { ...RULES, durationMinutes: 15, stepMinutes: 5, windowDays: 7 }, hosts: [host(AVA, { timeZone: NY, weekly: allDay })], timeZone: NY, now: NOW, from: TUE.from, to: TUE.from + 7 * 86_400_000 })
    const perDay = new Map<string, number>()
    for (const s of slots) {
      const key = new Intl.DateTimeFormat('en-CA', { timeZone: NY }).format(new Date(s.start))
      perDay.set(key, (perDay.get(key) ?? 0) + 1)
    }
    expect(perDay.size).toBe(7)
    expect(Math.max(...perDay.values())).toBe(96)
    expect(capPerDay([{ start: at('2031-01-07T15:00:00Z') }, { start: at('2031-01-07T16:00:00Z') }, { start: at('2031-01-08T15:00:00Z') }], NY, 1)).toHaveLength(2)
  })

  it('a day at its cap offers nothing; the next day does', () => {
    const link = { ...RULES, dailyCap: 1 }
    const slots = linkSlots({ link, hosts: [host(AVA, hours(NY))], timeZone: NY, now: NOW, from: TUE.from, to: TUE.to + 86_400_000, booked: [at('2031-01-07T20:00:00Z')] })
    expect(slots.length).toBeGreaterThan(0)
    expect(slots.every((s) => iso(s.start) >= '2031-01-08T05:00:00.000Z')).toBe(true)
    expect(linkSlots({ link: { ...link, dailyCap: 2 }, hosts: [host(AVA, hours(NY))], timeZone: NY, now: NOW, ...TUE, booked: [at('2031-01-07T20:00:00Z')] }).length).toBe(16)
  })

  it('no hosts, no times', () => {
    expect(linkSlots({ link: RULES, hosts: [], timeZone: NY, now: NOW, ...TUE })).toEqual([])
  })
})

describe('every host (all)', () => {
  it('only the times all of them have free, across their zones; each time names them all', () => {
    // Ben works 9 to 5 in Chicago (10 to 6 in New York) and is busy 1 to 2 his time (2 to 3 in New York).
    const slots = linkSlots({
      link: { ...RULES, hostMode: 'all', durationMinutes: 60 },
      hosts: [host(AVA, hours(NY)), host(BEN, hours(CHICAGO), [['2031-01-07T19:00:00Z', '2031-01-07T20:00:00Z']])],
      timeZone: NY,
      now: NOW,
      ...TUE,
    })
    expect(slots.map((s) => clock(s.start))).toEqual(['10:00', '11:00', '12:00', '13:00', '15:00', '16:00'])
    expect(slots.every((s) => s.hostIds.join() === `${AVA},${BEN}`)).toBe(true)
  })
})

describe('any one host', () => {
  it('the times any of them has free, each remembering who can take it', () => {
    const slots = linkSlots({
      link: { ...RULES, hostMode: 'any', durationMinutes: 60 },
      hosts: [host(AVA, hours(NY), [['2031-01-07T14:00:00Z', '2031-01-07T17:00:00Z']]), host(BEN, hours(NY), [['2031-01-07T17:00:00Z', '2031-01-07T18:00:00Z']])],
      timeZone: NY,
      now: NOW,
      ...TUE,
    })
    const who = Object.fromEntries(slots.map((s) => [clock(s.start), s.hostIds]))
    expect(who['09:00']).toEqual([BEN])
    expect(who['12:00']).toEqual([AVA])
    expect(who['13:00']).toEqual([AVA, BEN])
  })

  it('the booking goes to the least booked of those who can take it, ties by the link’s order', () => {
    expect(chooseHost([AVA, BEN], new Map([[AVA, 3], [BEN, 1]]), [AVA, BEN])).toBe(BEN)
    expect(chooseHost([AVA, BEN], new Map([[AVA, 2], [BEN, 2]]), [BEN, AVA])).toBe(BEN)
    expect(chooseHost([BEN, AVA], new Map(), [AVA, BEN])).toBe(AVA)
    expect(chooseHost([], new Map(), [AVA])).toBeNull()
  })
})

describe('readLinkTimes: unknown is never free', () => {
  const link = (over: Partial<BookingLink> = {}): BookingLink => ({
    id: 'link-1',
    workspaceId: 'ws-fernhill',
    ownerUserId: AVA,
    profileId: 'p-1',
    profileHandle: 'ava-lin',
    slug: 'intro',
    purpose: 'meeting',
    title: 'Intro call',
    description: null,
    durationMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    noticeMinutes: 0,
    windowDays: 30,
    stepMinutes: null,
    dailyCap: null,
    questions: [],
    video: true,
    location: null,
    askFirst: false,
    hostMode: 'all',
    weeklyHours: null,
    timeZone: null,
    jobKind: null,
    active: true,
    hosts: [
      { userId: AVA, position: 0 },
      { userId: BEN, position: 1 },
    ],
    createdAt: '2030-12-01T00:00:00Z',
    updatedAt: '2030-12-01T00:00:00Z',
    ...over,
  })
  const deps = (over: Record<string, unknown> = {}) => ({
    supabase: {} as never,
    now: () => NOW,
    readHours: vi.fn(async (userId: string) => (userId === BEN ? hours(CHICAGO) : hours(NY))),
    hasCalendar: vi.fn(async () => true),
    shares: vi.fn(async () => true),
    listEvents: vi.fn(async () => []),
    ...over,
  })

  it('reads every host strictly, in the organizer’s zone, leaving the claims a caller names out', async () => {
    const d = deps({ exceptClaims: { bookingId: 'b-1' } })
    const read = await readLinkTimes(link(), TUE, d)
    expect(read.known).toBe(true)
    if (!read.known) return
    expect(read.timeZone).toBe(NY)
    expect(read.slots[0].hostIds).toEqual([AVA, BEN])
    expect(d.listEvents).toHaveBeenCalledTimes(2)
    for (const call of d.listEvents.mock.calls as unknown as Array<[string, { strict: boolean; exceptClaims: unknown; workspaceId: string }]>) {
      expect(call[1]).toMatchObject({ strict: true, exceptClaims: { bookingId: 'b-1' }, workspaceId: 'ws-fernhill' })
    }
  })

  it('one host’s calendar that can’t be read, or none connected, or a host who stopped sharing: no times at all, and nothing about whose', async () => {
    const failing = await readLinkTimes(link(), TUE, deps({ listEvents: vi.fn(async (userId: string) => { if (userId === BEN) throw new Error('Google said 401 for ben@fernhill.example'); return [] }) }))
    expect(failing).toEqual({ known: false, reason: "The calendar couldn't be checked just now." })
    expect((await readLinkTimes(link({ hostMode: 'any' }), TUE, deps({ hasCalendar: vi.fn(async (userId: string) => userId !== BEN) }))).known).toBe(false)
    expect((await readLinkTimes(link({ hostMode: 'any' }), TUE, deps({ shares: vi.fn(async (userId: string) => userId !== BEN) }))).known).toBe(false)
    // The owner never needs to share with themself.
    const owner = deps({ shares: vi.fn(async () => false) })
    expect((await readLinkTimes(link({ hosts: [{ userId: AVA, position: 0 }], hostMode: 'one' }), TUE, owner)).known).toBe(true)
  })

  it('a link with its own hours uses them, in its own zone', async () => {
    const own = link({ hosts: [{ userId: AVA, position: 0 }], hostMode: 'one', weeklyHours: [[], [], [{ start: '13:00', end: '14:00' }], [], [], [], []], timeZone: CHICAGO })
    const read = await readLinkTimes(own, TUE, deps())
    expect(read.known && read.slots.map((s) => clock(s.start, CHICAGO))).toEqual(['13:00', '13:30'])
    expect(read.known && read.timeZone).toBe(CHICAGO)
  })

  it('a link with its own hours still keeps the host’s dated day off', async () => {
    const own = link({ hosts: [{ userId: AVA, position: 0 }], hostMode: 'one', weeklyHours: weekdays([{ start: '13:00', end: '14:00' }]), timeZone: NY })
    const d = deps({ readHours: vi.fn(async () => ({ ...hours(NY), overrides: { '2031-01-07': [], '2031-01-08': [{ start: '07:00', end: '08:00' }] } })) })
    const read = await readLinkTimes(own, { from: TUE.from, to: TUE.from + 2 * 86_400_000 }, d)
    // Tuesday is off; Wednesday keeps the link's own 13:00 (only days off carry over).
    expect(read.known && read.slots.map((s) => iso(s.start))).toEqual(['2031-01-08T18:00:00.000Z', '2031-01-08T18:30:00.000Z'])
  })

  it('a host whose time zone is nowhere known has no times (never their hours in UTC), unless the link names its own week and zone', async () => {
    const d = deps({ readHours: vi.fn(async (userId: string) => (userId === BEN ? { ...hours('UTC'), zoneKnown: false } : hours(NY))) })
    expect((await readLinkTimes(link(), TUE, d)).known).toBe(false)
    const own = link({ hosts: [{ userId: BEN, position: 0 }], ownerUserId: BEN, hostMode: 'one', weeklyHours: weekdays([{ start: '13:00', end: '14:00' }]), timeZone: CHICAGO })
    expect((await readLinkTimes(own, TUE, d)).known).toBe(true)
  })

  it('a daily cap reads the link’s own bookings once; a read that fails is unknown', async () => {
    const bookedStarts = vi.fn(async () => [at('2031-01-07T15:00:00Z')])
    const capped = await readLinkTimes(link({ dailyCap: 1, hosts: [{ userId: AVA, position: 0 }], hostMode: 'one' }), TUE, deps({ bookedStarts }))
    expect(capped).toEqual({ known: true, timeZone: NY, slots: [] })
    expect(bookedStarts).toHaveBeenCalledTimes(1)
    const broken = await readLinkTimes(link({ dailyCap: 1 }), TUE, deps({ bookedStarts: vi.fn(async () => { throw new Error('down') }) }))
    expect(broken.known).toBe(false)
  })

  it('the default hours are the engine’s: a host who set none works weekdays 9 to 6', () => {
    expect(DEFAULT_WEEKLY[2]).toEqual([{ start: '09:00', end: '18:00' }])
  })
})
