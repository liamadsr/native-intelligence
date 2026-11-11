/**
 * offer_times (availability phase 3a): the link, or an email or text that
 * carries it, modelled on send_quote (src/lib/customers/quote-reply.ts).
 *
 *   send_by 'link'   the offer is made (its times held) and its link comes
 *                    back with ready-to-paste text. Nothing is sent, so no
 *                    card.
 *   send_by 'email'  from the person's own mailbox, or
 *   send_by 'text'   from the workspace's business number (refused, saying
 *                    so, when it has none): ONLY as the replay of the
 *                    person's approval card, which shows the exact recipient
 *                    and the exact words. The outward gate holds every such
 *                    call (timeOfferHold): its card is planned from the call;
 *                    only once a card will really be raised (the person, in
 *                    the app or by text, or a home turn) does it make the
 *                    offer, state 'pending_send', its times held while the
 *                    card waits; the card's words' hash and the offer ride on
 *                    the approval (TimeOfferApprovalContext). The replay
 *                    builds the card again from that offer as it is then and
 *                    sends nothing when its words differ, or when a time is
 *                    no longer free; else it mints the link's token, opens
 *                    the offer and sends. A card declined or lapsed lets the
 *                    times go (settleTimeOfferApproval).
 *
 * The card shows every word that goes out but the link's token (minted only
 * when sent, never stored), shown as the link's address with "…".
 *
 * A poll (several guests, or co-hosts: ./polls.ts) and its reminders
 * (nudge_time_offer) go out the same three ways (./poll-send.ts): one card
 * for every guest, the same words to each but their own link.
 *
 * Server only; service role. Never throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendEmail } from '@/lib/crm/email-client'
import { checkSpansFree } from '@/lib/availability/slot-check'
import { activeBusinessNumber } from '@/lib/customers/numbers'
import { textBookingCustomer } from '@/lib/customers/booking'
import type { ApprovedCall, TimeOfferApprovalContext } from '@/lib/safety/approved-call'
import { unlinkedNumberOptedOut } from '@/lib/sms/store'
import { appOrigin } from '@/lib/twilio/config'
import { isNanpNumber } from '@/lib/twilio/phone'
import { plainSmsText } from '@/lib/twilio/sms-format'
import { offerTimesInput, type OfferTimesInput } from './input'
import { closeOffer, createOffer, planOffer, type OfferDeps, type OfferRefusal, type PlannedOffer } from './offers'
import { isPollRequest, type PollDeps } from './polls'
import { getOffer, moveOffer, setOfferApproval } from './store'
import { mintOfferToken, offerTokenHash, offerUrl, offerUrlShown } from './tokens'
import { NUDGE_TIME_OFFER_TOOL, OFFER_TIMES_TOOL, type TimeOffer } from './types'
import { emailWords, fitOfferWords, offerCard, offerCardHash, pasteText, slotLabel, smsText, zoneLabel, type OfferDelivery, type OfferWords } from './words'

type Refusal = { success: false; code: string; error: string }
const refusal = (r: OfferRefusal | { code: string; message: string }): Refusal => ({ success: false, code: r.code, error: r.message })

export interface SendDeps extends OfferDeps, PollDeps {
  origin?: string
  optedOut?: (phone: string) => Promise<boolean>
  businessNumber?: (workspaceId: string) => Promise<{ phone: string } | null>
  sendEmail?: typeof sendEmail
  sendText?: (args: { workspaceId: string; to: string; body: string }) => Promise<boolean>
}

/** What a card or a paste is made of: an offer's words, from a plan or a stored offer. */
export interface WordsSource {
  hostName: string
  recipientName: string
  title: string
  durationMinutes: number
  video: boolean
  location: string | null
  message: string | null
  timeZone: string
  starts: string[]
  expiresAt: string
}

const firstName = (name: string) => name.split(/\s+/)[0]?.slice(0, 40) || null

export function baseWords(s: WordsSource): OfferWords {
  return { hostName: s.hostName, recipientFirstName: firstName(s.recipientName), title: s.title, durationMinutes: s.durationMinutes, video: s.video, location: s.location, message: s.message, timeZone: s.timeZone, starts: s.starts }
}

export function sourceOfPlan(plan: PlannedOffer): WordsSource {
  return { hostName: plan.hostName, recipientName: plan.recipient.name, title: plan.title, durationMinutes: plan.durationMinutes, video: plan.video, location: plan.location, message: plan.message, timeZone: plan.timeZone, starts: plan.slots.map((s) => s.startsAt), expiresAt: plan.expiresAt }
}

export function sourceOfOffer(offer: TimeOffer): WordsSource {
  return { hostName: offer.hostName, recipientName: offer.recipientName, title: offer.title, durationMinutes: offer.durationMinutes, video: offer.video, location: offer.location, message: offer.message, timeZone: offer.timeZone, starts: offer.slots.map((s) => s.startsAt), expiresAt: offer.expiresAt }
}

/** The card and the words it shows (fitted to the card), for one way of sending. */
function cardFor(source: WordsSource, delivery: OfferDelivery, origin: string): { words: OfferWords; card: { title: string; why: string } } {
  const plain = (t: string) => plainSmsText(t, origin)
  const shown = offerUrlShown(origin)
  const words = fitOfferWords(baseWords(source), (w) => offerCard(w, delivery, source.recipientName, source.expiresAt, shown, plain).why)
  return { words, card: offerCard(words, delivery, source.recipientName, source.expiresAt, shown, plain) }
}

/** How the offer would go out, read now, or why it can't. Throws on a failed read. */
async function deliveryOf(
  supabase: SupabaseClient,
  workspaceId: string,
  sendBy: 'email' | 'text',
  recipient: { email: string | null; phone: string | null },
  deps: SendDeps,
): Promise<{ ok: true; delivery: OfferDelivery } | { ok: false; code: string; message: string }> {
  if (sendBy === 'email') {
    if (!recipient.email) return { ok: false, code: 'NEEDS_EMAIL', message: "send_by 'email' needs the recipient's email." }
    return { ok: true, delivery: { via: 'email', to: recipient.email } }
  }
  if (!recipient.phone) return { ok: false, code: 'NEEDS_PHONE', message: "send_by 'text' needs the recipient's mobile number." }
  if (!isNanpNumber(recipient.phone)) return { ok: false, code: 'NOT_TEXTABLE', message: "Their number is outside the US and Canada, so it can't be texted. Use send_by 'email' or 'link'." }
  const number = await (deps.businessNumber ?? ((ws) => activeBusinessNumber(supabase, ws)))(workspaceId)
  if (!number) {
    return { ok: false, code: 'NO_BUSINESS_NUMBER', message: "This workspace has no texting number, so nothing can be texted from it. Offer with send_by 'link' (you paste the link yourself) or 'email' (from your mailbox) instead." }
  }
  if (await (deps.optedOut ?? ((p) => unlinkedNumberOptedOut(supabase, p)))(recipient.phone)) {
    return { ok: false, code: 'OPTED_OUT', message: "Their number said STOP to texts from this business. Use send_by 'email' or 'link'." }
  }
  return { ok: true, delivery: { via: 'text', to: recipient.phone, from: number.phone } }
}

/**
 * Who the call names: one `recipient` (a pick), or `recipients` (a poll; one
 * of them with no co-hosts is a pick too). Pure.
 */
export function guestsOf(input: OfferTimesInput): { ok: true; recipient: NonNullable<OfferTimesInput['recipient']>; recipients: null } | { ok: true; recipient: null; recipients: NonNullable<OfferTimesInput['recipients']> } | { ok: false; error: string } {
  if (input.recipient && input.recipients?.length) return { ok: false, error: 'Give recipient (one person) or recipients (several), not both.' }
  if (input.recipient) return input.co_hosts?.length ? { ok: true, recipient: null, recipients: [input.recipient] } : { ok: true, recipient: input.recipient, recipients: null }
  if (!input.recipients?.length) return { ok: false, error: 'Who are the times for? Give recipient (one person) or recipients (several).' }
  if (input.recipients.length === 1 && !input.co_hosts?.length) return { ok: true, recipient: input.recipients[0], recipients: null }
  return { ok: true, recipient: null, recipients: input.recipients }
}

export function requestOf(args: { workspaceId: string; userId: string; browserTimeZone?: string | null; omitGrants?: boolean }, input: OfferTimesInput) {
  const guests = guestsOf(input)
  const one = guests.ok && guests.recipient ? guests.recipient : (input.recipient ?? input.recipients?.[0] ?? { name: '' })
  return {
    workspaceId: args.workspaceId,
    hostUserId: args.userId,
    recipient: { name: one.name, email: one.email ?? null, phone: one.phone ?? null },
    ...(guests.ok && guests.recipients ? { recipients: guests.recipients, coHosts: input.co_hosts ?? [] } : {}),
    omitGrants: args.omitGrants === true,
    title: input.title,
    slots: input.slots,
    durationMinutes: input.duration_minutes,
    video: input.video,
    location: input.location ?? null,
    message: input.message ?? null,
    expiresAt: input.expires_at ?? null,
    sendBy: input.send_by ?? 'link',
    browserTimeZone: args.browserTimeZone ?? null,
  } as const
}

// ── The outward gate's card ─────────────────────────────────────────────────

export interface TimeOfferHold {
  card: { title: string; why: string }
  context: { timeOffer: Partial<TimeOfferApprovalContext> & Pick<TimeOfferApprovalContext, 'card_hash'> }
  /** Make the offer for the card (its times held): only once a card will be raised. A reminder makes nothing: its context as it is. */
  prepare: () => Promise<{ ok: true; context: { timeOffer: TimeOfferApprovalContext } } | { ok: false; message: string }>
  /** The card was raised: its approval is recorded on the offer. */
  held: (context: { timeOffer?: TimeOfferApprovalContext }, approvalId: string) => Promise<void>
  /** No card came of it: the offer and its holds go. */
  abandon: (context: { timeOffer?: TimeOfferApprovalContext }) => Promise<void>
}

/**
 * The card for an offer_times call that sends (email or text), or null when
 * the call would be refused anyway (a bad input, no way to send): nothing is
 * held, and the tool says why. Throws on a failed read.
 */
export async function timeOfferHold(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; input: unknown; browserTimeZone?: string | null; toolName?: string },
  deps: SendDeps = {},
): Promise<TimeOfferHold | null> {
  if (args.toolName === NUDGE_TIME_OFFER_TOOL) {
    const { nudgeHold } = await import('./poll-send')
    return nudgeHold(supabase, args, deps)
  }
  const parsed = offerTimesInput.safeParse(args.input)
  if (!parsed.success) return null
  const sendBy = parsed.data.send_by ?? 'link'
  if (sendBy === 'link') return null
  const request = requestOf(args, parsed.data)
  if (isPollRequest(request)) {
    const { pollHold } = await import('./poll-send')
    return pollHold(supabase, args, request, deps)
  }
  if (!guestsOf(parsed.data).ok) return null
  const planned = await planOffer(supabase, request, deps)
  if (!planned.ok) return null
  const plan = planned.plan
  const way = await deliveryOf(supabase, args.workspaceId, sendBy, plan.recipient, deps)
  if (!way.ok) return null
  const origin = deps.origin ?? appOrigin()
  const { card } = cardFor(sourceOfPlan(plan), way.delivery, origin)
  const cardHash = offerCardHash(card)
  return {
    card,
    context: { timeOffer: { card_hash: cardHash } },
    prepare: async () => {
      const made = await createOffer(supabase, plan, { state: 'pending_send', createdBy: args.userId, cardHash }, deps)
      if (!made.ok) return { ok: false, message: `Nothing was sent or held: ${made.message}` }
      return { ok: true, context: { timeOffer: { offer_id: made.offer.id, card_hash: cardHash } } }
    },
    held: async (context, approvalId) => {
      if (context.timeOffer?.offer_id) await setOfferApproval(supabase, context.timeOffer.offer_id, approvalId).catch(() => {})
    },
    abandon: async (context) => {
      if (context.timeOffer?.offer_id) await closeOffer(supabase, context.timeOffer.offer_id, ['pending_send'], 'withdrawn').catch(() => null)
    },
  }
}

/** A card declined or lapsed: its offer's times go (best effort, never throws). */
export async function settleTimeOfferApproval(supabase: SupabaseClient, row: { context?: { timeOffer?: Partial<TimeOfferApprovalContext> } | null }, outcome: 'denied' | 'expired'): Promise<void> {
  const offerId = row.context?.timeOffer?.offer_id
  if (typeof offerId !== 'string') return
  try {
    await closeOffer(supabase, offerId, ['pending_send'], outcome === 'denied' ? 'declined' : 'expired')
  } catch (err) {
    console.warn('[time-offers] a declined offer could not be closed:', err instanceof Error ? err.message : String(err))
  }
}

// ── The tool ────────────────────────────────────────────────────────────────

/** What offer_times answers about an offer: who and what, the link, its times in the host's zone, and the paste text when it went by link. */
function offerResult(offer: TimeOffer, link: string, sentVia: 'link' | 'email' | 'text', to: string | null): Record<string, unknown> {
  const words = baseWords(sourceOfOffer(offer))
  const zone = zoneLabel(offer.timeZone, Date.parse(offer.slots[0]?.startsAt ?? offer.expiresAt))
  return {
    success: true,
    offer_id: offer.id,
    recipient_name: offer.recipientName,
    title: offer.title,
    duration_minutes: offer.durationMinutes,
    link,
    sent_via: sentVia,
    ...(to ? { to } : {}),
    time_zone: offer.timeZone,
    times: offer.slots.map((s) => ({ start: s.startsAt, label: `${slotLabel(s.startsAt, offer.timeZone)} ${zone}` })),
    expires: `${slotLabel(offer.expiresAt, offer.timeZone)} ${zone}`,
    ...(sentVia === 'link' ? { paste_text: pasteText(words, link) } : {}),
    message:
      sentVia === 'link'
        ? `The times are held for ${offer.recipientName} until they pick one or the offer expires. Nothing was sent: give the person the link and paste_text to send themselves. When ${offer.recipientName} picks, it is booked and they get the calendar invitation.`
        : `Sent by ${sentVia} to ${to}. The times are held until ${offer.recipientName} picks one (it is then booked and they get the calendar invitation) or the offer expires.`,
  }
}

/** Run one offer_times call (see the header). Never throws. */
export async function runOfferTimes(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string; approvedCall?: ApprovedCall; browserTimeZone?: string | null; omitGrants?: boolean },
  input: unknown,
  deps: SendDeps = {},
): Promise<Record<string, unknown>> {
  const origin = deps.origin ?? appOrigin()
  try {
    const parsed = offerTimesInput.safeParse(input)
    if (!parsed.success) return { success: false, code: 'BAD_INPUT', error: parsed.error.issues[0]?.message ?? 'Invalid input.' }
    const sendBy = parsed.data.send_by ?? 'link'
    const guests = guestsOf(parsed.data)
    if (!guests.ok) return { success: false, code: 'BAD_INPUT', error: guests.error }
    if (guests.recipients) {
      const { runPollTimes } = await import('./poll-send')
      return runPollTimes(supabase, args, parsed.data, deps)
    }

    if (sendBy === 'link') {
      const planned = await planOffer(supabase, requestOf(args, parsed.data), deps)
      if (!planned.ok) return refusal(planned)
      const made = await createOffer(supabase, planned.plan, { state: 'open', createdBy: args.userId }, deps)
      if (!made.ok) return refusal(made)
      return offerResult(made.offer, offerUrl(origin, made.token as string), 'link', null)
    }

    // Email or text: only the replay of the person's own card.
    const pin = args.approvedCall?.tool === OFFER_TIMES_TOOL ? args.approvedCall.timeOffer : undefined
    if (!pin) {
      const planned = await planOffer(supabase, requestOf(args, parsed.data), deps)
      if (!planned.ok) return refusal(planned)
      const way = await deliveryOf(supabase, args.workspaceId, sendBy, planned.plan.recipient, deps)
      if (!way.ok) return refusal(way)
      return { success: false, code: 'APPROVAL_REQUIRED', error: "Nothing was sent. offer_times by email or text only runs from the person's own approval card, which shows exactly what goes to whom." }
    }

    const offer = await getOffer(supabase, pin.offer_id, args.workspaceId)
    if (!offer || offer.hostUserId !== args.userId) return { success: false, code: 'NOT_FOUND', error: 'Nothing was sent: the offer this card was for is gone.' }
    if (offer.state !== 'pending_send') return { success: false, code: 'CLOSED', error: `Nothing was sent: the offer is ${offer.state === 'open' || offer.state === 'booked' ? 'already sent' : offer.state}.` }
    const way = await deliveryOf(supabase, args.workspaceId, sendBy, { email: offer.recipientEmail, phone: offer.recipientPhone }, deps)
    if (!way.ok) {
      await closeOffer(supabase, offer.id, ['pending_send'], 'withdrawn')
      return refusal({ code: way.code, message: `Nothing was sent: ${way.message}` })
    }
    const { words, card } = cardFor(sourceOfOffer(offer), way.delivery, origin)
    if (offerCardHash(card) !== pin.card_hash) {
      await closeOffer(supabase, offer.id, ['pending_send'], 'withdrawn')
      return { success: false, code: 'CARD_CHANGED', error: 'Nothing was sent: what they would get is no longer what the card showed (how to reach them changed since). The times were let go. Ask again for a fresh card.' }
    }
    // The times are held, but the person's own calendar may have filled since the card was made.
    const free = await (deps.checkFree ?? checkSpansFree)({
      userId: offer.hostUserId,
      workspaceId: offer.workspaceId,
      timeZone: offer.timeZone,
      spans: offer.slots.map((s) => ({ start: Date.parse(s.startsAt), end: Date.parse(s.endsAt) })),
      exceptClaims: { offerId: offer.id },
    })
    if (!free.known || free.busy.some(Boolean)) {
      await closeOffer(supabase, offer.id, ['pending_send'], 'withdrawn')
      return {
        success: false,
        code: free.known ? 'SLOT_TAKEN' : 'CALENDAR_UNKNOWN',
        error: free.known
          ? 'Nothing was sent: one of the times is no longer free on your calendar. The times were let go: find new ones with find_times and offer again.'
          : `Nothing was sent: your calendar couldn't be read (${free.reason}). The times were let go: offer again in a moment.`,
      }
    }

    const token = mintOfferToken()
    const opened = await moveOffer(supabase, offer.id, ['pending_send'], 'open', { token_hash: offerTokenHash(token), sent_via: way.delivery.via })
    if (!opened) return { success: false, code: 'CLOSED', error: 'Nothing was sent: the offer changed just now.' }
    const link = offerUrl(origin, token)
    let problem: string | null = null
    if (way.delivery.via === 'email') {
      const e = emailWords(words, link)
      try {
        await (deps.sendEmail ?? sendEmail)(args.userId, args.workspaceId, { to: [way.delivery.to], subject: e.subject, body_html: e.html, body_text: e.text })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        problem = /no .*(account|mailbox|integration)|not connected|token/i.test(message) ? 'no mailbox is connected to send it from' : 'the email could not be sent'
      }
    } else {
      const body = plainSmsText(smsText(words, link), origin)
      const to = way.delivery.to
      const sent = await (deps.sendText ?? ((a) => textBookingCustomer(supabase, { workspaceId: a.workspaceId, customerPhone: a.to, guestId: null }, a.body)))({ workspaceId: args.workspaceId, to, body })
      if (!sent) problem = 'the text could not be sent from the business number'
    }
    if (problem) {
      await closeOffer(supabase, offer.id, ['open'], 'withdrawn')
      return { success: false, code: 'NOT_SENT', error: `Nothing reached ${offer.recipientName}: ${problem}. The times were let go. Tell the person.` }
    }
    return offerResult(opened, link, way.delivery.via, way.delivery.to)
  } catch (err) {
    return { success: false, code: 'FAILED', error: `Nothing was sent: ${err instanceof Error ? err.message : String(err)}` }
  }
}
