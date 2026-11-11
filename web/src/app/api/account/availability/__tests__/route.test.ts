/**
 * /api/account/availability, /calendars and /copy (Settings > Availability
 * and the calendar's Copy availability). Pins: auth passes through; hours
 * and sharing read and saved for the caller only, a bad value a 400 with
 * nothing written; a calendar choice only on the caller's own account; copy
 * takes the four ranges and answers unknown rather than a guess.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { memoryDb } from '@/test/memory-db'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  service: { current: null as unknown },
  listCalendarChoices: vi.fn(),
  saveCalendarChoice: vi.fn(),
  availabilityText: vi.fn(),
}))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.service.current }))
vi.mock('@/lib/availability/calendar-choices', () => ({ listCalendarChoices: hoisted.listCalendarChoices, saveCalendarChoice: hoisted.saveCalendarChoice }))
vi.mock('@/lib/availability/copy-text', async (importOriginal) => ({ ...(await importOriginal<object>()), availabilityText: hoisted.availabilityText }))

import { GET, PUT } from '../route'
import { GET as GET_CALENDARS, PUT as PUT_CALENDAR } from '../calendars/route'
import { GET as GET_COPY } from '../copy/route'

const ME = 'user-ada'
const WS = 'ws-fernhill'
const NINE_TO_FIVE = [{ start: '09:00', end: '17:00' }]
const WEEK = [[], NINE_TO_FIVE, NINE_TO_FIVE, NINE_TO_FIVE, NINE_TO_FIVE, NINE_TO_FIVE, []]

let tables: Record<string, Record<string, unknown>[]>
beforeEach(() => {
  vi.clearAllMocks()
  tables = {
    availability_schedule: [],
    member: [
      { id: 'm-ada', user_id: ME, workspace_id: WS, time_zone: 'America/New_York', availability_sharing: 'busy_only' },
      { id: 'm-dana', user_id: 'user-dana', workspace_id: WS, time_zone: 'America/Chicago', availability_sharing: 'busy_only' },
    ],
    user_profiles: [],
  }
  hoisted.service.current = memoryDb(tables)
  hoisted.requireWorkspace.mockResolvedValue({ supabase: {}, user: { id: ME }, workspaceId: WS })
})

const BASE = 'https://nativeintelligence.dev/api/account/availability'
const put = (body: unknown, raw = false) => PUT(buildRequest({ url: BASE, method: 'PUT', body, raw }) as unknown as NextRequest)

describe('auth', () => {
  it("passes the auth helper's response through", async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response(null, { status: 401 }))
    expect((await GET()).status).toBe(401)
    expect((await put({})).status).toBe(401)
    expect((await GET_CALENDARS()).status).toBe(401)
    expect((await PUT_CALENDAR(buildRequest({ url: `${BASE}/calendars`, method: 'PUT', body: {} }) as unknown as NextRequest)).status).toBe(401)
    expect((await GET_COPY(buildRequest({ url: `${BASE}/copy?range=today`, method: 'GET' }) as unknown as NextRequest)).status).toBe(401)
  })
})

describe('hours and sharing', () => {
  it('GET: the defaults and busy_only before anything is set', async () => {
    const body = await readJson<{ hours: Record<string, unknown>; sharing: string }>(await GET())
    expect(body).toMatchObject({ sharing: 'busy_only', hours: { time_zone: 'America/New_York', follows_you: true, saved: false, overrides: {} } })
    expect((body.hours.weekly as unknown[]).length).toBe(7)
  })

  it("PUT: the week and the sharing, on the caller's own rows only", async () => {
    const res = await put({ weekly: WEEK, sharing: 'none' })
    expect(res.status).toBe(200)
    expect(await readJson(res)).toMatchObject({ sharing: 'none', hours: { weekly: WEEK, saved: true } })
    expect(tables.availability_schedule).toHaveLength(1)
    expect(tables.availability_schedule[0]).toMatchObject({ user_id: ME, weekly: WEEK })
    expect(tables.member.map((m) => m.availability_sharing)).toEqual(['none', 'busy_only'])
  })

  it('PUT: a dated change removed', async () => {
    tables.availability_schedule.push({ user_id: ME, time_zone: null, weekly: WEEK, overrides: { '2030-01-02': [], '2030-01-03': NINE_TO_FIVE } })
    const body = await readJson<{ hours: { overrides: Record<string, unknown> } }>(await put({ clear_dates: ['2030-01-02'] }))
    expect(Object.keys(body.hours.overrides)).toEqual(['2030-01-03'])
  })

  it('PUT: a bad value is a 400 and nothing is written', async () => {
    expect((await put({ sharing: 'everyone' })).status).toBe(400)
    expect((await put({ weekly: [[{ start: '10:00', end: '09:00' }]] })).status).toBe(400)
    expect((await put({ clear_dates: 'tomorrow' })).status).toBe(400)
    expect((await put('not json', true)).status).toBe(400)
    expect(tables.availability_schedule).toHaveLength(0)
    expect(tables.member[0].availability_sharing).toBe('busy_only')
  })
})

describe('calendars', () => {
  it('GET: the choices, in the API shape', async () => {
    hoisted.listCalendarChoices.mockResolvedValue([
      { id: 'acc-g', provider: 'google', accountEmail: 'ada.finch@example.com', error: null, calendars: [{ id: 'primary', name: 'Ada', color: null, primary: true, counts: true, countsByDefault: true }] },
    ])
    const body = await readJson(await GET_CALENDARS())
    expect(hoisted.listCalendarChoices).toHaveBeenCalledWith(hoisted.service.current, ME, WS)
    expect(body).toEqual({
      accounts: [{ id: 'acc-g', provider: 'google', account_email: 'ada.finch@example.com', error: null, calendars: [{ id: 'primary', name: 'Ada', color: null, primary: true, counts: true, counts_by_default: true }] }],
    })
  })

  it('PUT: one choice for the caller; a missing field or an account not theirs is a 400', async () => {
    const send = (body: unknown) => PUT_CALENDAR(buildRequest({ url: `${BASE}/calendars`, method: 'PUT', body }) as unknown as NextRequest)
    hoisted.saveCalendarChoice.mockResolvedValue(undefined)
    expect((await send({ account_id: 'acc-g', calendar_id: 'family', counts: false })).status).toBe(200)
    expect(hoisted.saveCalendarChoice).toHaveBeenCalledWith(hoisted.service.current, ME, { accountId: 'acc-g', calendarId: 'family', counts: false })
    expect((await send({ account_id: 'acc-g', calendar_id: 'family' })).status).toBe(400)
    hoisted.saveCalendarChoice.mockRejectedValue(new Error('Unknown calendar account'))
    expect((await send({ account_id: 'acc-bo', calendar_id: 'x', counts: true })).status).toBe(400)
  })
})

describe('copy', () => {
  const copy = (q: string) => GET_COPY(buildRequest({ url: `${BASE}/copy${q}`, method: 'GET' }) as unknown as NextRequest)

  it('the text for one of the four ranges, in the browser zone given', async () => {
    hoisted.availabilityText.mockResolvedValue({ known: true, text: 'My availability (EST):\nTue, Nov 10: 9:00 AM – 6:00 PM', timeZone: 'America/New_York' })
    const body = await readJson(await copy('?range=next_7_days&tz=America/New_York'))
    expect(body).toEqual({ known: true, text: 'My availability (EST):\nTue, Nov 10: 9:00 AM – 6:00 PM', time_zone: 'America/New_York' })
    expect(hoisted.availabilityText).toHaveBeenCalledWith(expect.objectContaining({ userId: ME, workspaceId: WS, range: 'next_7_days', browserTimeZone: 'America/New_York' }))
  })

  it('unknown says why; another range is a 400', async () => {
    hoisted.availabilityText.mockResolvedValue({ known: false, reason: 'A calendar account needs signing in again' })
    expect(await readJson(await copy('?range=today'))).toEqual({ known: false, reason: 'A calendar account needs signing in again' })
    expect((await copy('?range=next_month')).status).toBe(400)
  })
})
