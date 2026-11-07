/**
 * The owner's two answers to a customer's quote (roadmap F3), their names and
 * inputs, shared by the tools (src/lib/ai/tools/business.ts) and the outward
 * gate's card (src/lib/safety/outward-gate.ts). What they do is
 * ./quote-reply.ts, loaded only when one runs.
 *
 *   send_quote   the price, and the booking link or "reply to pick a time",
 *                to the customer who asked;
 *   book_quote   a time the customer already chose, booked for them.
 *
 * Client-safe and pure.
 */
import { z } from 'zod'

export const SEND_QUOTE_TOOL = 'send_quote' as const
export const BOOK_QUOTE_TOOL = 'book_quote' as const

/** The owner's own words added to the quote's text, at most this long. */
export const QUOTE_MESSAGE_MAX = 160
/** A quote card's longest words: the app shows a card's why up to 500 and its title up to 200 (src/lib/safety/approvals.ts). */
export const QUOTE_CARD_WHY_MAX = 450
export const QUOTE_CARD_TITLE_MAX = 200

/**
 * A link or a bare web address ("https://…", "www.…", "name.tld/…"). The
 * owner's added line may hold none, and none of the customer's own words
 * (their name, address, what they asked for) ride into a text: the only link
 * a quote's text carries is the business's own booking link.
 */
export const LINKISH = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b(?:\/\S*)?/i

/** Whether `text` holds a link or a bare web address. Pure. */
export function hasLink(text: string | null | undefined): boolean {
  return !!text && new RegExp(LINKISH.source, 'i').test(text)
}

/** `text` with every link or web address taken out. Pure. */
export function withoutLinks(text: string): string {
  return text.replace(new RegExp(LINKISH.source, 'gi'), ' ').replace(/\s+/g, ' ').trim()
}
/** A job's length the owner may give book_quote, in minutes (the profile's slot_minutes range). */
export const BOOK_MINUTES_MIN = 15
export const BOOK_MINUTES_MAX = 480

export const sendQuoteInput = z.object({
  quote_id: z.string().describe('The quote, from get_quote, list_quotes or the event that named it'),
  price: z
    .union([z.number(), z.string()])
    .optional()
    .describe('The price the owner named, in dollars (600 or "612.50"); it becomes the quote\'s price. Omit to send the price the quote already has'),
  message: z.string().max(QUOTE_MESSAGE_MAX).optional().describe(`A line of the owner's own words to add (at most ${QUOTE_MESSAGE_MAX} characters, no links or web addresses), only when they gave one`),
})

export type SendQuoteInput = z.infer<typeof sendQuoteInput>

export const bookQuoteInput = z.object({
  quote_id: z.string().describe('The quote whose customer is booked'),
  start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:00)?$/, 'start is the business\'s local date and time, like 2026-11-03T10:00 (no Z, no offset)')
    .describe("When the job starts, in the business's own time zone, like 2026-11-03T10:00 (no Z or offset)"),
  minutes: z.number().int().min(BOOK_MINUTES_MIN).max(BOOK_MINUTES_MAX).optional().describe("How long the job takes. Default: the business's slot length"),
})

export type BookQuoteInput = z.infer<typeof bookQuoteInput>
