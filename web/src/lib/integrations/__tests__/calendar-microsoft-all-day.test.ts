/**
 * Outlook all-day events are calendar DAYS on the server too.
 *
 * Graph says an all-day event as midnight to midnight with no zone. Read as
 * UTC instants, Thanksgiving (Thu Nov 26) was 4pm Wednesday to a reader in
 * Los Angeles, so every server reader that put an event in the person's zone
 * (the assistant's calendar tools, the spoken brief, the calendar card) had
 * it a day early. They now get dates, the shape Google's all-day events have
 * always had. The events are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ getValidToken: vi.fn() }))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidToken: hoisted.getValidToken,
  getValidTokenForAccount: vi.fn(),
  getValidTokenForCapability: vi.fn(),
  getAllValidTokens: vi.fn(),
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))

const { listCalendarEvents, microsoftEventTimes } = await import('@/lib/integrations/calendar')
const { eventInZone } = await import('@/lib/ai/tools/calendar')
const { allDayDates } = await import('@/calendar/adapters')

const originalFetch = globalThis.fetch
beforeEach(() => {
  hoisted.getValidToken.mockReset().mockImplementation(async (_u: string, provider: string) => (provider === 'microsoft' ? { token: 'mtok' } : null))
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

// As Graph's calendarView returns them (no Prefer: outlook.timezone header: UTC wall time, seven fraction digits).
const THANKSGIVING = {
  id: 'AAMk-holiday',
  subject: 'Thanksgiving Day',
  isAllDay: true,
  start: { dateTime: '2026-11-26T00:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-11-27T00:00:00.0000000', timeZone: 'UTC' },
}
const OFFSITE = {
  id: 'AAMk-offsite',
  subject: 'Offsite',
  isAllDay: true,
  start: { dateTime: '2026-11-22T00:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-11-28T00:00:00.0000000', timeZone: 'UTC' },
}
const STANDUP = {
  id: 'AAMk-standup',
  subject: 'Standup',
  isAllDay: false,
  start: { dateTime: '2026-11-26T17:30:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-11-26T17:45:00.0000000', timeZone: 'UTC' },
}

const ZONES = ['America/Los_Angeles', 'Pacific/Honolulu', 'America/New_York', 'UTC', 'Europe/Berlin', 'Asia/Kolkata', 'Pacific/Auckland']

describe('microsoftEventTimes', () => {
  it('gives an all-day event its dates, the end exclusive, never through a Date', () => {
    expect(microsoftEventTimes(THANKSGIVING)).toEqual({ start: '2026-11-26', end: '2026-11-27' })
    expect(microsoftEventTimes(OFFSITE)).toEqual({ start: '2026-11-22', end: '2026-11-28' })
    // Whatever zone Graph was asked to answer in, an all-day event's wall date is its date.
    expect(microsoftEventTimes({ isAllDay: true, start: { dateTime: '2026-11-26T00:00:00' }, end: { dateTime: '2026-11-27T00:00:00' } })).toEqual({ start: '2026-11-26', end: '2026-11-27' })
  })

  it('keeps a timed event as instants, as before', () => {
    expect(microsoftEventTimes(STANDUP)).toEqual({ start: '2026-11-26T17:30:00.000Z', end: '2026-11-26T17:45:00.000Z' })
    expect(microsoftEventTimes({ isAllDay: false, start: { dateTime: '2026-11-26T17:30:00Z' }, end: { dateTime: '2026-11-26T09:45:00-08:00' } })).toEqual({
      start: '2026-11-26T17:30:00.000Z',
      end: '2026-11-26T17:45:00.000Z',
    })
  })

  it('answers empty for a missing or unreadable time', () => {
    expect(microsoftEventTimes({})).toEqual({ start: '', end: '' })
    expect(microsoftEventTimes({ isAllDay: false, start: { dateTime: 'soon' }, end: {} })).toEqual({ start: '', end: '' })
  })
})

describe('an Outlook calendar read', () => {
  it('returns all-day events as dates and timed ones as instants', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ value: [THANKSGIVING, OFFSITE, STANDUP] }) })) as unknown as typeof fetch
    const events = await listCalendarEvents('user-1')
    expect(events.map((e) => [e.title, e.start, e.end, e.isAllDay])).toEqual([
      ['Thanksgiving Day', '2026-11-26', '2026-11-27', true],
      ['Offsite', '2026-11-22', '2026-11-28', true],
      ['Standup', '2026-11-26T17:30:00.000Z', '2026-11-26T17:45:00.000Z', false],
    ])
  })

  it.each(ZONES)('reads as the same days by the assistant’s calendar tools in %s', (zone) => {
    const event = { ...microsoftEventTimes(THANKSGIVING), isAllDay: true }
    expect(eventInZone(event, zone)).toEqual({ start: '2026-11-26', end: '2026-11-27', isAllDay: true })
  })

  it.each(ZONES)('is drawn on the same days by the calendar in %s', (zone) => {
    const clock = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
    const holiday = microsoftEventTimes(THANKSGIVING)
    expect(allDayDates(holiday.start, holiday.end, clock)).toEqual({ start: '2026-11-26', end: '2026-11-26' })
    const offsite = microsoftEventTimes(OFFSITE)
    expect(allDayDates(offsite.start, offsite.end, clock)).toEqual({ start: '2026-11-22', end: '2026-11-27' })
  })
})
