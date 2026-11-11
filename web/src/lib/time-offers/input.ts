/**
 * The time offers' tool inputs (src/lib/ai/tools/time-offers.ts): offer_times
 * (one guest, or a poll's several), shared with the outward gate's card
 * (src/lib/safety/outward-gate.ts) and the risk class
 * (src/lib/safety/action-review.ts riskClassOf): a link offer sends nothing,
 * an email or text one goes out only as the replay of the person's card; and
 * a poll's own tools (availability phase 5): nudge_time_offer (the same
 * rule), record_time_offer_answer and book_poll_time.
 *
 * Client-safe and pure.
 */
import { z } from 'zod'
import {
  EMAIL_MAX,
  LOCATION_MAX,
  NUDGE_TIME_OFFER_TOOL,
  OFFER_MESSAGE_MAX,
  OFFER_SLOTS_MAX,
  OFFER_SLOTS_MIN,
  OFFER_TIMES_TOOL,
  POLL_CO_HOSTS_MAX,
  POLL_NOTE_MAX,
  POLL_RECIPIENTS_MAX,
  POLL_SLOTS_MAX,
  RECIPIENT_NAME_MAX,
  SEND_BY,
  TITLE_MAX,
  type SendBy,
} from './types'

export { NUDGE_TIME_OFFER_TOOL, OFFER_TIMES_TOOL }

const guestInput = z.object({
  name: z.string().min(1).max(RECIPIENT_NAME_MAX).describe("The person's name, as the person gave it"),
  email: z.string().max(EMAIL_MAX).optional().describe('Their email address (needed for send_by email; the invitation goes there when it is booked)'),
  phone: z.string().max(30).optional().describe("Their mobile number with country code, like +13125550142 (needed for send_by text)"),
})

export const offerTimesInput = z.object({
  recipient: guestInput.optional().describe('The one outside person the times are for (they pick one). Give this or `recipients`, not both'),
  recipients: z
    .array(guestInput)
    .min(1)
    .max(POLL_RECIPIENTS_MAX)
    .optional()
    .describe(`Several outside people at once (a poll, at most ${POLL_RECIPIENTS_MAX}): each gets their own link and marks every time that works; when the last has answered, the earliest time that works for everyone is booked`),
  co_hosts: z
    .array(z.string().min(1).max(200))
    .max(POLL_CO_HOSTS_MAX)
    .optional()
    .describe("Teammates who attend too (names or sign-in emails, as find_times' people): their time is held with the person's and the booking invites them. Use the times find_times gave for them all"),
  title: z.string().min(1).max(TITLE_MAX).describe('What the meeting is, like "Intro call" (no links)'),
  slots: z
    .array(z.string().min(10).max(40))
    .min(OFFER_SLOTS_MIN)
    .max(POLL_SLOTS_MAX)
    .describe(`Start times exactly as find_times gave them (ISO, with their offset): ${OFFER_SLOTS_MIN} or ${OFFER_SLOTS_MAX} for one person, ${OFFER_SLOTS_MIN} to ${POLL_SLOTS_MAX} for a poll`),
  duration_minutes: z.number().int().min(5).max(480).describe('How long the meeting is'),
  video: z.boolean().optional().describe('Add a video link (Google Meet or Teams) when booked (default true)'),
  call_here: z.boolean().optional().describe("Meet on a call here: the booking gets one of the person's meeting links instead of Google Meet or Teams (only where calls are set up; default false)"),
  location: z.string().max(LOCATION_MAX).optional().describe('Where, when it is in person or on a call they should know of'),
  message: z.string().max(OFFER_MESSAGE_MAX).optional().describe(`A short line of the person's own words to add (at most ${OFFER_MESSAGE_MAX} characters, no links), only when they gave one`),
  expires_at: z.string().max(40).optional().describe('When the offer lapses (an ISO date or date-time). Default 3 days; never after the first time starts'),
  send_by: z
    .enum(SEND_BY)
    .optional()
    .describe("'link' (default): the offer's link and ready-to-paste text come back and nothing is sent. 'email' (from the person's mailbox) or 'text' (from the business's number): always the person's approval card first, showing exactly what goes to whom"),
})

export type OfferTimesInput = z.infer<typeof offerTimesInput>

/** How a call would send, read from its raw input: 'link' unless it says email or text. Pure. */
export function sendByOf(input: unknown): SendBy {
  const value = input && typeof input === 'object' ? (input as { send_by?: unknown }).send_by : undefined
  return value === 'email' || value === 'text' ? value : 'link'
}

/**
 * The agent's bookings from an offer's own times: each runs on its own only
 * when the person saw who the offer went to, else it is their card
 * (./agent-booking.ts, src/lib/safety/action-review.ts gateRiskyCall).
 */
export const OFFER_BOOKING_TOOLS: ReadonlySet<string> = new Set(['accept_time_offer', 'record_time_offer_answer', 'book_poll_time'])

/** An offer_times or nudge_time_offer call that sends (email or text): only ever the replay of the person's card. Pure. */
export function offerTimesSends(toolName: string, input: unknown): boolean {
  return (toolName === OFFER_TIMES_TOOL || toolName === NUDGE_TIME_OFFER_TOOL) && sendByOf(input) !== 'link'
}

export const nudgeTimeOfferInput = z.object({
  offer_id: z.string().uuid().describe('The poll (list_time_offers)'),
  send_by: z
    .enum(SEND_BY)
    .optional()
    .describe("'link' (default): each guest still to answer comes back with their link and a reminder to paste, and nothing is sent. 'email' or 'text': the person's approval card first, showing exactly who gets what"),
})

export type NudgeTimeOfferInput = z.infer<typeof nudgeTimeOfferInput>

export const recordTimeOfferAnswerInput = z.object({
  offer_id: z.string().uuid().describe('The poll (list_time_offers)'),
  guest_id: z.string().uuid().describe("That poll's own guest who answered (list_time_offers' guests)"),
  works: z
    .array(z.string().min(10).max(40))
    .max(POLL_SLOTS_MAX)
    .describe("The starts of every time that works for them, exactly as list_time_offers gives them; empty with none_work when none do"),
  none_work: z.boolean().optional().describe('None of the times work for them'),
  note: z.string().max(POLL_NOTE_MAX).optional().describe('What they said beyond the times, in their words, when it matters to the person'),
})

export type RecordTimeOfferAnswerInput = z.infer<typeof recordTimeOfferAnswerInput>

export const bookPollTimeInput = z.object({
  offer_id: z.string().uuid().describe('The poll (list_time_offers)'),
  start: z.string().min(10).max(40).describe("The time to book: one of the poll's own starts, exactly as list_time_offers gives it"),
  without: z
    .array(z.string().min(1).max(200))
    .max(POLL_RECIPIENTS_MAX)
    .optional()
    .describe("Guests to leave out (their guest_id or name), when the person says so. Those who said the time doesn't work are left out anyway; those who haven't answered are invited"),
})

export type BookPollTimeInput = z.infer<typeof bookPollTimeInput>
