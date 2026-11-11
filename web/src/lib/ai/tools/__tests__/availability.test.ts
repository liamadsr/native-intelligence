/**
 * The availability tools (../availability.ts): find_times reads the range in
 * the person's zone and answers in it (an unread calendar is "unknown", never
 * a guess); get_working_hours names each weekday; set_working_hours changes
 * only what it is given. The store and the engine are mocked here; they have
 * their own tests (src/lib/availability/__tests__).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import type { z } from 'zod'
import type { WorkingHours } from '@/lib/availability/schedule'

const hoisted = vi.hoisted(() => ({
  getCalendarProvider: vi.fn(async (..._args: unknown[]): Promise<string | null> => 'google'),
  findTimes: vi.fn(),
  readWorkingHours: vi.fn(),
  saveWorkingHours: vi.fn(),
}))

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ marker: 'service' }) }))
vi.mock('@/lib/integrations/calendar', () => ({ getCalendarProvider: hoisted.getCalendarProvider }))
vi.mock('@/lib/availability/find-times', () => ({ findTimes: hoisted.findTimes, FIND_TIMES_MAX_DAYS: 31 }))
vi.mock('@/lib/availability/schedule', () => ({ readWorkingHours: hoisted.readWorkingHours, saveWorkingHours: hoisted.saveWorkingHours }))

import { createAvailabilityTools } from '../availability'

const EXEC = { toolCallId: 'c1', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>
const NY = 'America/New_York'
const at = (value: string) => Date.parse(value)
// Monday Nov 2 2026, 8:00 in New York.
const NOW = at('2026-11-02T13:00:00.000Z')

const NINE_TO_SIX = [{ start: '09:00', end: '18:00' }]
const WEEK = [[], NINE_TO_SIX, NINE_TO_SIX, NINE_TO_SIX, NINE_TO_SIX, NINE_TO_SIX, []]
const hours = (extra: Partial<WorkingHours> = {}): WorkingHours => ({ timeZone: NY, zoneSource: 'member', weekly: WEEK.map((d) => [...d]), overrides: {}, saved: false, ...extra })

type Answer = Record<string, unknown> & { success: boolean; error?: string }
const tools = (zone: { timeZone?: string } = {}) => createAvailabilityTools('user-ada', 'ws-fernhill', zone)
const run = async (name: 'find_times' | 'get_working_hours' | 'set_working_hours', input: Record<string, unknown>, zone: { timeZone?: string } = {}) =>
  (await tools(zone)[name].execute!(input as never, EXEC)) as unknown as Answer
const plain = (s: unknown) => String(s).replace(/\s/g, ' ')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  hoisted.getCalendarProvider.mockReset().mockResolvedValue('google')
  hoisted.findTimes.mockReset().mockResolvedValue({ known: true, free: [], suggested: [] })
  hoisted.readWorkingHours.mockReset().mockResolvedValue(hours())
  hoisted.saveWorkingHours.mockReset().mockImplementation(async (_s: unknown, _p: unknown, change: { weekly?: unknown }) => hours({ saved: true, ...(change.weekly ? { weekly: change.weekly as WorkingHours['weekly'] } : {}) }))
})

afterEach(() => {
  vi.useRealTimers()
})

const sent = () => hoisted.findTimes.mock.calls[0][0] as { from: number; to: number; durationMinutes: number; bufferMinutes: number; now: number; schedule: { timeZone: string }; userId: string; workspaceId?: string }

describe('find_times', () => {
  it('no calendar connected: a Connect card, and nothing read', async () => {
    hoisted.getCalendarProvider.mockResolvedValue(null)
    const out = await run('find_times', {})
    expect(out.success).toBe(false)
    expect(out.error).toMatch(/No calendar connected.*connect/)
    expect(hoisted.findTimes).not.toHaveBeenCalled()
  })

  it('the defaults: now to 7 days on, 30 minutes, a 10-minute gap', async () => {
    const out = await run('find_times', {})
    expect(sent()).toMatchObject({ userId: 'user-ada', workspaceId: 'ws-fernhill', from: NOW, to: NOW + 7 * 86_400_000, durationMinutes: 30, bufferMinutes: 10, now: NOW })
    expect(out).toMatchObject({ success: true, time_zone: NY, duration_minutes: 30, buffer_minutes: 10, working_hours_are_default: true, suggested: [], free: [] })
    expect(out.note).toMatch(/Nothing is free/)
  })

  it("reads the range in the person's zone: a bare date's start, and an end date through that whole day", async () => {
    await run('find_times', { from: '2026-11-03', to: '2026-11-05', duration_minutes: 45, buffer_minutes: 0 })
    expect(sent()).toMatchObject({ from: at('2026-11-03T05:00:00.000Z'), to: at('2026-11-06T05:00:00.000Z'), durationMinutes: 45, bufferMinutes: 0 })
  })

  it("a zone named for the hours wins; with none, this turn's browser zone over the saved one", async () => {
    await run('find_times', { from: '2026-11-03' }, { timeZone: 'Europe/Berlin' })
    expect(sent().schedule.timeZone).toBe('Europe/Berlin')
    expect(sent().from).toBe(at('2026-11-02T23:00:00.000Z'))

    hoisted.findTimes.mockClear()
    hoisted.readWorkingHours.mockResolvedValue(hours({ timeZone: 'Asia/Tokyo', zoneSource: 'schedule', saved: true }))
    const out = await run('find_times', {}, { timeZone: 'Europe/Berlin' })
    expect(sent().schedule.timeZone).toBe('Asia/Tokyo')
    expect(out).toMatchObject({ time_zone: 'Asia/Tokyo', working_hours_are_default: false })

    hoisted.findTimes.mockClear()
    hoisted.readWorkingHours.mockResolvedValue(hours())
    await run('find_times', {}, { timeZone: 'Not a zone' })
    expect(sent().schedule.timeZone).toBe(NY)
  })

  it('answers in the zone with the offset written, and a line to say', async () => {
    hoisted.findTimes.mockResolvedValue({
      known: true,
      suggested: [{ start: at('2026-11-03T15:00:00.000Z'), end: at('2026-11-03T15:30:00.000Z') }],
      free: [{ start: at('2026-11-03T14:00:00.000Z'), end: at('2026-11-03T17:00:00.000Z') }],
    })
    const out = await run('find_times', {})
    expect(out.note).toBeUndefined()
    const [suggested] = out.suggested as Array<{ start: string; end: string; label: string }>
    expect(suggested.start).toBe('2026-11-03T10:00:00-05:00')
    expect(suggested.end).toBe('2026-11-03T10:30:00-05:00')
    expect(plain(suggested.label)).toBe('Tue, Nov 3, 10:00 AM to 10:30 AM')
    expect(plain((out.free as Array<{ label: string }>)[0].label)).toBe('Tue, Nov 3, 9:00 AM to 12:00 PM')
  })

  it('a calendar that could not be read: unknown, never offered times', async () => {
    hoisted.findTimes.mockResolvedValue({ known: false, reason: 'A calendar account needs signing in again' })
    const out = await run('find_times', {})
    expect(out).toMatchObject({ success: false, unknown: true })
    expect(out.error).toMatch(/^Free time is unknown: A calendar account needs signing in again\./)
    expect(out.suggested).toBeUndefined()
    expect(out.free).toBeUndefined()
  })

  it('refuses a range it cannot read, one that is over, and one too long', async () => {
    expect((await run('find_times', { from: 'next tuesday' })).error).toMatch(/Could not read from \(next tuesday\)/)
    expect((await run('find_times', { to: 'soon' })).error).toMatch(/Could not read to \(soon\)/)
    expect((await run('find_times', { from: '2026-10-01', to: '2026-10-02' })).error).toMatch(/The range is over/)
    expect((await run('find_times', { from: '2026-11-05', to: '2026-11-04' })).error).toMatch(/The range is over/)
    expect((await run('find_times', { from: '2026-11-03', to: '2026-12-31' })).error).toMatch(/at most 31 days/)
    expect(hoisted.findTimes).not.toHaveBeenCalled()
    // A range that began in the past but runs on is fine (findTimes starts it at now).
    await run('find_times', { from: '2026-11-01', to: '2026-11-03' })
    expect(sent().from).toBe(at('2026-11-01T04:00:00.000Z'))
  })

  it('hours that cannot be read: an error, and nothing guessed', async () => {
    hoisted.readWorkingHours.mockRejectedValue(new Error('Working hours could not be read: statement timeout'))
    expect(await run('find_times', {})).toEqual({ success: false, error: 'Working hours could not be read: statement timeout' })
    expect(hoisted.findTimes).not.toHaveBeenCalled()
  })

  it('reads the hours for the person, with an empty workspace when none is given', async () => {
    await createAvailabilityTools('user-ada').find_times.execute!({} as never, EXEC)
    expect(hoisted.readWorkingHours).toHaveBeenCalledWith({ marker: 'service' }, { userId: 'user-ada', workspaceId: '' })
  })

  it('takes a duration from 5 to 480 minutes and a buffer up to 120', () => {
    const schema = tools().find_times.inputSchema as unknown as z.ZodType
    expect(schema.safeParse({ duration_minutes: 4 }).success).toBe(false)
    expect(schema.safeParse({ duration_minutes: 481 }).success).toBe(false)
    expect(schema.safeParse({ duration_minutes: 30.5 }).success).toBe(false)
    expect(schema.safeParse({ buffer_minutes: 121 }).success).toBe(false)
    expect(schema.safeParse({ duration_minutes: 60, buffer_minutes: 0, from: '2026-11-03', to: '2026-11-04' }).success).toBe(true)
  })
})

describe('get_working_hours', () => {
  it('each weekday by name, the dated changes, and where the zone comes from', async () => {
    hoisted.readWorkingHours.mockResolvedValue(hours({ overrides: { '2026-11-27': [] }, saved: true }))
    const out = await run('get_working_hours', {})
    expect(out).toEqual({
      success: true,
      time_zone: NY,
      time_zone_follows_the_person: true,
      is_default: false,
      week: { sunday: [], monday: NINE_TO_SIX, tuesday: NINE_TO_SIX, wednesday: NINE_TO_SIX, thursday: NINE_TO_SIX, friday: NINE_TO_SIX, saturday: [] },
      dated_changes: { '2026-11-27': [] },
    })
  })

  it('a failed read is an error', async () => {
    hoisted.readWorkingHours.mockRejectedValue(new Error('Working hours could not be read: down'))
    expect(await run('get_working_hours', {})).toEqual({ success: false, error: 'Working hours could not be read: down' })
  })
})

describe('set_working_hours', () => {
  const change = () => hoisted.saveWorkingHours.mock.calls[0][2] as Record<string, unknown>

  it('the days it names replace those days; the others stay as they are', async () => {
    const out = await run('set_working_hours', { week: { friday: [{ start: '09:00', end: '12:00' }], saturday: [{ start: '10:00', end: '14:00' }] } })
    expect(change()).toEqual({
      weekly: [[], NINE_TO_SIX, NINE_TO_SIX, NINE_TO_SIX, NINE_TO_SIX, [{ start: '09:00', end: '12:00' }], [{ start: '10:00', end: '14:00' }]],
      setOverrides: undefined,
      clearOverrides: undefined,
    })
    expect(hoisted.saveWorkingHours.mock.calls[0][1]).toEqual({ userId: 'user-ada', workspaceId: 'ws-fernhill' })
    expect(out).toMatchObject({ success: true, is_default: false, week: { friday: [{ start: '09:00', end: '12:00' }], saturday: [{ start: '10:00', end: '14:00' }], monday: NINE_TO_SIX } })
  })

  it('a day named with no ranges is a day off', async () => {
    await run('set_working_hours', { week: { monday: [] } })
    expect((change().weekly as unknown[])[1]).toEqual([])
  })

  it('dates and cleared dates go through as given; no week, the week is left alone', async () => {
    await run('set_working_hours', { dates: { '2026-11-27': [], '2026-11-28': [{ start: '10:00', end: '13:00' }] }, clear_dates: ['2026-12-24'] })
    expect(change()).toEqual({ weekly: undefined, setOverrides: { '2026-11-27': [], '2026-11-28': [{ start: '10:00', end: '13:00' }] }, clearOverrides: ['2026-12-24'] })
    expect(hoisted.readWorkingHours).not.toHaveBeenCalled()
  })

  it('a zone: named, or null to follow the person; left out, not sent at all', async () => {
    await run('set_working_hours', { time_zone: 'Asia/Tokyo' })
    expect(change()).toMatchObject({ timeZone: 'Asia/Tokyo' })
    hoisted.saveWorkingHours.mockClear()
    await run('set_working_hours', { time_zone: null })
    expect(change()).toMatchObject({ timeZone: null })
    hoisted.saveWorkingHours.mockClear()
    await run('set_working_hours', { clear_dates: ['2026-12-24'] })
    expect('timeZone' in change()).toBe(false)
  })

  it("the store's refusal comes back as the error", async () => {
    hoisted.saveWorkingHours.mockRejectedValue(new Error('"Mars/Olympus_Mons" is not a time zone. Use an IANA name like America/New_York.'))
    expect(await run('set_working_hours', { time_zone: 'Mars/Olympus_Mons' })).toEqual({ success: false, error: '"Mars/Olympus_Mons" is not a time zone. Use an IANA name like America/New_York.' })
  })

  it('takes only weekday names, HH:MM ranges and ISO dates', () => {
    const schema = tools().set_working_hours.inputSchema as unknown as z.ZodType
    expect(schema.safeParse({ week: { friday: [{ start: '09:00', end: '24:00' }] } }).success).toBe(true)
    expect(schema.safeParse({ week: { funday: [] } }).success).toBe(false)
    expect(schema.safeParse({ week: { friday: [{ start: '9am', end: '5pm' }] } }).success).toBe(false)
    expect(schema.safeParse({ week: { friday: [{ start: '24:00', end: '24:00' }] } }).success).toBe(false)
    expect(schema.safeParse({ dates: { 'next friday': [] } }).success).toBe(false)
    expect(schema.safeParse({ clear_dates: ['2026-11-27'] }).success).toBe(true)
  })
})
