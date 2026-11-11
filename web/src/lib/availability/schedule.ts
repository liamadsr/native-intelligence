/**
 * A person's working hours (availability_schedule, migration 550): one row
 * per person, the same in every workspace they are in. A weekly pattern, and
 * dates whose hours replace that whole day (an empty date is a day off).
 *
 * Nobody has to set anything up: a person with no row works weekdays 9 to 6
 * (DEFAULT_WEEKLY) in their own zone. A row's zone is null until the person
 * names one, so their hours follow the zone they are in
 * (readMemberTimeZone's chain).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isStorableTimeZone, readMemberTimeZone } from '@/lib/agent-events/member-time-zone'
import { DEFAULT_WEEKLY, type AvailabilitySchedule, type DayRange } from './engine'
import { clockMinutes } from './zone'

const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** The most ranges one day holds. */
export const DAY_RANGES_MAX = 6
/** The most dated overrides one person keeps. */
export const OVERRIDES_MAX = 366

/** YYYY-MM-DD naming a real date (Date.parse alone takes 2026-02-30 as March 2). Pure. */
function isCalendarDate(value: string): boolean {
  const at = DATE_RE.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value
}

/** A day's ranges as stored: each HH:MM to a later HH:MM (or 24:00), in order, none overlapping. Null when they aren't. Pure. */
export function readDayRanges(value: unknown): DayRange[] | null {
  if (!Array.isArray(value) || value.length > DAY_RANGES_MAX) return null
  const out: DayRange[] = []
  for (const item of value as Array<{ start?: unknown; end?: unknown }>) {
    const start = item?.start
    const end = item?.end
    if (typeof start !== 'string' || typeof end !== 'string' || !CLOCK_RE.test(start) || !(CLOCK_RE.test(end) || end === '24:00')) return null
    if (clockMinutes(end) <= clockMinutes(start)) return null
    out.push({ start, end })
  }
  out.sort((a, b) => clockMinutes(a.start) - clockMinutes(b.start))
  for (let i = 1; i < out.length; i++) if (clockMinutes(out[i].start) < clockMinutes(out[i - 1].end)) return null
  return out
}

/** A stored weekly pattern (seven days, Sunday first), or null when it isn't one. Pure. */
export function readWeekly(value: unknown): DayRange[][] | null {
  if (!Array.isArray(value) || value.length !== 7) return null
  const out: DayRange[][] = []
  for (const day of value) {
    const ranges = readDayRanges(day)
    if (!ranges) return null
    out.push(ranges)
  }
  return out
}

/** Stored overrides, the unreadable ones dropped. Pure. */
export function readOverrides(value: unknown): Record<string, DayRange[]> {
  const out: Record<string, DayRange[]> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [date, ranges] of Object.entries(value as Record<string, unknown>)) {
    const read = DATE_RE.test(date) ? readDayRanges(ranges) : null
    if (read) out[date] = read
  }
  return out
}

export interface WorkingHours extends AvailabilitySchedule {
  weekly: DayRange[][]
  overrides: Record<string, DayRange[]>
  /** False when the person never set their hours: these are the defaults. */
  saved: boolean
  /** Where the zone came from: the person named it for their hours, or it follows the zone they are in. */
  zoneSource: 'schedule' | 'member'
}

interface ScheduleRow {
  time_zone?: unknown
  weekly?: unknown
  overrides?: unknown
}

/** A person's working hours, the defaults where they set none. Throws on a failed read (hours are never guessed on an error). */
export async function readWorkingHours(supabase: SupabaseClient, person: { userId: string; workspaceId: string }): Promise<WorkingHours> {
  const [found, memberZone] = await Promise.all([
    supabase.from('availability_schedule').select('time_zone, weekly, overrides').eq('user_id', person.userId).maybeSingle(),
    readMemberTimeZone(supabase, person),
  ])
  if (found.error) throw new Error(`Working hours could not be read: ${found.error.message}`)
  const row = found.data as ScheduleRow | null
  const ownZone = isStorableTimeZone(row?.time_zone) ? row.time_zone : null
  return {
    timeZone: ownZone ?? memberZone.timeZone,
    zoneSource: ownZone ? 'schedule' : 'member',
    weekly: readWeekly(row?.weekly) ?? DEFAULT_WEEKLY.map((day) => day.map((range) => ({ ...range }))),
    overrides: readOverrides(row?.overrides),
    saved: !!row,
  }
}

export interface WorkingHoursChange {
  /** The whole weekly pattern (seven days, Sunday first); left out, it stays. */
  weekly?: DayRange[][]
  /** A zone for the hours, or null to follow the zone the person is in; left out, it stays. */
  timeZone?: string | null
  /** Dates to set (an empty list is a day off). */
  setOverrides?: Record<string, DayRange[]>
  /** Dates to go back to the weekly pattern. */
  clearOverrides?: string[]
}

/** Save a change to a person's working hours and return them as they now stand. Throws on a bad value or a failed write. */
export async function saveWorkingHours(supabase: SupabaseClient, person: { userId: string; workspaceId: string }, change: WorkingHoursChange, now: number = Date.now()): Promise<WorkingHours> {
  const current = await readWorkingHours(supabase, person)
  const weekly = change.weekly === undefined ? current.weekly : readWeekly(change.weekly)
  if (!weekly) throw new Error('Working hours need seven days (Sunday first), each a list of HH:MM ranges that end after they start and do not overlap.')
  if (change.timeZone !== undefined && change.timeZone !== null && !isStorableTimeZone(change.timeZone)) throw new Error(`"${change.timeZone}" is not a time zone. Use an IANA name like America/New_York.`)

  const overrides = { ...current.overrides }
  for (const date of change.clearOverrides ?? []) delete overrides[date]
  for (const [date, ranges] of Object.entries(change.setOverrides ?? {})) {
    const read = isCalendarDate(date) ? readDayRanges(ranges) : null
    if (!read) throw new Error(`Could not read the hours for ${date}. Use an ISO date and HH:MM ranges.`)
    overrides[date] = read
  }
  // Dates gone by are dropped, so the list never grows without end.
  const cutoff = new Date(now - 2 * 24 * 60 * 60_000).toISOString().slice(0, 10)
  for (const date of Object.keys(overrides)) if (date < cutoff) delete overrides[date]
  if (Object.keys(overrides).length > OVERRIDES_MAX) throw new Error(`At most ${OVERRIDES_MAX} dated changes are kept.`)

  const timeZone = change.timeZone === undefined ? (current.zoneSource === 'schedule' ? current.timeZone : null) : change.timeZone
  const { error } = await supabase
    .from('availability_schedule')
    .upsert({ user_id: person.userId, time_zone: timeZone, weekly, overrides, updated_at: new Date(now).toISOString() }, { onConflict: 'user_id' })
  if (error) throw new Error(`Working hours could not be saved: ${error.message}`)
  return readWorkingHours(supabase, person)
}
