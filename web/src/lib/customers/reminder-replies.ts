/**
 * A customer's answer to their reminder (roadmap issue #11; the reminder
 * itself: ./reminders.ts). Their reply to the business's number reaches
 * their own agent (./texting.ts), which knows their open reminders
 * (./customer-spec.ts customerRecordSection) and holds two tools for them
 * (./customer-tools.ts):
 *
 *   confirm_appointment  "yes": the reminder is answered confirmed, a
 *                        booking's customer_confirmed_at is set (the owner's
 *                        list_bookings and morning list show it), and the
 *                        owner's home thread gets one quiet line.
 *   move_appointment     another time for a booked job: the new start must
 *                        be an open slot NOW (the business's booking hours,
 *                        the owner's calendar, other bookings: the same
 *                        check a new booking gets). The booking moves (its
 *                        unique live-slot key keeps two from one start), its
 *                        calendar event moves with it, and the customer
 *                        confirmed it by picking it. A calendar that refuses
 *                        puts the booking back (or, when its old time was
 *                        taken meanwhile, leaves it moved and tells the owner
 *                        to move the event). The owner is told where they
 *                        are: who, from when, to when. A meeting is never
 *                        moved here: its invite is the owner's (others may be
 *                        on it), so the agent passes the customer's times on
 *                        with message_owner.
 *
 * And STOP (src/lib/sms/inbound.ts, before any agent): their open reminders
 * are answered opted_out and the owner is told, since the job still stands.
 *
 * No approval card for any of it (Liam: act when confident and let the
 * person undo; cards only for what can't be undone): a confirmation changes
 * nothing, and a move goes only to a time the owner's own booking hours and
 * calendar offer, the owner hears of it at once, and it moves back the same
 * way. Everything is fenced to the business (the token's workspace) and to
 * the number the customer texts from: a reminder sent to another number is
 * "not found".
 *
 * Server only; service role.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { updateCalendarEvent } from '@/lib/integrations/calendar'
import { cleanText } from './intake'
import { answerReminder, getReminder, openRemindersForPhone, reminderAt, type CustomerReminder } from './reminder-store'
import { dayAndTime, reminderZone, reportToOwner, type OwnerReportDeps } from './reminders'
import { openSlotAt, slotLabel, type FindOpenSlotsDeps } from './slots'
import { BOOKING_SELECT, expireStaleBookings, getBooking, toBooking } from './store'
import { BOOKING_REQUEST_TTL_MS, type CustomerBooking } from './types'

type ToolOutput = Record<string, unknown>

/** Seams for the tests. */
export interface ReminderReplyDeps extends OwnerReportDeps {
  now?: () => number
  timeZone?: (business: { workspaceId: string; ownerUserId: string }) => Promise<string>
  openSlotAt?: typeof openSlotAt
  listEvents?: FindOpenSlotsDeps['listEvents']
  moveEvent?: (ownerUserId: string, eventId: string, slot: { start: string; end: string }) => Promise<unknown>
}

const name = (reminder: Pick<CustomerReminder, 'customerName'>) => cleanText(reminder.customerName, 40) ?? 'A customer'

/** "Tue, Nov 10 at 9:00 AM". Pure. */
export function whenLabel(iso: string, timeZone: string): string {
  const { day, time } = dayAndTime(iso, timeZone)
  return `${day} at ${time}`
}

/** The owner's line when a customer confirmed. Pure. */
export function confirmedReport(reminder: Pick<CustomerReminder, 'customerName' | 'kind'>, at: string, timeZone: string): string {
  return `${name(reminder)} confirmed their ${reminder.kind} on ${whenLabel(at, timeZone)}.`
}

/** Where the booking's calendar event ended up after a move. */
export type CalendarAfterMove = 'moved' | 'none' | 'stuck'

/** The owner's line when a customer moved their booking. Pure. */
export function movedReport(reminder: Pick<CustomerReminder, 'customerName' | 'kind'>, from: string, to: string, timeZone: string, calendar: CalendarAfterMove): string {
  const where =
    calendar === 'moved'
      ? " It's moved on your calendar too."
      : calendar === 'stuck'
        ? ` Your calendar wouldn't move, so it still shows ${whenLabel(from, timeZone)}: move that event yourself.`
        : ''
  return `${name(reminder)} moved their ${reminder.kind} from ${whenLabel(from, timeZone)} to ${whenLabel(to, timeZone)}.${where} Tell me if you want it back.`
}

/** The owner's line when a customer said STOP to their reminder. Pure. */
export function stoppedReport(reminder: Pick<CustomerReminder, 'customerName' | 'kind'>, at: string, timeZone: string, business: string): string {
  return `${name(reminder)} replied STOP to their reminder, so ${business} can't text them any more. Their ${reminder.kind} on ${whenLabel(at, timeZone)} still stands; call them if you need to.`
}

/** The reminder, when it is this business's, went to this number, and is still ahead. Throws on a failed read. */
async function theirReminder(supabase: SupabaseClient, workspaceId: string, phone: string, reminderId: string, now: number): Promise<CustomerReminder | null> {
  const reminder = await getReminder(supabase, workspaceId, reminderId)
  if (!reminder || reminder.phone !== phone || reminder.status !== 'sent') return null
  return Date.parse(reminderAt(reminder)) > now ? reminder : null
}

const NOT_FOUND: ToolOutput = { success: false, code: 'NOT_FOUND', message: "There's no reminder like that for this customer, or its time has passed. Answer from what you know, or pass it to the owner with message_owner." }

/** The booking a reminder is for, still confirmed and still this customer's. Throws on a failed read. */
async function remindedBooking(supabase: SupabaseClient, reminder: CustomerReminder): Promise<CustomerBooking | null> {
  if (reminder.subjectType !== 'booking') return null
  const booking = await getBooking(supabase, reminder.workspaceId, reminder.subjectId)
  return booking && booking.state === 'confirmed' && booking.customerPhone === reminder.phone ? booking : null
}

const BOOKING_GONE: ToolOutput = {
  success: false,
  code: 'BOOKING_GONE',
  message: "That booking isn't on the calendar any more. Don't promise anything: pass it to the owner with message_owner.",
}

/** confirm_appointment (see the header). Never throws on a refusal; throws on a failed read. */
export async function confirmAppointment(
  supabase: SupabaseClient,
  args: { workspaceId: string; ownerUserId: string; phone: string; reminderId: string },
  deps: ReminderReplyDeps = {},
): Promise<ToolOutput> {
  const now = (deps.now ?? Date.now)()
  const nowIso = new Date(now).toISOString()
  const reminder = await theirReminder(supabase, args.workspaceId, args.phone, args.reminderId, now)
  if (!reminder) return NOT_FOUND
  if (reminder.answer === 'confirmed' || reminder.answer === 'moved') {
    return { success: true, status: 'already_confirmed', message: "It was already confirmed. Thank them; don't repeat the details unless they ask." }
  }
  if (reminder.subjectType === 'booking') {
    const booking = await remindedBooking(supabase, reminder)
    if (!booking) return BOOKING_GONE
    const { error } = await supabase
      .from('customer_booking')
      .update({ customer_confirmed_at: nowIso, updated_at: nowIso })
      .eq('workspace_id', booking.workspaceId)
      .eq('id', booking.id)
      .eq('state', 'confirmed')
    if (error) throw new Error(`customer_booking update failed: ${error.message}`)
  }
  const answered = await answerReminder(supabase, { workspaceId: args.workspaceId, id: reminder.id, answer: 'confirmed', from: [null, 'opted_out'], nowIso })
  if (answered) {
    const zone = await (deps.timeZone ?? ((b) => reminderZone(supabase, b)))({ workspaceId: args.workspaceId, ownerUserId: reminder.ownerUserId })
    await reportToOwner(
      supabase,
      { workspaceId: args.workspaceId, userId: reminder.ownerUserId, messageId: `customer-reminder:${reminder.id}:confirmed`, text: confirmedReport(reminder, reminderAt(reminder), zone), routes: false },
      deps,
    )
  }
  return { success: true, status: 'confirmed', message: 'Confirmed, and the owner can see it. Thank them in a few words.' }
}

/**
 * Move a confirmed booking to [slot.start, slot.end), fenced on it still
 * being where it was (a second move, or the owner's own change, wins). The
 * moved booking, `taken` when another live booking holds that start, or
 * null when it changed. Throws on any other failed write.
 */
async function rescheduleBooking(
  supabase: SupabaseClient,
  booking: CustomerBooking,
  slot: { start: string; end: string },
  nowIso: string,
): Promise<CustomerBooking | 'taken' | null> {
  const { data, error } = await supabase
    .from('customer_booking')
    .update({ starts_at: slot.start, ends_at: slot.end, customer_confirmed_at: nowIso, updated_at: nowIso })
    .eq('workspace_id', booking.workspaceId)
    .eq('id', booking.id)
    .eq('state', 'confirmed')
    .eq('starts_at', booking.startsAt)
    .select(BOOKING_SELECT)
    .maybeSingle()
  if (error?.code === '23505') return 'taken'
  if (error) throw new Error(`customer_booking update failed: ${error.message}`)
  return data ? toBooking(data as Parameters<typeof toBooking>[0]) : null
}

/** move_appointment (see the header). Never throws on a refusal; throws on a failed read. */
export async function moveAppointment(
  supabase: SupabaseClient,
  args: { workspaceId: string; ownerUserId: string; phone: string; reminderId: string; start: string },
  deps: ReminderReplyDeps = {},
): Promise<ToolOutput> {
  const now = (deps.now ?? Date.now)()
  const nowIso = new Date(now).toISOString()
  const reminder = await theirReminder(supabase, args.workspaceId, args.phone, args.reminderId, now)
  if (!reminder) return NOT_FOUND
  if (reminder.subjectType === 'meeting') {
    return {
      success: false,
      code: 'OWNER_MOVES_MEETINGS',
      message: "A meeting is moved by the owner, not here. Ask which days and times suit them, pass that on with message_owner, and tell them the owner will confirm the new time.",
    }
  }
  const booking = await remindedBooking(supabase, reminder)
  if (!booking) return BOOKING_GONE
  const business = { workspaceId: booking.workspaceId, ownerUserId: booking.ownerUserId }
  const zone = await (deps.timeZone ?? ((b) => reminderZone(supabase, b)))(business)
  if (Date.parse(args.start) === Date.parse(booking.startsAt)) {
    return { success: true, status: 'unchanged', when: slotLabel(booking.startsAt, zone), message: "That's the time it's already booked for. Ask whether they meant another time." }
  }

  // A request the owner never answered still holds its slot's key until it is marked expired (as requestBooking does first).
  await expireStaleBookings(supabase, booking.workspaceId, new Date(now - BOOKING_REQUEST_TTL_MS).toISOString())
  let open: Awaited<ReturnType<typeof openSlotAt>>
  try {
    // The booking itself, and its own calendar event, never block its new time (a 2-hour job moving an hour later).
    open = await (deps.openSlotAt ?? openSlotAt)(supabase, business, args.start, {
      now: () => now,
      ...(deps.listEvents ? { listEvents: deps.listEvents } : {}),
      except: { bookingId: booking.id, eventId: booking.calendarEventId },
    })
  } catch (err) {
    console.warn('[reminders] slot check failed:', err instanceof Error ? err.message : String(err))
    return { success: false, code: 'CALENDAR_UNAVAILABLE', message: "I can't check the calendar right now. Ask them to try again in a little while, or pass their time to the owner with message_owner." }
  }
  if (!open.slot) return { success: false, code: 'SLOT_TAKEN', message: "That time isn't open. Offer others from find_open_slots." }
  const slot = open.slot

  const moved = await rescheduleBooking(supabase, booking, slot, nowIso)
  if (moved === 'taken') return { success: false, code: 'SLOT_TAKEN', message: 'Someone just took that time. Offer others from find_open_slots.' }
  if (!moved) return { success: false, code: 'CHANGED', message: 'That booking just changed. Pass their new time to the owner with message_owner.' }

  // The owner's calendar event follows the booking; a calendar that refuses puts the booking back. When the
  // old time was taken meanwhile (another customer's request), it can't go back: it stays moved, and the owner
  // is told their calendar still shows the old time.
  let calendar: CalendarAfterMove = 'none'
  if (booking.calendarEventId) {
    try {
      await (deps.moveEvent ?? ((userId, eventId, s) => updateCalendarEvent(userId, eventId, { start: s.start, end: s.end })))(booking.ownerUserId, booking.calendarEventId, slot)
      calendar = 'moved'
    } catch (err) {
      console.warn('[reminders] calendar move failed:', err instanceof Error ? err.message : String(err))
      const { data: back, error } = await supabase
        .from('customer_booking')
        .update({ starts_at: booking.startsAt, ends_at: booking.endsAt, customer_confirmed_at: booking.customerConfirmedAt, updated_at: nowIso })
        .eq('workspace_id', booking.workspaceId)
        .eq('id', booking.id)
        .eq('starts_at', slot.start)
        .select('id')
        .maybeSingle()
      if (!error && back) {
        return { success: false, code: 'CALENDAR_FAILED', message: "I couldn't move it on the calendar just now, so it stays at the old time. Pass their new time to the owner with message_owner." }
      }
      console.warn('[reminders] booking not put back:', error?.message ?? 'it changed')
      calendar = 'stuck'
    }
  }

  const from = reminderAt(reminder)
  const answered = await answerReminder(supabase, { workspaceId: args.workspaceId, id: reminder.id, answer: 'moved', from: [null, 'confirmed', 'moved', 'opted_out'], movedTo: slot.start, nowIso })
  if (answered) {
    await reportToOwner(
      supabase,
      {
        workspaceId: args.workspaceId,
        userId: booking.ownerUserId,
        messageId: `customer-reminder:${reminder.id}:moved:${slot.start}`,
        text: movedReport(reminder, from, slot.start, zone, calendar),
        routes: true,
      },
      deps,
    )
  }
  const label = slotLabel(slot.start, zone)
  return { success: true, status: 'moved', when: label, message: `Moved to ${label}, and the owner has been told. Tell them it's booked for then.` }
}

/**
 * A customer said STOP to the business's number (src/lib/sms/inbound.ts):
 * their open reminders are answered opted_out and the owner hears of each,
 * once. Never throws.
 */
export async function remindersStopped(
  supabase: SupabaseClient,
  args: { workspaceId: string; phone: string; businessName: string },
  deps: ReminderReplyDeps = {},
): Promise<number> {
  try {
    const now = (deps.now ?? Date.now)()
    const nowIso = new Date(now).toISOString()
    let told = 0
    for (const reminder of await openRemindersForPhone(supabase, args.workspaceId, args.phone, now)) {
      if (reminder.answer === 'opted_out') continue
      const answered = await answerReminder(supabase, { workspaceId: args.workspaceId, id: reminder.id, answer: 'opted_out', from: [null, 'confirmed', 'moved'], nowIso })
      if (!answered) continue
      const zone = await (deps.timeZone ?? ((b) => reminderZone(supabase, b)))({ workspaceId: args.workspaceId, ownerUserId: reminder.ownerUserId })
      const ok = await reportToOwner(
        supabase,
        {
          workspaceId: args.workspaceId,
          userId: reminder.ownerUserId,
          messageId: `customer-reminder:${reminder.id}:stop`,
          text: stoppedReport(reminder, reminderAt(reminder), zone, args.businessName),
          routes: true,
        },
        deps,
      )
      if (ok) told += 1
    }
    return told
  } catch (err) {
    console.warn('[reminders] stop not recorded:', err instanceof Error ? err.message : String(err))
    return 0
  }
}
