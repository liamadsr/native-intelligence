/**
 * The person's agent booking one of an offer's own times for its guests
 * (accept_time_offer, record_time_offer_answer, book_poll_time): the event
 * goes on the host's calendar and the calendar emails every guest on it, from
 * the host's own account.
 *
 * That runs without a card only when the person saw who the offer went to
 * (time_offer.recipients_shown): it went out on their approved card (email
 * or text), or their own attended turn made it. An offer made anywhere else
 * (by link in a home turn, a run, a text, or a prompt in a mail the agent was
 * reading) names guests nobody approved, so a booking from it is held as the
 * person's card naming them, as create_calendar_event's outside attendees
 * are (src/lib/safety/outward-gate.ts), and refused NEEDS_PERSON where no
 * card can be raised. A guest's own pick (the public page, a text from the
 * offer's own number) is theirs and never passes here.
 *
 * Server only; service role.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getPoll } from './poll-store'
import { getOffer } from './store'

export interface OfferBookingHold {
  card: { title: string; why: string }
  refusal: string
}

const offerIdOf = (input: unknown): string | null => {
  const id = input && typeof input === 'object' ? (input as { offer_id?: unknown }).offer_id : undefined
  return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id.trim()) ? id.trim() : null
}

function listed(names: readonly string[]): string {
  const shown = names.slice(0, 5).join(', ')
  return names.length > 5 ? `${shown} and ${names.length - 5} more` : shown
}

/**
 * The hold an agent booking from this offer needs, or null when it may run:
 * its guests were shown to the person, or there is no such offer of theirs
 * (the tool refuses that itself). A read that fails is held: the call can't
 * be checked. Never throws.
 */
export async function offerBookingHold(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; toolName: string; input: unknown },
): Promise<OfferBookingHold | null> {
  const offerId = offerIdOf(args.input)
  if (!offerId) return null
  let who: string[]
  let title: string
  try {
    const offer = await getOffer(supabase, offerId, args.workspaceId)
    if (!offer || offer.hostUserId !== args.userId || offer.recipientsShown) return null
    title = offer.title
    if (offer.mode === 'poll') {
      const poll = await getPoll(supabase, offerId, args.workspaceId)
      who = (poll?.recipients ?? []).map((r) => (r.email ? `${r.name} (${r.email})` : r.name))
    } else {
      who = [offer.recipientEmail ? `${offer.recipientName} (${offer.recipientEmail})` : offer.recipientName]
    }
  } catch (err) {
    console.warn('[time-offers] an agent booking could not be checked; held:', err instanceof Error ? err.message : String(err))
    return {
      card: {
        title: `Approve ${args.toolName}?`,
        why: "This books a meeting from one of your time offers, and your calendar emails its guests the invitation. Who they are couldn't be checked just now. Nothing reaches another person without your yes. It runs once, with exactly the inputs below, when you accept.",
      },
      refusal: `Nothing ran. ${args.toolName} books a meeting whose guests the person hasn't approved, and nobody is here to approve it. Do not retry; report what you would have booked.`,
    }
  }
  const guests = listed(who)
  const does =
    args.toolName === 'record_time_offer_answer'
      ? `This records a guest's answer to your poll "${title}". If it is the last answer, the meeting is booked on your calendar, and your calendar emails the invitation (its title, description and video link) to ${guests}.`
      : `This books "${title}" on your calendar, and your calendar emails the invitation (its title, description and video link) to ${guests}.`
  return {
    card: {
      title: `Book "${title.slice(0, 60)}" with ${who.length <= 2 ? who.join(' and ') : `${who[0]} and ${who.length - 1} more`}?`,
      why: `${does} You haven't approved who this offer went to: it was made without you seeing it. Nothing reaches another person without your yes. It runs once, with exactly the inputs below, when you accept.`,
    },
    refusal:
      `Nothing ran. ${args.toolName} would book "${title}" and send the invitation to ${guests}, people the person never approved this offer for, and nobody is here to approve it. ` +
      'Do not retry; report what you would have booked so the person can do it.',
  }
}
