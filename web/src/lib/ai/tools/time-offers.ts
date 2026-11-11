import { tool } from 'ai'
import { z } from 'zod'
import { getServiceClient } from '@/lib/admin'
import type { ApprovedCall } from '@/lib/safety/approved-call'
import { bookPollTimeInput, nudgeTimeOfferInput, offerTimesInput, recordTimeOfferAnswerInput } from '@/lib/time-offers/input'
import type { MeetingBooking, TimeOffer, TimeOfferPoll } from '@/lib/time-offers/types'

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
 *   list_time_offers        the person's open and recent offers, and the
 *                           meetings booked from them or from the person's
 *                           booking links (src/lib/booking-links/).
 *   withdraw_time_offer     take an open offer back: its held times go.
 *   cancel_offered_meeting  cancel a meeting booked from an offer or a
 *                           booking link (or a request still waiting): the
 *                           calendar event is deleted and the guest told by
 *                           the calendar. Never an unattended run's.
 *   accept_time_offer       the guest answered in words ("Tuesday works"):
 *                           book one of that offer's own times for that
 *                           offer's own recipient. It takes only the offer
 *                           and a start, never another time or guest. No
 *                           second card when the person saw who the offer
 *                           went to (its card, or their own turn made it);
 *                           otherwise the calendar would email someone they
 *                           never approved, so it is their card first
 *                           (src/lib/time-offers/agent-booking.ts), and it
 *                           runs only as that card's replay.
 *
 * And polls (availability phase 5, src/lib/time-offers/polls.ts): offer_times
 * with several `recipients` (and teammates as `co_hosts`); each guest marks
 * every time that works, and the last answer books the earliest time that
 * works for everyone.
 *
 *   record_time_offer_answer  a poll guest answered in words ("Tuesday or
 *                           Thursday work"): only that poll's own guest and
 *                           its own times, gated as accept_time_offer.
 *   book_poll_time          book one of a poll's times with whoever can
 *                           make it, at the person's word ("Tuesday at 10
 *                           without Dana"). Gated as accept_time_offer, and
 *                           never an unattended run's (it overrides the
 *                           guests' answers).
 *   nudge_time_offer        remind the guests still to answer: by link (the
 *                           person pastes it) or, as offer_times, only as the
 *                           replay of the person's card by email or text.
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
  /** A guest's or a linked agent's own turn: no grant of the person's is read (a linked guest's free/busy, #74). */
  omitGrants?: boolean
  /** The person at the keyboard, reading this turn: an offer made by link is shown to them (time_offer.recipients_shown). */
  personAttended?: boolean
}

/**
 * An agent booking from an offer whose guests the person never saw runs only
 * as the replay of their card (the gate raises it: src/lib/time-offers/
 * agent-booking.ts); a door that never asked gets this refusal. Null: it may
 * run.
 */
async function unseenGuestsRefusal(ctx: TimeOfferToolContext, toolName: string, workspaceId: string, offerId: string): Promise<{ success: false; code: string; error: string } | null> {
  if (ctx.approvedCall?.tool === toolName) return null
  const { getOffer } = await import('@/lib/time-offers/store')
  const offer = await getOffer(getServiceClient(), offerId, workspaceId).catch(() => null)
  if (!offer || offer.recipientsShown) return null
  return { success: false, code: 'NEEDS_PERSON', error: `Nothing was booked. The person never saw who this offer went to, so ${toolName} needs their approval card first. Don't retry; tell them what you would have booked.` }
}

function label(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso)).replace(/[  ]/g, ' ')
  } catch {
    return iso
  }
}

/** A poll's guests as the model reads them: who, their link, and what they answered (never shown to another guest). */
function guestsForModel(poll: TimeOfferPoll, origin: string, recipientLink: (origin: string, id: string) => string) {
  return poll.recipients.map((r) => ({
    guest_id: r.id,
    name: r.name,
    ...(r.email ? { email: r.email } : {}),
    ...(r.phone ? { phone: r.phone } : {}),
    ...(r.sent ? { link: recipientLink(origin, r.id) } : {}),
    answered: !!r.answeredAt,
    ...(r.answeredAt ? { works: poll.slots.filter((s) => r.works.includes(s.id)).map((s) => s.startsAt), ...(r.works.length ? {} : { none_work: true }) } : {}),
    ...(r.answeredVia === 'calendar' ? { from_calendar: true } : {}),
    ...(r.note ? { note: r.note } : {}),
    ...(r.attending !== null ? { attending: r.attending } : {}),
  }))
}

function offerForModel(offer: TimeOffer, poll?: { poll: TimeOfferPoll; origin: string; recipientLink: (origin: string, id: string) => string; best?: string | null }) {
  return {
    offer_id: offer.id,
    state: offer.state,
    ...(poll
      ? { mode: 'poll', guests: guestsForModel(poll.poll, poll.origin, poll.recipientLink), ...(offer.coHostIds.length ? { co_hosts: offer.coHostIds.length } : {}), ...(poll.best ? { best_time: poll.best } : {}) }
      : { recipient: { name: offer.recipientName, email: offer.recipientEmail, phone: offer.recipientPhone } }),
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
    ...(booking.linkId ? { from_booking_link: true } : {}),
    ...(booking.source === 'poll' ? { from_poll: true } : {}),
    ...(booking.state === 'requested' ? { waiting_on_you: true } : {}),
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
        'Several outside people at once: `recipients` (a poll, up to 8), and teammates who attend too in `co_hosts` (with times find_times gave for them all): each guest gets their own link and marks every time that works; ' +
        'when the last has answered, the earliest time that works for everyone is booked with all of them, and the person is told (or told the best option when none works). ' +
        "A guest whose agent is linked with the person's and shares free/busy is answered from their calendar at once. " +
        "For teammates only, find_times and create_calendar_event instead. A single offer's link is shown only once, here; a poll guest's link list_time_offers shows again.",
      inputSchema: offerTimesInput,
      execute: async (input) => {
        if (!workspaceId) return noWorkspace
        // Loaded on use: the offer, calendar and sending code stays out of every tool set's imports.
        const { runOfferTimes } = await import('@/lib/time-offers/send')
        return runOfferTimes(getServiceClient(), { userId, workspaceId, approvedCall: ctx.approvedCall, browserTimeZone: ctx.timeZone ?? null, omitGrants: ctx.omitGrants === true, personAttended: ctx.personAttended === true }, input)
      },
    }),

    list_time_offers: tool({
      description:
        "The person's time offers (open, waiting on their card, booked, expired, withdrawn) and the meetings booked from them or from their booking links (a request still waiting on their yes is requested), newest first: who, what, the times and their state. " +
        "A poll lists each guest with their own link and what they answered (from_calendar when their calendar answered), and best_time when everyone answered and no time works for all. " +
        "Use it to find an offer's id before withdraw_time_offer, accept_time_offer, record_time_offer_answer, book_poll_time or nudge_time_offer, or a booking's before cancel_offered_meeting.",
      inputSchema: z.object({
        open_only: z.boolean().optional().describe('Only offers still waiting for a pick (default false: also the last 30 days)'),
        limit: z.number().int().min(1).max(30).optional().describe('At most this many of each (default 10)'),
      }),
      execute: async ({ open_only, limit }) => {
        if (!workspaceId) return noWorkspace
        try {
          const [{ listOffers, listBookings }, { withRecipients }, { recipientLink }, { bestSlot, commonSlots, everyoneAnswered }, { bestOptionWords }, { appOrigin }] = await Promise.all([
            import('@/lib/time-offers/store'),
            import('@/lib/time-offers/poll-store'),
            import('@/lib/time-offers/polls'),
            import('@/lib/time-offers/types'),
            import('@/lib/time-offers/words'),
            import('@/lib/twilio/config'),
          ])
          const supabase = getServiceClient()
          const since = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString()
          const [listed, bookings] = await Promise.all([
            listOffers(supabase, { workspaceId, hostUserId: userId, ...(open_only ? { states: ['open', 'pending_send'] } : { sinceIso: since }), limit: limit ?? 10 }),
            open_only ? Promise.resolve([]) : listBookings(supabase, { workspaceId, hostUserId: userId, sinceIso: since, limit: limit ?? 10, sources: ['offer', 'link', 'poll'] }),
          ])
          // Every poll's guests and answers: two reads, whatever the count.
          const offers = await withRecipients(supabase, listed)
          const origin = appOrigin()
          const now = Date.now()
          const zoneOf = new Map(offers.map((o) => [o.id, o.timeZone]))
          const fallbackZone = offers[0]?.timeZone ?? 'UTC'
          return {
            success: true,
            offers: offers.map((o) => {
              if (o.mode !== 'poll') return offerForModel(o)
              const stuck = o.state === 'open' && everyoneAnswered(o.recipients) && !commonSlots(o, now).length ? bestSlot(o, now) : null
              return offerForModel(o, { poll: o, origin, recipientLink: (base, id) => recipientLink(base, id), best: stuck ? bestOptionWords(stuck, o.timeZone) : null })
            }),
            bookings: bookings.map((b) => bookingForModel(b, b.hostTimeZone || (b.offerId && zoneOf.get(b.offerId)) || fallbackZone)),
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
        "Cancel a meeting an outside guest booked from one of the person's time offers or booking links, when the person says so: the calendar event is deleted and the calendar sends the guest its cancellation; the time is free again.",
      inputSchema: z.object({ booking_id: z.string().uuid().describe('The booking (list_time_offers)') }),
      execute: async ({ booking_id }) => {
        if (ctx.unattended) return { success: false, code: 'NEEDS_PERSON', error: 'Only the person cancels a meeting with a guest (the guest is told). Leave it to them.' }
        if (!workspaceId) return noWorkspace
        try {
          const [{ hostBooking, cancelMeeting }, { getPoll }, { hostCancelledWords }] = await Promise.all([
            import('@/lib/time-offers/manage'),
            import('@/lib/time-offers/poll-store'),
            import('@/lib/time-offers/words'),
          ])
          const supabase = getServiceClient()
          const booking = await hostBooking(supabase, { workspaceId, userId, bookingId: booking_id })
          if (!booking) return { success: false, code: 'NOT_FOUND', error: 'No booking of yours with that id in this workspace (list_time_offers).' }
          const result = await cancelMeeting(supabase, { booking, by: 'host' })
          if (!result.ok) return { success: false, code: result.code, error: result.message }
          // A poll's meeting has its attending guests, each with or without an email; any other has its one guest.
          const poll = booking.source === 'poll' && booking.offerId ? await getPoll(supabase, booking.offerId, workspaceId).catch(() => null) : null
          const guests = poll ? poll.recipients.filter((r) => r.attending === true).map((r) => ({ name: r.name, email: r.email })) : [{ name: booking.guestName, email: booking.guestEmail }]
          return { success: true, booking_id: result.booking.id, state: result.booking.state, message: hostCancelledWords(result.booking, guests.length ? guests : [{ name: booking.guestName, email: booking.guestEmail }]) }
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
    }),

    record_time_offer_answer: tool({
      description:
        "Record which of a poll's times work for one of its own guests, when they answered in words (\"Tuesday or Thursday work\", \"none of those\", in an email or a message the person shows you): every time that works, or none_work. It replaces their earlier answer. " +
        "Only that poll's own guest (guest_id from list_time_offers) and its own times: never another time or person. When it is the last answer, the earliest time that works for everyone is booked (the calendar sends the invitations). No approval card when the person saw who the poll went to; otherwise it waits on their card.",
      inputSchema: recordTimeOfferAnswerInput,
      execute: async (input) => {
        if (!workspaceId) return noWorkspace
        const unseen = await unseenGuestsRefusal(ctx, 'record_time_offer_answer', workspaceId, input.offer_id)
        if (unseen) return unseen
        const { recordAnswer } = await import('@/lib/time-offers/polls')
        const result = await recordAnswer(getServiceClient(), {
          ref: { offerId: input.offer_id, workspaceId, recipientId: input.guest_id },
          works: input.works,
          none: input.none_work === true,
          note: input.note ?? null,
          via: 'host',
          actingUserId: userId,
        })
        if (!result.ok) {
          return { success: false, code: result.code, error: result.message, ...(result.openSlots ? { still_open: result.openSlots.map((s) => ({ start: s.startsAt })) } : {}) }
        }
        const zone = result.poll.timeZone
        const b = result.booking
        return {
          success: true,
          offer_id: result.poll.id,
          guest: { guest_id: result.recipient.id, name: result.recipient.name },
          works: result.poll.slots.filter((s) => result.recipient.works.includes(s.id)).map((s) => ({ start: s.startsAt, label: label(s.startsAt, zone) })),
          waiting: result.waiting,
          ...(b ? { booking: bookingForModel(b, zone) } : {}),
          message: b
            ? `Recorded. Everyone has answered: ${b.title} is booked for ${label(b.startsAt, zone)}${b.state === 'confirmed' ? ', and the invitations went out' : '; the calendar event follows shortly'}.`
            : result.waiting
              ? `Recorded ${result.recipient.name}'s answer. ${result.waiting} still to answer.`
              : `Recorded. Everyone has answered, but no time works for all of them: list_time_offers shows the best one; book_poll_time books it with whoever can make it, if the person says so.`,
        }
      },
    }),

    book_poll_time: tool({
      description:
        "Book one of a poll's own times now, with whoever can make it, when the person says so (\"book Tuesday 10 without Dana\"): everyone but those who said it doesn't work and those named in `without`; a guest who hasn't answered is invited. " +
        "It is booked on the person's calendar (co-hosts too) and the calendar sends the invitations. Only the poll's own times and guests.",
      inputSchema: bookPollTimeInput,
      execute: async (input) => {
        // The person's own approved card for it is their word too.
        if (ctx.unattended && ctx.approvedCall?.tool !== 'book_poll_time') return { success: false, code: 'NEEDS_PERSON', error: "Only the person books a poll's time over its guests' answers. Leave it to them." }
        if (!workspaceId) return noWorkspace
        const unseen = await unseenGuestsRefusal(ctx, 'book_poll_time', workspaceId, input.offer_id)
        if (unseen) return unseen
        const { bookPollAnyway } = await import('@/lib/time-offers/polls')
        const result = await bookPollAnyway(getServiceClient(), { workspaceId, userId, offerId: input.offer_id, start: input.start, without: input.without })
        if (!result.ok) return { success: false, code: result.code, error: result.message }
        const zone = result.poll.timeZone
        const b = result.booking
        const on = result.poll.recipients.filter((r) => r.attending).map((r) => r.name)
        return {
          success: true,
          booking: bookingForModel(b, zone),
          attending: on,
          ...(result.left.length ? { left_out: result.left.map((r) => r.name) } : {}),
          message: `Booked ${b.title} for ${label(b.startsAt, zone)} with ${on.join(', ')}.${result.left.length ? ` Not on it: ${result.left.map((r) => r.name).join(', ')} (they were not told: tell them if they should know).` : ''}`,
        }
      },
    }),

    nudge_time_offer: tool({
      description:
        "Remind a poll's guests who haven't answered yet (at most three times each, 12 hours apart). send_by 'link' (the default) sends nothing: each comes back with their link and a reminder to paste. " +
        "send_by 'email' or 'text' never runs in the turn: it becomes the person's approval card showing exactly who gets what, and sends once when they accept.",
      inputSchema: nudgeTimeOfferInput,
      execute: async (input) => {
        if (!workspaceId) return noWorkspace
        const { runNudge } = await import('@/lib/time-offers/poll-send')
        return runNudge(getServiceClient(), { userId, workspaceId, approvedCall: ctx.approvedCall }, input)
      },
    }),

    accept_time_offer: tool({
      description:
        "Book one of an offer's own times for that offer's own recipient, when they answered in words (\"Tuesday at 10 works\", in an email or a message the person shows you). Only a time that offer holds, only for its recipient: never another time or person (offer new times for that). " +
        'It is booked on the person\'s calendar and the calendar sends them the invitation. No approval card when the person saw who the offer went to; otherwise it waits on their card.',
      inputSchema: z.object({
        offer_id: z.string().uuid().describe('The offer (list_time_offers)'),
        start: z.string().min(10).max(40).describe("The picked time's start, exactly as list_time_offers gives it"),
      }),
      execute: async ({ offer_id, start }) => {
        if (!workspaceId) return noWorkspace
        const unseen = await unseenGuestsRefusal(ctx, 'accept_time_offer', workspaceId, offer_id)
        if (unseen) return unseen
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
