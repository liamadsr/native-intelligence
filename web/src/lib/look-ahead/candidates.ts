/**
 * The look-ahead's candidates (docs/plans/look-ahead-heartbeat.md §4.1–4.2):
 * which calendar items in a slot's span are worth a message, all in code, no
 * model.
 *
 * THE SLOTS. Two passes a day, each over its own span, in the person's zone:
 *   • evening, at 19:00: tomorrow from midnight until noon, plus tomorrow's
 *     all-day events. A morning message reaches those too late;
 *   • morning, at 08:00: today from noon until midnight ("for later today").
 * The rest is the morning's: an item before noon was the evening's.
 *
 * A CANDIDATE is an item that is any of:
 *   • travel or a booking of the person's own (no one else on it): a flight,
 *     train, rental, hotel, reservation or appointment, by its title's words;
 *   • somewhere: a physical place (not a video link, a dial-in, a meeting
 *     room or a web address);
 *   • early and the person's own (the evening's span only): before
 *     EARLY_BEFORE_HOUR (9:00), with no one else invited, not repeating.
 * A meeting with others counts only with a real place, and goes out only on
 * the model's yes (`needsModel`): its title's words never count, so
 * "Check-in with Sam" or a partner call stays prep's, 30 minutes before
 * (Liam's 10-15 rule). An invite the person never answered still counts (a
 * partner's plan rarely gets an "accept": Liam's 10-27 car pickup was one),
 * but it goes by text only when their own mail backs it up (message.ts).
 *
 * THE PERSON'S GUESTS (Liam, 2026-10-31: every event of a three-day trip was
 * an invite from his wife, and nothing was texted). The addresses of the
 * guests he chose on his People tab (`trusted`, src/lib/guests/store.ts
 * trustedGuestEmails, less any workspace member: run.ts) are not "others":
 * an item whose only other people are guests is his own (its travel and early
 * words count, no model yes needed), and an item a guest organized, or with
 * no one but guests besides him, is `trusted`. A trusted item he never
 * answered is TEXTED only when its own data backs the guest up
 * (`guestConfirmed`: he organized it, or the guest organizer is on it as an
 * attendee who accepted, Google's shape for an invite she made), or his mail
 * does (message.ts). An emailed invite can name anyone as its organizer, so a
 * stranger's that names his wife and lists only him stays in the app (it
 * still counts as his own for the rest).
 * Never: a repeating item with no place and no travel (a standup, a daily
 * focus block, a weekly all-day "office day"), an all-day event that is
 * neither travel nor somewhere (a birthday, a holiday, out of office).
 * At most LOOK_AHEAD_MAX_CANDIDATES, all-day first, then earliest first.
 */
import type { UpcomingMeeting } from '@/lib/agent-events/upcoming-meetings'

export type LookAheadSlot = 'evening' | 'morning'

/** The local hour each slot's pass runs at. */
export const LOOK_AHEAD_SLOT_HOURS: Record<LookAheadSlot, number> = { evening: 19, morning: 8 }
/** Starting before this local hour is early. */
export const EARLY_BEFORE_HOUR = 9
/** The most items one look-ahead carries. */
export const LOOK_AHEAD_MAX_CANDIDATES = 6

/** The slot a local hour runs, or null. Pure. */
export function lookAheadSlotAt(hour: unknown): LookAheadSlot | null {
  return hour === LOOK_AHEAD_SLOT_HOURS.evening ? 'evening' : hour === LOOK_AHEAD_SLOT_HOURS.morning ? 'morning' : null
}

/** What one slot looks at: a local date, its hours [from, to), and whether all-day and early items count. */
export interface LookAheadSpan {
  slot: LookAheadSlot
  date: string
  fromHour: number
  toHour: number
  allDay: boolean
  early: boolean
}

/** Why an item is a candidate. */
export type LookAheadWhy = 'travel' | 'place' | 'early'

export interface LookAheadCandidate {
  meeting: UpcomingMeeting
  why: LookAheadWhy[]
  /** Local start "HH:MM" (24 h), or null for an all-day item. */
  localTime: string | null
  /** A meeting with others: it goes out only on the model's yes, never on the calendar alone. */
  needsModel?: boolean
  /**
   * A guest of the person's organized it, or no one but guests is on it
   * besides them: it counts as the person's own (solo above).
   */
  trusted?: boolean
  /**
   * A trusted item whose own data backs the guest up (guestConfirmed): texted
   * even unanswered (message.ts). Without it, an unanswered trusted item
   * stays in the app unless the person's mail backs it up.
   */
  guestConfirmed?: boolean
}

// ── Time, in the person's zone ───────────────────────────────────────────────

/** The local wall-clock parts of an instant in `timeZone`. Pure. */
export function localParts(ms: number, timeZone: string): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')) }
}

/** The instant (ms) a local date's `hour`:00 is in `timeZone`, DST included. Pure. */
export function zonedInstant(date: string, hour: number, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d, hour)
  // The zone's offset at a moment, from the wall clock it shows then.
  const offsetAt = (ms: number) => {
    const p = localParts(ms, timeZone)
    const [py, pm, pd] = p.date.split('-').map(Number)
    return Date.UTC(py, pm - 1, pd, p.hour, p.minute) - ms
  }
  const first = guess - offsetAt(guess)
  // Once more at the found instant: a DST change between the guess and it moves the offset.
  return guess - offsetAt(first)
}

/** The local date after `date` (YYYY-MM-DD). Pure. */
export function nextDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

/** A slot's span, from the local date its pass runs on. Pure. */
export function lookAheadSpan(slot: LookAheadSlot, today: string): LookAheadSpan {
  return slot === 'evening'
    ? { slot, date: nextDate(today), fromHour: 0, toHour: 12, allDay: true, early: true }
    : { slot, date: today, fromHour: 12, toHour: 24, allDay: false, early: false }
}

/** The instants a span reads (its start a minute early: the read's start is exclusive). Pure. */
export function spanWindow(span: LookAheadSpan, timeZone: string): { fromMs: number; toMs: number } {
  const toMs = span.toHour >= 24 ? zonedInstant(nextDate(span.date), 0, timeZone) : zonedInstant(span.date, span.toHour, timeZone)
  return { fromMs: zonedInstant(span.date, span.fromHour, timeZone) - 60_000, toMs }
}

// ── Which items ──────────────────────────────────────────────────────────────

/** Words that make an item travel or a booking. */
const TRAVEL_RE =
  /\b(flight|fly(ing)?|airport|depart(s|ure)?|boarding|train|amtrak|rail|ferry|rental|rent(al)? car|car pick ?up|pick ?up|drop ?off|hotel|check[- ]?(in|out)|airbnb|reservation|booking|appointment|appt|dentist|doctor|dr\.|clinic|hospital|vet|haircut|salon|dmv|passport|visa)\b/i

/** Words that make an item a departure: it gets a heads-up a few hours before. */
const DEPARTURE_RE = /\b(flight|fly(ing)?|airport|boarding|train|amtrak|rail|ferry|depart(s|ure)?)\b/i

/** A location that is a video link, a dial-in, a meeting room or a web address, not somewhere to go. */
const NOT_A_PLACE_RE =
  /https?:\/\/|www\.|@|\b[a-z0-9-]{2,}\.[a-z]{2,24}\b|\b(zoom|google meet|teams|webex|whereby|chime|facetime|skype|hangouts?|huddle|dial[- ]?in|conference call|phone|tbd|tba|virtual|online|remote)\b|\b(conf(erence)?\.?\s*room|meeting room|boardroom|room\s+[a-z0-9-]+)\b/i

/** Whether a calendar location is somewhere to go. Pure. */
export function isPlace(location: string | null | undefined): boolean {
  const text = (location ?? '').trim()
  return text.length >= 3 && !NOT_A_PLACE_RE.test(text)
}

/** Whether a candidate is a departure of the person's own (a flight, a train): it gets its own heads-up. Pure. */
export function isDeparture(c: LookAheadCandidate): boolean {
  return c.localTime !== null && c.why.includes('travel') && DEPARTURE_RE.test(c.meeting.title ?? '')
}

/** No one trusted: every other person counts. */
const NO_ONE: ReadonlySet<string> = new Set()

/**
 * How many people besides the person are on it: the provider's count (else
 * the attendee list less one for them), plus an organizer who isn't the
 * person and isn't listed (Microsoft lists the organizer apart, so a 1:1 from
 * Sam would otherwise read as the person's own block), less the person's
 * guests (`trusted`: listed attendees and an unlisted organizer alike). Pure.
 */
export function othersOn(m: UpcomingMeeting, trusted: ReadonlySet<string> = NO_ONE): number {
  const base = typeof m.others === 'number' ? m.others : Math.max(0, m.attendees.length - 1)
  const outsideOrganizer = m.mine === false && !!m.organizer && !m.attendees.includes(m.organizer) && !trusted.has(m.organizer)
  const guests = trusted.size ? m.attendees.filter((a) => trusted.has(a)).length : 0
  return Math.max(0, base - guests) + (outsideOrganizer ? 1 : 0)
}

/**
 * Whether a guest's invite stands behind it: a guest organized it, or guests
 * are on it and no one else besides the person is. Never for an item with no
 * one else at all (that is the person's own, as before). Pure.
 */
export function guestTrusted(m: UpcomingMeeting, trusted: ReadonlySet<string> = NO_ONE): boolean {
  if (!trusted.size) return false
  if (m.mine !== true && !!m.organizer && trusted.has(m.organizer)) return true
  return m.attendees.some((a) => trusted.has(a)) && othersOn(m, trusted) === 0
}

/**
 * Whether a guest's invite is backed up by its own data, enough to text it
 * unanswered: the person organized it, or its organizer is a guest who is on
 * it as an attendee who accepted (Google lists an invite's organizer so). An
 * emailed invite file names its organizer freely; one that names a guest and
 * lists only the person doesn't pass. Not proof (a forged file could list her
 * as accepted too), but it raises the bar, and a guest's real invite from
 * Google Calendar always has it. Microsoft lists the organizer apart, so a
 * guest's unanswered Outlook invite stays in the app. Pure.
 */
export function guestConfirmed(m: UpcomingMeeting, trusted: ReadonlySet<string> = NO_ONE): boolean {
  if (m.mine === true) return true
  return !!m.organizer && trusted.has(m.organizer) && m.organizerAccepted === true
}

/**
 * A span's candidates, all-day first, then earliest first, at most
 * LOOK_AHEAD_MAX_CANDIDATES. `meetings` is a `details` read of the span's
 * window (readMeetingWindow); `trusted` the person's guests' addresses (see
 * the header). Pure.
 */
export function lookAheadCandidates(
  meetings: readonly UpcomingMeeting[],
  args: { span: LookAheadSpan; timeZone: string; trusted?: ReadonlySet<string> },
): LookAheadCandidate[] {
  const { span } = args
  const trusted = args.trusted ?? NO_ONE
  const out: LookAheadCandidate[] = []
  for (const m of meetings) {
    const title = m.title ?? ''
    const others = othersOn(m, trusted)
    const solo = others === 0
    const fromGuest = guestTrusted(m, trusted) ? { trusted: true, ...(guestConfirmed(m, trusted) ? { guestConfirmed: true } : {}) } : {}
    // Travel words count only for the person's own items: on a meeting with others they are anyone's words.
    const travel = solo && TRAVEL_RE.test(title)
    const place = isPlace(m.location)
    const recurring = m.recurring === true || !!m.seriesKey
    // A meeting with others: only with a real place (and the model's yes, below).
    if (!solo && !place) continue
    // A repeating item with no travel (a standup, a focus block, a weekly office day) is never one.
    if (recurring && !travel) continue
    if (m.allDay === true || (m.allDayDate !== undefined && m.allDayDate !== null)) {
      // All day: the provider's date, else (the desktop's local midnight) its date in the person's zone.
      const date = m.allDayDate ?? (Number.isFinite(Date.parse(m.startIso)) ? localParts(Date.parse(m.startIso), args.timeZone).date : null)
      if (!span.allDay || date !== span.date || !(travel || place)) continue
      out.push({ meeting: m, why: [travel ? 'travel' : 'place'], localTime: null, ...(solo ? {} : { needsModel: true }), ...fromGuest })
      continue
    }
    const startMs = Date.parse(m.startIso)
    if (!Number.isFinite(startMs)) continue
    const local = localParts(startMs, args.timeZone)
    if (local.date !== span.date || local.hour < span.fromHour || local.hour >= span.toHour) continue
    const early = span.early && local.hour < EARLY_BEFORE_HOUR && solo
    const why: LookAheadWhy[] = [...(travel ? (['travel'] as const) : []), ...(place ? (['place'] as const) : []), ...(early ? (['early'] as const) : [])]
    if (why.length === 0) continue
    out.push({ meeting: m, why, localTime: `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`, ...(solo ? {} : { needsModel: true }), ...fromGuest })
  }
  return out
    .sort((a, b) => (a.localTime ?? '').localeCompare(b.localTime ?? '') || Date.parse(a.meeting.startIso) - Date.parse(b.meeting.startIso))
    .slice(0, LOOK_AHEAD_MAX_CANDIDATES)
}
