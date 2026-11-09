/**
 * The owner's answer to a customer's quote (roadmap F3,
 * docs/plans/customer-front-door.md), for any service business. A website
 * sends two kinds of quote, and the owner's yes answers each:
 *
 *   send_quote   a request with no price or time (an estimate, a contact
 *                form). The owner names the price; the customer gets the
 *                business's name, what it's for, the price, and its booking
 *                link (/book/<slug>) to pick a time, or "reply to pick a
 *                time" when it has none. By text from the business's own
 *                number (never the Dial8 one; US and Canadian numbers only;
 *                never a number that said STOP); with no business number or
 *                no number to text, by email from the owner's own mailbox.
 *                The quote is marked sent.
 *   book_quote   a request where the customer already chose a time (the
 *                quote's requested dates, or a time in their notes, which the
 *                agent reads: no site's format is parsed here). The owner's
 *                yes books it: a customer_booking (source 'owner') for the
 *                quote's customer, then the same confirmBooking a customer's
 *                own request gets on the owner's yes (./booking.ts): the slot
 *                checked again, the owner's calendar written, the booking
 *                confirmed, the quote marked booked, the customer texted from
 *                the business's number. No second card: this one IS the yes.
 *
 * Only on the owner's approval card. The quote's number and email came from
 * a web form, nobody's verified contact, so nothing reaches them before the
 * owner's yes (track B's rule: a number typed on the booking page is texted
 * only after the owner's yes). The outward gate holds every call
 * (quoteReplyHold) as a card saying exactly who gets what text, and keeps the
 * hash of those words on the approval (QuoteReplyApprovalContext). The replay
 * builds the card again from the rows as they are then and sends nothing
 * when its words differ: a price changed since, another booking link, a
 * number that said STOP. The card shows EVERY word that goes out, in the app
 * and by text (its title names the recipient; the texted prompt carries the
 * whole card, src/lib/sms/approvals.ts): the words are cut to fit it
 * (QUOTE_CARD_WHY_MAX), the owner's added line holds no link, and none of the
 * customer's own words carry one, so the only link is the business's own
 * booking link. A yes that doesn't book never leaves its hold behind.
 * Owners and admins only. No money moves here: send_payment_link is the one
 * money tool, its own card.
 *
 * Server only; service role, every read fenced to the workspace.
 */
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getCalendarProvider } from '@/lib/integrations/calendar'
import { sendEmail } from '@/lib/crm/email-client'
import { unlinkedNumberOptedOut } from '@/lib/sms/store'
import { appOrigin } from '@/lib/twilio/config'
import { plainSmsText } from '@/lib/twilio/sms-format'
import { isNanpNumber } from '@/lib/twilio/phone'
import type { ApprovedCall, QuoteReplyApprovalContext } from '@/lib/safety/approved-call'
import { bookingConfirmedText, confirmBooking, textBookingCustomer, type ConfirmDeps } from './booking'
import { cleanText, dollarsToCents } from './intake'
import { activeBusinessNumber } from './numbers'
import { bookingUrl } from './profile-input'
import { BOOK_QUOTE_TOOL, QUOTE_CARD_WHY_MAX, QUOTE_MESSAGE_MAX, SEND_QUOTE_TOOL, bookQuoteInput, hasLink, sendQuoteInput, withoutLinks } from './quote-reply-input'
import { bookingSetup, isSlotFree, localDate, localStartInstant, slotLabel } from './slots'
import { businessName, businessOwnerUserId, getBusinessProfile, getQuote, insertBooking, moveBooking, updateQuote } from './store'
import { QUOTE_ADDRESS_MAX, QUOTE_NAME_MAX, formatCents, quoteSummary, type CustomerQuote } from './types'

type Refusal = { success: false; code: string; error: string }
type Planned<T> = { ok: true; plan: T } | { ok: false; refusal: Refusal }
export type QuoteCard = { title: string; why: string }

const refuse = (code: string, error: string): { ok: false; refusal: Refusal } => ({ ok: false, refusal: { success: false, code, error } })

/** Seams for the tests. */
export interface QuoteReplyDeps {
  now?: () => number
  origin?: string
  /** Whether a number said STOP to the business (default: the SMS log). */
  optedOut?: (phone: string) => Promise<boolean>
  /** The text's send (default: Twilio, from the business's number). */
  send?: NonNullable<Parameters<typeof textBookingCustomer>[3]>['send']
  /** The email's send (default: the owner's connected mailbox). */
  sendEmail?: typeof sendEmail
  /** confirmBooking's seams; its calendar check and slot check are also the ones run before anything is held. */
  confirm?: ConfirmDeps
}

/** The words a card shows, as one hash: the replay sends only when its own card hashes the same. Pure. */
export function quoteReplyCardHash(card: QuoteCard): string {
  return createHash('sha256').update(`${card.title}\n${card.why}`).digest('hex').slice(0, 32)
}

/** The owner or an admin of the workspace: they answer its customers. Throws on a failed read. */
async function managerCheck(supabase: SupabaseClient, workspaceId: string, userId: string, verb: string): Promise<Refusal | null> {
  const { data, error } = await supabase.from('member').select('role').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle<{ role: string | null }>()
  if (error) throw new Error(`member read failed: ${error.message}`)
  if (!data) return { success: false, code: 'NOT_A_MEMBER', error: 'Not a workspace member.' }
  if (data.role !== 'owner' && data.role !== 'admin') return { success: false, code: 'NOT_ALLOWED', error: `Only the workspace owner or an admin ${verb}. Ask them.` }
  return null
}

/** The quote, still open to answer. Throws on a failed read. */
async function openQuote(supabase: SupabaseClient, workspaceId: string, quoteId: string, nothing: string): Promise<Planned<CustomerQuote>> {
  const quote = await getQuote(supabase, workspaceId, quoteId)
  if (!quote) return refuse('NOT_FOUND', `No quote with that id in this workspace. ${nothing}`)
  if (quote.status === 'booked') return refuse('ALREADY_BOOKED', `That quote is already booked (list_bookings shows it). ${nothing}`)
  if (quote.status === 'done' || quote.status === 'cancelled') return refuse('CLOSED', `That quote is ${quote.status}. ${nothing}`)
  return { ok: true, plan: quote }
}

/** At most `max` characters, an ellipsis marking a cut; '' for no room. Pure. */
export function clip(text: string, max: number): string {
  if (max <= 0) return ''
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** The customer's own words for a text or a card: one line, no links or web addresses, clipped. Null when nothing is left. Pure. */
function customerWords(value: string | null | undefined, max: number): string | null {
  const text = cleanText(value, 2000)
  if (!text) return null
  const kept = withoutLinks(text)
  return kept ? clip(kept, max) : null
}

/** What a quote is for, without its price: "2 items (8x10 ft, 5x7 ft), cleaning", or null. Pure. */
function quoteWhat(quote: Pick<CustomerQuote, 'items' | 'service' | 'currency'>): string | null {
  const what = quoteSummary({ items: quote.items, service: quote.service, totalCents: null, currency: quote.currency })
  return what === 'a quote request' ? null : customerWords(what, 100)
}

/** A number as a card shows it: "+1 312-555-0142" (a US or Canadian one), else as it is. Pure. */
export const shown = (to: string) => (/^\+1\d{10}$/.test(to) ? `+1 ${to.slice(2, 5)}-${to.slice(5, 8)}-${to.slice(8)}` : to)

/** One line of someone's words inside a card, quoted. Pure. */
const quoted = (text: string) => `“${text.replace(/\s+/g, ' ').trim()}”`

/** Below this, what a quote is for is left out of a card rather than cut to a stub. */
const WHAT_MIN = 12

/**
 * Shrink `words`' parts, in `order`, until `render(words)` fits
 * QUOTE_CARD_WHY_MAX: each part is cut by what overflows, to its floor (a
 * part whose floor is 0 is dropped once it would fall under WHAT_MIN). What
 * the card shows is what is sent, so the parts are cut in both. Pure.
 */
function fitCard<T extends object>(words: T, order: ReadonlyArray<{ key: keyof T; floor: number }>, render: (w: T) => string): T {
  const out = { ...words }
  // Again while it still overflows (a text's "…" is sent as "..."), a few times at most.
  for (let pass = 0; pass < 3 && render(out).length > QUOTE_CARD_WHY_MAX; pass++) {
    for (const { key, floor } of order) {
      const over = render(out).length - QUOTE_CARD_WHY_MAX
      if (over <= 0) break
      const current = out[key]
      if (typeof current !== 'string' || !current) continue
      const target = current.length - over
      if (floor === 0 && target < WHAT_MIN) out[key] = null as T[keyof T]
      else out[key] = clip(current, Math.max(floor, target)) as T[keyof T]
    }
  }
  return out
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── send_quote ──────────────────────────────────────────────────────────────

export interface QuoteWords {
  business: string
  /** The customer's first name, for an email's greeting. */
  firstName: string | null
  what: string | null
  price: string
  message: string | null
  bookingLink: string | null
}

/** The quote in one paragraph: the text's whole body, the email's after its greeting. Pure. */
export function quoteText(w: QuoteWords, via: 'text' | 'email' = 'text'): string {
  const reply = via === 'text' ? 'reply here' : 'reply to this email'
  // The link never ends the words, so nothing that follows it reads as part of it.
  const next = w.bookingLink ? `Pick a time at ${w.bookingLink} or ${reply}.` : `${reply.charAt(0).toUpperCase()}${reply.slice(1)} to pick a time.`
  return `${w.business}: here is your quote${w.what ? ` for ${w.what}` : ''}: ${w.price}.${w.message ? ` ${w.message}` : ''} ${next}`
}

/** The customer's email: a greeting and the same paragraph, its link shown as it is. Pure. */
export function quoteEmail(w: QuoteWords): { subject: string; greeting: string; text: string; html: string } {
  const greeting = w.firstName ? `Hi ${w.firstName},` : 'Hi,'
  const body = quoteText(w, 'email')
  const link = w.bookingLink
  const at = link ? body.lastIndexOf(link) : -1
  const html =
    `<p>${escapeHtml(greeting)}</p><p>` +
    (link && at >= 0 ? `${escapeHtml(body.slice(0, at))}<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>${escapeHtml(body.slice(at + link.length))}` : escapeHtml(body)) +
    '</p>'
  return { subject: `Your quote, ${w.price}`, greeting, text: `${greeting}\n\n${body}`, html }
}

export interface SendQuotePlan {
  quote: CustomerQuote
  priceCents: number
  /** The owner named a price that isn't the quote's yet: it becomes the quote's. */
  setsPrice: boolean
  /** The customer's name as the card's title shows it. */
  name: string
  delivery: { via: 'text'; to: string; from: string; body: string } | { via: 'email'; to: string; subject: string; greeting: string; text: string; html: string }
}

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/
/** The longest address a card's title can show in full (QUOTE_CARD_TITLE_MAX): a longer one is not emailed. */
const EMAIL_SHOWN_MAX = 120

/** The card's closing words for send_quote. Pure. */
function sendTail(setsPrice: boolean, price: string): string {
  return `Then the quote is marked sent${setsPrice ? ` at ${price}` : ''}. It runs once, exactly as shown, when you accept.`
}

type SendWay = { via: 'text'; to: string; from: string } | { via: 'email'; to: string }

/** What goes out one way, in these words: a text as the SMS formatter sends it (ASCII punctuation), so the card shows it to the letter. Pure. */
function deliveryFor(way: SendWay, w: QuoteWords, origin: string): SendQuotePlan['delivery'] {
  return way.via === 'text' ? { ...way, body: plainSmsText(quoteText(w), origin) } : { ...way, ...quoteEmail(w) }
}

/** The card's why: from whom, and the exact words. Pure. */
function sendWhy(d: SendQuotePlan['delivery'], setsPrice: boolean, price: string): string {
  const said = d.via === 'text' ? `From the business number ${shown(d.from)}: ${quoted(d.body)}` : `From your mailbox, subject ${quoted(d.subject)}: ${quoted(d.text)}`
  return `${said} ${sendTail(setsPrice, price)}`
}

/**
 * Everything send_quote would do, read now, or why it would send nothing.
 * Throws on a failed read.
 */
export async function planSendQuote(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string },
  input: unknown,
  deps: QuoteReplyDeps = {},
): Promise<Planned<SendQuotePlan>> {
  const parsed = sendQuoteInput.safeParse(input)
  if (!parsed.success) return refuse('BAD_INPUT', `${parsed.error.issues[0]?.message ?? 'Invalid input.'} Nothing was sent.`)
  if (hasLink(parsed.data.message)) {
    return refuse('MESSAGE_HAS_LINK', "message can't hold a link or a web address: the only link a quote carries is the business's own booking link. Say it without one. Nothing was sent.")
  }
  const denied = await managerCheck(supabase, args.workspaceId, args.userId, 'sends a customer their quote')
  if (denied) return { ok: false, refusal: denied }
  const open = await openQuote(supabase, args.workspaceId, parsed.data.quote_id, 'Nothing was sent.')
  if (!open.ok) return open
  const quote = open.plan

  let priceCents = quote.totalCents
  if (parsed.data.price !== undefined) {
    const cents = dollarsToCents(parsed.data.price)
    if (cents === null || cents <= 0) return refuse('BAD_PRICE', 'price must be dollars, like 600 or "612.50". Nothing was sent.')
    priceCents = cents
  }
  if (typeof priceCents !== 'number' || priceCents <= 0) {
    return refuse('NEEDS_PRICE', 'This quote has no price yet. Ask the owner for one, then call send_quote with it. Nothing was sent.')
  }
  const price = formatCents(priceCents, quote.currency) as string
  const setsPrice = priceCents !== quote.totalCents

  // By text from the business's own number when it can; else by email.
  const phone = quote.customerPhone
  let way: SendWay | null = null
  let textBlocked: string
  if (phone && isNanpNumber(phone)) {
    const number = await activeBusinessNumber(supabase, args.workspaceId)
    if (!number) textBlocked = 'the business has no texting number yet'
    else if (await (deps.optedOut ?? ((p) => unlinkedNumberOptedOut(supabase, p)))(phone)) textBlocked = 'their number said STOP'
    else {
      textBlocked = ''
      way = { via: 'text', to: phone, from: number.phone }
    }
  } else {
    textBlocked = phone ? 'their number is outside the US and Canada' : 'the quote has no phone number'
  }
  if (!way) {
    const email = quote.customerEmail?.trim().toLowerCase() ?? ''
    if (!EMAIL.test(email)) {
      return refuse('NO_WAY_TO_REACH', `Nothing was sent: ${textBlocked}, and the quote has no email. Tell the owner, who can reach the customer themselves.`)
    }
    if (email.length > EMAIL_SHOWN_MAX) {
      return refuse('NO_WAY_TO_REACH', `Nothing was sent: ${textBlocked}, and the quote's email is too long to show on the card. Tell the owner, who can reach the customer themselves.`)
    }
    way = { via: 'email', to: email }
  }

  const [business, profile] = await Promise.all([businessName(supabase, args.workspaceId), getBusinessProfile(supabase, args.workspaceId)])
  // The card shows every word that goes out, so the words are cut to fit it:
  // what the quote is for first, then the business's name, then the owner's line.
  const chosen = way
  const origin = deps.origin ?? appOrigin()
  const words = fitCard<QuoteWords>(
    {
      business: clip(business, 60),
      firstName: customerWords(quote.customerName?.split(/\s+/)[0], 20),
      what: quoteWhat(quote),
      price,
      message: cleanText(parsed.data.message, QUOTE_MESSAGE_MAX),
      bookingLink: profile?.bookingSlug ? bookingUrl(origin, profile.bookingSlug) : null,
    },
    [{ key: 'what', floor: 0 }, { key: 'business', floor: 40 }, { key: 'message', floor: 100 }],
    (w) => sendWhy(deliveryFor(chosen, w, origin), setsPrice, price),
  )
  const name = customerWords(quote.customerName, 40) ?? 'the customer'
  return { ok: true, plan: { quote, priceCents, setsPrice, name, delivery: deliveryFor(chosen, words, origin) } }
}

/** send_quote's card: who gets it (in the title), from whom, and the exact words. Pure. */
export function sendQuoteCard(plan: SendQuotePlan): QuoteCard {
  const price = formatCents(plan.priceCents, plan.quote.currency) as string
  const d = plan.delivery
  const why = sendWhy(d, plan.setsPrice, price)
  return d.via === 'text'
    ? { title: `Text ${plan.name} (${shown(d.to)}) their quote, ${price}?`, why }
    : { title: `Email ${plan.name} (${d.to}) their quote, ${price}?`, why }
}

/**
 * Whether this run is the owner's yes to exactly this card: the replay of
 * the tool's own approval, whose words hash the same. Else what the model reads.
 */
function notApproved(approved: ApprovedCall | undefined, tool: string, kind: QuoteReplyApprovalContext['kind'], quoteId: string, card: QuoteCard): Refusal | null {
  const nothing = kind === 'send' ? 'Nothing was sent' : 'Nothing was booked'
  if (approved?.tool !== tool) {
    return { success: false, code: 'APPROVAL_REQUIRED', error: `${nothing}. ${tool} only runs from the owner's own approval card, which shows exactly what the customer gets.` }
  }
  const pin = approved.quoteReply
  if (!pin || pin.kind !== kind || pin.quote_id !== quoteId || pin.card_hash !== quoteReplyCardHash(card)) {
    return {
      success: false,
      code: 'CARD_CHANGED',
      error: `${nothing}: what the customer would get is no longer what the card showed (the quote, the business's details or how to reach them changed since). Ask again for a fresh card.`,
    }
  }
  return null
}

/** Run one send_quote call (see the header). Never throws. */
export async function runSendQuote(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string; approvedCall?: ApprovedCall },
  input: unknown,
  deps: QuoteReplyDeps = {},
): Promise<Record<string, unknown>> {
  try {
    const planned = await planSendQuote(supabase, args, input, deps)
    if (!planned.ok) return planned.refusal
    const plan = planned.plan
    const held = notApproved(args.approvedCall, SEND_QUOTE_TOOL, 'send', plan.quote.id, sendQuoteCard(plan))
    if (held) return held

    // The price the owner named is the quote's, whatever the send does.
    if (plan.setsPrice) await updateQuote(supabase, args.workspaceId, plan.quote.id, { totalCents: plan.priceCents })
    const d = plan.delivery
    let problem: string | null = null
    if (d.via === 'text') {
      const sent = await textBookingCustomer(supabase, { workspaceId: args.workspaceId, customerPhone: d.to, guestId: null }, d.body, { send: deps.send })
      if (!sent) problem = 'the text could not be sent from the business number'
    } else {
      try {
        await (deps.sendEmail ?? sendEmail)(args.userId, args.workspaceId, { to: [d.to], subject: d.subject, body_html: d.html, body_text: d.text })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        problem = /no .*(account|mailbox|integration)|not connected|token/i.test(message) ? 'no mailbox is connected to send it from' : 'the email could not be sent'
      }
    }
    const price = formatCents(plan.priceCents, plan.quote.currency)
    if (problem) {
      return { success: false, code: 'NOT_SENT', error: `Nothing reached the customer: ${problem}.${plan.setsPrice ? ` The quote's price is now ${price}.` : ''} Tell the owner.` }
    }
    // A quote they already accepted stays accepted.
    if (plan.quote.status !== 'accepted') await updateQuote(supabase, args.workspaceId, plan.quote.id, { status: 'sent' })
    return {
      success: true,
      quote_id: plan.quote.id,
      price,
      sent_via: d.via,
      to: d.to,
      message: `Sent by ${d.via === 'text' ? 'text' : 'email'} to ${shown(d.to)}. The quote is marked sent; when they pick a time it comes back as a booking for the owner's yes.`,
    }
  } catch (err) {
    return { success: false, code: 'FAILED', error: `Nothing was sent: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// ── book_quote ──────────────────────────────────────────────────────────────

export interface BookQuotePlan {
  quote: CustomerQuote
  /** Whose calendar the booking goes on: the business's owner. */
  ownerUserId: string
  /** The person answering is that owner (their calendar), or an admin (the owner's). */
  ownCalendar: boolean
  kind: string
  startsAt: string
  endsAt: string
  minutes: number
  /** The start as the texts say it ("Wed, Nov 4, 9:30 AM"). */
  label: string
  /** The start as the card's title says it: with its year when that isn't this year. */
  cardLabel: string
  customerName: string
  phone: string | null
  /** The booking's address, as the card shows it and the booking keeps it. */
  address: string | null
  /** What the quote is for, as the card shows it (null: left out to fit). */
  what: string | null
  /** Whether the card says how long the job takes (left out only to fit). */
  showsMinutes: boolean
  /** The confirmation text confirmBooking sends, or why none goes. */
  confirmation: { to: string; from: string; body: string } | { skipped: string }
}

/**
 * Everything book_quote would do, read now, or why it would book nothing.
 * Throws on a failed read.
 */
export async function planBookQuote(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string },
  input: unknown,
  deps: QuoteReplyDeps = {},
): Promise<Planned<BookQuotePlan>> {
  const parsed = bookQuoteInput.safeParse(input)
  if (!parsed.success) return refuse('BAD_INPUT', `${parsed.error.issues[0]?.message ?? 'Invalid input.'} Nothing was booked.`)
  const denied = await managerCheck(supabase, args.workspaceId, args.userId, "books a customer's job")
  if (denied) return { ok: false, refusal: denied }
  const open = await openQuote(supabase, args.workspaceId, parsed.data.quote_id, 'Nothing was booked.')
  if (!open.ok) return open
  const quote = open.plan

  const ownerUserId = (await getBusinessProfile(supabase, args.workspaceId))?.ownerUserId ?? (await businessOwnerUserId(supabase, args.workspaceId))
  if (!ownerUserId) return refuse('NO_OWNER', 'The business has no owner whose calendar a booking could go on. Nothing was booked.')
  const setup = await bookingSetup(supabase, { workspaceId: args.workspaceId, ownerUserId })
  const at = localStartInstant(parsed.data.start, setup.timeZone)
  if (at === null) return refuse('BAD_START', `${parsed.data.start} is not a time that exists in ${setup.timeZone}. Nothing was booked.`)
  if (at <= (deps.now ?? Date.now)()) return refuse('PAST', 'That time has already passed. Nothing was booked.')
  const minutes = parsed.data.minutes ?? setup.rules.slotMinutes
  const startsAt = new Date(at).toISOString()
  const endsAt = new Date(at + minutes * 60_000).toISOString()
  const label = slotLabel(startsAt, setup.timeZone)
  const now = (deps.now ?? Date.now)()
  const cardLabel = localDate(at, setup.timeZone).y === localDate(now, setup.timeZone).y ? label : yearLabel(startsAt, setup.timeZone)
  const kind = setup.rules.bookingKind

  // Whether confirmBooking's text will go (textBookingCustomer's own checks), so the card can say.
  const phone = quote.customerPhone
  let sender: { to: string; from: string; business: string } | { skipped: string }
  if (!phone) sender = { skipped: 'the quote has no phone number' }
  else if (!isNanpNumber(phone)) sender = { skipped: 'their number is outside the US and Canada' }
  else {
    const number = await activeBusinessNumber(supabase, args.workspaceId)
    if (!number) sender = { skipped: 'the business has no texting number yet' }
    else if (await (deps.optedOut ?? ((p) => unlinkedNumberOptedOut(supabase, p)))(phone)) sender = { skipped: 'their number said STOP' }
    else sender = { to: phone, from: number.phone, business: await businessName(supabase, args.workspaceId) }
  }
  // As textBookingCustomer sends it (the SMS formatter's ASCII punctuation), so the card shows it to the letter.
  const confirmationFor = (address: string | null): BookQuotePlan['confirmation'] =>
    'skipped' in sender ? sender : { to: sender.to, from: sender.from, body: plainSmsText(bookingConfirmedText(sender.business, { kind, address }, label), deps.origin ?? appOrigin()) }

  const base: BookQuotePlan = {
    quote,
    ownerUserId,
    ownCalendar: ownerUserId === args.userId,
    kind,
    startsAt,
    endsAt,
    minutes,
    label,
    cardLabel,
    customerName: customerWords(quote.customerName, QUOTE_NAME_MAX) ?? 'Customer',
    phone,
    address: customerWords(quote.address, QUOTE_ADDRESS_MAX),
    what: quoteWhat(quote),
    showsMinutes: true,
    confirmation: confirmationFor(null),
  }
  // The card shows every word that goes out (the confirmation text names the
  // address), so the words are cut to fit it: what the quote is for first,
  // then the job's length, then the address (which the booking keeps as shown).
  const fitted = fitCard<{ what: string | null; minutes: string | null; address: string | null }>(
    { what: base.what, minutes: `${minutes} min`, address: base.address },
    [{ key: 'what', floor: 0 }, { key: 'minutes', floor: 0 }, { key: 'address', floor: 40 }],
    (w) => bookQuoteCard({ ...base, what: w.what, showsMinutes: !!w.minutes, address: w.address, confirmation: confirmationFor(w.address) }).why,
  )
  return { ok: true, plan: { ...base, what: fitted.what, showsMinutes: !!fitted.minutes, address: fitted.address, confirmation: confirmationFor(fitted.address) } }
}

/** A start with its year: "Wed, Nov 4, 2027, 9:30 AM". Pure. */
function yearLabel(startIso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(startIso))
  } catch {
    return startIso
  }
}

/** book_quote's card: who and when (in the title), what, and the exact text they get. Pure. */
export function bookQuoteCard(plan: BookQuotePlan): QuoteCard {
  const calendar = plan.ownCalendar ? 'your calendar' : "the owner's calendar"
  const head = plan.showsMinutes ? `${plan.minutes} min${plan.what ? ` for ${plan.what}` : ''}. ` : plan.what ? `For ${plan.what}. ` : ''
  const tail = 'It runs once, exactly as shown, when you accept.'
  const c = plan.confirmation
  if ('skipped' in c) {
    const kind = `${plan.kind.charAt(0).toUpperCase()}${plan.kind.slice(1)}`
    return {
      title: `Book ${clip(plan.customerName, 40)} for ${plan.cardLabel}?`,
      why: `${head}${kind}${plan.address ? ` at ${plan.address}` : ''}. Yes puts it on ${calendar} and marks the quote booked. No confirmation text goes (${c.skipped}): tell them yourself. ${tail}`,
    }
  }
  return {
    title: `Book ${clip(plan.customerName, 40)} (${shown(c.to)}) for ${plan.cardLabel}?`,
    why: `${head}Yes puts it on ${calendar} and marks the quote booked; they get, from the business number ${shown(c.from)}: ${quoted(c.body)} ${tail}`,
  }
}

/** Run one book_quote call (see the header). Never throws. */
export async function runBookQuote(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string; approvedCall?: ApprovedCall },
  input: unknown,
  deps: QuoteReplyDeps = {},
): Promise<Record<string, unknown>> {
  try {
    const planned = await planBookQuote(supabase, args, input, deps)
    if (!planned.ok) return planned.refusal
    const plan = planned.plan
    const held = notApproved(args.approvedCall, BOOK_QUOTE_TOOL, 'book', plan.quote.id, bookQuoteCard(plan))
    if (held) return held

    // Nothing is held, and nobody is texted, for a booking that can't go on a
    // calendar or whose time is taken: confirmBooking would release it and
    // text the customer "we can't", for what is only the owner's to fix.
    const business = { workspaceId: args.workspaceId, ownerUserId: plan.ownerUserId }
    const hasCalendar = deps.confirm?.hasCalendar ?? (async (userId: string) => ['google', 'microsoft'].includes((await getCalendarProvider(userId)) ?? ''))
    if (!(await hasCalendar(plan.ownerUserId).catch(() => false))) {
      return { success: false, code: 'NO_CALENDAR', error: 'No Google or Outlook calendar is connected, so nothing was booked and the customer was not told. Connect one in Settings, then ask again.' }
    }
    let free: boolean
    try {
      free = await (deps.confirm?.isSlotFree ?? isSlotFree)(supabase, business, { start: plan.startsAt, end: plan.endsAt })
    } catch {
      return { success: false, code: 'CALENDAR_UNAVAILABLE', error: "The calendar couldn't be read just now, so nothing was booked and the customer was not told. Try again in a little while." }
    }
    if (!free) {
      return { success: false, code: 'SLOT_TAKEN', error: `Something is already on the calendar at ${plan.label} (or another booking), so nothing was booked and the customer was not told. Pick another time (find_booking_slots).` }
    }
    const inserted = await insertBooking(supabase, {
      workspaceId: args.workspaceId,
      ownerUserId: plan.ownerUserId,
      quoteId: plan.quote.id,
      contactId: plan.quote.contactId,
      guestId: null,
      source: 'owner',
      kind: plan.kind,
      startsAt: plan.startsAt,
      endsAt: plan.endsAt,
      customerName: plan.customerName,
      customerPhone: plan.phone,
      address: plan.address,
      note: null,
    })
    if (!inserted.ok) {
      return inserted.reason === 'taken'
        ? { success: false, code: 'SLOT_TAKEN', error: `Another booking just took ${plan.label}, so nothing was booked and the customer was not told. Pick another time.` }
        : { success: false, code: 'FAILED', error: `The booking could not be saved (${inserted.error ?? 'unknown'}). Nothing was booked.` }
    }
    // The yes the card was: the booking's owner confirms it (confirmBooking
    // checks the booking is theirs; the person answering may be an admin).
    let result: Record<string, unknown>
    try {
      result = await confirmBooking(supabase, { userId: plan.ownerUserId, workspaceId: args.workspaceId, bookingId: inserted.booking.id }, deps.confirm)
    } catch (err) {
      result = { success: false, code: 'FAILED', error: `Nothing was booked: ${err instanceof Error ? err.message : String(err)}` }
    }
    // A yes that didn't book never leaves its hold behind: this booking has no
    // approval to lapse, and a live one would block its start for good. No
    // text: the card never promised one for this.
    if (result.success !== true) await releaseOwnerBooking(supabase, args.workspaceId, inserted.booking.id)
    return { ...result, quote_id: plan.quote.id }
  } catch (err) {
    return { success: false, code: 'FAILED', error: `Nothing was booked: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** An owner booking still requested after a yes that didn't book: cancelled, quietly. Never throws. */
async function releaseOwnerBooking(supabase: SupabaseClient, workspaceId: string, bookingId: string): Promise<void> {
  try {
    await moveBooking(supabase, { workspaceId, bookingId, from: 'requested', to: 'cancelled' })
  } catch (err) {
    console.warn('[quote-reply] an unbooked hold could not be released:', err instanceof Error ? err.message : String(err))
  }
}

// ── The outward gate's card ─────────────────────────────────────────────────

/**
 * The card and its check for a send_quote or book_quote call, or null when
 * the call would be refused anyway (not an owner or admin, no such quote, no
 * price, no way to reach the customer, a time that doesn't exist): nothing is
 * held, and the tool says why. Throws on a failed read.
 */
export async function quoteReplyHold(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; toolName: string; input: unknown },
  deps: QuoteReplyDeps = {},
): Promise<{ card: QuoteCard; context: { quoteReply: QuoteReplyApprovalContext } } | null> {
  const scope = { workspaceId: args.workspaceId, userId: args.userId }
  if (args.toolName === SEND_QUOTE_TOOL) {
    const planned = await planSendQuote(supabase, scope, args.input, deps)
    if (!planned.ok) return null
    const card = sendQuoteCard(planned.plan)
    return { card, context: { quoteReply: { kind: 'send', quote_id: planned.plan.quote.id, card_hash: quoteReplyCardHash(card) } } }
  }
  if (args.toolName === BOOK_QUOTE_TOOL) {
    const planned = await planBookQuote(supabase, scope, args.input, deps)
    if (!planned.ok) return null
    const card = bookQuoteCard(planned.plan)
    return { card, context: { quoteReply: { kind: 'book', quote_id: planned.plan.quote.id, card_hash: quoteReplyCardHash(card) } } }
  }
  return null
}
