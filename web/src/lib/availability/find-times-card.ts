/**
 * What the chat's find_times card draws (src/app/account/(dashboard)/chat/
 * find-times-card.tsx), read from the tool's answer
 * (src/lib/ai/tools/availability.ts): the times to offer, and for a group,
 * each person with whether their time is known. Only what the answer
 * already says to the person: names, coverage, reasons, zones. Pure.
 *
 * Null (the generic chip instead) for a call that failed before reading
 * anyone (a bad range, no calendar connected), or one person's unknown
 * answer, which has no people to list and only an error to say.
 */
import { zoneAbbreviation } from './zone'

export interface FindTimesCardPerson {
  name: string
  you: boolean
  known: boolean
  reason: string | null
  /** Their zone's short name ("CST") when it differs from the person's own. */
  zone: string | null
}

export interface FindTimesCardData {
  durationMinutes: number | null
  /** The person's zone's short name ("EST"), which every time is in. */
  zone: string | null
  /** The times to offer, each "Tue, Nov 3, 10:00 AM – 10:30 AM". */
  suggested: string[]
  /** A group's people, the person first; null for the person alone. */
  people: FindTimesCardPerson[] | null
  /** Someone's time is unknown: no common times. */
  unknown: boolean
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function readPeople(value: unknown, ownZone: string | null, at: number): FindTimesCardPerson[] | null {
  if (!Array.isArray(value) || !value.length) return null
  const out: FindTimesCardPerson[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== 'string') return null
    const zone = zoneAbbreviation(item.time_zone, at)
    out.push({
      name: item.name,
      you: item.you === true,
      known: item.coverage === 'complete',
      reason: typeof item.reason === 'string' && item.reason ? item.reason : null,
      zone: zone && zone !== ownZone ? zone : null,
    })
  }
  return out
}

export function findTimesCardOf(output: unknown, now: number = Date.now()): FindTimesCardData | null {
  if (!isRecord(output)) return null
  const zone = zoneAbbreviation(output.time_zone, now)
  const durationMinutes = typeof output.duration_minutes === 'number' ? output.duration_minutes : null
  const people = readPeople(output.people, zone, now)
  if (output.success !== true) {
    // A group whose common time is unknown: who and why. Anything else is the chip's.
    if (output.unknown !== true || !people) return null
    return { durationMinutes, zone, suggested: [], people, unknown: true }
  }
  if (!Array.isArray(output.suggested)) return null
  const suggested = output.suggested
    .map((s) => (isRecord(s) && typeof s.label === 'string' ? s.label.replace(/\s+/g, ' ').replace(' to ', ' – ') : null))
    .filter((s): s is string => !!s)
  return { durationMinutes, zone, suggested, people, unknown: false }
}
