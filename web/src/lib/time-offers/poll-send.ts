/**
 * A poll's offer_times and its reminders, nudge_time_offer (availability
 * phase 5, ./polls.ts), sent as a single offer is (./send.ts):
 *
 *   send_by 'link'   the poll is made (every host's times held) and each
 *                    guest's own link comes back with ready-to-paste text;
 *                    nothing is sent, so no card. A reminder by link gives
 *                    each guest still to answer their link and a reminder.
 *   send_by 'email'  from the person's own mailbox, one email per guest, or
 *   send_by 'text'   from the business's number, one text per guest: ONLY
 *                    as the replay of the person's approval card, which
 *                    shows every guest with their address and the exact
 *                    words (the same for each but their own link, shown as
 *                    the link's address with "…"), pinned by hash. A poll's
 *                    card makes the poll (pending_send, its times held) only
 *                    once it is really raised; the replay builds the card
 *                    again from the poll as it is and sends nothing when the
 *                    words differ or a time is no longer free on a host's
 *                    calendar. A reminder's card names the guests it goes to
 *                    then: one who answered since changes the card, and
 *                    nothing is sent.
 *
 * A card that can't show every guest and every word (OFFER_CARD_WHY_MAX) is
 * refused: by link instead, or fewer people.
 *
 * Linked guests are answered from their calendar once the poll is out
 * (./polls.ts autoAnswerLinked): they are still told of it.
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
import { nudgeTimeOfferInput, type OfferTimesInput } from './input'
import { closeOffer, type OfferRequest } from './offers'
import { autoAnswerLinked, createPoll, nudgeTargets, openRecipientLinks, planPoll, recipientLink } from './polls'
import { getPoll, markNudged } from './poll-store'
import { baseWords, requestOf, sourceOfOffer, sourceOfPlan, type SendDeps, type TimeOfferHold, type WordsSource } from './send'
import { moveOffer, offerHosts, setOfferApproval } from './store'
import { offerUrlShown } from './tokens'
import { NUDGE_TIME_OFFER_TOOL, OFFER_TIMES_TOOL, type PollRecipient, type TimeOfferPoll } from './types'
import {
  OFFER_CARD_WHY_MAX,
  POLL_CARD_TITLE_MAX,
  fitOfferWords,
  nudgeEmailWords,
  nudgePasteText,
  nudgeSmsText,
  offerCardHash,
  pollCard,
  pollEmailWords,
  pollPasteText,
  pollSmsText,
  slotLabel,
  zoneLabel,
  type OfferWords,
  type PollDelivery,
} from './words'

type Refusal = { success: false; code: string; error: string }
const refusal = (code: string, error: string): Refusal => ({ success: false, code, error })

/** A poll's words: no first-name greeting, the same for every guest. */
const pollWords = (source: WordsSource): OfferWords => ({ ...baseWords(source), recipientFirstName: null })

const TOO_LONG =
  "That's too many people or words for one approval card to show exactly. Offer by send_by 'link' (you paste each guest their own link), or to fewer people at a time."

/** How a poll (or a reminder) would go to these guests, read now, or why it can't. Throws on a failed read. */
async function pollDeliveryOf(
  supabase: SupabaseClient,
  workspaceId: string,
  sendBy: 'email' | 'text',
  guests: ReadonlyArray<{ name: string; email: string | null; phone: string | null }>,
  deps: SendDeps,
): Promise<{ ok: true; delivery: PollDelivery } | { ok: false; code: string; message: string }> {
  if (!guests.length) return { ok: false, code: 'NOBODY', message: 'Nobody to send to.' }
  if (sendBy === 'email') {
    const missing = guests.filter((g) => !g.email)
    if (missing.length) return { ok: false, code: 'NEEDS_EMAIL', message: `send_by 'email' needs every guest's email: ${missing.map((g) => g.name).join(', ')} ${missing.length === 1 ? 'has' : 'have'} none.` }
    return { ok: true, delivery: { via: 'email', to: guests.map((g) => ({ name: g.name, address: g.email as string })) } }
  }
  const missing = guests.filter((g) => !g.phone)
  if (missing.length) return { ok: false, code: 'NEEDS_PHONE', message: `send_by 'text' needs every guest's mobile number: ${missing.map((g) => g.name).join(', ')} ${missing.length === 1 ? 'has' : 'have'} none.` }
  const abroad = guests.filter((g) => !isNanpNumber(g.phone as string))
  if (abroad.length) return { ok: false, code: 'NOT_TEXTABLE', message: `${abroad.map((g) => g.name).join(', ')}: outside the US and Canada, so not textable. Use send_by 'email' or 'link'.` }
  const number = await (deps.businessNumber ?? ((ws) => activeBusinessNumber(supabase, ws)))(workspaceId)
  if (!number) {
    return { ok: false, code: 'NO_BUSINESS_NUMBER', message: "This workspace has no texting number, so nothing can be texted from it. Use send_by 'link' (you paste each link yourself) or 'email' (from your mailbox) instead." }
  }
  for (const g of guests) {
    if (await (deps.optedOut ?? ((p) => unlinkedNumberOptedOut(supabase, p)))(g.phone as string)) {
      return { ok: false, code: 'OPTED_OUT', message: `${g.name}'s number said STOP to texts from this business. Use send_by 'email' or 'link'.` }
    }
  }
  return { ok: true, delivery: { via: 'text', to: guests.map((g) => ({ name: g.name, address: g.phone as string })), from: number.phone } }
}

/** The card and the words it shows, fitted; null when even fitted it can't show them all. */
function pollCardFor(source: WordsSource, delivery: PollDelivery, kind: 'poll' | 'nudge', origin: string): { words: OfferWords; card: { title: string; why: string } } | null {
  const plain = (t: string) => plainSmsText(t, origin)
  const shown = offerUrlShown(origin)
  const words = fitOfferWords(pollWords(source), (w) => pollCard(w, delivery, kind, source.expiresAt, shown, plain).why)
  const card = pollCard(words, delivery, kind, source.expiresAt, shown, plain)
  return card.why.length <= OFFER_CARD_WHY_MAX && card.title.length <= POLL_CARD_TITLE_MAX ? { words, card } : null
}

/** Send each guest their words with their own link: who it reached and who it didn't. */
async function sendEach(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string },
  guests: readonly PollRecipient[],
  delivery: PollDelivery,
  kind: 'poll' | 'nudge',
  words: OfferWords,
  origin: string,
  deps: SendDeps,
): Promise<{ reached: PollRecipient[]; missed: PollRecipient[]; problem: string | null }> {
  const reached: PollRecipient[] = []
  const missed: PollRecipient[] = []
  let problem: string | null = null
  for (const guest of guests) {
    const link = recipientLink(origin, guest.id, deps.secret)
    let ok = false
    if (delivery.via === 'email' && guest.email) {
      const e = kind === 'poll' ? pollEmailWords(words, link) : nudgeEmailWords(words, link)
      try {
        await (deps.sendEmail ?? sendEmail)(args.userId, args.workspaceId, { to: [guest.email], subject: e.subject, body_html: e.html, body_text: e.text })
        ok = true
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        problem = /no .*(account|mailbox|integration)|not connected|token/i.test(message) ? 'no mailbox is connected to send it from' : 'the email could not be sent'
      }
    } else if (delivery.via === 'text' && guest.phone) {
      const body = plainSmsText(kind === 'poll' ? pollSmsText(words, link) : nudgeSmsText(words, link), origin)
      ok = await (deps.sendText ?? ((a) => textBookingCustomer(supabase, { workspaceId: a.workspaceId, customerPhone: a.to, guestId: null }, a.body)))({ workspaceId: args.workspaceId, to: guest.phone, body })
      if (!ok) problem = 'the text could not be sent from the business number'
    }
    ;(ok ? reached : missed).push(guest)
  }
  return { reached, missed, problem }
}

/** What offer_times answers about a poll: who, what, each guest's own link (and paste text by link), the times, and who already answered. */
export function pollResult(poll: TimeOfferPoll, origin: string, sentVia: 'link' | 'email' | 'text', extra: { secret?: string; missed?: readonly PollRecipient[]; autoAnswered?: number } = {}): Record<string, unknown> {
  const words = pollWords(sourceOfOffer(poll))
  const zone = zoneLabel(poll.timeZone, Date.parse(poll.slots[0]?.startsAt ?? poll.expiresAt))
  const missed = new Set((extra.missed ?? []).map((r) => r.id))
  const booked = poll.state === 'booked'
  return {
    success: true,
    offer_id: poll.id,
    mode: 'poll',
    state: poll.state,
    title: poll.title,
    duration_minutes: poll.durationMinutes,
    sent_via: sentVia,
    time_zone: poll.timeZone,
    times: poll.slots.map((s) => ({ start: s.startsAt, label: `${slotLabel(s.startsAt, poll.timeZone)} ${zone}`, state: s.state })),
    expires: `${slotLabel(poll.expiresAt, poll.timeZone)} ${zone}`,
    guests: poll.recipients.map((r) => {
      const link = recipientLink(origin, r.id, extra.secret)
      return {
        guest_id: r.id,
        name: r.name,
        ...(r.email ? { email: r.email } : {}),
        ...(r.phone ? { phone: r.phone } : {}),
        link,
        answered: !!r.answeredAt,
        ...(r.answeredAt ? { works: poll.slots.filter((s) => r.works.includes(s.id)).map((s) => s.startsAt) } : {}),
        ...(r.answeredVia === 'calendar' ? { from_calendar: true } : {}),
        ...(sentVia === 'link' || missed.has(r.id) ? { paste_text: pollPasteText(words, link) } : {}),
        ...(missed.has(r.id) ? { not_sent: true } : {}),
      }
    }),
    ...(poll.coHostIds.length ? { co_hosts: poll.coHostIds.length } : {}),
    ...(booked && poll.bookingId ? { booking_id: poll.bookingId } : {}),
    message: [
      sentVia === 'link'
        ? `The times are held until everyone answers or the poll expires. Nothing was sent: give each guest their own link (paste_text has the words). When the last one has answered, the earliest time that works for everyone is booked and they get the invitation.`
        : `Sent by ${sentVia} to each guest${missed.size ? `, except ${[...(extra.missed ?? [])].map((r) => r.name).join(', ')} (give them their link yourself)` : ''}. The times are held until everyone answers (the earliest time that works for all is then booked) or the poll expires.`,
      ...(extra.autoAnswered ? [`${extra.autoAnswered === 1 ? 'One linked guest was' : `${extra.autoAnswered} linked guests were`} answered from their own calendar; they can still change it.`] : []),
      ...(booked ? ['Everyone has answered already, and it is booked: see booking_id.'] : []),
    ].join(' '),
  }
}

// ── offer_times for a poll ──────────────────────────────────────────────────

/** The card for a poll that sends (email or text), or null when the call would be refused anyway. Throws on a failed read. */
export async function pollHold(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; browserTimeZone?: string | null },
  request: OfferRequest,
  deps: SendDeps = {},
): Promise<TimeOfferHold | null> {
  if (request.sendBy === 'link') return null
  const planned = await planPoll(supabase, request, deps)
  if (!planned.ok) return null
  const plan = planned.plan
  const way = await pollDeliveryOf(supabase, args.workspaceId, request.sendBy, plan.recipients, deps)
  if (!way.ok) return null
  const made = pollCardFor(sourceOfPlan(plan), way.delivery, 'poll', deps.origin ?? appOrigin())
  if (!made) return null
  const cardHash = offerCardHash(made.card)
  return {
    card: made.card,
    context: { timeOffer: { card_hash: cardHash } },
    prepare: async () => {
      const poll = await createPoll(supabase, plan, { state: 'pending_send', createdBy: args.userId, cardHash, omitGrants: request.omitGrants }, deps)
      if (!poll.ok) return { ok: false, message: `Nothing was sent or held: ${poll.message}` }
      return { ok: true, context: { timeOffer: { offer_id: poll.poll.id, card_hash: cardHash } } }
    },
    held: async (context, approvalId) => {
      if (context.timeOffer?.offer_id) await setOfferApproval(supabase, context.timeOffer.offer_id, approvalId).catch(() => {})
    },
    abandon: async (context) => {
      if (context.timeOffer?.offer_id) await closeOffer(supabase, context.timeOffer.offer_id, ['pending_send'], 'withdrawn').catch(() => null)
    },
  }
}

/** Run offer_times for a poll (see the header). Never throws. */
export async function runPollTimes(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string; approvedCall?: ApprovedCall; browserTimeZone?: string | null; omitGrants?: boolean },
  input: OfferTimesInput,
  deps: SendDeps = {},
): Promise<Record<string, unknown>> {
  const origin = deps.origin ?? appOrigin()
  try {
    const request = requestOf(args, input)
    const sendBy = request.sendBy
    if (sendBy === 'link') {
      const planned = await planPoll(supabase, request, deps)
      if (!planned.ok) return refusal(planned.code, planned.message)
      const made = await createPoll(supabase, planned.plan, { state: 'open', createdBy: args.userId, omitGrants: request.omitGrants }, deps)
      if (!made.ok) return refusal(made.code, made.message)
      const auto = await autoAnswerLinked(supabase, made.poll.id, { ...deps, omitGrants: request.omitGrants })
      const poll = (await getPoll(supabase, made.poll.id)) ?? made.poll
      return pollResult(poll, origin, 'link', { secret: deps.secret, autoAnswered: auto })
    }

    // Email or text: only the replay of the person's own card.
    const pin = args.approvedCall?.tool === OFFER_TIMES_TOOL ? args.approvedCall.timeOffer : undefined
    if (!pin) {
      const planned = await planPoll(supabase, request, deps)
      if (!planned.ok) return refusal(planned.code, planned.message)
      const way = await pollDeliveryOf(supabase, args.workspaceId, sendBy, planned.plan.recipients, deps)
      if (!way.ok) return refusal(way.code, way.message)
      if (!pollCardFor(sourceOfPlan(planned.plan), way.delivery, 'poll', origin)) return refusal('CARD_TOO_LONG', TOO_LONG)
      return refusal('APPROVAL_REQUIRED', "Nothing was sent. offer_times by email or text only runs from the person's own approval card, which shows exactly what goes to whom.")
    }
    return await sendApprovedPoll(supabase, args, pin, sendBy, origin, deps)
  } catch (err) {
    return refusal('FAILED', `Nothing was sent: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function sendApprovedPoll(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string; omitGrants?: boolean },
  pin: TimeOfferApprovalContext,
  sendBy: 'email' | 'text',
  origin: string,
  deps: SendDeps,
): Promise<Record<string, unknown>> {
  const poll = await getPoll(supabase, pin.offer_id, args.workspaceId)
  if (!poll || poll.hostUserId !== args.userId) return refusal('NOT_FOUND', 'Nothing was sent: the poll this card was for is gone.')
  if (poll.state !== 'pending_send') return refusal('CLOSED', `Nothing was sent: the poll is ${poll.state === 'open' || poll.state === 'booked' ? 'already sent' : poll.state}.`)
  const way = await pollDeliveryOf(supabase, args.workspaceId, sendBy, poll.recipients, deps)
  if (!way.ok) {
    await closeOffer(supabase, poll.id, ['pending_send'], 'withdrawn')
    return refusal(way.code, `Nothing was sent: ${way.message}`)
  }
  const made = pollCardFor(sourceOfOffer(poll), way.delivery, 'poll', origin)
  if (!made || offerCardHash(made.card) !== pin.card_hash) {
    await closeOffer(supabase, poll.id, ['pending_send'], 'withdrawn')
    return refusal('CARD_CHANGED', 'Nothing was sent: what they would get is no longer what the card showed (how to reach them changed since). The times were let go. Ask again for a fresh card.')
  }
  // Held, but a host's own calendar may have filled since the card was made.
  for (const userId of offerHosts(poll)) {
    const free = await (deps.checkFree ?? checkSpansFree)({
      userId,
      workspaceId: poll.workspaceId,
      timeZone: poll.timeZone,
      spans: poll.slots.map((s) => ({ start: Date.parse(s.startsAt), end: Date.parse(s.endsAt) })),
      exceptClaims: { offerId: poll.id },
    })
    if (!free.known || free.busy.some(Boolean)) {
      await closeOffer(supabase, poll.id, ['pending_send'], 'withdrawn')
      return refusal(
        free.known ? 'SLOT_TAKEN' : 'CALENDAR_UNKNOWN',
        free.known
          ? 'Nothing was sent: one of the times is no longer free on a host\'s calendar. The times were let go: find new ones with find_times and offer again.'
          : "Nothing was sent: a host's calendar couldn't be read. The times were let go: offer again in a moment.",
      )
    }
  }
  const opened = await moveOffer(supabase, poll.id, ['pending_send'], 'open', { sent_via: way.delivery.via })
  if (!opened) return refusal('CLOSED', 'Nothing was sent: the poll changed just now.')
  await openRecipientLinks(supabase, poll, deps.secret)
  const sent = await sendEach(supabase, args, poll.recipients, way.delivery, 'poll', made.words, origin, deps)
  if (!sent.reached.length) {
    await closeOffer(supabase, poll.id, ['open'], 'withdrawn')
    return refusal('NOT_SENT', `Nothing reached any guest: ${sent.problem ?? 'it could not be sent'}. The times were let go. Tell the person.`)
  }
  const auto = await autoAnswerLinked(supabase, poll.id, { ...deps, omitGrants: args.omitGrants })
  const fresh = (await getPoll(supabase, poll.id)) ?? poll
  return pollResult(fresh, origin, way.delivery.via, { secret: deps.secret, missed: sent.missed, autoAnswered: auto })
}

// ── nudge_time_offer ────────────────────────────────────────────────────────

/** The card for a reminder that sends (email or text), or null when the call would be refused anyway. Throws on a failed read. */
export async function nudgeHold(supabase: SupabaseClient, args: { workspaceId: string; userId: string; input: unknown }, deps: SendDeps = {}): Promise<TimeOfferHold | null> {
  const parsed = nudgeTimeOfferInput.safeParse(args.input)
  if (!parsed.success || (parsed.data.send_by ?? 'link') === 'link') return null
  const poll = await getPoll(supabase, parsed.data.offer_id, args.workspaceId)
  if (!poll || poll.hostUserId !== args.userId) return null
  const targets = nudgeTargets(poll, (deps.now ?? Date.now)())
  const way = await pollDeliveryOf(supabase, args.workspaceId, parsed.data.send_by as 'email' | 'text', targets, deps)
  if (!way.ok) return null
  const made = pollCardFor(sourceOfOffer(poll), way.delivery, 'nudge', deps.origin ?? appOrigin())
  if (!made) return null
  // Nothing to make first: the card pins the poll and who it reminds.
  const timeOffer = { offer_id: poll.id, card_hash: offerCardHash(made.card) }
  return { card: made.card, context: { timeOffer }, prepare: async () => ({ ok: true, context: { timeOffer } }), held: async () => {}, abandon: async () => {} }
}

/** Run one nudge_time_offer call (see the header). Never throws. */
export async function runNudge(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string; approvedCall?: ApprovedCall },
  input: unknown,
  deps: SendDeps = {},
): Promise<Record<string, unknown>> {
  const origin = deps.origin ?? appOrigin()
  const now = (deps.now ?? Date.now)()
  try {
    const parsed = nudgeTimeOfferInput.safeParse(input)
    if (!parsed.success) return refusal('BAD_INPUT', parsed.error.issues[0]?.message ?? 'Invalid input.')
    const sendBy = parsed.data.send_by ?? 'link'
    const poll = await getPoll(supabase, parsed.data.offer_id, args.workspaceId)
    if (!poll || poll.hostUserId !== args.userId) return refusal('NOT_FOUND', 'No poll of yours with that id in this workspace (list_time_offers).')
    if (poll.state !== 'open' || Date.parse(poll.expiresAt) <= now) return refusal('CLOSED', `That poll is ${poll.state === 'open' ? 'expired' : poll.state === 'booked' ? 'already booked' : poll.state}: nobody needs a reminder.`)
    const targets = nudgeTargets(poll, now)
    if (!targets.length) {
      const waiting = poll.recipients.filter((r) => !r.answeredAt)
      return refusal('NOTHING_TO_SEND', waiting.length ? `${waiting.map((r) => r.name).join(', ')} ${waiting.length === 1 ? 'was' : 'were'} reminded in the last 12 hours (or three times already). Leave it for now.` : 'Everyone has answered: nobody needs a reminder.')
    }
    const words = pollWords(sourceOfOffer(poll))

    if (sendBy === 'link') {
      await markNudged(supabase, targets, new Date(now).toISOString())
      return {
        success: true,
        offer_id: poll.id,
        sent_via: 'link',
        guests: targets.map((r) => {
          const link = recipientLink(origin, r.id, deps.secret)
          return { guest_id: r.id, name: r.name, link, paste_text: nudgePasteText(words, link) }
        }),
        message: 'Nothing was sent: give each of them their reminder (paste_text) yourself.',
      }
    }

    const way = await pollDeliveryOf(supabase, args.workspaceId, sendBy, targets, deps)
    if (!way.ok) return refusal(way.code, way.message)
    const made = pollCardFor(sourceOfOffer(poll), way.delivery, 'nudge', origin)
    if (!made) return refusal('CARD_TOO_LONG', TOO_LONG)
    const pin = args.approvedCall?.tool === NUDGE_TIME_OFFER_TOOL ? args.approvedCall.timeOffer : undefined
    if (!pin) return refusal('APPROVAL_REQUIRED', "Nothing was sent. nudge_time_offer by email or text only runs from the person's own approval card, which shows exactly what goes to whom.")
    if (pin.offer_id !== poll.id || offerCardHash(made.card) !== pin.card_hash) {
      return refusal('CARD_CHANGED', 'Nothing was sent: who still has to answer changed since the card was made. Ask again for a fresh card if someone still needs a reminder.')
    }
    const sent = await sendEach(supabase, args, targets, way.delivery, 'nudge', made.words, origin, deps)
    await markNudged(supabase, sent.reached, new Date(now).toISOString())
    if (!sent.reached.length) return refusal('NOT_SENT', `Nothing reached them: ${sent.problem ?? 'it could not be sent'}.`)
    return {
      success: true,
      offer_id: poll.id,
      sent_via: way.delivery.via,
      guests: sent.reached.map((r) => ({ guest_id: r.id, name: r.name })),
      ...(sent.missed.length ? { not_sent: sent.missed.map((r) => ({ guest_id: r.id, name: r.name, link: recipientLink(origin, r.id, deps.secret) })) } : {}),
      message: `Reminded ${sent.reached.map((r) => r.name).join(', ')} by ${way.delivery.via}.${sent.missed.length ? ` ${sent.missed.map((r) => r.name).join(', ')} didn't get it (${sent.problem}).` : ''}`,
    }
  } catch (err) {
    return refusal('FAILED', `Nothing was sent: ${err instanceof Error ? err.message : String(err)}`)
  }
}

