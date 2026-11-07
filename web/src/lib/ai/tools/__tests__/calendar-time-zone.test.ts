/**
 * get_calendar_events in the person's zone (PROD, 2026-11-02): a week asked
 * for with bare dates came back Exchange-only, because Google refused the
 * bare date and the read skipped it in silence; and an Exchange call at
 * 12:00Z (7:00 am Eastern) was read as noon. The range is now read in the
 * person's zone, every time goes back in that zone with its offset, and a
 * calendar the read left out is named in the answer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import type { CalendarSkip } from '@/lib/integrations/calendar'

const hoisted = vi.hoisted(() => ({
  listCalendarEventsUnified: vi.fn(),
  readMemberTimeZone: vi.fn(async (..._args: unknown[]) => ({ timeZone: 'America/New_York', source: 'member' })),
}))

vi.mock('@/lib/integrations/calendar', () => ({
  listCalendarEventsUnified: hoisted.listCalendarEventsUnified,
  listCalendarEvents: vi.fn(),
  createCalendarEvent: vi.fn(),
  updateCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
  getCalendarProvider: vi.fn(async () => 'google'),
}))
vi.mock('@/lib/agent-events/member-time-zone', () => ({ readMemberTimeZone: hoisted.readMemberTimeZone }))

import { createCalendarTools, eventInZone, skippedWarnings } from '../calendar'

const EXEC = { toolCallId: 'c1', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>
const SUPABASE = { marker: 'service' } as never

type Answer = {
  success: boolean
  error?: string
  time_zone?: string
  events?: Array<Record<string, unknown>>
  partial?: boolean
  warnings?: string[]
}

async function run(input: Record<string, unknown>, zone: { timeZone?: string } = {}): Promise<Answer> {
  const tools = createCalendarTools('user-1', 'ws-1', { supabase: SUPABASE, ...zone })
  return (await tools.get_calendar_events.execute!({ max_results: 50, ...input } as never, EXEC)) as unknown as Answer
}

const sent = () => hoisted.listCalendarEventsUnified.mock.calls[0][1] as { timeMin?: string; timeMax?: string; onSkipped?: (s: CalendarSkip) => void }

beforeEach(() => {
  hoisted.listCalendarEventsUnified.mockReset()
  hoisted.listCalendarEventsUnified.mockResolvedValue([])
  hoisted.readMemberTimeZone.mockClear()
})

describe('get_calendar_events: the range is read in the person zone', () => {
  it('sends bare dates as that day’s start, and the end date through the whole day (the PROD week)', async () => {
    const out = await run({ start_date: '2026-11-02', end_date: '2026-11-07' })
    expect(out).toMatchObject({ success: true, time_zone: 'America/New_York' })
    expect(sent().timeMin).toBe('2026-11-02T05:00:00.000Z')
    // Through Saturday 23:59 Eastern: the end is Sunday's midnight there.
    expect(sent().timeMax).toBe('2026-11-08T05:00:00.000Z')
    expect(hoisted.readMemberTimeZone).toHaveBeenCalledWith(SUPABASE, { workspaceId: 'ws-1', userId: 'user-1' })
  })

  it('crosses the daylight-saving change: Sunday starts in EDT, ends in EST', async () => {
    await run({ start_date: '2026-11-01', end_date: '2026-11-01' })
    expect(sent().timeMin).toBe('2026-11-01T04:00:00.000Z')
    expect(sent().timeMax).toBe('2026-11-02T05:00:00.000Z')
  })

  it('reads a date-time with no offset as the person’s clock, and one with an offset as written', async () => {
    await run({ start_date: '2026-11-02T09:00:00', end_date: '2026-11-02T17:00:00-08:00' })
    expect(sent().timeMin).toBe('2026-11-02T14:00:00.000Z')
    expect(sent().timeMax).toBe('2026-11-03T01:00:00.000Z')
  })

  it('takes this turn’s browser zone over the saved one', async () => {
    const out = await run({ start_date: '2026-11-02' }, { timeZone: 'Europe/Berlin' })
    expect(out.time_zone).toBe('Europe/Berlin')
    expect(sent().timeMin).toBe('2026-11-01T23:00:00.000Z')
    // No end: 7 days after the start, not after now.
    expect(sent().timeMax).toBe('2026-11-08T23:00:00.000Z')
    expect(hoisted.readMemberTimeZone).not.toHaveBeenCalled()
  })

  it('leaves the defaults to the provider read when no range is given', async () => {
    await run({})
    expect(sent().timeMin).toBeUndefined()
    expect(sent().timeMax).toBeUndefined()
  })

  it('refuses an unreadable or backwards range instead of reading the wrong one', async () => {
    expect(await run({ start_date: 'next week' })).toMatchObject({ success: false, error: expect.stringContaining('start_date') })
    expect(await run({ start_date: '2026-11-08', end_date: '2026-11-02' })).toMatchObject({ success: false, error: 'end_date must be after start_date.' })
    expect(hoisted.listCalendarEventsUnified).not.toHaveBeenCalled()
  })
})

describe('get_calendar_events: every time in the person zone', () => {
  it('re-renders UTC Exchange times, keeps Google’s Eastern times, and leaves all-day dates alone', async () => {
    hoisted.listCalendarEventsUnified.mockResolvedValue([
      { id: 'x1', title: 'Work call', start: '2026-11-05T12:00:00+00:00', end: '2026-11-05T12:30:00+00:00', provider: 'local_exchange' },
      { id: 'g1', title: 'Standup', start: '2026-11-05T06:30:00-05:00', end: '2026-11-05T06:45:00-05:00', provider: 'google' },
      { id: 'g2', title: 'Offsite', start: '2026-11-06', end: '2026-11-07', isAllDay: true, provider: 'google' },
      { id: 'm1', title: 'Outlook all-day', start: '2026-11-06T00:00:00.000Z', end: '2026-11-07T00:00:00.000Z', isAllDay: true, provider: 'microsoft' },
    ])
    const out = await run({ start_date: '2026-11-02', end_date: '2026-11-08' })
    expect(out.events!.map((e) => [e.id, e.start, e.end])).toEqual([
      ['x1', '2026-11-05T07:00:00-05:00', '2026-11-05T07:30:00-05:00'],
      ['g1', '2026-11-05T06:30:00-05:00', '2026-11-05T06:45:00-05:00'],
      ['g2', '2026-11-06', '2026-11-07'],
      ['m1', '2026-11-06T00:00:00.000Z', '2026-11-07T00:00:00.000Z'],
    ])
    expect(out.partial).toBeUndefined()
    expect(out).not.toHaveProperty('warnings')
  })

  it('eventInZone keeps the rest of the event and leaves an unreadable time as it is', () => {
    const e = { id: 'e', title: 'T', start: '2026-07-01T16:00:00Z', end: '', isAllDay: false, description: 'd' }
    expect(eventInZone(e, 'America/Los_Angeles')).toEqual({ ...e, start: '2026-07-01T09:00:00-07:00', end: '' })
    const allDay = { start: '2026-07-01', end: '2026-07-02', isAllDay: true }
    expect(eventInZone(allDay, 'Asia/Tokyo')).toBe(allDay)
  })
})

describe('get_calendar_events: a calendar the read left out', () => {
  it('says the list is partial and names the calendar', async () => {
    hoisted.listCalendarEventsUnified.mockImplementation(async (_user: string, options: { onSkipped?: (s: CalendarSkip) => void }) => {
      options.onSkipped?.({ provider: 'google', accountEmail: 'me@gmail.com', reason: 'Google Calendar API error: 400' })
      options.onSkipped?.({ provider: 'google', accountEmail: 'me@gmail.com', reason: 'Google Calendar API error: 400' })
      return [{ id: 'x1', title: 'Work call', start: '2026-11-05T12:00:00+00:00', end: '2026-11-05T12:30:00+00:00', provider: 'local_exchange' }]
    })
    const out = await run({ start_date: '2026-11-02', end_date: '2026-11-08' })
    expect(out).toMatchObject({ success: true, partial: true })
    expect(out.warnings).toEqual([
      "Google calendar me@gmail.com couldn't be read (Google Calendar API error: 400): its events are missing from this list.",
    ])
  })

  it('leaves out a warning about another account when one account is named', async () => {
    hoisted.listCalendarEventsUnified.mockImplementation(async (_user: string, options: { onSkipped?: (s: CalendarSkip) => void }) => {
      options.onSkipped?.({ provider: 'microsoft', accountEmail: 'me@work.com', reason: 'it needs signing in again' })
      return [{ id: 'g1', title: 'Standup', start: '2026-11-05T11:30:00Z', end: '2026-11-05T11:45:00Z', accountEmail: 'me@gmail.com' }]
    })
    const out = await run({ account_email: 'Me@Gmail.com' })
    expect(out.events).toHaveLength(1)
    expect(out).not.toHaveProperty('partial')
  })

  it('skippedWarnings words each kind of calendar', () => {
    expect(skippedWarnings([
      { provider: 'microsoft', reason: 'it needs signing in again' },
      { provider: 'local_exchange', reason: 'timeout' },
    ])).toEqual([
      "Outlook calendar couldn't be read (it needs signing in again): its events are missing from this list.",
      "Exchange calendar (from the Mac app) couldn't be read (timeout): its events are missing from this list.",
    ])
  })
})
