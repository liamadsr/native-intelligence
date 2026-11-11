/**
 * A time that works for several members of one workspace: each person's
 * working hours in their own zone (./schedule.ts), minus their busy time on
 * every calendar of theirs that counts (./busy.ts, read server-side with the
 * service client), intersected (./engine.ts intersectAll).
 *
 * Coverage, per person: `complete`, or `unknown` with the reason (they don't
 * share their availability, no calendar connected, a calendar of theirs
 * needs signing in again or could not be read, their working hours could
 * not be read). Only when everyone is complete are there common free
 * windows and up to three times to offer; otherwise there are none, and the
 * answer says who and why. A teammate's unread calendar is never free.
 *
 * What crosses between people: nothing but time. Each person's busy blocks
 * stay inside this module (titleless already: src/lib/guests/free-busy.ts);
 * the answer carries the common free windows and each person's coverage and
 * zone, never a teammate's event, location, attendees or which calendar a
 * block came from, and never their own free time on its own. A reason for a
 * teammate is one of a fixed set: a provider's error text is the requester's
 * to see only for their own calendar.
 *
 * Everyone is read at once; nothing is kept between requests.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { hasCountedCalendar } from './busy'
import { intersectAll, suggestTimes, type AvailabilitySchedule, type Span } from './engine'
import { capWindows, readFreeTime, type FindTimesDeps } from './find-times'
import type { WorkspacePerson } from './people'
import { readWorkingHours } from './schedule'

export const NOT_SHARING_REASON = "they don't share their availability"
/** A teammate whose zone is nowhere to be found: their hours in UTC would be a guess. */
export const ZONE_UNKNOWN_REASON = "their time zone isn't known (they can set it in Settings > Availability); ask them which hours suit them"

export type Coverage = 'complete' | 'unknown'

export interface PersonCoverage {
  userId: string
  name: string
  /** The person asking. */
  isRequester: boolean
  coverage: Coverage
  reason?: string
  /** The zone their working hours are in; null for someone who doesn't share. */
  timeZone: string | null
}

/** `freeUntil`: as in ./find-times.ts FindTimesResult, set when `free` was cut. */
export type FindTimesTogetherResult = { known: true; people: PersonCoverage[]; free: Span[]; suggested: Span[]; freeUntil?: number } | { known: false; people: PersonCoverage[] }

export interface FindTimesTogetherInput {
  workspaceId: string
  /** The person asking, with their hours already in the zone this turn uses. */
  requester: { userId: string; name: string; schedule: AvailabilitySchedule }
  others: readonly WorkspacePerson[]
  from: number
  to: number
  durationMinutes: number
  bufferMinutes?: number
  now: number
}

export interface FindTimesTogetherDeps extends FindTimesDeps {
  supabase?: SupabaseClient
  /** `zoneKnown: false` (./schedule.ts WorkingHours): no zone of theirs is known. */
  readHours?: (userId: string) => Promise<AvailabilitySchedule & { zoneKnown?: boolean }>
  hasCalendar?: (userId: string) => Promise<boolean>
}

/** A teammate's read error as the requester may see it: what went wrong, never the provider's words. Pure. */
export function teammateReason(message: string): string {
  return /sign(ing)? in again|reconnect/i.test(message) ? 'a calendar of theirs needs signing in again' : 'a calendar of theirs could not be read'
}

type PersonRead = { coverage: PersonCoverage; free?: Span[] }

async function readPerson(
  person: { userId: string; name: string; isRequester: boolean; sharing: WorkspacePerson['sharing'] },
  schedule: AvailabilitySchedule | null,
  input: FindTimesTogetherInput,
  deps: Required<Pick<FindTimesTogetherDeps, 'readHours' | 'hasCalendar'>> & FindTimesDeps,
): Promise<PersonRead> {
  const base = { userId: person.userId, name: person.name, isRequester: person.isRequester }
  const unknown = (reason: string, timeZone: string | null): PersonRead => ({ coverage: { ...base, coverage: 'unknown', reason, timeZone } })
  if (!person.isRequester && person.sharing !== 'busy_only') return unknown(NOT_SHARING_REASON, null)

  let hours = schedule
  if (!hours) {
    let read: AvailabilitySchedule & { zoneKnown?: boolean }
    try {
      read = await deps.readHours(person.userId)
    } catch {
      return unknown('their working hours could not be read', null)
    }
    // Never their hours read in UTC: someone in New York would be offered at 4 AM.
    if (read.zoneKnown === false) return unknown(ZONE_UNKNOWN_REASON, null)
    hours = read
  }
  let connected: boolean
  try {
    connected = await deps.hasCalendar(person.userId)
  } catch (err) {
    return unknown(person.isRequester ? (err instanceof Error ? err.message : 'your calendar could not be read') : teammateReason(err instanceof Error ? err.message : ''), hours.timeZone)
  }
  if (!connected) return unknown(person.isRequester ? 'you have no calendar connected in this workspace' : 'they have no calendar connected', hours.timeZone)

  const read = await readFreeTime(
    { userId: person.userId, workspaceId: input.workspaceId, schedule: hours, from: input.from, to: input.to, durationMinutes: input.durationMinutes, bufferMinutes: input.bufferMinutes, now: input.now },
    { listEvents: deps.listEvents },
  )
  if (!read.known) return unknown(person.isRequester ? read.reason : teammateReason(read.reason), hours.timeZone)
  return { coverage: { ...base, coverage: 'complete', timeZone: hours.timeZone }, free: read.free }
}

/** When everyone can meet in [from, to) (see the header). The person asking comes first. */
export async function findTimesTogether(input: FindTimesTogetherInput, deps: FindTimesTogetherDeps = {}): Promise<FindTimesTogetherResult> {
  const supabase = deps.supabase ?? getServiceClient()
  const resolved = {
    listEvents: deps.listEvents,
    readHours: deps.readHours ?? ((userId: string) => readWorkingHours(supabase, { userId, workspaceId: input.workspaceId })),
    hasCalendar: deps.hasCalendar ?? ((userId: string) => hasCountedCalendar(userId, input.workspaceId, { supabase })),
  }
  const reads = await Promise.all([
    readPerson({ userId: input.requester.userId, name: input.requester.name, isRequester: true, sharing: 'busy_only' }, input.requester.schedule, input, resolved),
    ...input.others.filter((p) => p.userId !== input.requester.userId).map((p) => readPerson({ userId: p.userId, name: p.name, isRequester: false, sharing: p.sharing }, null, input, resolved)),
  ])
  const people = reads.map((r) => r.coverage)
  if (reads.some((r) => !r.free)) return { known: false, people }
  const free = intersectAll(reads.map((r) => r.free!)).filter((s) => s.end - s.start >= input.durationMinutes * 60_000)
  return {
    known: true,
    people,
    ...capWindows(free),
    suggested: suggestTimes(free, { durationMinutes: input.durationMinutes, timeZone: input.requester.schedule.timeZone }),
  }
}
