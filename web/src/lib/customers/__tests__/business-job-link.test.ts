/**
 * A business's booking rules on its job link (migration 581, ../store.ts):
 * the profile reads its days, hours, length, lead time, horizon and job word
 * from the link, and its booking slug from the workspace's handle while the
 * link is on; a change to them writes the link (made the first time: the
 * owner its one host, every request on their yes, the address question) and
 * the handle; the old /book/<slug> finds the business by its handle. The
 * profile's own columns are left as they were. Over the real store in
 * memory; the business is made up.
 */
import { describe, expect, it } from 'vitest'
import { bookingDb } from '@/test/booking-db'
import { bookingSetup, openSlots } from '../slots'
import { getBusinessProfile, getBusinessProfileBySlug, jobLinkColumns, upsertBusinessProfile, withJobLink } from '../store'
import type { BusinessProfile } from '../types'

type Row = Record<string, unknown>
const WS = 'ws-brightloom'
const OWNER = 'user-owner'
const NY = 'America/New_York'

function setup(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {
    workspace: [{ id: WS, name: 'Bright Loom', settings: { edition: 'service', edition_source: 'business' } }],
    business_profile: [
      { workspace_id: WS, owner_user_id: OWNER, business_name: 'Bright Loom', customer_facts: null, time_zone: NY, booking_days: [1, 2, 3, 4, 5], booking_start: '09:00', booking_end: '17:00', slot_minutes: 60, lead_hours: 24, horizon_days: 14, booking_kind: 'pickup', booking_slug: null, reminders: true },
    ],
    booking_profile: [],
    booking_link: [],
    booking_link_host: [],
    ...seed,
  }
  const db = bookingDb(tables, {
    booking_profile: (a, b) => a.handle === b.handle || (a.workspace_id === b.workspace_id && (a.user_id ?? null) === (b.user_id ?? null)),
    booking_link: (a, b) => a.purpose === 'job' && b.purpose === 'job' && a.workspace_id === b.workspace_id,
  })
  return { tables, db }
}

describe('a change to the booking rules', () => {
  it('makes the job link the first time: the owner its one host, every request on their yes, the address question; the slug the workspace’s handle', async () => {
    const { tables, db } = setup()
    const written = await upsertBusinessProfile(db, { workspaceId: WS, ownerUserId: OWNER }, { bookingDays: [1, 3, 5], bookingStart: '10:00', bookingEnd: '16:00', slotMinutes: 90, leadHours: 12, horizonDays: 21, bookingKind: 'visit', bookingSlug: 'Bright-Loom' })
    expect(written.ok).toBe(true)
    if (!written.ok) return
    expect(written.profile).toMatchObject({ bookingDays: [1, 3, 5], bookingStart: '10:00', bookingEnd: '16:00', slotMinutes: 90, leadHours: 12, horizonDays: 21, bookingKind: 'visit', bookingSlug: 'bright-loom', bookingWeekly: null })
    const [link] = tables.booking_link
    expect(link).toMatchObject({ purpose: 'job', slug: 'book', title: 'Visit', job_kind: 'visit', duration_minutes: 90, step_minutes: 90, notice_minutes: 720, window_days: 21, ask_first: true, host_mode: 'one', video: false, active: true, owner_user_id: OWNER })
    expect(link.questions).toEqual([{ id: 'address', label: 'Address', required: false, kind: 'text' }])
    expect(link.weekly_hours).toEqual([[], [{ start: '10:00', end: '16:00' }], [], [{ start: '10:00', end: '16:00' }], [], [{ start: '10:00', end: '16:00' }], []])
    expect(tables.booking_link_host).toEqual([expect.objectContaining({ link_id: link.id, user_id: OWNER, position: 0 })])
    expect(tables.booking_profile).toEqual([expect.objectContaining({ workspace_id: WS, user_id: null, handle: 'bright-loom' })])
    expect(link.profile_id).toBe(tables.booking_profile[0].id)
    // The profile's own columns are the undo: never written again.
    expect(tables.business_profile[0]).toMatchObject({ booking_days: [1, 2, 3, 4, 5], slot_minutes: 60, booking_slug: null })
  })

  it('changes the link it has, one field at a time; a start after the end is refused', async () => {
    const { tables, db } = setup()
    await upsertBusinessProfile(db, { workspaceId: WS, ownerUserId: OWNER }, { bookingSlug: 'bright-loom' })
    await upsertBusinessProfile(db, { workspaceId: WS, ownerUserId: OWNER }, { slotMinutes: 45 })
    expect(tables.booking_link).toHaveLength(1)
    expect(tables.booking_link[0]).toMatchObject({ duration_minutes: 45, step_minutes: 45, active: true })
    expect((await getBusinessProfile(db, WS))?.slotMinutes).toBe(45)
    expect(await upsertBusinessProfile(db, { workspaceId: WS, ownerUserId: OWNER }, { bookingStart: '18:00' })).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('keeps a notice set to the minute on the link (90 minutes) through a change that doesn’t name it', async () => {
    const { tables, db } = setup()
    await upsertBusinessProfile(db, { workspaceId: WS, ownerUserId: OWNER }, { bookingSlug: 'bright-loom' })
    tables.booking_link[0].notice_minutes = 90
    await upsertBusinessProfile(db, { workspaceId: WS, ownerUserId: OWNER }, { slotMinutes: 45 })
    expect(tables.booking_link[0].notice_minutes).toBe(90)
    await upsertBusinessProfile(db, { workspaceId: WS, ownerUserId: OWNER }, { leadHours: 3 })
    expect(tables.booking_link[0].notice_minutes).toBe(180)
  })

  it('a slug someone has is taken; null turns the page off and keeps the handle', async () => {
    const { tables, db } = setup({ booking_profile: [{ id: 'p-other', workspace_id: 'ws-other', user_id: null, handle: 'bright-loom' }] })
    expect(await upsertBusinessProfile(db, { workspaceId: WS, ownerUserId: OWNER }, { bookingSlug: 'bright-loom' })).toEqual({ ok: false, reason: 'slug_taken' })
    await upsertBusinessProfile(db, { workspaceId: WS, ownerUserId: OWNER }, { bookingSlug: 'brightloom' })
    const off = await upsertBusinessProfile(db, { workspaceId: WS, ownerUserId: OWNER }, { bookingSlug: null })
    expect(off.ok && off.profile.bookingSlug).toBeNull()
    expect(tables.booking_link[0].active).toBe(false)
    expect(tables.booking_profile.find((p) => p.workspace_id === WS)?.handle).toBe('brightloom')
    expect(await getBusinessProfileBySlug(db, 'brightloom')).toBeNull()
  })
})

describe('reading the profile', () => {
  it('the job link’s rules over the profile’s own; the slug while the page is on; an old /book/<slug> finds it by its handle', async () => {
    const { db } = setup()
    await upsertBusinessProfile(db, { workspaceId: WS, ownerUserId: OWNER }, { bookingSlug: 'bright-loom', bookingDays: [2, 4] })
    const profile = await getBusinessProfile(db, WS)
    expect(profile).toMatchObject({ businessName: 'Bright Loom', bookingDays: [2, 4], bookingSlug: 'bright-loom' })
    expect((await getBusinessProfileBySlug(db, 'bright-loom'))?.workspaceId).toBe(WS)
    expect(await getBusinessProfileBySlug(db, 'nobody')).toBeNull()
  })

  it('a profile with no job link yet reads its own columns', async () => {
    const { db } = setup()
    expect(await getBusinessProfile(db, WS)).toMatchObject({ bookingDays: [1, 2, 3, 4, 5], slotMinutes: 60, bookingSlug: null })
  })

  it('a person’s handle is never a business’s page', async () => {
    const { db } = setup({ booking_profile: [{ id: 'p-dana', workspace_id: WS, user_id: 'user-dana', handle: 'dana-wu' }] })
    expect(await getBusinessProfileBySlug(db, 'dana-wu')).toBeNull()
  })

  it('hours of more than one range a day (set on the link) come through whole, and the slots follow them', async () => {
    const weekly = [[], [{ start: '09:00', end: '11:00' }, { start: '14:00', end: '15:00' }], [], [], [], [], []]
    const { db } = setup({
      booking_link: [{ id: 'l-job', workspace_id: WS, owner_user_id: OWNER, profile_id: null, slug: 'book', purpose: 'job', title: 'Pickup', job_kind: 'pickup', duration_minutes: 60, step_minutes: 60, notice_minutes: 0, window_days: 14, weekly_hours: weekly, active: false, questions: [], created_at: '2030-01-01T00:00:00Z', updated_at: '2030-01-01T00:00:00Z' }],
    })
    const profile = (await getBusinessProfile(db, WS))!
    expect(profile.bookingWeekly).toEqual(weekly)
    expect(profile.bookingDays).toEqual([1])
    const setup_ = await bookingSetup(db, { workspaceId: WS, ownerUserId: OWNER })
    expect(setup_.rules.weekly).toEqual(weekly)
    // Monday Jan 6 2031 in New York: 9, 10 and 2 o'clock.
    const slots = openSlots({ rules: setup_.rules, timeZone: NY, now: Date.parse('2031-01-05T12:00:00Z'), busy: [], bookings: [], fromDate: '2031-01-06', days: 1 })
    expect(slots.map((s) => s.start)).toEqual(['2031-01-06T14:00:00.000Z', '2031-01-06T15:00:00.000Z', '2031-01-06T19:00:00.000Z'])
  })

  it('the pure halves: one range a day reads as days and hours; a fresh row without its defaults still makes a link', () => {
    const base = { bookingDays: [1], bookingStart: '09:00', bookingEnd: '17:00', slotMinutes: 60, leadHours: 24, horizonDays: 14, bookingKind: 'pickup', bookingSlug: null } as BusinessProfile
    const plain = withJobLink(base, { weeklyHours: [[], [{ start: '08:00', end: '12:00' }], [{ start: '08:00', end: '12:00' }], [], [], [], []], durationMinutes: 30, noticeMinutes: 90, windowDays: 7, jobKind: 'walk', active: true, profileHandle: 'paws' } as never)
    expect(plain).toMatchObject({ bookingDays: [1, 2], bookingStart: '08:00', bookingEnd: '12:00', bookingWeekly: null, slotMinutes: 30, leadHours: 2, horizonDays: 7, bookingKind: 'walk', bookingSlug: 'paws' })
    const bare = jobLinkColumns({ bookingDays: [] } as unknown as BusinessProfile, { bookingDays: [1, 2] })
    expect('columns' in bare && bare.columns).toMatchObject({ duration_minutes: 60, notice_minutes: 1440, window_days: 14, job_kind: 'pickup', weekly_hours: [[], [{ start: '09:00', end: '17:00' }], [{ start: '09:00', end: '17:00' }], [], [], [], []] })
  })
})
