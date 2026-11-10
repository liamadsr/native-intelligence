/**
 * The owner's daily list of jobs (roadmap F3, ../daily-jobs.ts), for any
 * business with bookings: 7 o'clock in the business's own zone (across zones
 * and daylight-saving changes), one request per local date (its event id
 * dedupes it), only that local day's confirmed bookings, nothing at all on
 * an empty day, and one line per job: time, name, address, phone, what.
 * Over the real store on an in-memory database; the business is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import {
  DAILY_JOBS_EVENT,
  buildDailyJobs,
  dailyJobLine,
  dailyJobsEventId,
  dailyJobsText,
  findDailyJobsBusinesses,
  localClock,
  planDailyJobs,
  textDailyJobs,
  writeDailyJobsHome,
} from '../daily-jobs'

const WS = 'ws-brightside'
const OWNER = 'user-owner'
const CHICAGO = 'America/Chicago'
const QUOTE = '44444444-4444-4444-8444-444444444444'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
let db: SupabaseClient

const booking = (over: Row): Row => ({
  workspace_id: WS, owner_user_id: OWNER, quote_id: null, contact_id: null, guest_id: null, source: 'owner', kind: 'visit',
  customer_name: 'Someone', customer_phone: null, address: null, note: null, state: 'confirmed', approval_id: null, calendar_event_id: 'evt',
  created_at: '2026-11-01T12:00:00Z', ...over,
})

beforeEach(() => {
  tables = {
    business_profile: [{ workspace_id: WS, owner_user_id: OWNER, business_name: 'Brightside Window Washing', customer_facts: null, time_zone: CHICAGO, booking_days: [1, 2, 3, 4, 5], booking_start: '08:00', booking_end: '17:00', slot_minutes: 90, lead_hours: 12, horizon_days: 21, booking_kind: 'visit', booking_slug: null }],
    workspace: [{ id: WS, name: 'Brightside HQ', settings: {} }],
    customer_quote: [{ id: QUOTE, workspace_id: WS, contact_id: 'c-dana', source: 'web_form', status: 'booked', customer_name: 'Dana Ruiz', customer_email: null, customer_phone: '+13125550142', address: '400 Lake St, Oak Park', service: 'Window screens', items: [{ description: 'Screen', width: 3, length: 5, unit: 'ft', quantity: 2 }], total_cents: 15_000, currency: 'usd', requested_dates: [], notes: null, created_at: '2026-11-01T12:00:00Z', updated_at: '2026-11-01T12:00:00Z' }],
    customer_booking: [
      // Nov 4 in Chicago (standard time, UTC-6) runs 06:00Z to 06:00Z the next day.
      booking({ starts_at: '2026-11-04T05:30:00Z', ends_at: '2026-11-04T06:30:00Z', customer_name: 'Before Midnight' }), // Nov 3, 11:30 PM
      booking({ starts_at: '2026-11-04T15:00:00Z', ends_at: '2026-11-04T16:30:00Z', customer_name: 'Dana Ruiz', customer_phone: '+13125550142', address: '400 Lake St, Oak Park', quote_id: QUOTE }),
      booking({ starts_at: '2026-11-04T20:30:00Z', ends_at: '2026-11-04T22:00:00Z', customer_name: 'Sam Ortiz', customer_phone: '+13125550199', address: '12 Pine Ave' }),
      booking({ starts_at: '2026-11-04T18:00:00Z', ends_at: '2026-11-04T19:00:00Z', customer_name: 'Still Waiting', state: 'requested' }),
      booking({ starts_at: '2026-11-04T17:00:00Z', ends_at: '2026-11-04T18:00:00Z', customer_name: 'Said No', state: 'declined' }),
      booking({ starts_at: '2026-11-05T05:00:00Z', ends_at: '2026-11-05T06:00:00Z', customer_name: 'Late Customer' }), // Nov 4, 11:00 PM
      booking({ starts_at: '2026-11-05T06:30:00Z', ends_at: '2026-11-05T07:30:00Z', customer_name: 'Next Day' }), // Nov 5, 12:30 AM
      booking({ workspace_id: 'ws-other', starts_at: '2026-11-04T16:00:00Z', ends_at: '2026-11-04T17:00:00Z', customer_name: 'Other Business' }),
    ],
    member: [{ workspace_id: WS, user_id: OWNER, role: 'owner' }],
    user_profiles: [],
  }
  db = memoryDb(tables)
})

describe('7 o’clock in the business’s own zone', () => {
  const at = (iso: string, zones: string[]) => planDailyJobs(zones.map((timeZone, i) => ({ workspaceId: `ws-${i}`, ownerUserId: 'u', timeZone })), Date.parse(iso))

  it('one request per business whose zone reads 7, whatever the zone, dated by its local day', () => {
    const zones = [CHICAGO, 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Auckland']
    // 13:00Z: 7:00 in Chicago (CST), 8:00 in New York, 5:00 in Los Angeles, 22:00 in Tokyo.
    expect(at('2026-11-04T13:00:00Z', zones)).toEqual([{ id: 'daily-jobs:ws-0:2026-11-04', name: DAILY_JOBS_EVENT, data: { workspaceId: 'ws-0', localDate: '2026-11-04' } }])
    // 18:00Z on Nov 3 is already 7:00 on Nov 4 in Auckland (NZDT, UTC+13): its own date, not UTC's.
    expect(at('2026-11-03T18:00:00Z', zones)).toEqual([{ id: 'daily-jobs:ws-4:2026-11-04', name: DAILY_JOBS_EVENT, data: { workspaceId: 'ws-4', localDate: '2026-11-04' } }])
  })

  it('follows the clocks across a daylight-saving change: 7:00 local is 12:00Z in October, 13:00Z in November', () => {
    expect(at('2026-10-30T12:00:00Z', [CHICAGO])).toHaveLength(1)
    expect(at('2026-10-30T13:00:00Z', [CHICAGO])).toHaveLength(0)
    expect(at('2026-11-02T12:00:00Z', [CHICAGO])).toHaveLength(0)
    expect(at('2026-11-02T13:00:00Z', [CHICAGO])).toHaveLength(1)
    // The fall-back day itself (Nov 1) still has exactly one 7 o'clock.
    const day = Array.from({ length: 24 }, (_, h) => at(`2026-11-01T${String(h).padStart(2, '0')}:00:00Z`, [CHICAGO]).length)
    expect(day.reduce((a, b) => a + b, 0)).toBe(1)
  })

  it('a half-hour zone gets its one hourly tick at 7:30; an unknown zone gets none', () => {
    expect(at('2026-11-04T02:00:00Z', ['Asia/Kolkata'])).toHaveLength(1)
    expect(localClock(Date.parse('2026-11-04T02:00:00Z'), 'Asia/Kolkata')).toEqual({ date: '2026-11-04', hour: 7 })
    expect(at('2026-11-04T13:00:00Z', ['Not/AZone'])).toEqual([])
  })

  it('the event id is one per business per local date, so a retried or repeated pass sends nothing twice', () => {
    expect(dailyJobsEventId(WS, '2026-11-04')).toBe('daily-jobs:ws-brightside:2026-11-04')
    expect(at('2026-11-04T13:00:00Z', [CHICAGO])[0].id).toBe(at('2026-11-04T13:00:00Z', [CHICAGO])[0].id)
  })

  it("reads each business's zone: its profile's, else its owner's", async () => {
    tables.business_profile.push({ workspace_id: 'ws-2', owner_user_id: 'user-2', business_name: 'Northside Tutoring', time_zone: null, booking_days: [], booking_start: '15:00', booking_end: '19:00', slot_minutes: 60, lead_hours: 12, horizon_days: 14, booking_kind: 'session', booking_slug: null })
    tables.member.push({ workspace_id: 'ws-2', user_id: 'user-2', role: 'owner', time_zone: 'America/Denver' })
    expect(await findDailyJobsBusinesses(db)).toEqual([
      { workspaceId: 'ws-2', ownerUserId: 'user-2', timeZone: 'America/Denver' },
      { workspaceId: WS, ownerUserId: OWNER, timeZone: CHICAGO },
    ])
  })
})

describe("the day's list", () => {
  it("lists only that local day's confirmed bookings, soonest first: time, name, address, phone, what (items, sizes, price)", async () => {
    const plan = await buildDailyJobs(db, { workspaceId: WS, localDate: '2026-11-04' }, { paused: async () => false })
    expect(plan).toEqual({
      outcome: 'ready',
      userId: OWNER,
      jobs: 3,
      body: [
        'Brightside Window Washing, today (Wed, Nov 4): 3 booked',
        '9:00 AM - Dana Ruiz - 400 Lake St, Oak Park - +1 (312) 555-0142 - 2 items (3x5 ft), window screens, $150',
        '2:30 PM - Sam Ortiz - 12 Pine Ave - +1 (312) 555-0199 - visit',
        '11:00 PM - Late Customer - visit',
      ].join('\n'),
    })
  })

  it('an empty day sends nothing at all; a paused agent or a workspace with no profile is skipped', async () => {
    expect(await buildDailyJobs(db, { workspaceId: WS, localDate: '2026-11-06' }, { paused: async () => false })).toEqual({ outcome: 'empty' })
    expect(await buildDailyJobs(db, { workspaceId: WS, localDate: '2026-11-04' }, { paused: async () => true })).toEqual({ outcome: 'paused' })
    expect(await buildDailyJobs(db, { workspaceId: 'ws-none', localDate: '2026-11-04' }, { paused: async () => false })).toEqual({ outcome: 'no_profile' })
    expect(await buildDailyJobs(db, { workspaceId: WS, localDate: 'Nov 4' })).toEqual({ outcome: 'bad_date' })
  })

  it("goes only to a profile owner who still runs the workspace (its owner or an admin)", async () => {
    tables.member[0].role = 'admin'
    expect(await buildDailyJobs(db, { workspaceId: WS, localDate: '2026-11-04' }, { paused: async () => false })).toMatchObject({ outcome: 'ready' })
    tables.member[0].role = 'member'
    expect(await buildDailyJobs(db, { workspaceId: WS, localDate: '2026-11-04' }, { paused: async () => false })).toEqual({ outcome: 'owner_gone' })
    tables.member = []
    expect(await buildDailyJobs(db, { workspaceId: WS, localDate: '2026-11-04' }, { paused: async () => false })).toEqual({ outcome: 'owner_gone' })
  })

  it("reads the kill switch itself: autonomy off skips the day", async () => {
    tables.workspace[0].settings = { agent_autonomy: { mode: 'off' } }
    expect(await buildDailyJobs(db, { workspaceId: WS, localDate: '2026-11-04' })).toEqual({ outcome: 'paused' })
  })

  it("keeps the customer's words to one short line each, and counts what a long day leaves out", () => {
    const line = dailyJobLine({ booking: { startsAt: '2026-11-04T15:00:00Z', customerName: `A ${'very '.repeat(20)}long name\nwith a break`, address: null, customerPhone: null, kind: 'visit' }, quote: null }, CHICAGO)
    expect(line).not.toContain('\n')
    expect(line.length).toBeLessThan(70)
    // A long quote's summary is clipped too.
    const items = Array.from({ length: 30 }, (_, i) => ({ description: `Item ${i}`, service: `A very long service name number ${i}`, width: 12, length: 34, unit: 'ft' }))
    const long = dailyJobLine({ booking: { startsAt: '2026-11-04T15:00:00Z', customerName: 'X', address: null, customerPhone: null, kind: 'visit' }, quote: { items, service: null, totalCents: 1000, currency: 'usd' } }, CHICAGO)
    expect(long.split(' - ').pop()!.length).toBeLessThanOrEqual(80)
    const jobs = Array.from({ length: 45 }, () => ({ booking: { startsAt: '2026-11-04T15:00:00Z', customerName: 'X', address: null, customerPhone: null, kind: 'visit' }, quote: null }))
    const text = dailyJobsText({ business: 'B', dayLabel: 'Wed, Nov 4', timeZone: CHICAGO, jobs })
    expect(text.split('\n')).toHaveLength(1 + 40 + 1)
    expect(text.endsWith('…and 5 more in Native Intelligence.')).toBe(true)
  })

  it("goes to the owner's home thread (once per date) and by text from the workspace's own number (textPerson)", async () => {
    const appendHome = vi.fn(async () => ({ written: true }))
    const text = vi.fn(async () => ({ sent: true as const, sid: 'SM1' }))
    expect(await writeDailyJobsHome(db, { workspaceId: WS, userId: OWNER, localDate: '2026-11-04', body: 'the list' }, { appendHome })).toBe(true)
    expect(appendHome).toHaveBeenCalledWith(db, { userId: OWNER, workspaceId: WS, parts: [{ type: 'text', text: 'the list' }], messageId: 'daily-jobs-ws-brightside-2026-11-04', metadata: { kind: 'daily_jobs', local_date: '2026-11-04' } })
    expect(await textDailyJobs(db, { workspaceId: WS, userId: OWNER, body: 'the list' }, { text })).toBe(true)
    expect(text).toHaveBeenCalledWith(db, { userId: OWNER, workspaceId: WS, body: 'the list', kind: 'notice' })
  })
})
