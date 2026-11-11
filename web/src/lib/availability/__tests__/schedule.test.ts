/**
 * A person's working hours (../schedule.ts, availability_schedule, migration
 * 550): the defaults with no row, the zone they follow until they name one,
 * every bad value refused before anything is written, dated changes set and
 * cleared, and dates gone by dropped on save.
 */
import { describe, expect, it } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { DEFAULT_WEEKLY, type DayRange } from '../engine'
import { DAY_RANGES_MAX, readDayRanges, readOverrides, readWeekly, readWorkingHours, saveWorkingHours } from '../schedule'

const PERSON = { userId: 'user-ada', workspaceId: 'ws-fernhill' }
const NINE_TO_FIVE: DayRange[] = [{ start: '09:00', end: '17:00' }]
const WEEK: DayRange[][] = [[], NINE_TO_FIVE, NINE_TO_FIVE, NINE_TO_FIVE, NINE_TO_FIVE, [{ start: '09:00', end: '12:00' }], []]
// Tuesday Nov 10 2026, noon UTC.
const NOW = Date.parse('2026-11-10T12:00:00.000Z')

function db(rows: { schedule?: Record<string, unknown>[]; memberZone?: string | null; profileZone?: string } = {}) {
  const tables = {
    availability_schedule: rows.schedule ?? [],
    member: [{ id: 'm-1', workspace_id: PERSON.workspaceId, user_id: PERSON.userId, time_zone: rows.memberZone === undefined ? 'America/Chicago' : rows.memberZone }],
    user_profiles: rows.profileZone ? [{ user_id: PERSON.userId, timezone: rows.profileZone }] : [],
  }
  return { tables, supabase: memoryDb(tables) }
}

/** A client whose availability_schedule read or write fails. */
function failing(kind: 'read' | 'write') {
  const { supabase } = db()
  return {
    from: (table: string) => {
      if (table !== 'availability_schedule') return supabase.from(table)
      if (kind === 'write') {
        const real = supabase.from(table) as unknown as Record<string, unknown>
        return { ...real, upsert: async () => ({ data: null, error: { message: 'permission denied' } }) }
      }
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.maybeSingle = async () => ({ data: null, error: { message: 'statement timeout' } })
      return chain
    },
  } as never
}

describe('the stored shapes', () => {
  it("a day's ranges: HH:MM to a later HH:MM or 24:00, sorted, none overlapping", () => {
    expect(readDayRanges([])).toEqual([])
    expect(readDayRanges([{ start: '13:00', end: '17:00' }, { start: '09:00', end: '12:00' }])).toEqual([{ start: '09:00', end: '12:00' }, { start: '13:00', end: '17:00' }])
    expect(readDayRanges([{ start: '20:00', end: '24:00' }])).toEqual([{ start: '20:00', end: '24:00' }])
    // Touching ranges are fine; overlapping ones are not.
    expect(readDayRanges([{ start: '09:00', end: '12:00' }, { start: '12:00', end: '13:00' }])).toHaveLength(2)
    expect(readDayRanges([{ start: '09:00', end: '12:00' }, { start: '11:00', end: '13:00' }])).toBeNull()
    for (const bad of [{ start: '10:00', end: '09:00' }, { start: '10:00', end: '10:00' }, { start: '9:00', end: '10:00' }, { start: '24:00', end: '24:00' }, { start: '10:00', end: '24:30' }, { start: '10:00', end: '25:00' }, { start: 10, end: 11 }, null]) {
      expect(readDayRanges([bad]), JSON.stringify(bad)).toBeNull()
    }
    expect(readDayRanges('09:00-17:00')).toBeNull()
    expect(readDayRanges(Array.from({ length: DAY_RANGES_MAX + 1 }, (_, i) => ({ start: `${String(i).padStart(2, '0')}:00`, end: `${String(i).padStart(2, '0')}:30` })))).toBeNull()
  })

  it('a week is exactly seven readable days', () => {
    expect(readWeekly(WEEK)).toEqual(WEEK)
    expect(readWeekly(WEEK.slice(0, 6))).toBeNull()
    expect(readWeekly([...WEEK.slice(0, 6), [{ start: '17:00', end: '09:00' }]])).toBeNull()
    expect(readWeekly({})).toBeNull()
  })

  it('stored overrides keep the readable dates and drop the rest', () => {
    expect(readOverrides({ '2026-11-27': [], '2026-11-28': NINE_TO_FIVE, 'next friday': [], '2026-11-29': [{ start: '12:00', end: '11:00' }] })).toEqual({ '2026-11-27': [], '2026-11-28': NINE_TO_FIVE })
    expect(readOverrides(null)).toEqual({})
    expect(readOverrides([])).toEqual({})
  })
})

describe('readWorkingHours', () => {
  it('with no row: weekdays 9 to 6, in the zone the person is in, marked as defaults', async () => {
    const hours = await readWorkingHours(db().supabase, PERSON)
    expect(hours).toEqual({ timeZone: 'America/Chicago', zoneSource: 'member', zoneKnown: true, weekly: DEFAULT_WEEKLY, overrides: {}, saved: false })
    // A copy: changing it changes nobody else's defaults.
    hours.weekly[1].push({ start: '20:00', end: '21:00' })
    expect(DEFAULT_WEEKLY[1]).toEqual([{ start: '09:00', end: '18:00' }])
  })

  it('no zone known anywhere: UTC as a placeholder, said so (zoneKnown false); a profile zone before that', async () => {
    expect(await readWorkingHours(db({ memberZone: null }).supabase, PERSON)).toMatchObject({ timeZone: 'UTC', zoneKnown: false })
    expect(await readWorkingHours(db({ memberZone: null, profileZone: 'Europe/Lisbon' }).supabase, PERSON)).toMatchObject({ timeZone: 'Europe/Lisbon', zoneKnown: true })
    // A zone named for the hours is known, wherever else none is.
    expect(await readWorkingHours(db({ memberZone: null, schedule: [{ user_id: PERSON.userId, time_zone: 'Asia/Tokyo', weekly: WEEK, overrides: {} }] }).supabase, PERSON)).toMatchObject({ zoneKnown: true })
  })

  it('a row with a zone: that zone, from the schedule; a row with none follows the person', async () => {
    const own = await readWorkingHours(db({ schedule: [{ user_id: PERSON.userId, time_zone: 'Asia/Tokyo', weekly: WEEK, overrides: { '2026-11-27': [] } }] }).supabase, PERSON)
    expect(own).toEqual({ timeZone: 'Asia/Tokyo', zoneSource: 'schedule', zoneKnown: true, weekly: WEEK, overrides: { '2026-11-27': [] }, saved: true })
    const follows = await readWorkingHours(db({ schedule: [{ user_id: PERSON.userId, time_zone: null, weekly: WEEK, overrides: {} }] }).supabase, PERSON)
    expect(follows).toMatchObject({ timeZone: 'America/Chicago', zoneSource: 'member', saved: true })
  })

  it("another person's row is not theirs; an unreadable stored week falls back to the defaults", async () => {
    expect((await readWorkingHours(db({ schedule: [{ user_id: 'user-bo', time_zone: 'Asia/Tokyo', weekly: WEEK, overrides: {} }] }).supabase, PERSON)).saved).toBe(false)
    const broken = await readWorkingHours(db({ schedule: [{ user_id: PERSON.userId, time_zone: 'Not/AZone', weekly: [[]], overrides: 'x' }] }).supabase, PERSON)
    expect(broken).toMatchObject({ timeZone: 'America/Chicago', zoneSource: 'member', weekly: DEFAULT_WEEKLY, overrides: {}, saved: true })
  })

  it('a failed read throws: hours are never guessed', async () => {
    await expect(readWorkingHours(failing('read'), PERSON)).rejects.toThrow('Working hours could not be read: statement timeout')
  })
})

describe('saveWorkingHours', () => {
  it('saves a new week, keeps the zone following the person, and returns the hours as they now stand', async () => {
    const { tables, supabase } = db()
    const saved = await saveWorkingHours(supabase, PERSON, { weekly: WEEK }, NOW)
    expect(saved).toEqual({ timeZone: 'America/Chicago', zoneSource: 'member', zoneKnown: true, weekly: WEEK, overrides: {}, saved: true })
    expect(tables.availability_schedule).toHaveLength(1)
    expect(tables.availability_schedule[0]).toMatchObject({ user_id: PERSON.userId, time_zone: null, weekly: WEEK, overrides: {}, updated_at: '2026-11-10T12:00:00.000Z' })
  })

  it('one row per person: a second save updates it', async () => {
    const { tables, supabase } = db()
    await saveWorkingHours(supabase, PERSON, { weekly: WEEK }, NOW)
    await saveWorkingHours(supabase, PERSON, { setOverrides: { '2026-11-27': [] } }, NOW)
    expect(tables.availability_schedule).toHaveLength(1)
    expect(tables.availability_schedule[0]).toMatchObject({ weekly: WEEK, overrides: { '2026-11-27': [] } })
  })

  it('a named zone stays until it is changed, and null goes back to following the person', async () => {
    const { tables, supabase } = db()
    expect((await saveWorkingHours(supabase, PERSON, { timeZone: 'Asia/Tokyo' }, NOW)).zoneSource).toBe('schedule')
    // A change that leaves the zone out keeps it.
    const kept = await saveWorkingHours(supabase, PERSON, { weekly: WEEK }, NOW)
    expect(kept).toMatchObject({ timeZone: 'Asia/Tokyo', zoneSource: 'schedule' })
    expect(tables.availability_schedule[0].time_zone).toBe('Asia/Tokyo')
    const follows = await saveWorkingHours(supabase, PERSON, { timeZone: null }, NOW)
    expect(follows).toMatchObject({ timeZone: 'America/Chicago', zoneSource: 'member' })
    expect(tables.availability_schedule[0].time_zone).toBeNull()
  })

  it('dated changes: set (no ranges is a day off), replaced, cleared; a date in both is set', async () => {
    const { supabase } = db()
    await saveWorkingHours(supabase, PERSON, { setOverrides: { '2026-11-26': [], '2026-11-27': [], '2026-11-28': [{ start: '10:00', end: '14:00' }] } }, NOW)
    const next = await saveWorkingHours(supabase, PERSON, { setOverrides: { '2026-11-28': NINE_TO_FIVE, '2026-11-26': NINE_TO_FIVE }, clearOverrides: ['2026-11-27', '2026-11-26', '2026-12-31'] }, NOW)
    expect(next.overrides).toEqual({ '2026-11-26': NINE_TO_FIVE, '2026-11-28': NINE_TO_FIVE })
    // The week was never touched: still the defaults.
    expect(next.weekly).toEqual(DEFAULT_WEEKLY)
  })

  it('dates gone by are dropped on save; the last two days stay', async () => {
    const { tables, supabase } = db({ schedule: [{ user_id: PERSON.userId, time_zone: null, weekly: WEEK, overrides: { '2026-10-01': [], '2026-11-07': [], '2026-11-08': [], '2026-11-09': [], '2026-11-12': [] } }] })
    const saved = await saveWorkingHours(supabase, PERSON, {}, NOW)
    expect(Object.keys(saved.overrides).sort()).toEqual(['2026-11-08', '2026-11-09', '2026-11-12'])
    expect(Object.keys(tables.availability_schedule[0].overrides as object).sort()).toEqual(['2026-11-08', '2026-11-09', '2026-11-12'])
  })

  it('refuses a bad value and writes nothing', async () => {
    const refusals: Array<[Parameters<typeof saveWorkingHours>[2], string]> = [
      [{ weekly: WEEK.slice(0, 6) }, 'Working hours need seven days'],
      [{ weekly: [...WEEK.slice(0, 6), [{ start: '09:00', end: '12:00' }, { start: '11:00', end: '13:00' }]] }, 'Working hours need seven days'],
      [{ weekly: [...WEEK.slice(0, 6), [{ start: '18:00', end: '09:00' }]] }, 'Working hours need seven days'],
      [{ timeZone: 'Mars/Olympus_Mons' }, '"Mars/Olympus_Mons" is not a time zone'],
      [{ timeZone: '' }, 'is not a time zone'],
      [{ setOverrides: { 'next friday': [] } }, 'Could not read the hours for next friday'],
      [{ setOverrides: { '2026-02-30': [] } }, 'Could not read the hours for 2026-02-30'],
      [{ setOverrides: { '2026-13-01': [] } }, 'Could not read the hours for 2026-13-01'],
      [{ setOverrides: { '2026-11-27': [{ start: '14:00', end: '13:00' }] } }, 'Could not read the hours for 2026-11-27'],
    ]
    for (const [change, message] of refusals) {
      const { tables, supabase } = db()
      await expect(saveWorkingHours(supabase, PERSON, change, NOW), JSON.stringify(change)).rejects.toThrow(message)
      expect(tables.availability_schedule, JSON.stringify(change)).toEqual([])
    }
  })

  it('a leap day is a date; at most 366 dated changes are kept', async () => {
    const { supabase } = db()
    expect((await saveWorkingHours(supabase, PERSON, { setOverrides: { '2028-02-29': [] } }, NOW)).overrides).toEqual({ '2028-02-29': [] })
    const many = Object.fromEntries(Array.from({ length: 367 }, (_, i) => [new Date(NOW + (i + 1) * 86_400_000).toISOString().slice(0, 10), []]))
    await expect(saveWorkingHours(db().supabase, PERSON, { setOverrides: many }, NOW)).rejects.toThrow('At most 366 dated changes are kept.')
  })

  it('a failed write throws', async () => {
    await expect(saveWorkingHours(failing('write'), PERSON, { weekly: WEEK }, NOW)).rejects.toThrow('Working hours could not be saved: permission denied')
  })
})
