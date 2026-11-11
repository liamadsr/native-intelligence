/**
 * "When can this person meet": their working hours (./schedule.ts) minus
 * their busy time on every calendar that counts (./busy.ts), through the
 * engine (./engine.ts). The answer is either known (the free stretches and up
 * to three times to offer) or unknown with the reason: a calendar that could
 * not be read is never read as free.
 */
import { busyBlocks } from '@/lib/guests/free-busy'
import { listCountedEvents } from './busy'
import { freeWindows, suggestTimes, type AvailabilitySchedule, type Span } from './engine'
import { addDays, localDate, zonedTime } from './zone'

/** The longest range one read covers. */
export const FIND_TIMES_MAX_DAYS = 31
/** The most free stretches one answer carries. */
export const FREE_WINDOWS_MAX = 60
/** The most events read per calendar. */
const EVENTS_MAX = 1000
const DAY_MS = 24 * 60 * 60_000
const QUARTER_MS = 15 * 60_000

export interface FindTimesInput {
  userId: string
  workspaceId?: string
  schedule: AvailabilitySchedule
  /** The range, as instants. */
  from: number
  to: number
  durationMinutes: number
  bufferMinutes?: number
  now: number
}

export type FindTimesResult = { known: true; free: Span[]; suggested: Span[] } | { known: false; reason: string }

export interface FindTimesDeps {
  listEvents?: typeof listCountedEvents
}

export type FreeTimeResult = { known: true; free: Span[] } | { known: false; reason: string }

/**
 * Every free stretch of the person's in [from, to), never before now, at
 * least the duration long, uncapped: what findTimes offers from, and one
 * person's share of a group's time (./team.ts).
 */
export async function readFreeTime(input: FindTimesInput, deps: FindTimesDeps = {}): Promise<FreeTimeResult> {
  const { schedule } = input
  // Nothing is offered in the past, and a time to offer starts on a quarter hour.
  const notBefore = Math.ceil(Math.max(input.from, input.now) / QUARTER_MS) * QUARTER_MS
  if (input.to <= notBefore) return { known: true, free: [] }

  // The day before and after, so an all-day event's UTC midnights are seen.
  const timeMin = new Date(notBefore - DAY_MS).toISOString()
  const timeMax = new Date(input.to + DAY_MS).toISOString()
  let events
  try {
    events = await (deps.listEvents ?? listCountedEvents)(input.userId, { timeMin, timeMax, maxResults: EVENTS_MAX, workspaceId: input.workspaceId, strict: true })
  } catch (err) {
    return { known: false, reason: err instanceof Error ? err.message : 'a calendar could not be read' }
  }

  const firstDay = localDate(notBefore, schedule.timeZone)
  // Every local day the range touches.
  let days = 1
  while (days < FIND_TIMES_MAX_DAYS + 2 && zonedTime(addDays(firstDay, days), '00:00', schedule.timeZone) < input.to) days++

  const free = freeWindows({
    schedule,
    busy: busyBlocks(events, timeMin, timeMax),
    firstDay,
    days,
    bufferMinutes: input.bufferMinutes,
    minMinutes: input.durationMinutes,
    notBefore,
    notAfter: input.to,
  })
  return { known: true, free }
}

/** The person's free time in [from, to), never before now (see the header). */
export async function findTimes(input: FindTimesInput, deps: FindTimesDeps = {}): Promise<FindTimesResult> {
  const read = await readFreeTime(input, deps)
  if (!read.known) return read
  return {
    known: true,
    free: read.free.slice(0, FREE_WINDOWS_MAX),
    suggested: suggestTimes(read.free, { durationMinutes: input.durationMinutes, timeZone: input.schedule.timeZone }),
  }
}
