import { tool } from 'ai'
import { z } from 'zod'
import { getServiceClient } from '@/lib/admin'
import type { ApprovedCall } from '@/lib/safety/approved-call'
import { offerTimesInput } from '@/lib/time-offers/input'
import type { MeetingBooking, TimeOffer } from '@/lib/time-offers/types'

/**
 * Time offers (availability phase 3a, src/lib/time-offers/): offering an
 * outside person two or three of the person's times, held until they pick
 * one, booked when they do.
 *
 *   offer_times             make an offer. By link (default): it comes back
 *                           with ready-to-paste text and nothing is sent. By
 *                           email (the person's mailbox) or text (the
 *                           business's number): only as the replay of the
 *                           person's approval card showing exactly what goes
 *                           to whom (the outward gate; send_quote's model).
 *   list_time_offers        the person's open and recent offers and bookings.
 *   withdraw_time_offer     take an open offer back: its held times go.
 *   cancel_offered_meeting  cancel a meeting booked from an offer: the
 *                           calendar event is deleted and the guest told by
 *                           the calendar. Never an unattended run's.
 *   accept_time_offer       the guest answered in words ("Tuesday works"):
 *                           book one of that offer's own times for that
 *                           offer's own recipient. The person approved
 *                           offering exactly these times to exactly this
 *                           person, so no second card: it takes only the
 *                           offer and a start, never another time or guest
 *                           (src/lib/safety/action-review.ts preApprovedCall).
 *
 * Only the person's own offers: the host is always the caller.
 */
export interface TimeOfferToolContext {
  /** The approval being replayed (executeStoredCall only): offer_times by email or text sends only under its own. */
  approvedCall?: ApprovedCall
  /** Nobody at the keyboard (a work run's, a loop's or a home turn's own work): no meeting is cancelled. */
  unattended?: boolean
  /** This turn's browser zone, read as find_times reads it. */
  timeZone?: string | null
}

function label(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso)).replace(/[  ]/g, ' ')
  } catch {
    return iso
  }
}

function offerForModel(offer: TimeOffer) {
  return {
    offer_id: offer.id,
    state: offer.state,
    recipient: { name: offer.recipientName, email: offer.recipientEmail, phone: offer.recipientPhone },
    title: offer.title,
    duration_minutes: offer.durationMinutes,
    sent_via: offer.sentVia,
    times: offer.slots.map((s) => ({ start: s.startsAt, label: label(s.startsAt, offer.timeZone), state: s.state })),
    expires: label(offer.expiresAt, offer.timeZone),
    ...(offer.bookingId ? { booking_id: offer.bookingId } : {}),
  }
}

function bookingForModel(booking: MeetingBooking, timeZone: string) {
  return {
    booking_id: booking.id,
    state: booking.state,
    guest: { name: booking.guestName, email: booking.guestEmail },
    title: booking.title,
    start: booking.startsAt,
    when: label(booking.startsAt, timeZone),
    ...(booking.conferenceUrl ? { video_link: booking.conferenceUrl } : {}),
    ...(booking.offerId ? { offer_id: booking.offerId } : {}),
    ...(booking.state === 'failed' && booking.lastError ? { why_failed: booking.lastError.slice(0, 160) } : {}),
  }
}

export function createTimeOfferTools(userId: string, workspaceId?: string, ctx: TimeOfferToolContext = {}) {
  const noWorkspace = { success: false, error: 'No workspace is active.' }
  return {
    offer_times: tool({
      description:
        'Offer someone OUTSIDE the workspace two or three of the person\'s times to meet, from find_times\' `suggested` (or `free`): each time is checked free and HELD on the person\'s calendar until they pick one or the offer expires (3 days by default, never past the first time). ' +
        'They pick on a private link, or by replying; it is then booked on the person\'s calendar and the calendar sends them the invitation, with a video link unless video is false. ' +
        "send_by 'link' (the default) sends nothing: it returns the link and `paste_text` for the person to send. " +
        "send_by 'email' (from the person's mailbox) or 'text' (from the business's number, when the workspace has one) never runs in the turn: it becomes the person's approval card showing exactly who gets what, and sends once when they accept. " +
        'For teammates, create_calendar_event instead. The link is shown only once, here.',
      inputSchema: offerTimesInput,
      execute: async (input) => {
        if (!workspaceId) return noWorkspace
        // Loaded on use: the offer, calendar and sending code stays out of every tool set's imports.
        const { runOfferTimes } = await import('@/lib/time-offers/send')
        return runOfferTimes(getServiceClient(), { userId, workspaceId, approvedCall: ctx.approvedCall, browserTimeZone: ctx.timeZone ?? null }, input)
      },
    }),

    list_time_offers: tool({
      description:
        "The person's time offers (open, waiting on their card, booked, expired, withdrawn) and the meetings booked from them, newest first: who, what, the times and their state. Use it to find an offer's id before withdraw_time_offer or accept_time_offer, or a booking's before cancel_offered_meeting.",
      inputSchema: z.object({
        open_only: z.boolean().optional().describe('Only offers still waiting for a pick (default false: also the last 30 days)'),
        limit: z.number().int().min(1).max(30).optional().describe('At most this many of each (default 10)'),
      }),
      execute: async ({ open_only, limit }) => {
        if (!workspaceId) return noWorkspace
        try {
          const { listOffers, listBookings } = await import('@/lib/time-offers/store')
          const supabase = getServiceClient()
          const since = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString()
          const [offers, bookings] = await Promise.all([
            listOffers(supabase, { workspaceId, hostUserId: userId, ...(open_only ? { states: ['open', 'pending_send'] } : { sinceIso: since }), limit: limit ?? 10 }),
            open_only ? Promise.resolve([]) : listBookings(supabase, { workspaceId, hostUserId: userId, sinceIso: since, limit: limit ?? 10 }),
          ])
          const zoneOf = new Map(offers.map((o) => [o.id, o.timeZone]))
          const fallbackZone = offers[0]?.timeZone ?? 'UTC'
          return {
            success: true,
            offers: offers.map(offerForModel),
            bookings: bookings.map((b) => bookingForModel(b, (b.offerId && zoneOf.get(b.offerId)) || fallbackZone)),
          }
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
    }),

    withdraw_time_offer: tool({
      description: "Take back one of the person's open time offers (or one still waiting on their card): its link stops working and its held times are free again. A booked one is cancel_offered_meeting instead.",
      inputSchema: z.object({ offer_id: z.string().uuid().describe('The offer (list_time_offers)') }),
      execute: async ({ offer_id }) => {
        if (!workspaceId) return noWorkspace
        const { withdrawOffer } = await import('@/lib/time-offers/offers')
        const result = await withdrawOffer(getServiceClient(), { workspaceId, userId, offerId: offer_id })
        if (!result.ok) return { success: false, code: result.code, error: result.message }
        return { success: true, offer: offerForModel(result.offer), message: `Withdrawn: the times held for ${result.offer.recipientName} are free again. They were not told: tell them if they should know.` }
      },
    }),

    cancel_offered_meeting: tool({
      description:
        "Cancel a meeting an outside guest booked from one of the person's time offers, when the person says so: the calendar event is deleted and the calendar sends the guest its cancellation; the time is free again.",
      inputSchema: z.object({ booking_id: z.string().uuid().describe('The booking (list_time_offers)') }),
      execute: async ({ booking_id }) => {
        if (ctx.unattended) return { success: false, code: 'NEEDS_PERSON', error: 'Only the person cancels a meeting with a guest (the guest is told). Leave it to them.' }
        if (!workspaceId) return noWorkspace
        try {
          const { hostBooking, cancelMeeting } = await import('@/lib/time-offers/manage')
          const supabase = getServiceClient()
          const booking = await hostBooking(supabase, { workspaceId, userId, bookingId: booking_id })
          if (!booking) return { success: false, code: 'NOT_FOUND', error: 'No booking of yours with that id in this workspace (list_time_offers).' }
          const result = await cancelMeeting(supabase, { booking, by: 'host' })
          if (!result.ok) return { success: false, code: result.code, error: result.message }
          return { success: true, booking_id: result.booking.id, state: result.booking.state, message: `Cancelled ${booking.title} with ${booking.guestName}. ${booking.guestEmail ? 'The calendar sent them the cancellation.' : 'They have no email on file: tell them yourself.'}` }
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
    }),

    accept_time_offer: tool({
      description:
        "Book one of an offer's own times for that offer's own recipient, when they answered in words (\"Tuesday at 10 works\", in an email or a message the person shows you). Only a time that offer holds, only for its recipient: never another time or person (offer new times for that). " +
        'It is booked on the person\'s calendar and the calendar sends them the invitation. No approval card: the person already offered them these times.',
      inputSchema: z.object({
        offer_id: z.string().uuid().describe('The offer (list_time_offers)'),
        start: z.string().min(10).max(40).describe("The picked time's start, exactly as list_time_offers gives it"),
      }),
      execute: async ({ offer_id, start }) => {
        if (!workspaceId) return noWorkspace
        const { acceptOffer } = await import('@/lib/time-offers/accept')
        const result = await acceptOffer(getServiceClient(), { offer: { id: offer_id, workspaceId }, slotStart: start, via: 'host', actingUserId: userId })
        if (!result.ok) {
          return {
            success: false,
            code: result.code,
            error: result.message,
            ...(result.openSlots ? { still_open: result.openSlots.map((s) => ({ start: s.startsAt })) } : {}),
          }
        }
        const b = result.booking
        return {
          success: true,
          already_booked: result.already,
          booking: bookingForModel(b, result.offer.timeZone),
          message:
            b.state === 'confirmed'
              ? `Booked ${b.title} with ${b.guestName}, ${label(b.startsAt, result.offer.timeZone)}. ${b.guestEmail ? 'The calendar sent them the invitation.' : 'They have no email on file, so no invitation went: tell them.'}`
              : `Held ${label(b.startsAt, result.offer.timeZone)} for ${b.guestName}; the calendar event is still being written and will follow shortly.`,
        }
      },
    }),
  }
}
