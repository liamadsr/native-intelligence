/**
 * Reminders and confirmations (roadmap issue #11): the day before a booked
 * job, or a meeting with a customer, the business's own number texts that
 * customer a reminder they can confirm, move, or stop.
 *
 *   1. Hourly (src/lib/inngest/customer-reminders.ts), every business with a
 *      profile, reminders on (business_profile.reminders, migration 471: on
 *      unless the owner turns them off) and a live business number, whose own
 *      zone reads REMINDER_LOCAL_HOUR, gets ONE request for that local date
 *      (each later hour until REMINDER_SEND_UNTIL_HOUR asks again, a
 *      catch-up for a missed pass). The Inngest event id
 *      `customer-reminders:<workspace>:<YYYY-MM-DD>` keeps it to one.
 *   2. The request reminds about TOMORROW in the business's zone. Skipped
 *      whole: reminders off, no live number, the profile's owner no longer an
 *      owner or admin, the agent paused, or a run that lands outside
 *      REMINDER_SEND_FROM_HOUR..REMINDER_SEND_UNTIL_HOUR local time, or on
 *      another local date (a late retry never texts at night).
 *   3. Who is reminded:
 *      - a booked job: tomorrow's CONFIRMED bookings with a US or Canadian
 *        number (the customer gave it: by text, on the booking page, or on
 *        the quote the owner booked);
 *      - a meeting with a customer: a timed event tomorrow on the owner's
 *        calendar (not declined, not cancelled, at most MEETING_ATTENDEES_MAX
 *        people, not a booking's own event) with an attendee whose email is a
 *        CRM contact of the workspace with a US or Canadian phone, who is a
 *        customer: marked one (relationship 'customer') or one who has
 *        texted the business's number (a customer row). A lead found any
 *        other way is never texted.
 *      Never: a number that said STOP (the SMS ledger), a contact tagged
 *      'unsubscribed sms' (src/lib/outreach/opt-out.ts), the same customer
 *      twice for one booking or meeting (the claim), more than
 *      REMINDERS_PER_DAY_MAX in a day.
 *   4. Each reminder is CLAIMED before its text goes (customer_reminder,
 *      unique per subject and phone: ./reminder-store.ts), then texted from
 *      the business's number (./booking.ts textBookingCustomer, logged as a
 *      `notice`: never the global auto-reply cap's) in Dial8's
 *      words (reminderText): the business, what, when, where, "Reply YES to
 *      confirm, or tell us a better time", and the opt-out. A crash between
 *      the claim and the text sends nothing again: at most once.
 *   5. The owner hears what went out: one line in their home thread
 *      (remindersSentReport), read back from the table for tomorrow, so a run
 *      cut short after its texts still reports them on its retry. The first
 *      day a business ever reminds anyone it reaches them where they are (the
 *      reach router) and says how to turn reminders off; after that it stays
 *      in the thread.
 *
 * Their answers (./reminder-replies.ts) go to the customer's own agent:
 * confirm_appointment and move_appointment, and STOP from the inbound
 * handler. No model call here: every word is Dial8's or the owner's.
 *
 * Server only; service role.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { appendHomeMessage } from '@/lib/chat/home-message-writer'
import { readMemberTimeZone, isStorableTimeZone } from '@/lib/agent-events/member-time-zone'
import { listCalendarEventsUnified, type CalendarEvent } from '@/lib/integrations/calendar'
import { optedOutByTag } from '@/lib/outreach/opt-out'
import { requestRoute } from '@/lib/reach/route'
import { unlinkedNumberOptedOut } from '@/lib/sms/store'
import { fetchAllRows } from '@/lib/supabase/paging'
import { isNanpNumber, normalizeE164 } from '@/lib/twilio/phone'
import { isAgentPaused } from '@/lib/work/agent-paused'
import { textBookingCustomer } from './booking'
import { findCustomerGuest } from './customer-guests'
import { localClock } from './daily-jobs'
import { cleanText } from './intake'
import { activeBusinessNumber } from './numbers'
import { withoutLinks } from './quote-reply-input'
import { CUSTOMER_REMINDER_MESSAGE_KIND, CUSTOMER_REMINDER_ROUTES_KEY } from './reminder-message'
import { claimReminder, markReminderSent, sentRemindersBefore, sentRemindersBetween, type ReminderSubjectType } from './reminder-store'
import { zonedTime } from './slots'
import { businessName, getBusinessProfile, listBookings } from './store'
import type { CustomerBooking } from './types'

/** The local hour the day-before reminders go out. */
export const REMINDER_LOCAL_HOUR = 10
/** No reminder is texted before this local hour or from this one on (quiet hours; a late retry). */
export const REMINDER_SEND_FROM_HOUR = 9
export const REMINDER_SEND_UNTIL_HOUR = 20
/** The event one business's reminders are requested with. */
export const REMINDERS_EVENT = 'customers/reminders.requested' as const
/** The most reminders one business texts in a day. */
export const REMINDERS_PER_DAY_MAX = 50
/** A meeting with more people than this is not a meeting with a customer (a webinar, an all-hands). */
export const MEETING_ATTENDEES_MAX = 6
/** The word a meeting's reminder uses. */
export const MEETING_KIND = 'meeting'

export interface ReminderBusiness {
  workspaceId: string
  ownerUserId: string
  timeZone: string
}

export interface RemindersRequest {
  id: string
  name: typeof REMINDERS_EVENT
  data: { workspaceId: string; localDate: string }
}

/** The event id that makes one business's reminders once per local date. Pure. */
export function remindersEventId(workspaceId: string, localDateKey: string): string {
  return `customer-reminders:${workspaceId}:${localDateKey}`
}

/**
 * One request per business whose zone reads REMINDER_LOCAL_HOUR or later
 * (before REMINDER_SEND_UNTIL_HOUR) at `now`. Each later hour is a catch-up
 * for a pass that was skipped or failed: the event id dedupes it to one per
 * local date. Pure.
 */
export function planReminders(businesses: readonly ReminderBusiness[], now: number): RemindersRequest[] {
  const out: RemindersRequest[] = []
  for (const b of businesses) {
    const clock = localClock(now, b.timeZone)
    if (!clock || clock.hour < REMINDER_LOCAL_HOUR || clock.hour >= REMINDER_SEND_UNTIL_HOUR) continue
    out.push({ id: remindersEventId(b.workspaceId, clock.date), name: REMINDERS_EVENT, data: { workspaceId: b.workspaceId, localDate: clock.date } })
  }
  return out
}

/**
 * Every business with reminders on and a live number, and its zone (its
 * profile's, else its owner's). Throws on a failed read.
 */
export async function findReminderBusinesses(supabase: SupabaseClient): Promise<ReminderBusiness[]> {
  const [profiles, numbers] = await Promise.all([
    fetchAllRows<{ workspace_id: string; owner_user_id: string; time_zone: string | null }>(
      () => supabase.from('business_profile').select('workspace_id, owner_user_id, time_zone').eq('reminders', true),
      { orderBy: 'workspace_id' },
    ),
    fetchAllRows<{ workspace_id: string }>(() => supabase.from('business_phone_number').select('workspace_id').eq('state', 'active'), { orderBy: 'workspace_id' }),
  ])
  if (profiles.error) throw new Error(`business_profile read failed: ${profiles.error.message}`)
  if (numbers.error) throw new Error(`business_phone_number read failed: ${numbers.error.message}`)
  const withNumber = new Set(numbers.data.map((n) => n.workspace_id))
  const out: ReminderBusiness[] = []
  for (const row of profiles.data) {
    if (!withNumber.has(row.workspace_id)) continue
    const timeZone = isStorableTimeZone(row.time_zone)
      ? row.time_zone
      : (await readMemberTimeZone(supabase, { workspaceId: row.workspace_id, userId: row.owner_user_id })).timeZone
    out.push({ workspaceId: row.workspace_id, ownerUserId: row.owner_user_id, timeZone })
  }
  return out
}

// ── The words ───────────────────────────────────────────────────────────────

/** "Tue, Nov 10" and "9:00 AM" in the business's zone. Pure. */
export function dayAndTime(iso: string, timeZone: string): { day: string; time: string } {
  const at = new Date(iso)
  try {
    return {
      day: new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(at),
      time: new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(at),
    }
  } catch {
    return { day: iso.slice(0, 10), time: iso.slice(11, 16) }
  }
}

/** A place as a text may carry it: one short line, no links. Null when nothing is left. Pure. */
export function reminderPlace(place: string | null | undefined): string | null {
  const text = cleanText(place, 300)
  if (!text) return null
  // What a link leaves behind ("Lee's office, ") is trimmed of its dangling separator.
  return cleanText(withoutLinks(text).replace(/[\s,;:|–—-]+$/, ''), 60)
}

/**
 * The customer's reminder, in Dial8's words but for the business's name,
 * the job word and the address. Pure.
 */
export function reminderText(args: { business: string; kind: string; startsAt: string; timeZone: string; place: string | null }): string {
  const business = cleanText(args.business, 40) ?? 'Your appointment'
  const { day, time } = dayAndTime(args.startsAt, args.timeZone)
  const place = reminderPlace(args.place)
  return `${business}: a reminder that your ${cleanText(args.kind, 40) ?? 'appointment'} is tomorrow (${day}) at ${time}${place ? `, ${place}` : ''}. Reply YES to confirm, or tell us a better time. Reply STOP to opt out.`
}

/** The owner's line once the day's reminders went (first: the first day ever, which says what they are). Pure. */
export function remindersSentReport(args: { sent: ReadonlyArray<{ name: string; kind: string; startsAt: string }>; timeZone: string; first: boolean }): string {
  const who = args.sent.map((s) => `${cleanText(s.name, 40) ?? 'a customer'} (${s.kind}, ${dayAndTime(s.startsAt, args.timeZone).time})`)
  const list = who.length <= 2 ? who.join(' and ') : `${who.slice(0, -1).join(', ')} and ${who[who.length - 1]}`
  const lines = [`I texted ${args.sent.length === 1 ? 'a reminder' : `${args.sent.length} reminders`} for tomorrow: ${list}. I'll tell you if anyone moves or says STOP.`]
  if (args.first) {
    lines.push(
      'This is new: the day before each booked job or meeting with a customer, your business number texts them a reminder they can confirm or move to another open time. Tell me to turn reminders off if you’d rather not.',
    )
  }
  return lines.join(' ')
}

// ── Telling the owner ───────────────────────────────────────────────────────

export interface OwnerReportDeps {
  append?: typeof appendHomeMessage
  route?: typeof requestRoute
}

/**
 * One reminder report in the owner's home thread (keyed by `messageId`, so a
 * retry writes it once). `routes`: it goes on to find them where they are
 * (a banner, or a text when away; quiet hours kept), as a customer's note
 * does. Never throws; whether it was written.
 */
export async function reportToOwner(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; messageId: string; text: string; routes: boolean },
  deps: OwnerReportDeps = {},
): Promise<boolean> {
  try {
    const written = await (deps.append ?? appendHomeMessage)(supabase, {
      userId: args.userId,
      workspaceId: args.workspaceId,
      messageId: args.messageId,
      parts: [{ type: 'text', text: args.text }],
      metadata: { kind: CUSTOMER_REMINDER_MESSAGE_KIND, [CUSTOMER_REMINDER_ROUTES_KEY]: args.routes },
    })
    if (!written.written) return false
    if (args.routes && written.conversationId) {
      await (deps.route ?? requestRoute)({ userId: args.userId, workspaceId: args.workspaceId, conversationId: written.conversationId }, args.messageId)
    }
    return true
  } catch (err) {
    console.warn('[reminders] owner report skipped:', err instanceof Error ? err.message : String(err))
    return false
  }
}

// ── Who is reminded ─────────────────────────────────────────────────────────

/** One thing to remind one customer of. */
export interface ReminderSubject {
  type: ReminderSubjectType
  /** The booking's id, or the calendar event's. */
  id: string
  phone: string
  customerName: string
  contactId: string | null
  guestId: string | null
  kind: string
  startsAt: string
  endsAt: string
  place: string | null
}

/** Tomorrow's confirmed bookings with a number to text. Pure. */
export function bookingSubjects(bookings: readonly CustomerBooking[], window: { from: number; to: number }): ReminderSubject[] {
  const out: ReminderSubject[] = []
  for (const b of bookings) {
    const at = Date.parse(b.startsAt)
    if (b.state !== 'confirmed' || at < window.from || at >= window.to) continue
    if (!b.customerPhone || !isNanpNumber(b.customerPhone)) continue
    out.push({
      type: 'booking',
      id: b.id,
      phone: b.customerPhone,
      customerName: b.customerName,
      contactId: b.contactId,
      guestId: b.guestId,
      kind: b.kind,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      place: b.address,
    })
  }
  return out
}

interface ContactForReminder {
  id: string
  full_name: string | null
  phone: string | null
  relationship_type: string | null
  tags?: unknown
}

export interface MeetingLookups {
  /** The workspace's live contact with this email, or null. */
  contactByEmail(email: string): Promise<ContactForReminder | null>
  /** Whether this number has texted the business's number (a customer row). */
  isTextingCustomer(phone: string): Promise<boolean>
}

/** An email a contact lookup can take whole (no separators a PostgREST `or` would split on). */
const PLAIN_EMAIL = /^[^\s,()"@]+@[^\s,()"@]+$/

/**
 * The attendees worth a look: plain emails, not the calendar's own account
 * (the owner), not one who declined. A customer who organized it counts. Pure.
 */
export function meetingGuests(event: CalendarEvent): string[] {
  const own = event.accountEmail?.trim().toLowerCase() ?? null
  const details = event.attendeeDetails?.length ? event.attendeeDetails : (event.attendees ?? []).map((email) => ({ email, responseStatus: undefined as string | undefined }))
  const out: string[] = []
  for (const a of details) {
    const email = a.email?.trim().toLowerCase()
    if (!email || !PLAIN_EMAIL.test(email) || a.responseStatus === 'declined' || email === own || out.includes(email)) continue
    out.push(email)
  }
  return out
}

/**
 * Tomorrow's meetings with a customer (see the header, step 3): one subject
 * per customer attendee. `bookingEvents` are the calendar events bookings
 * made (reminded as bookings). Throws on a failed lookup.
 */
export async function meetingSubjects(
  events: readonly CalendarEvent[],
  window: { from: number; to: number },
  bookingEvents: ReadonlySet<string>,
  lookups: MeetingLookups,
): Promise<ReminderSubject[]> {
  const out: ReminderSubject[] = []
  for (const event of events) {
    if (event.isAllDay || event.status === 'cancelled' || event.myResponse === 'declined' || bookingEvents.has(event.id)) continue
    const from = Date.parse(event.start)
    const to = Date.parse(event.end)
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || from < window.from || from >= window.to) continue
    const people = event.attendeeDetails?.length ?? event.attendees?.length ?? 0
    if (people > MEETING_ATTENDEES_MAX) continue
    for (const email of meetingGuests(event)) {
      const contact = await lookups.contactByEmail(email)
      const phone = normalizeE164(contact?.phone ?? null)
      if (!contact || !phone || !isNanpNumber(phone) || optedOutByTag(contact.tags, 'sms')) continue
      if (contact.relationship_type !== 'customer' && !(await lookups.isTextingCustomer(phone))) continue
      out.push({
        type: 'meeting',
        id: event.id,
        phone,
        customerName: cleanText(contact.full_name, 120) ?? 'Customer',
        contactId: contact.id,
        guestId: null,
        kind: MEETING_KIND,
        startsAt: new Date(from).toISOString(),
        endsAt: new Date(to).toISOString(),
        place: event.location ?? null,
      })
    }
  }
  return out
}

/** Bookings first; a meeting at the same time for the same number is the booking. Pure. */
export function mergeSubjects(bookings: readonly ReminderSubject[], meetings: readonly ReminderSubject[]): ReminderSubject[] {
  const seen = new Set(bookings.map((s) => `${s.phone}|${s.startsAt}`))
  const out = [...bookings]
  for (const m of meetings) {
    const key = `${m.phone}|${m.startsAt}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(m)
  }
  return out.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
}

// ── One business's day ──────────────────────────────────────────────────────

export type RemindersOutcome =
  | { outcome: 'bad_date' | 'no_profile' | 'off' | 'no_number' | 'owner_gone' | 'paused' | 'quiet' }
  | { outcome: 'done'; sent: number; skipped: number; failed: number; reported: boolean }

/** Seams for the tests. */
export interface RemindersDeps extends OwnerReportDeps {
  now?: () => number
  paused?: (workspaceId: string) => Promise<boolean>
  listEvents?: typeof listCalendarEventsUnified
  optedOut?: (phone: string) => Promise<boolean>
  /** The text, from the business's number (default: textBookingCustomer). */
  text?: (to: { workspaceId: string; customerPhone: string; guestId: string | null }, body: string) => Promise<boolean>
}

/** The workspace's contact with this email, for a meeting's reminder. Throws on a failed read. */
async function contactByEmail(supabase: SupabaseClient, workspaceId: string, email: string): Promise<ContactForReminder | null> {
  const { data, error } = await supabase
    .from('contact')
    .select('id, full_name, phone, relationship_type, tags')
    .eq('workspace_id', workspaceId)
    .is('merged_into_contact_id', null)
    .or(`email.eq.${email},secondary_emails.cs.{"${email}"}`)
    .limit(1)
    .maybeSingle<ContactForReminder>()
  if (error) throw new Error(`contact read failed: ${error.message}`)
  return data ?? null
}

/** A booking's contact said no to texts (an import's tag). Throws on a failed read. */
async function contactOptedOut(supabase: SupabaseClient, workspaceId: string, contactId: string): Promise<boolean> {
  const { data, error } = await supabase.from('contact').select('tags').eq('workspace_id', workspaceId).eq('id', contactId).maybeSingle<{ tags?: unknown }>()
  if (error) throw new Error(`contact read failed: ${error.message}`)
  return optedOutByTag(data?.tags, 'sms')
}

/**
 * Text one business's customers their reminders for the day after
 * `localDate` (its own date when the pass ran), and tell the owner (steps 2
 * to 5 of the header). Throws on a failed read before anything is sent (the
 * step retries; every text is claimed, so none goes twice).
 */
export async function sendDayReminders(
  supabase: SupabaseClient,
  args: { workspaceId: string; localDate: string },
  deps: RemindersDeps = {},
): Promise<RemindersOutcome> {
  const now = (deps.now ?? Date.now)()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(args.localDate)
  if (!m) return { outcome: 'bad_date' }
  const profile = await getBusinessProfile(supabase, args.workspaceId)
  if (!profile) return { outcome: 'no_profile' }
  if (!profile.reminders) return { outcome: 'off' }
  if (!(await activeBusinessNumber(supabase, args.workspaceId))) return { outcome: 'no_number' }
  const { data: member, error: memberError } = await supabase
    .from('member')
    .select('role')
    .eq('workspace_id', args.workspaceId)
    .eq('user_id', profile.ownerUserId)
    .maybeSingle<{ role: string | null }>()
  if (memberError) throw new Error(`member read failed: ${memberError.message}`)
  if (member?.role !== 'owner' && member?.role !== 'admin') return { outcome: 'owner_gone' }
  if (await (deps.paused ?? ((w) => isAgentPaused(supabase, w)))(args.workspaceId)) return { outcome: 'paused' }

  const timeZone = isStorableTimeZone(profile.timeZone)
    ? profile.timeZone
    : (await readMemberTimeZone(supabase, { workspaceId: args.workspaceId, userId: profile.ownerUserId })).timeZone
  // Never at night, and never a day late: a retry after the day is over reminds no one.
  const clock = localClock(now, timeZone)
  if (!clock || clock.date !== args.localDate || clock.hour < REMINDER_SEND_FROM_HOUR || clock.hour >= REMINDER_SEND_UNTIL_HOUR) return { outcome: 'quiet' }

  const today = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
  const next = (days: number) => {
    const d = new Date(Date.UTC(today.y, today.m - 1, today.d + days))
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }
  }
  const window = { from: zonedTime(next(1), '00:00', timeZone), to: zonedTime(next(2), '00:00', timeZone) }

  const bookings = await listBookings(supabase, args.workspaceId, { fromIso: new Date(window.from).toISOString(), state: 'confirmed', limit: 100 })
  const fromBookings = bookingSubjects(bookings, window)
  const bookingEvents = new Set(bookings.map((b) => b.calendarEventId).filter((id): id is string => !!id))
  let events: CalendarEvent[] = []
  try {
    events = await (deps.listEvents ?? listCalendarEventsUnified)(profile.ownerUserId, {
      timeMin: new Date(window.from).toISOString(),
      timeMax: new Date(window.to).toISOString(),
      maxResults: 250,
      workspaceId: args.workspaceId,
    })
  } catch (err) {
    // No calendar, or one that can't be read: the bookings' reminders still go.
    console.warn('[reminders] calendar not read:', err instanceof Error ? err.message : String(err))
  }
  const fromMeetings = await meetingSubjects(events, window, bookingEvents, {
    contactByEmail: (email) => contactByEmail(supabase, args.workspaceId, email),
    isTextingCustomer: async (phone) => (await findCustomerGuest(supabase, args.workspaceId, phone)) !== null,
  })
  const subjects = mergeSubjects(fromBookings, fromMeetings).slice(0, REMINDERS_PER_DAY_MAX)
  if (!subjects.length) return { outcome: 'done', sent: 0, skipped: 0, failed: 0, reported: false }

  const name = await businessName(supabase, args.workspaceId)
  const optedOut = deps.optedOut ?? ((phone: string) => unlinkedNumberOptedOut(supabase, phone))
  const text = deps.text ?? ((to: { workspaceId: string; customerPhone: string; guestId: string | null }, body: string) => textBookingCustomer(supabase, to, body, { kind: 'notice' }))
  const sent: ReminderSubject[] = []
  let skipped = 0
  let failed = 0
  for (const subject of subjects) {
    try {
      if ((await optedOut(subject.phone)) || (subject.type === 'booking' && subject.contactId && (await contactOptedOut(supabase, args.workspaceId, subject.contactId)))) {
        skipped += 1
        continue
      }
      const claim = await claimReminder(supabase, {
        workspaceId: args.workspaceId,
        ownerUserId: profile.ownerUserId,
        subjectType: subject.type,
        subjectId: subject.id,
        contactId: subject.contactId,
        phone: subject.phone,
        customerName: cleanText(subject.customerName, 120) ?? 'Customer',
        kind: cleanText(subject.kind, 40) ?? MEETING_KIND,
        startsAt: subject.startsAt,
        endsAt: subject.endsAt,
      })
      if (!claim.ok) {
        skipped += 1
        continue
      }
      const guestId = subject.guestId ?? (await findCustomerGuest(supabase, args.workspaceId, subject.phone).catch(() => null))?.id ?? null
      const ok = await text(
        { workspaceId: args.workspaceId, customerPhone: subject.phone, guestId },
        reminderText({ business: name, kind: subject.kind, startsAt: subject.startsAt, timeZone, place: subject.place }),
      )
      await markReminderSent(supabase, args.workspaceId, claim.id, ok, new Date(now).toISOString())
      if (ok) sent.push(subject)
      else failed += 1
    } catch (err) {
      // One customer's failure never costs the others theirs.
      failed += 1
      console.warn('[reminders] one reminder failed:', err instanceof Error ? err.message : String(err))
    }
  }

  // Everything sent for tomorrow, this run's or a run cut short before its report (the message id keeps it to one).
  const fromIso = new Date(window.from).toISOString()
  const all = await sentRemindersBetween(supabase, args.workspaceId, fromIso, new Date(window.to).toISOString())
  const first = all.length > 0 && !(await sentRemindersBefore(supabase, args.workspaceId, fromIso))
  const reported = all.length
    ? await reportToOwner(
        supabase,
        {
          workspaceId: args.workspaceId,
          userId: profile.ownerUserId,
          messageId: remindersEventId(args.workspaceId, args.localDate),
          text: remindersSentReport({ sent: all.map((r) => ({ name: r.customerName, kind: r.kind, startsAt: r.startsAt })), timeZone, first }),
          routes: first,
        },
        deps,
      )
    : false
  return { outcome: 'done', sent: sent.length, skipped, failed, reported }
}

/** The business's zone for its texts and reports (its profile's, else its owner's). Never throws (UTC when unreadable). */
export async function reminderZone(supabase: SupabaseClient, business: { workspaceId: string; ownerUserId: string }): Promise<string> {
  try {
    const profile = await getBusinessProfile(supabase, business.workspaceId)
    if (isStorableTimeZone(profile?.timeZone)) return profile.timeZone
    return (await readMemberTimeZone(supabase, { workspaceId: business.workspaceId, userId: business.ownerUserId })).timeZone
  } catch {
    return 'UTC'
  }
}
