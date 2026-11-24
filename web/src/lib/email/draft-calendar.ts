import type { SupabaseClient } from '@supabase/supabase-js'
import { DEFAULT_MEETING_MS, meetingClock, meetingWhen } from '@/lib/agent-events/meeting-time'
import { readMeetingWindow, type MeetingPerson } from '@/lib/agent-events/upcoming-meetings'
import { mailboxAddresses } from '@/lib/email/reply-policy'
import { wrapUntrusted } from '@/lib/email/untrusted'

/**
 * The person's calendar, for a reply draft (2026-11-24). A contact wrote at
 * 10:08 to ask whether the person could still join their 10:00 call. The
 * person was already on it, and the automatic drafter answered for them:
 * "I'm here and ready for our call. Are you still available to hop on now?"
 * The drafter had no calendar to check.
 *
 * One read per drafting pass serves two uses. The read is the meeting pass's
 * own (readMeetingWindow): this workspace's calendar accounts and the
 * desktop's events, without cancelled or declined events.
 *   - The draft's message gets a "Their calendar" section
 *     (buildCalendarSection). It lists the person's meetings with people on
 *     the thread, from 2 hours ago to 24 hours ahead, each marked happening
 *     now, over, or how soon it starts.
 *   - An automatic draft is skipped when the newest message arrived during a
 *     meeting with its sender (meetingWithSenderAt). The two people are
 *     together at that moment, so whatever the mail asks about the meeting
 *     (is it still on, what's the link, is the person running late) gets
 *     answered there. A draft could only guess where the person is.
 *
 * A read that fails or is too slow counts as no calendar: no section, no
 * skip, and the draft is written as before. Nothing here throws.
 */

/** The section lists meetings that ended no longer ago than this. */
export const CALENDAR_LOOKBACK_MS = 2 * 60 * 60_000
/** ...and that start no further ahead than this. */
export const CALENDAR_LOOKAHEAD_MS = 24 * 60 * 60_000
/**
 * The read reaches this much further back than the lookback, so a long
 * meeting that began earlier and is still running is read too. (The read
 * selects events by when they start.)
 */
export const LONGEST_MEETING_MS = 6 * 60 * 60_000
/**
 * The longest a drafting pass waits on the calendar. After that the draft is
 * written without it: a slow provider must never stall the arrival pass,
 * whose own budget is 420 s.
 */
export const CALENDAR_READ_TIMEOUT_MS = 8_000
/** The most meetings the section lists, soonest-relevant first. */
export const CALENDAR_SECTION_MAX = 8

/** One of the person's meetings, as the drafter uses it. */
export interface DraftMeeting {
  title: string | null
  startMs: number
  /** Its end, else its start plus DEFAULT_MEETING_MS (a meeting still going is never called over). */
  endMs: number
  /** Everyone on it, lower case: the attendees and the organizer. */
  people: string[]
}

export interface DraftCalendarDeps {
  read?: typeof readMeetingWindow
  timeoutMs?: number
}

/**
 * The person's meetings around `nowMs`, in this workspace. The read covers
 * meetings starting from LONGEST_MEETING_MS before the lookback up to the
 * lookahead. Returns [] when nothing is connected, the read fails, or it
 * takes longer than CALENDAR_READ_TIMEOUT_MS. Never throws.
 */
export async function readDraftCalendar(
  supabase: SupabaseClient,
  person: Pick<MeetingPerson, 'workspaceId' | 'userId'>,
  nowMs: number,
  deps: DraftCalendarDeps = {},
): Promise<DraftMeeting[]> {
  const read = deps.read ?? readMeetingWindow
  const window = { fromMs: nowMs - CALENDAR_LOOKBACK_MS - LONGEST_MEETING_MS, toMs: nowMs + CALENDAR_LOOKAHEAD_MS }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      // `text`: the organizer is kept (Microsoft lists them apart from the attendees).
      read(supabase, person, window, { nowMs }, { text: true }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), deps.timeoutMs ?? CALENDAR_READ_TIMEOUT_MS)
      }),
    ])
    if (!result) {
      console.warn('[draft-calendar] calendar read too slow; drafting without it')
      return []
    }
    return result.meetings.flatMap((m) => {
      const startMs = Date.parse(m.startIso)
      if (!Number.isFinite(startMs) || m.allDay) return []
      const endParsed = m.endIso ? Date.parse(m.endIso) : NaN
      const endMs = Number.isFinite(endParsed) && endParsed > startMs ? endParsed : startMs + DEFAULT_MEETING_MS
      const people = [...new Set([...m.attendees, m.organizer ?? ''].map((a) => a.trim().toLowerCase()).filter((a) => a.includes('@')))]
      return people.length ? [{ title: m.title, startMs, endMs, people }] : []
    })
  } catch (err) {
    console.warn('[draft-calendar] calendar read failed; drafting without it:', err instanceof Error ? err.message : err)
    return []
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * The meeting with `sender` on it that was under way at `atMs` (started at or
 * before it, not yet ended), or null. Pure.
 */
export function meetingWithSenderAt(
  meetings: readonly DraftMeeting[],
  sender: string | null | undefined,
  atMs: number,
): DraftMeeting | null {
  const who = (sender ?? '').trim().toLowerCase()
  if (!who || !Number.isFinite(atMs)) return null
  return meetings.find((m) => m.startMs <= atMs && atMs < m.endMs && m.people.includes(who)) ?? null
}

/**
 * The meetings the section lists: someone in `participants` is on it, it
 * ended no more than CALENDAR_LOOKBACK_MS before `nowMs`, and it starts no
 * more than CALENDAR_LOOKAHEAD_MS after. Meetings under way come first, then
 * the next ones, then the ones that ended. At most CALENDAR_SECTION_MAX. Pure.
 */
export function meetingsWithThread(
  meetings: readonly DraftMeeting[],
  participants: Iterable<string>,
  nowMs: number,
): DraftMeeting[] {
  const people = new Set([...participants].map((p) => p.trim().toLowerCase()).filter(Boolean))
  if (!people.size) return []
  const rank = (m: DraftMeeting) => (m.startMs <= nowMs && nowMs < m.endMs ? 0 : m.startMs > nowMs ? 1 : 2)
  return meetings
    .filter((m) => m.endMs > nowMs - CALENDAR_LOOKBACK_MS && m.startMs <= nowMs + CALENDAR_LOOKAHEAD_MS && m.people.some((p) => people.has(p)))
    .sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? b.endMs - a.endMs : a.startMs - b.startMs))
    .slice(0, CALENDAR_SECTION_MAX)
}

/** "8 minutes", "1 hour", "3 hours": a length of time, rounded down to whole minutes, or to whole hours past the first hour. Pure. */
export function spanWords(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return minutes === 1 ? '1 minute' : `${minutes} minutes`
  const hours = Math.floor(minutes / 60)
  return hours === 1 ? '1 hour' : `${hours} hours`
}

/** Where a meeting stands at `nowMs`: "happening now (it started 8 minutes ago)", "over (it ended 40 minutes ago)", "starts in 3 hours". Pure. */
export function meetingState(m: Pick<DraftMeeting, 'startMs' | 'endMs'>, nowMs: number): string {
  if (m.endMs <= nowMs) return `over (it ended ${spanWords(nowMs - m.endMs)} ago)`
  if (m.startMs <= nowMs) return `happening now (it started ${spanWords(nowMs - m.startMs)} ago)`
  return `starts in ${spanWords(m.startMs - nowMs)}`
}

/** Shown above the list. */
export const CALENDAR_SECTION_NOTE =
  "The person's meetings with people on this thread, from 2 hours ago to 24 hours ahead, as their calendar shows them. Where each one stands is as of Now."

/**
 * The "Their calendar" section's body. It lists the meetings
 * meetingsWithThread keeps, each with its title, the thread's people on it,
 * its time in the person's zone, and where it stands. '' when there are none,
 * and then the section is left out. The titles and addresses can come from a
 * sender's invite, so the list goes inside one untrusted-content marker
 * (CALENDAR). Pure.
 */
export function buildCalendarSection(
  meetings: readonly DraftMeeting[],
  participants: Iterable<string>,
  clock: { nowMs: number; timeZone: string },
): string {
  const people = new Set([...participants].map((p) => p.trim().toLowerCase()).filter(Boolean))
  const listed = meetingsWithThread(meetings, people, clock.nowMs)
  if (!listed.length) return ''
  const lines = listed.map((m) => {
    const title = (m.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled meeting'
    const who = m.people.filter((p) => people.has(p)).slice(0, 5).join(', ')
    const startIso = new Date(m.startMs).toISOString()
    const until = meetingClock(new Date(m.endMs).toISOString(), clock.timeZone)
    return `- "${title}" with ${who}, ${meetingWhen(startIso, clock.timeZone)} until ${until}: ${meetingState(m, clock.nowMs)}`
  })
  return `${CALENDAR_SECTION_NOTE}\n\n${wrapUntrusted(lines.join('\n'), 'CALENDAR')}`
}

/**
 * Everyone on the thread, lower case: each message's From, To and Cc, and
 * the index's participant list. The caller leaves out the person's own
 * addresses. Pure.
 */
export function threadPeople(
  messages: ReadonlyArray<{ from?: string | null; to?: string | null; cc?: string | null }>,
  indexed: unknown = [],
): string[] {
  const out = new Set<string>()
  for (const m of messages) {
    for (const header of [m.from, m.to, m.cc]) {
      if (typeof header === 'string' && header) for (const a of mailboxAddresses(header)) out.add(a)
    }
  }
  for (const a of Array.isArray(indexed) ? indexed : []) {
    if (typeof a === 'string' && a.includes('@')) out.add(a.trim().toLowerCase())
  }
  return [...out]
}
