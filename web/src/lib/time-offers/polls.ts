/**
 * Polls (availability phase 5, migration 583): a handful of the host's
 * times offered to several outside guests at once (and, optionally, to some
 * of the host's teammates as co-hosts), each guest marking every time that
 * works for them, booked when the last one has answered.
 *
 *   planPoll        the request read and checked, nothing written: two to
 *                   eight guests (each a name, an email and/or a mobile;
 *                   no one twice), two to six times, the co-hosts (members
 *                   of the workspace who share their availability, by name
 *                   or email, as find_times reads them), the expiry (3
 *                   days by default, never after the last time starts).
 *   createPoll      every time checked free right now on the host's and
 *                   each co-host's calendar (strict: one that can't be read
 *                   refuses the poll), a Google or Outlook calendar of the
 *                   host's to book on, then the offer (mode 'poll'), its
 *                   times, its guests, and a HOLD on each time for every host.
 *                   A guest whose email is a linked Native Intelligence user
 *                   is kept as one (their free/busy may be read: src/lib/
 *                   guests/linked-free-busy.ts). An open poll's guests get
 *                   their links now; one waiting on its card when it is sent.
 *   autoAnswerLinked  a linked guest whose link lets the host's agent read
 *                   their free/busy is answered from their calendar at once
 *                   (free at a time: it works), marked as answered that way;
 *                   they are told of the poll like anyone else and can change
 *                   it. Unreadable: they are simply asked.
 *   recordAnswer    one guest's whole answer, from their page, the host's
 *                   agent reading their reply (record_time_offer_answer) or
 *                   the business's assistant reading their text
 *                   (answer_offered_times): only that poll's own guest and
 *                   its own open times, replaced whole (migration 583
 *                   answer_time_offer, under the offer's lock). The last
 *                   answer books.
 *   bookWhenAnswered  when everyone has answered: the earliest time that
 *                   works for everyone, every host's calendar read again live
 *                   (a time now busy is let go and the next one tried), then
 *                   ONE transaction (book_time_offer_poll) re-checks every
 *                   answer under the lock and books: two last answers at
 *                   once make one booking. No common time: nothing is booked,
 *                   the times stay held until the poll expires (a guest may
 *                   still change their answer), and the host is told the
 *                   time most can make. A calendar that can't be read leaves
 *                   it for the sweep (./sweep.ts) to try again.
 *   bookPollAnyway  the host books one of the poll's times with whoever can
 *                   make it ("Tuesday at 10 without Dana"): everyone but
 *                   those who said it doesn't work and those the host leaves
 *                   out (a guest who hasn't answered is invited).
 *   pollParty       the booked meeting's one calendar event (./accept.ts
 *                   finishBooking): every attending guest with an email and
 *                   every co-host invited by the provider; afterwards a
 *                   mobile-only guest is texted from the business's number
 *                   with their own manage link (as a booking link's guest
 *                   is), and the host told who heard how. The event's
 *                   description holds no guest's own link: everyone gets it.
 *   declineGroupMeeting  a guest who can't make it any more, from their own
 *                   manage link: they come off the invitation (the provider
 *                   tells them), the meeting stays, the host is told. Only
 *                   the host cancels or moves a group meeting: a guest can't
 *                   move one (their page says to reply to the host).
 *   nudgeTargets    the guests a reminder goes to: sent, not answered, not
 *                   reminded in the last 12 hours, at most three times.
 *   reportPollExpired  the sweep's line to the host when a poll lapsed
 *                   unbooked: who never answered, and the best option.
 *
 * The host hears of a booking in their home thread (a line, kept there), and
 * of no common time, an expiry or a guest dropping out where they are
 * (routed). Every guest sees only counts of the others: never their names
 * or answers.
 *
 * Server only; service role. Never throws: every outcome is a result.
 */
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkSpansFree } from '@/lib/availability/slot-check'
import { findWorkspacePeople } from '@/lib/availability/people'
import { textBookingCustomer } from '@/lib/customers/booking'
import { findContactByEmailOrPhone } from '@/lib/customers/contacts'
import { reportToOwner } from '@/lib/customers/reminders'
import { linkedFreeBusyGrant, linkedSpansBusy, type LinkedFreeBusyDeps } from '@/lib/guests/linked-free-busy'
import { updateCalendarEvent } from '@/lib/integrations/calendar'
import { appOrigin } from '@/lib/twilio/config'
import { normalizeE164 } from '@/lib/twilio/phone'
import { listMemberEmails } from '@/lib/workspace-member-emails'
import { finishBooking, type AcceptDeps } from './accept'
import { bookingCalendarAccount } from './host-calendar'
import { cleanEmail, defaultZone, hostDisplayName, normalizeOfferRequest, oneLine, type OfferDeps, type OfferRefusal, type OfferRequest, type PlannedOffer } from './offers'
import { changeable, hostZone, type ManageFailure } from './manage'
import { answerPoll, bookPollSlot, getPoll, getPollByRecipientHash, insertRecipients, markDeclined, setRecipientTokens, unmarkDeclined, withRecipients } from './poll-store'
import { countLiveOffers, deleteHolds, deleteOffer, getBooking, insertHolds, insertOffer, offerHosts, pendingOfferWithCard, releaseSlots } from './store'
import { manageTokenFor, manageTokenHash, manageUrl, offerTokenHash, pollManageTokenFor, pollTokenFor } from './tokens'
import {
  OPEN_OFFERS_MAX,
  POLL_CO_HOSTS_MAX,
  POLL_NOTE_MAX,
  POLL_NUDGE_GAP_MS,
  POLL_NUDGES_MAX,
  POLL_RECIPIENTS_MAX,
  POLL_SAVES_DAILY_CAP,
  RECIPIENT_NAME_MAX,
  bestSlot,
  commonSlots,
  everyoneAnswered,
  type AnswerVia,
  type MeetingBooking,
  type OfferSlot,
  type PollRecipient,
  type TimeOfferPoll,
} from './types'
import { namesList, pollBookedReport, pollBookedText, pollDeclinedReport, pollEventWords, pollExpiredReport, pollNoCommonReport, slotLabel } from './words'

const refuse = (code: string, message: string): OfferRefusal => ({ ok: false, code, message })

export interface PlannedPoll extends PlannedOffer {
  recipients: Array<{ name: string; email: string | null; phone: string | null }>
  coHosts: Array<{ userId: string; name: string }>
}

export interface PollDeps extends OfferDeps, LinkedFreeBusyDeps {
  /** The co-hosts named, resolved in the workspace (default: find_times' people). */
  findPeople?: typeof findWorkspacePeople
  /** A guest's grant to read their free/busy (default: ../guests/linked-free-busy.ts). */
  linkedGrant?: typeof linkedFreeBusyGrant
  /** The poll guest's link token (default: the server's secret). */
  secret?: string
}

/** Whether an offer_times request is a poll: several guests, or co-hosts. Pure. */
export function isPollRequest(req: Pick<OfferRequest, 'recipients' | 'coHosts'>): boolean {
  return (req.recipients?.length ?? 0) > 1 || ((req.recipients?.length ?? 0) >= 1 && (req.coHosts?.length ?? 0) > 0)
}

/** A poll's guests read and checked (see the header). Pure. */
export function normalizeRecipients(
  raw: NonNullable<OfferRequest['recipients']>,
  sendBy: OfferRequest['sendBy'],
): { ok: true; recipients: PlannedPoll['recipients'] } | OfferRefusal {
  if (!raw.length || raw.length > POLL_RECIPIENTS_MAX) return refuse('BAD_INPUT', `A poll goes to 1 to ${POLL_RECIPIENTS_MAX} people.`)
  const out: PlannedPoll['recipients'] = []
  for (const r of raw) {
    const name = oneLine(r.name, RECIPIENT_NAME_MAX)
    if (!name) return refuse('BAD_INPUT', 'Every guest needs a name.')
    const rawEmail = typeof r.email === 'string' && r.email.trim() ? r.email : null
    const email = rawEmail ? cleanEmail(rawEmail) : null
    if (rawEmail && !email) return refuse('BAD_INPUT', `${rawEmail.slice(0, 80)} isn't an email address.`)
    const rawPhone = typeof r.phone === 'string' && r.phone.trim() ? r.phone : null
    const phone = rawPhone ? normalizeE164(rawPhone) : null
    if (rawPhone && !phone) return refuse('BAD_INPUT', `${rawPhone.slice(0, 30)} isn't a phone number I can text (use +1 and the number).`)
    if (sendBy === 'email' && !email) return refuse('NEEDS_EMAIL', `send_by 'email' needs every guest's email: ${name} has none.`)
    if (sendBy === 'text' && !phone) return refuse('NEEDS_PHONE', `send_by 'text' needs every guest's mobile number: ${name} has none.`)
    if (out.some((o) => (email && o.email === email) || (phone && o.phone === phone))) return refuse('BAD_INPUT', `${name} is in the list twice.`)
    out.push({ name, email, phone })
  }
  return { ok: true, recipients: out }
}

/** The poll request read and checked (see the header); nothing is written. */
export async function planPoll(supabase: SupabaseClient, req: OfferRequest, deps: PollDeps = {}): Promise<{ ok: true; plan: PlannedPoll } | OfferRefusal> {
  try {
    const hostName = await hostDisplayName(supabase, req.workspaceId, req.hostUserId)
    if (!hostName) return refuse('NOT_A_MEMBER', 'Not a workspace member.')
    const guests = normalizeRecipients(req.recipients ?? [], req.sendBy)
    if (!guests.ok) return guests
    const timeZone = await (deps.timeZone ?? ((r) => defaultZone(supabase, r)))(req)
    // The shared rules (title, times, expiry), read for the first guest; the guests were checked above.
    const base = normalizeOfferRequest({ ...req, recipient: { name: guests.recipients[0].name }, sendBy: 'link' }, { timeZone, hostName, now: (deps.now ?? Date.now)() }, true)
    if (!base.ok) return base

    const asked = [...new Set((req.coHosts ?? []).map((c) => c.trim()).filter(Boolean))]
    if (asked.length > POLL_CO_HOSTS_MAX) return refuse('BAD_INPUT', `At most ${POLL_CO_HOSTS_MAX} co-hosts.`)
    let coHosts: PlannedPoll['coHosts'] = []
    if (asked.length) {
      const people = await (deps.findPeople ?? findWorkspacePeople)(supabase, req.workspaceId, req.hostUserId, asked)
      if (!people.ok) return refuse('BAD_INPUT', people.error)
      const hidden = people.others.filter((p) => p.sharing !== 'busy_only')
      if (hidden.length) {
        return refuse('NOT_SHARING', `${namesList(hidden.map((p) => p.name))} ${hidden.length === 1 ? "doesn't" : "don't"} share their availability, so their time can't be held. Leave them out, or ask them to turn sharing on in Settings > Availability.`)
      }
      coHosts = people.others.map((p) => ({ userId: p.userId, name: p.name }))
    }
    const summary = namesList(guests.recipients.map((r) => r.name)).slice(0, RECIPIENT_NAME_MAX)
    return {
      ok: true,
      plan: { ...base.plan, recipient: { name: summary, email: null, phone: null }, sendBy: req.sendBy, recipients: guests.recipients, coHosts },
    }
  } catch (err) {
    return refuse('FAILED', `The times couldn't be prepared: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export type CreatePollResult = { ok: true; poll: TimeOfferPoll; reused?: true } | OfferRefusal

/** The guests' links go live: each one's token hash stored. Throws on a failed write. */
export async function openRecipientLinks(supabase: SupabaseClient, poll: Pick<TimeOfferPoll, 'recipients'>, secret?: string): Promise<void> {
  await setRecipientTokens(supabase, poll.recipients.map((r) => ({ id: r.id, tokenHash: offerTokenHash(pollTokenFor(r.id, secret)) })))
}

/** Each guest's own link (the host may copy it again: list_time_offers). Pure but for the secret. */
export function recipientLink(origin: string, recipientId: string, secret?: string): string {
  return `${origin.replace(/\/$/, '')}/t/${pollTokenFor(recipientId, secret)}`
}

/**
 * Check every host's times are free, then write the poll, its guests and the
 * holds (see the header). `pending_send` (by email or text, made for its
 * card) gives the guests no live link yet, and the same card asked again gets
 * its poll back.
 */
export async function createPoll(
  supabase: SupabaseClient,
  plan: PlannedPoll,
  opts: { state: 'open' | 'pending_send'; createdBy: string | null; cardHash?: string | null; omitGrants?: boolean; recipientsShown?: boolean },
  deps: PollDeps = {},
): Promise<CreatePollResult> {
  const now = (deps.now ?? Date.now)()
  const nowIso = new Date(now).toISOString()
  try {
    if (opts.state === 'pending_send' && opts.cardHash) {
      const same = await pendingOfferWithCard(supabase, plan.hostUserId, opts.cardHash, nowIso)
      if (same && same.mode === 'poll') return { ok: true, poll: (await withRecipients(supabase, [same]))[0], reused: true }
    }
    if ((await countLiveOffers(supabase, plan.hostUserId, nowIso)) >= OPEN_OFFERS_MAX) {
      return refuse('TOO_MANY_OFFERS', `There are already ${OPEN_OFFERS_MAX} open offers holding your time. Withdraw some (list_time_offers) before offering more.`)
    }
    const account = await (deps.calendarAccount ?? bookingCalendarAccount)(supabase, plan.hostUserId, plan.workspaceId)
    if (!account) return refuse('NO_CALENDAR', 'No Google or Outlook calendar is connected in this workspace, so a booked time would have nowhere to go. Connect one first.')

    // Every host's calendar, strictly: the host's and each co-host's.
    const spans = plan.slots.map((s) => ({ start: Date.parse(s.startsAt), end: Date.parse(s.endsAt) }))
    const hosts = [{ userId: plan.hostUserId, name: null as string | null }, ...plan.coHosts.map((c) => ({ userId: c.userId, name: c.name }))]
    for (const host of hosts) {
      const free = await (deps.checkFree ?? checkSpansFree)({ userId: host.userId, workspaceId: plan.workspaceId, timeZone: plan.timeZone, spans })
      if (!free.known) {
        // A teammate's reason stays theirs: only that it couldn't be read.
        return refuse('CALENDAR_UNKNOWN', host.name ? `${host.name}'s calendar couldn't be read, so no times were offered. Try again in a moment, or leave them out.` : `Your calendar couldn't be read (${free.reason}), so no times were offered. Try again in a moment.`)
      }
      const busy = plan.slots.filter((_, i) => free.busy[i])
      if (busy.length) {
        return refuse('SLOT_TAKEN', `Something is already on ${host.name ? `${host.name}'s` : 'your'} calendar (or held for another offer) at ${busy.map((s) => slotLabel(s.startsAt, plan.timeZone)).join(' and ')}. Pick other times with find_times.`)
      }
    }

    const findContact = deps.findContact ?? ((ws: string, who: { email: string | null; phone: string | null }) => findContactByEmailOrPhone(supabase, ws, who))
    const grant = deps.linkedGrant ?? linkedFreeBusyGrant
    const rows = await Promise.all(
      plan.recipients.map(async (r) => {
        const [contact, linked] = await Promise.all([
          findContact(plan.workspaceId, { email: r.email, phone: r.phone }).catch(() => null),
          grant(supabase, { hostUserId: plan.hostUserId, email: r.email, omitGrants: opts.omitGrants }, deps),
        ])
        return { name: r.name, email: r.email, phone: r.phone, contactId: contact?.id ?? null, peerUserId: linked?.peerUserId ?? null }
      }),
    )

    const offer = await insertOffer(supabase, {
      workspaceId: plan.workspaceId,
      hostUserId: plan.hostUserId,
      createdBy: opts.createdBy,
      hostName: plan.hostName,
      recipientName: plan.recipient.name,
      recipientEmail: null,
      recipientPhone: null,
      contactId: null,
      title: plan.title,
      durationMinutes: plan.durationMinutes,
      video: plan.video,
      callHere: plan.callHere,
      location: plan.location,
      message: plan.message,
      timeZone: plan.timeZone,
      state: opts.state,
      tokenHash: null,
      sentVia: opts.state === 'open' ? 'link' : null,
      cardHash: opts.cardHash ?? null,
      recipientsShown: opts.recipientsShown === true,
      expiresAt: plan.expiresAt,
      slots: plan.slots,
      mode: 'poll',
      coHostIds: plan.coHosts.map((c) => c.userId),
    })
    let recipients: PollRecipient[]
    try {
      recipients = await insertRecipients(supabase, offer, rows)
    } catch (err) {
      await deleteOffer(supabase, offer.id)
      throw err
    }
    const held = await insertHolds(supabase, offer)
    if (!held.ok) {
      await deleteOffer(supabase, offer.id)
      return held.conflict
        ? refuse('SLOT_TAKEN', "One of those times was just held or booked by another offer (yours or a co-host's). Pick other times with find_times.")
        : refuse('FAILED', `The times couldn't be held (${held.error}). Nothing was offered.`)
    }
    const poll: TimeOfferPoll = { ...offer, recipients }
    if (opts.state === 'open') await openRecipientLinks(supabase, poll, deps.secret)
    return { ok: true, poll: { ...poll, recipients: recipients.map((r) => ({ ...r, sent: opts.state === 'open' })) } }
  } catch (err) {
    return refuse('FAILED', `Nothing was offered: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ── Answers ─────────────────────────────────────────────────────────────────

export interface AnswerDeps extends AcceptDeps, LinkedFreeBusyDeps {
  linkedGrant?: typeof linkedFreeBusyGrant
}

export type AnswerFailure = {
  ok: false
  code: 'NOT_FOUND' | 'EXPIRED' | 'WITHDRAWN' | 'BOOKED' | 'BAD_INPUT' | 'LIMIT' | 'FAILED'
  message: string
  openSlots?: OfferSlot[]
}

export type BookAttempt =
  | { status: 'booked'; booking: MeetingBooking; already: boolean }
  | { status: 'waiting'; waiting: number }
  | { status: 'no_common' }
  | { status: 'unknown' }
  | { status: 'closed' }

export type AnswerResult = { ok: true; poll: TimeOfferPoll; recipient: PollRecipient; booking: MeetingBooking | null; waiting: number } | AnswerFailure

export interface AnswerInput {
  /** The guest's own link (their page), or the poll and the guest within a workspace (the agents). */
  ref: { token: string } | { offerId: string; workspaceId: string; recipientId?: string }
  /** The starts of the times that work, as the poll gave them. */
  works: readonly string[]
  /** None of the times work (then `works` is empty). */
  none?: boolean
  note?: string | null
  via: Exclude<AnswerVia, 'calendar'>
  /** The host's agent: only the poll's own host may answer for its guest. */
  actingUserId?: string
  /** The business's assistant: only the guest with this phone. */
  guestPhone?: string
}

const failAnswer = (code: AnswerFailure['code'], message: string, openSlots?: OfferSlot[]): AnswerFailure => ({ ok: false, code, message, ...(openSlots ? { openSlots } : {}) })

const openOf = (poll: Pick<TimeOfferPoll, 'slots'>, now: number) => poll.slots.filter((s) => s.state === 'open' && Date.parse(s.startsAt) > now)

async function loadAnswerTarget(supabase: SupabaseClient, input: AnswerInput): Promise<{ poll: TimeOfferPoll; recipient: PollRecipient } | AnswerFailure> {
  const ref = input.ref
  if ('token' in ref) {
    const found = await getPollByRecipientHash(supabase, offerTokenHash(ref.token))
    return found && found.poll.state !== 'pending_send' ? found : failAnswer('NOT_FOUND', 'These times do not exist.')
  }
  const poll = await getPoll(supabase, ref.offerId, ref.workspaceId)
  if (!poll) return failAnswer('NOT_FOUND', 'No poll with that id in this workspace (list_time_offers).')
  if (input.via === 'host') {
    if (poll.hostUserId !== input.actingUserId) return failAnswer('NOT_FOUND', 'No poll of yours with that id in this workspace (list_time_offers).')
    const recipient = poll.recipients.find((r) => r.id === ref.recipientId)
    return recipient ? { poll, recipient } : failAnswer('NOT_FOUND', "That guest isn't one of this poll's: answer only for its own guests (list_time_offers).")
  }
  // The business's assistant: only the guest the text came from.
  const phone = input.guestPhone ? normalizeE164(input.guestPhone) : null
  const recipient = phone ? poll.recipients.find((r) => r.phone === phone && (!ref.recipientId || r.id === ref.recipientId)) : undefined
  return recipient && poll.state !== 'pending_send' ? { poll, recipient } : failAnswer('NOT_FOUND', 'No times were offered to this customer with that id.')
}

/** Record one guest's whole answer, and book when it was the last (see the header). */
export async function recordAnswer(supabase: SupabaseClient, input: AnswerInput, deps: AnswerDeps = {}): Promise<AnswerResult> {
  const now = (deps.now ?? Date.now)()
  try {
    const target = await loadAnswerTarget(supabase, input)
    if ('ok' in target) return target
    const { poll, recipient } = target
    if (poll.state === 'booked') return failAnswer('BOOKED', 'These times were already booked.')
    if (poll.state === 'withdrawn' || poll.state === 'declined') return failAnswer('WITHDRAWN', `${poll.hostName} withdrew these times.`)
    if (poll.state === 'expired' || Date.parse(poll.expiresAt) <= now) return failAnswer('EXPIRED', 'These times have expired.')

    const open = openOf(poll, now)
    const picked: string[] = []
    for (const start of input.works) {
      const at = Date.parse(start)
      const slot = Number.isFinite(at) ? poll.slots.find((s) => Date.parse(s.startsAt) === at) : undefined
      if (!slot) return failAnswer('BAD_INPUT', `${String(start).slice(0, 40)} is not one of the offered times.`, open)
      if (!open.some((s) => s.id === slot.id)) return failAnswer('BAD_INPUT', `${slotLabel(slot.startsAt, poll.timeZone)} is no longer available.`, open)
      if (!picked.includes(slot.id)) picked.push(slot.id)
    }
    if (input.none && picked.length) return failAnswer('BAD_INPUT', 'Either mark the times that work, or say none of them do: not both.', open)
    if (!input.none && !picked.length) return failAnswer('BAD_INPUT', 'Mark every time that works, or say none of them do.', open)

    const outcome = await answerPoll(supabase, {
      offerId: poll.id,
      recipientId: recipient.id,
      works: picked,
      note: oneLine(input.note, POLL_NOTE_MAX),
      via: input.via,
      saveCap: input.via === 'link' ? POLL_SAVES_DAILY_CAP : null,
    })
    if (outcome.status === 'booked') return failAnswer('BOOKED', 'These times were already booked.')
    if (outcome.status === 'closed') return outcome.state === 'withdrawn' || outcome.state === 'declined' ? failAnswer('WITHDRAWN', `${poll.hostName} withdrew these times.`) : failAnswer('EXPIRED', 'These times have expired.')
    if (outcome.status === 'limited') return failAnswer('LIMIT', 'Too many changes today. Reply to the host instead.')
    if (outcome.status === 'invalid') return failAnswer('BAD_INPUT', 'Those times changed just now. Reload and mark them again.', open)
    if (outcome.status === 'missing') return failAnswer('NOT_FOUND', 'These times do not exist.')

    const attempt = outcome.waiting === 0 ? await bookWhenAnswered(supabase, poll.id, deps) : ({ status: 'waiting', waiting: outcome.waiting } as BookAttempt)
    const fresh = (await getPoll(supabase, poll.id)) ?? poll
    const me = fresh.recipients.find((r) => r.id === recipient.id) ?? recipient
    return { ok: true, poll: fresh, recipient: me, booking: attempt.status === 'booked' ? attempt.booking : null, waiting: fresh.recipients.filter((r) => !r.answeredAt).length }
  } catch (err) {
    console.warn('[time-offers] poll answer failed:', err instanceof Error ? err.message : String(err))
    return failAnswer('FAILED', "That didn't go through. Try again in a moment.")
  }
}

/**
 * Answer each linked guest of a poll from their own calendar, when their
 * grant lets the host's agent read it (see the header); then book if that
 * was everyone. How many were answered. Never throws.
 */
export async function autoAnswerLinked(supabase: SupabaseClient, offerId: string, deps: AnswerDeps & { omitGrants?: boolean } = {}): Promise<number> {
  const now = (deps.now ?? Date.now)()
  let answered = 0
  let waiting: number | null = null
  try {
    const poll = await getPoll(supabase, offerId)
    if (!poll || poll.state !== 'open') return 0
    const open = openOf(poll, now)
    if (!open.length) return 0
    for (const r of poll.recipients) {
      if (!r.peerUserId || r.answeredAt) continue
      // The grant read again now: a link ended or a setting changed since the poll was made is no grant.
      const grant = await (deps.linkedGrant ?? linkedFreeBusyGrant)(supabase, { hostUserId: poll.hostUserId, email: r.email, omitGrants: deps.omitGrants }, deps)
      if (!grant || grant.peerUserId !== r.peerUserId) continue
      const read = await linkedSpansBusy(supabase, grant, open.map((s) => ({ start: Date.parse(s.startsAt), end: Date.parse(s.endsAt) })), deps)
      if (!read.known) continue
      const works = open.filter((_, i) => !read.busy[i]).map((s) => s.id)
      const outcome = await answerPoll(supabase, { offerId: poll.id, recipientId: r.id, works, note: null, via: 'calendar', saveCap: null })
      if (outcome.status !== 'recorded') break
      answered++
      waiting = outcome.waiting
    }
    if (waiting === 0) await bookWhenAnswered(supabase, offerId, deps)
  } catch (err) {
    console.warn('[time-offers] a linked guest could not be answered from their calendar:', err instanceof Error ? err.message : String(err))
  }
  return answered
}

// ── Booking ─────────────────────────────────────────────────────────────────

/** The guests a booking names on the host's calendar: "Dana Reyes, Sam Ortiz and Lee Park". Pure. */
export function pollGuestName(recipients: readonly Pick<PollRecipient, 'name'>[]): string {
  return namesList(recipients.map((r) => r.name)).slice(0, RECIPIENT_NAME_MAX) || 'Guests'
}

/** Every host's calendar, live, at one time: busy, free, or unknown. */
async function hostsFreeAt(poll: TimeOfferPoll, slot: OfferSlot, deps: AnswerDeps): Promise<'free' | 'busy' | 'unknown'> {
  for (const userId of offerHosts(poll)) {
    const free = await (deps.checkFree ?? checkSpansFree)({
      userId,
      workspaceId: poll.workspaceId,
      timeZone: poll.timeZone,
      spans: [{ start: Date.parse(slot.startsAt), end: Date.parse(slot.endsAt) }],
      exceptClaims: { offerId: poll.id },
    })
    if (!free.known) return 'unknown'
    if (free.busy[0]) return 'busy'
  }
  return 'free'
}

/** That time is gone for good (a host's calendar filled, or another claim took it): its holds go, the rest stay. */
async function letSlotGo(supabase: SupabaseClient, poll: TimeOfferPoll, slot: OfferSlot): Promise<void> {
  await deleteHolds(supabase, poll.id, slot.id).catch(() => {})
  await releaseSlots(supabase, poll.id, slot.id).catch(() => {})
}

async function bookSlotFor(
  supabase: SupabaseClient,
  poll: TimeOfferPoll,
  slot: OfferSlot,
  attendees: readonly PollRecipient[],
  everyone: boolean,
  deps: AnswerDeps,
): Promise<{ status: 'booked'; booking: MeetingBooking; already: boolean } | { status: 'gone' } | { status: 'changed' } | { status: 'closed' } | { status: 'unknown' } | { status: 'failed'; message: string }> {
  const account = await (deps.calendarAccount ?? bookingCalendarAccount)(supabase, poll.hostUserId, poll.workspaceId)
  if (!account) return { status: 'failed', message: `${poll.hostName}'s calendar isn't connected right now, so nothing was booked.` }
  const bookingId = (deps.newId ?? randomUUID)()
  const outcome = await bookPollSlot(supabase, {
    offerId: poll.id,
    slotId: slot.id,
    bookingId,
    manageTokenHash: manageTokenHash(manageTokenFor(bookingId, deps.secret)),
    calendarAccountId: account.id,
    guestName: pollGuestName(attendees),
    attendees: attendees.map((r) => r.id),
    manageHashes: Object.fromEntries(attendees.map((r) => [r.id, manageTokenHash(pollManageTokenFor(bookingId, r.id, deps.secret))])),
    everyone,
  })
  if (outcome.status === 'already') {
    const booking = outcome.bookingId ? await getBooking(supabase, outcome.bookingId) : null
    return booking ? { status: 'booked', booking, already: true } : { status: 'closed' }
  }
  if (outcome.status === 'taken') return { status: 'gone' }
  if (outcome.status === 'changed') return { status: 'changed' }
  if (outcome.status === 'closed' || outcome.status === 'missing') return { status: 'closed' }
  if (outcome.status === 'invalid') return { status: 'failed', message: 'Nobody would be on that meeting.' }
  const booking = await finishBooking(supabase, outcome.bookingId, deps)
  return booking ? { status: 'booked', booking, already: false } : { status: 'failed', message: 'The booking could not be read back. Try again in a moment.' }
}

/**
 * Book a poll every guest has answered, at the earliest time that works for
 * everyone (see the header). Never throws.
 */
export async function bookWhenAnswered(supabase: SupabaseClient, offerId: string, deps: AnswerDeps = {}): Promise<BookAttempt> {
  const now = (deps.now ?? Date.now)()
  try {
    // Each round lets one time go or re-reads changed answers: never more rounds than times, and a few more.
    for (let round = 0; round < 10; round++) {
      const poll = await getPoll(supabase, offerId)
      if (!poll) return { status: 'closed' }
      if (poll.state === 'booked') {
        const booking = poll.bookingId ? await getBooking(supabase, poll.bookingId) : null
        return booking ? { status: 'booked', booking, already: true } : { status: 'closed' }
      }
      if (poll.state !== 'open' || Date.parse(poll.expiresAt) <= now) return { status: 'closed' }
      if (!everyoneAnswered(poll.recipients)) return { status: 'waiting', waiting: poll.recipients.filter((r) => !r.answeredAt).length }
      const slot = commonSlots(poll, now)[0]
      if (!slot) {
        await tellNoCommon(supabase, poll, now, deps)
        return { status: 'no_common' }
      }
      const live = await hostsFreeAt(poll, slot, deps)
      if (live === 'unknown') return { status: 'unknown' }
      if (live === 'busy') {
        await letSlotGo(supabase, poll, slot)
        continue
      }
      const booked = await bookSlotFor(supabase, poll, slot, poll.recipients, true, deps)
      if (booked.status === 'booked') return booked
      if (booked.status === 'gone') {
        await letSlotGo(supabase, poll, slot)
        continue
      }
      if (booked.status === 'changed') continue
      if (booked.status === 'closed') return { status: 'closed' }
      return { status: 'unknown' }
    }
    return { status: 'unknown' }
  } catch (err) {
    console.warn('[time-offers] a poll could not be booked:', err instanceof Error ? err.message : String(err))
    return { status: 'unknown' }
  }
}

function tellOf(supabase: SupabaseClient, deps: Pick<AcceptDeps, 'tellHost'>): NonNullable<AcceptDeps['tellHost']> {
  return deps.tellHost ?? ((args) => reportToOwner(supabase, args))
}

async function tellNoCommon(supabase: SupabaseClient, poll: TimeOfferPoll, now: number, deps: AnswerDeps): Promise<void> {
  // Said once per poll: a changed answer that still leaves no time says nothing new.
  await tellOf(supabase, deps)({
    workspaceId: poll.workspaceId,
    userId: poll.hostUserId,
    messageId: `time-offer:${poll.id}:no-common`,
    text: pollNoCommonReport(poll, bestSlot(poll, now)),
    routes: true,
  }).catch(() => false)
}

export type BookAnywayResult = { ok: true; poll: TimeOfferPoll; booking: MeetingBooking; left: PollRecipient[] } | { ok: false; code: string; message: string }

/**
 * The host books one of a poll's times with whoever can make it (see the
 * header): `without` names guests (their ids, or names as the poll has them)
 * to leave out. Never throws.
 */
export async function bookPollAnyway(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; offerId: string; start: string; without?: readonly string[] },
  deps: AnswerDeps = {},
): Promise<BookAnywayResult> {
  const now = (deps.now ?? Date.now)()
  try {
    const poll = await getPoll(supabase, args.offerId, args.workspaceId)
    if (!poll || poll.hostUserId !== args.userId) return { ok: false, code: 'NOT_FOUND', message: 'No poll of yours with that id in this workspace (list_time_offers).' }
    if (poll.state === 'booked') return { ok: false, code: 'BOOKED', message: 'That poll was already booked: list_time_offers shows the meeting.' }
    if (poll.state !== 'open' || Date.parse(poll.expiresAt) <= now) return { ok: false, code: 'CLOSED', message: `That poll is ${poll.state === 'open' ? 'expired' : poll.state}: offer new times instead.` }
    const at = Date.parse(args.start)
    const slot = Number.isFinite(at) ? openOf(poll, now).find((s) => Date.parse(s.startsAt) === at) : undefined
    if (!slot) return { ok: false, code: 'BAD_INPUT', message: 'That time is not one of the poll\'s open times (list_time_offers).' }
    const out = new Set<string>()
    for (const who of args.without ?? []) {
      const key = who.trim().toLowerCase()
      const hit = poll.recipients.find((r) => r.id === who || r.name.toLowerCase() === key || r.name.toLowerCase().split(' ')[0] === key || (r.email && r.email === key))
      if (!hit) return { ok: false, code: 'BAD_INPUT', message: `${who.slice(0, 60)} isn't a guest of this poll (its guests: ${namesList(poll.recipients.map((r) => r.name), 8)}).` }
      out.add(hit.id)
    }
    // Who can make it: not those who said this time doesn't work, nor those left out.
    const attendees = poll.recipients.filter((r) => !out.has(r.id) && !(r.answeredAt && !r.works.includes(slot.id)))
    if (!attendees.length) return { ok: false, code: 'NOBODY', message: 'None of the guests can make that time (or all were left out), so nothing was booked.' }
    const live = await hostsFreeAt(poll, slot, deps)
    if (live === 'unknown') return { ok: false, code: 'CALENDAR_UNKNOWN', message: "A host's calendar couldn't be checked just now. Try again in a minute." }
    if (live === 'busy') {
      await letSlotGo(supabase, poll, slot)
      return { ok: false, code: 'SLOT_TAKEN', message: `Something is on a host's calendar at ${slotLabel(slot.startsAt, poll.timeZone)} now, so that time was let go. Pick another.` }
    }
    const booked = await bookSlotFor(supabase, poll, slot, attendees, false, deps)
    if (booked.status === 'gone') {
      await letSlotGo(supabase, poll, slot)
      return { ok: false, code: 'SLOT_TAKEN', message: 'That time was just taken by another booking. Pick another.' }
    }
    if (booked.status !== 'booked') return { ok: false, code: booked.status === 'closed' ? 'CLOSED' : 'FAILED', message: booked.status === 'failed' ? booked.message : 'That poll changed just now: check list_time_offers.' }
    const fresh = (await getPoll(supabase, poll.id)) ?? poll
    return { ok: true, poll: fresh, booking: booked.booking, left: fresh.recipients.filter((r) => r.attending === false) }
  } catch (err) {
    return { ok: false, code: 'FAILED', message: err instanceof Error ? err.message : String(err) }
  }
}

// ── The booked meeting ──────────────────────────────────────────────────────

/** A guest's own manage link for their group meeting. */
export function recipientManageUrl(origin: string, bookingId: string, recipientId: string, secret?: string): string {
  return manageUrl(origin, pollManageTokenFor(bookingId, recipientId, secret))
}

async function coHostEmails(workspaceId: string, userIds: readonly string[], deps: Pick<AcceptDeps, 'hostEmails'>): Promise<string[]> {
  if (!userIds.length) return []
  if (deps.hostEmails) return deps.hostEmails(workspaceId, userIds)
  const members = await listMemberEmails(workspaceId)
  return userIds.map((id) => members.find((m) => m.userId === id)?.email).filter((e): e is string => !!e)
}

/**
 * A poll booking's calendar event and what follows it (./accept.ts
 * finishBooking; see the header): its words, its attendees, and once it is
 * confirmed the texts and the host's line. Throws on a failed read.
 */
export async function pollParty(
  supabase: SupabaseClient,
  booking: MeetingBooking,
  deps: AcceptDeps,
): Promise<{ words: { title: string; description: string }; attendees: string[]; after: (confirmed: MeetingBooking, zone: string) => Promise<void> }> {
  const poll = booking.offerId ? await getPoll(supabase, booking.offerId) : null
  const guests = (poll?.recipients ?? []).filter((r) => r.attending)
  const attendees = [...guests.map((r) => r.email).filter((e): e is string => !!e), ...(await coHostEmails(booking.workspaceId, booking.otherHostIds, deps))]
  const origin = deps.origin ?? appOrigin()
  return {
    words: pollEventWords(booking),
    attendees: [...new Set(attendees)],
    after: async (confirmed, zone) => {
      const texted: string[] = []
      const untold: string[] = []
      for (const r of guests.filter((g) => !g.email)) {
        const body = pollBookedText(confirmed, zone, recipientManageUrl(origin, confirmed.id, r.id, deps.secret))
        const sent = r.phone ? await (deps.textGuest ?? ((b, text) => textBookingCustomer(supabase, { workspaceId: b.workspaceId, customerPhone: r.phone, guestId: null }, text)))(confirmed, body).catch(() => false) : false
        ;(sent ? texted : untold).push(r.name)
      }
      const everyone = !!poll && everyoneAnswered(poll.recipients) && poll.recipients.every((r) => r.attending && r.works.includes(poll.slots.find((s) => s.state === 'booked')?.id ?? ''))
      await tellOf(supabase, deps)({
        workspaceId: confirmed.workspaceId,
        userId: confirmed.hostUserId,
        messageId: `meeting-booking:${confirmed.id}:booked`,
        text: pollBookedReport(confirmed, zone, {
          invited: guests.filter((g) => g.email).map((g) => g.name),
          texted,
          untold,
          left: (poll?.recipients ?? []).filter((r) => r.attending === false).map((r) => r.name),
          anyway: !everyone,
        }),
        routes: false,
      }).catch(() => false)
    },
  }
}

/** A guest of a group meeting says they can't make it (see the header). */
export async function declineGroupMeeting(
  supabase: SupabaseClient,
  args: { booking: MeetingBooking; recipient: PollRecipient },
  deps: AcceptDeps & { updateEvent?: typeof updateCalendarEvent } = {},
): Promise<{ ok: true; booking: MeetingBooking; recipient: PollRecipient } | ManageFailure> {
  const now = (deps.now ?? Date.now)()
  const { booking, recipient } = args
  const blocked = changeable(booking, now)
  if (blocked) return blocked
  if (recipient.attending !== true) return { ok: false, code: 'CLOSED', message: "You're not on this meeting any more." }
  try {
    const declined = await markDeclined(supabase, recipient.id, new Date(now).toISOString())
    if (!declined) return { ok: false, code: 'CLOSED', message: 'This meeting changed just now. Reload to see it.' }
    const poll = booking.offerId ? await getPoll(supabase, booking.offerId) : null
    const staying = (poll?.recipients ?? []).filter((r) => r.attending && r.id !== recipient.id)
    if (booking.calendarEventId && recipient.email) {
      const emails = [...staying.map((r) => r.email).filter((e): e is string => !!e), ...(await coHostEmails(booking.workspaceId, booking.otherHostIds, deps))]
      try {
        await (deps.updateEvent ?? updateCalendarEvent)(booking.hostUserId, booking.calendarEventId, { attendees: [...new Set(emails)] }, { accountId: booking.calendarAccountId ?? undefined, notifyAttendees: true })
      } catch (err) {
        // The calendar still has them: so does the meeting.
        await unmarkDeclined(supabase, recipient.id).catch(() => {})
        return { ok: false, code: 'FAILED', message: `The calendar couldn't take you off (${err instanceof Error ? err.message : String(err)}). Nothing changed: try again in a moment.` }
      }
    }
    const zone = await hostZone(supabase, booking)
    await tellOf(supabase, deps)({
      workspaceId: booking.workspaceId,
      userId: booking.hostUserId,
      messageId: `meeting-booking:${booking.id}:declined:${recipient.id}`,
      text: pollDeclinedReport(booking, zone, recipient.name, staying.map((r) => r.name)),
      routes: true,
    }).catch(() => false)
    return { ok: true, booking, recipient: declined }
  } catch (err) {
    return { ok: false, code: 'FAILED', message: err instanceof Error ? err.message : String(err) }
  }
}

// ── Reminders and expiry ────────────────────────────────────────────────────

/** The guests a reminder would go to now (see the header). Pure. */
export function nudgeTargets(poll: TimeOfferPoll, now: number): PollRecipient[] {
  if (poll.state !== 'open' || Date.parse(poll.expiresAt) <= now) return []
  return poll.recipients.filter((r) => r.sent && !r.answeredAt && r.nudges < POLL_NUDGES_MAX && (!r.nudgedAt || Date.parse(r.nudgedAt) <= now - POLL_NUDGE_GAP_MS))
}

/** The sweep's line to the host for a poll that lapsed unbooked. Best effort. */
export async function reportPollExpired(supabase: SupabaseClient, offerId: string, deps: Pick<AcceptDeps, 'tellHost' | 'now'> = {}): Promise<void> {
  try {
    const poll = await getPoll(supabase, offerId)
    if (!poll || !poll.sentVia) return
    const now = (deps.now ?? Date.now)()
    // The best option among the times that were offered, as the answers stood.
    const asOffered = { ...poll, slots: poll.slots.map((s) => ({ ...s, state: 'open' as const })) }
    const best = bestSlot(asOffered, Math.min(now, Date.parse(poll.expiresAt) - 1))
    await tellOf(supabase, deps)({
      workspaceId: poll.workspaceId,
      userId: poll.hostUserId,
      messageId: `time-offer:${poll.id}:expired`,
      text: pollExpiredReport(poll, poll.recipients.filter((r) => !r.answeredAt).map((r) => r.name), best && best.can.length ? best : null),
      routes: true,
    }).catch(() => false)
  } catch {
    // The report is a courtesy: the poll is closed either way.
  }
}
