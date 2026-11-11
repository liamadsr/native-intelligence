/**
 * The public API of booking links (../public.ts): a link's page data (what a
 * guest may see, never a host's email or calendar), its open times (kept a
 * minute per link and range; unknown is a 503, never empty), a booking
 * (honeypot, caps by counted rows, the shared error shape), a business's job
 * link through the same routes (the customer's request on the owner's yes),
 * and an old /book/<slug> address resolved to the link it is now. Over the
 * real store on the one booking model in memory; made-up people.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/safety/approvals', () => ({ createToolApproval: vi.fn() }))

import { __clearLinkTimesCacheForTests, handleBookLink, handleGetLink, handleLegacySlug, handleLinkTimes, loadLinkPage, resolveLegacySlug, timesRange, type LinkPublicDeps } from '../public'
import { LINK_ATTEMPTS_HOURLY_CAP } from '../types'
import { AVA, BEN, hoursAhead, NY, openAt, seams, studioDb, WS } from './fixtures'
import type { BookingLinkDeps } from '@/lib/customers/booking-link'

type Row = Record<string, unknown>
const NOW = Date.now()
const T1 = hoursAhead(30, NOW)
const INTRO = '0f1e2d3c-4b5a-4968-8776-655443322110'
const JOB = '0f1e2d3c-4b5a-4968-8776-655443322111'

function linkRow(over: Row = {}): Row {
  return {
    id: INTRO, workspace_id: WS, owner_user_id: AVA, profile_id: 'prof-ava', slug: 'intro', purpose: 'meeting', title: 'Intro call', description: 'A first chat.',
    duration_minutes: 30, buffer_before_minutes: 0, buffer_after_minutes: 0, notice_minutes: 0, window_days: 30, step_minutes: null, daily_cap: null,
    questions: [{ id: 'company', label: 'Company', required: false, kind: 'text' }], video: true, location: null, ask_first: false, host_mode: 'all',
    weekly_hours: null, time_zone: null, job_kind: null, active: true, created_at: '2030-12-01T00:00:00Z', updated_at: '2030-12-01T00:00:00Z', ...over,
  }
}

function setup(over: { links?: Row[]; hosts?: Row[] } = {}) {
  const studio = studioDb({
    booking_profile: [
      { id: 'prof-ava', workspace_id: WS, user_id: AVA, handle: 'ava-lin' },
      { id: 'prof-ws', workspace_id: WS, user_id: null, handle: 'fernhill' },
    ],
    booking_link: over.links ?? [
      linkRow(),
      linkRow({ id: JOB, profile_id: 'prof-ws', slug: 'book', purpose: 'job', title: 'Pickup', job_kind: 'pickup', ask_first: true, host_mode: 'one', video: false, questions: [{ id: 'address', label: 'Address', required: false, kind: 'text' }] }),
    ],
    booking_link_host: over.hosts ?? [
      { link_id: INTRO, user_id: AVA, workspace_id: WS, position: 0 },
      { link_id: INTRO, user_id: BEN, workspace_id: WS, position: 1 },
      { link_id: JOB, user_id: AVA, workspace_id: WS, position: 0 },
    ],
    booking_link_attempt: [],
    business_profile: [{ workspace_id: WS, owner_user_id: AVA, business_name: 'Fernhill Studio', time_zone: NY, booking_days: [1, 2, 3, 4, 5], booking_start: '09:00', booking_end: '17:00', slot_minutes: 60, lead_hours: 24, horizon_days: 14, booking_kind: 'pickup', booking_slug: 'fernhill' }],
  })
  const s = seams()
  const readTimes = openAt([T1], [AVA, BEN])
  const deps: LinkPublicDeps = { supabase: studio.db, now: () => NOW, book: s.deps, readTimes, canText: vi.fn(async () => true), zoneOf: vi.fn(async () => NY) }
  return { ...studio, s, readTimes, deps }
}

const post = (body: unknown) => new Request('https://app.example/api/public/booking-links/ava-lin/intro/book', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const get = (query = '') => new Request(`https://app.example/api/public/booking-links/ava-lin/intro/times${query}`)

beforeEach(() => {
  __clearLinkTimesCacheForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

describe('the link', () => {
  it('reads what a guest may see: title, length, the hosts’ names, questions, zone, how they are reached; never an email', async () => {
    const { deps } = setup()
    const res = await handleGetLink('ava-lin', 'intro', deps)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = await res.json()
    expect(body.link).toEqual({
      profile: 'ava-lin',
      slug: 'intro',
      purpose: 'meeting',
      title: 'Intro call',
      description: 'A first chat.',
      duration_minutes: 30,
      window_days: 30,
      host_mode: 'all',
      host_names: ['Ava Lin', 'Ben Ruiz'],
      questions: [{ id: 'company', label: 'Company', required: false, kind: 'text' }],
      time_zone: NY,
      video: true,
      location: null,
      ask_first: false,
      contact: 'email_or_phone',
    })
    expect(JSON.stringify(body)).not.toContain('@')
    const page = await loadLinkPage(deps, 'ava-lin', 'intro')
    expect(page.kind === 'found' && page.data).toEqual(body.link)
  })

  it('a workspace that can’t text asks for an email; a business’s job link asks for a mobile and always asks first', async () => {
    const { deps } = setup()
    const noText = await (await handleGetLink('ava-lin', 'intro', { ...deps, canText: vi.fn(async () => false) })).json()
    expect(noText.link.contact).toBe('email')
    const job = await (await handleGetLink('fernhill', 'book', deps)).json()
    expect(job.link).toMatchObject({ purpose: 'job', host_names: ['Fernhill Studio'], contact: 'phone', ask_first: true, video: false })
  })

  it('a link that isn’t there, is turned off, or has no host is not found', async () => {
    expect((await handleGetLink('ava-lin', 'nope', setup().deps)).status).toBe(404)
    expect((await handleGetLink('nobody-here', 'intro', setup().deps)).status).toBe(404)
    expect((await handleGetLink('ava-lin', 'intro', setup({ links: [linkRow({ active: false })] }).deps)).status).toBe(404)
    expect((await handleGetLink('ava-lin', 'intro', setup({ hosts: [] }).deps)).status).toBe(404)
    expect((await loadLinkPage(setup().deps, 'ava-lin', 'nope')).kind).toBe('missing')
  })
})

describe('its times', () => {
  it('the open times as instants, in the hosts’ zone, read at most once a minute per link and range', async () => {
    const { deps, readTimes } = setup()
    const res = await handleLinkTimes(get('?from=2031-01-07&days=3&tz=America/Chicago'), 'ava-lin', 'intro', deps)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ time_zone: NY, from: '2031-01-07T06:00:00.000Z', to: '2031-01-10T06:00:00.000Z', slots: [{ start: T1, end: new Date(Date.parse(T1) + 30 * 60_000).toISOString() }] })
    await handleLinkTimes(get('?from=2031-01-07&days=3&tz=America/Chicago'), 'ava-lin', 'intro', deps)
    expect(readTimes).toHaveBeenCalledTimes(1)
    await handleLinkTimes(get('?from=2031-01-08&days=3&tz=America/Chicago'), 'ava-lin', 'intro', deps)
    expect(readTimes).toHaveBeenCalledTimes(2)
  })

  it('a time found taken at booking drops the kept times, so the page’s next read is fresh', async () => {
    const { deps, readTimes } = setup()
    await handleLinkTimes(get('?from=2031-01-07&days=3&tz=America/Chicago'), 'ava-lin', 'intro', deps)
    const taken = await handleBookLink(post({ start: hoursAhead(80, NOW), name: 'Dana', email: 'dana@initech.example' }), 'ava-lin', 'intro', deps)
    expect(taken.status).toBe(409)
    const calls = readTimes.mock.calls.length
    await handleLinkTimes(get('?from=2031-01-07&days=3&tz=America/Chicago'), 'ava-lin', 'intro', deps)
    expect(readTimes).toHaveBeenCalledTimes(calls + 1)
  })

  it('a host’s calendar that can’t be read is a 503, never an empty list', async () => {
    const { deps } = setup()
    const res = await handleLinkTimes(get(), 'ava-lin', 'intro', { ...deps, readTimes: vi.fn(async () => ({ known: false as const, reason: 'x' })) })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('a range it can’t read is a 400; at most a month at once', () => {
    expect(timesRange(new URLSearchParams('from=2031-13-40'), NY, NOW)).toBeNull()
    expect(timesRange(new URLSearchParams('days=0'), NY, NOW)).toBeNull()
    const wide = timesRange(new URLSearchParams('from=2031-01-01&days=90'), NY, NOW)!
    expect((wide.to - wide.from) / 86_400_000).toBe(31)
  })

  it('a job link’s times are the business’s open slots', async () => {
    const { deps } = setup()
    const jobTimes = vi.fn(async () => ({ timeZone: NY, slots: [{ start: T1, end: hoursAhead(31, NOW) }] }))
    const res = await handleLinkTimes(new Request('https://app.example/x?from=2031-01-07&days=7'), 'fernhill', 'book', { ...deps, jobTimes })
    expect((await res.json()).slots).toEqual([{ start: T1, end: hoursAhead(31, NOW) }])
    expect(jobTimes).toHaveBeenCalledWith({ workspaceId: WS, ownerUserId: AVA }, { fromDate: '2031-01-07', days: 7 })
  })
})

describe('booking', () => {
  it('201 with the booking and the guest’s manage link', async () => {
    const { deps, tables } = setup()
    const res = await handleBookLink(post({ start: T1, name: 'Dana Reyes', email: 'dana@initech.example', answers: { company: 'Initech' }, time_zone: 'America/Chicago' }), 'ava-lin', 'intro', deps)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, status: 'confirmed', booking: { start: T1, title: 'Intro call', host_name: 'Ava Lin and Ben Ruiz', video: true, conference_url: 'https://meet.example/abc-defg-hij', location: null } })
    expect(body.manage_url).toMatch(/^https:\/\/app\.example\/b\/[A-Za-z0-9_-]{24}$/)
    expect(tables.booking_link_attempt).toHaveLength(1)
    expect(tables.meeting_booking).toHaveLength(1)
  })

  it('the honeypot answers as if it went and writes nothing', async () => {
    const { deps, tables } = setup()
    const res = await handleBookLink(post({ start: T1, name: 'Bot', email: 'bot@spam.example', website: 'http://spam.example' }), 'ava-lin', 'intro', deps)
    expect(res.status).toBe(201)
    expect(tables.meeting_booking).toHaveLength(0)
    expect(tables.booking_link_attempt).toHaveLength(0)
  })

  it('capped: tries per link per hour, and bookings per guest per day', async () => {
    const { deps, tables } = setup()
    tables.booking_link_attempt.push(...Array.from({ length: LINK_ATTEMPTS_HOURLY_CAP }, (_, i) => ({ id: `a-${i}`, link_id: INTRO, created_at: new Date(NOW - 60_000).toISOString() })))
    expect((await handleBookLink(post({ start: T1, name: 'Dana', email: 'dana@initech.example' }), 'ava-lin', 'intro', deps)).status).toBe(429)
    const other = setup()
    other.tables.meeting_booking.push(
      ...[1, 2].map((i) => ({ id: `mb-${i}`, link_id: INTRO, workspace_id: WS, host_user_id: AVA, guest_email: 'dana@initech.example', guest_phone: null, state: 'confirmed', starts_at: hoursAhead(40 + i, NOW), ends_at: hoursAhead(41 + i, NOW), created_at: new Date(NOW - 3_600_000).toISOString() })),
    )
    expect((await handleBookLink(post({ start: T1, name: 'Dana', email: 'Dana@initech.example' }), 'ava-lin', 'intro', other.deps)).status).toBe(429)
  })

  it('its failures in the shared error shape: a time taken is 409, a missing contact 400 naming the field', async () => {
    const { deps } = setup()
    const taken = await handleBookLink(post({ start: hoursAhead(80, NOW), name: 'Dana', email: 'dana@initech.example' }), 'ava-lin', 'intro', deps)
    expect(taken.status).toBe(409)
    expect(await taken.json()).toMatchObject({ code: 'SLOT_TAKEN' })
    const noContact = await handleBookLink(post({ start: T1, name: 'Dana' }), 'ava-lin', 'intro', deps)
    expect(noContact.status).toBe(400)
    expect(await noContact.json()).toMatchObject({ code: 'NEEDS_CONTACT' })
    const badEmail = await handleBookLink(post({ start: T1, name: 'Dana', email: 'nope' }), 'ava-lin', 'intro', deps)
    expect(await badEmail.json()).toMatchObject({ code: 'BAD_INPUT', details: { field: 'email' } })
    expect((await handleBookLink(post({ name: 'Dana' }), 'ava-lin', 'intro', deps)).status).toBe(400)
    expect((await handleBookLink(new Request('https://app.example/x', { method: 'POST', body: 'not json' }), 'ava-lin', 'intro', deps)).status).toBe(400)
  })

  it('a job link’s booking is the customer’s request on the owner’s yes: their mobile, the address answer, no manage link', async () => {
    const { deps } = setup()
    const request = vi.fn(async () => ({ ok: true as const, booking: { id: 'b-1', startsAt: T1, endsAt: hoursAhead(31, NOW), address: '12 Elm St' } as never, approvalId: 'appr-1', label: 'Tue, Jan 7, 10:00 AM' }))
    const job: BookingLinkDeps = { profileBySlug: vi.fn(), businessPhone: vi.fn(), openSlots: vi.fn(), countLinkRequestsSince: vi.fn(async () => 0), request, now: () => NOW }
    const res = await handleBookLink(post({ start: T1, name: 'Sarah Lee', phone: '(212) 555-0199', answers: { address: '12 Elm St' } }), 'fernhill', 'book', { ...deps, job })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true, status: 'requested', booking: { start: T1, end: hoursAhead(31, NOW), title: 'Pickup', host_name: 'Fernhill Studio', video: false, conference_url: null, location: '12 Elm St' }, manage_url: null })
    expect(request).toHaveBeenCalledWith({ workspaceId: WS, ownerUserId: AVA }, { start: T1, name: 'Sarah Lee', phone: '+12125550199', address: '12 Elm St', note: null })
    // A mobile is required there.
    expect((await handleBookLink(post({ start: T1, name: 'Sarah Lee', email: 'sarah@example.com' }), 'fernhill', 'book', { ...deps, job })).status).toBe(400)
  })
})

describe('an old /book/<slug> address', () => {
  it('resolves to the business’s job link while it is on', async () => {
    const { deps, tables } = setup()
    const res = await handleLegacySlug('fernhill', deps)
    expect(await res.json()).toEqual({ profile: 'fernhill', slug: 'book' })
    tables.booking_link[1].active = false
    expect((await handleLegacySlug('fernhill', deps)).status).toBe(404)
  })

  it('a person’s handle, or one nobody has, is no old address', async () => {
    const { db } = setup()
    expect(await resolveLegacySlug(db, 'ava-lin')).toBeNull()
    expect(await resolveLegacySlug(db, 'not-a-handle')).toBeNull()
  })
})
