/**
 * offer_times's input (src/lib/ai/tools/time-offers.ts), shared with the
 * outward gate's card (src/lib/safety/outward-gate.ts) and the risk class
 * (src/lib/safety/action-review.ts riskClassOf): a link offer sends nothing,
 * an email or text one goes out only as the replay of the person's card.
 *
 * Client-safe and pure.
 */
import { z } from 'zod'
import { EMAIL_MAX, LOCATION_MAX, OFFER_MESSAGE_MAX, OFFER_SLOTS_MAX, OFFER_SLOTS_MIN, OFFER_TIMES_TOOL, RECIPIENT_NAME_MAX, SEND_BY, TITLE_MAX, type SendBy } from './types'

export { OFFER_TIMES_TOOL }

export const offerTimesInput = z.object({
  recipient: z
    .object({
      name: z.string().min(1).max(RECIPIENT_NAME_MAX).describe("The person's name, as the person gave it"),
      email: z.string().max(EMAIL_MAX).optional().describe('Their email address (needed for send_by email; the invitation goes there when they pick)'),
      phone: z.string().max(30).optional().describe("Their mobile number with country code, like +13125550142 (needed for send_by text)"),
    })
    .describe('The one outside person the times are for'),
  title: z.string().min(1).max(TITLE_MAX).describe('What the meeting is, like "Intro call" (no links)'),
  slots: z
    .array(z.string().min(10).max(40))
    .min(OFFER_SLOTS_MIN)
    .max(OFFER_SLOTS_MAX)
    .describe(`${OFFER_SLOTS_MIN} or ${OFFER_SLOTS_MAX} start times, exactly as find_times gave them (ISO, with their offset)`),
  duration_minutes: z.number().int().min(5).max(480).describe('How long the meeting is'),
  video: z.boolean().optional().describe('Add a video link (Google Meet or Teams) when booked (default true)'),
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

/** An offer_times call that sends (email or text): only ever the replay of the person's card. Pure. */
export function offerTimesSends(toolName: string, input: unknown): boolean {
  return toolName === OFFER_TIMES_TOOL && sendByOf(input) !== 'link'
}
