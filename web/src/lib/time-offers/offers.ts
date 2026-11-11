/**
 * Making a time offer (availability phase 3a), and letting it go:
 *
 *   planOffer      the request read and checked, nothing written: the
 *                  recipient (a name; an email and/or a phone), what, how
 *                  long, two or three times, where, the expiry (3 days by
 *                  default, never after the first time starts). The times are
 *                  read in the host's zone when they carry no offset.
 *   createOffer    each time checked free on the host's calendar right now
 *                  (src/lib/availability/slot-check.ts, strict: a calendar
 *                  that can't be read refuses the offer), a Google or Outlook
 *                  calendar there to book on, then the offer, its slots and a
 *                  HOLD on each time (host_time_claim: an overlap with any
 *                  other claim refuses it). Linked to the CRM contact the
 *                  email or phone matches; no contact is made and nothing is
 *                  enriched. An open offer gets its link's token now; one
 *                  waiting on the person's approval card ('pending_send')
 *                  gets it when it is sent (./send.ts).
 *   withdrawOffer  the host takes it back: its holds go.
 *   closeOffer     it expired, or its card was declined or lapsed: its holds go.
 *
 * Server only; service role. Never throws: every outcome is a result.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { readRangeEdge } from '@/lib/integrations/calendar-zone'
import { isTimeZone } from '@/lib/chat-cards/calendar'
import { readWorkingHours } from '@/lib/availability/schedule'
import { checkSpansFree } from '@/lib/availability/slot-check'
import { findContactByEmailOrPhone } from '@/lib/customers/contacts'
import { hasLink } from '@/lib/customers/quote-reply-input'
import { normalizeE164 } from '@/lib/twilio/phone'
import { bookingCalendarAccount } from './host-calendar'
import { countLiveOffers, deleteHolds, deleteOffer, getOffer, insertHolds, insertOffer, moveOffer, pendingOfferWithCard, releaseSlots } from './store'
import { mintOfferToken, offerTokenHash } from './tokens'
import {
  EMAIL_MAX,
  LOCATION_MAX,
  OFFER_DEFAULT_TTL_MS,
  OFFER_HORIZON_MS,
  OFFER_LEAD_MS,
  OFFER_MAX_TTL_MS,
  OFFER_MESSAGE_MAX,
  OFFER_SLOTS_MAX,
  OFFER_SLOTS_MIN,
  OPEN_OFFERS_MAX,
  RECIPIENT_NAME_MAX,
  TITLE_MAX,
  type OfferState,
  type SendBy,
  type TimeOffer,
} from './types'
import { slotLabel } from './words'

export type OfferRefusal = { ok: false; code: string; message: string }
const refuse = (code: string, message: string): OfferRefusal => ({ ok: false, code, message })

export interface OfferRequest {
  workspaceId: string
  /** The person offering: the times are theirs, on their calendar. */
  hostUserId: string
  recipient: { name: string; email?: string | null; phone?: string | null }
  title: string
  /** ISO starts: with an offset as find_times gives them, or a wall-clock time in the host's zone. */
  slots: readonly string[]
  durationMinutes: number
  video?: boolean
  location?: string | null
  message?: string | null
  expiresAt?: string | null
  sendBy: SendBy
  /** This turn's browser zone: the host's zone when their hours follow them (as find_times reads it). */
  browserTimeZone?: string | null
}

export interface PlannedOffer {
  workspaceId: string
  hostUserId: string
  hostName: string
  timeZone: string
  recipient: { name: string; email: string | null; phone: string | null }
  title: string
  durationMinutes: number
  video: boolean
  location: string | null
  message: string | null
  expiresAt: string
  slots: Array<{ startsAt: string; endsAt: string }>
  sendBy: SendBy
}

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/

/** One line of someone's words: whitespace collapsed, cut to `max`. Null when empty. Pure. */
export function oneLine(value: string | null | undefined, max: number): string | null {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return text ? text.slice(0, max) : null
}

/** An email as an offer keeps it (lower-cased), or null when it isn't one. Pure. */
export function cleanEmail(value: string | null | undefined): string | null {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return email && email.length <= EMAIL_MAX && EMAIL.test(email) ? email : null
}

/**
 * The request read in the host's zone, or why it can't be offered (see the
 * header). Pure.
 */
export function normalizeOfferRequest(
  req: OfferRequest,
  ctx: { timeZone: string; hostName: string; now: number },
): { ok: true; plan: PlannedOffer } | OfferRefusal {
  const name = oneLine(req.recipient.name, RECIPIENT_NAME_MAX)
  if (!name) return refuse('BAD_INPUT', "I need the recipient's name.")
  const rawEmail = typeof req.recipient.email === 'string' && req.recipient.email.trim() ? req.recipient.email : null
  const email = rawEmail ? cleanEmail(rawEmail) : null
  if (rawEmail && !email) return refuse('BAD_INPUT', `${rawEmail.slice(0, 80)} isn't an email address.`)
  const rawPhone = typeof req.recipient.phone === 'string' && req.recipient.phone.trim() ? req.recipient.phone : null
  const phone = rawPhone ? normalizeE164(rawPhone) : null
  if (rawPhone && !phone) return refuse('BAD_INPUT', `${rawPhone.slice(0, 30)} isn't a phone number I can text (use +1 and the number).`)
  if (req.sendBy === 'email' && !email) return refuse('NEEDS_EMAIL', "send_by 'email' needs the recipient's email.")
  if (req.sendBy === 'text' && !phone) return refuse('NEEDS_PHONE', "send_by 'text' needs the recipient's mobile number.")

  const title = oneLine(req.title, TITLE_MAX)
  if (!title) return refuse('BAD_INPUT', 'Give the meeting a title, like "Intro call".')
  if (hasLink(title)) return refuse('HAS_LINK', "The title can't hold a link or a web address.")
  const message = oneLine(req.message, OFFER_MESSAGE_MAX)
  if (message && hasLink(message)) return refuse('HAS_LINK', "message can't hold a link or a web address: the only link an offer carries is its own. Say it without one.")
  const location = oneLine(req.location, LOCATION_MAX)
  const duration = Math.round(req.durationMinutes)
  if (!Number.isFinite(duration) || duration < 5 || duration > 480) return refuse('BAD_INPUT', 'duration_minutes is 5 to 480.')

  if (req.slots.length < OFFER_SLOTS_MIN || req.slots.length > OFFER_SLOTS_MAX) return refuse('BAD_INPUT', `Offer ${OFFER_SLOTS_MIN} or ${OFFER_SLOTS_MAX} times.`)
  const starts: number[] = []
  for (const raw of req.slots) {
    const value = String(raw).trim()
    if (!/\d{2}:\d{2}/.test(value)) return refuse('BAD_INPUT', `${value.slice(0, 40)} has no time of day: give each time as a date-time from find_times.`)
    const at = readRangeEdge(value, ctx.timeZone, 'start')
    if (at === null) return refuse('BAD_INPUT', `${value.slice(0, 40)} isn't a time I can read.`)
    starts.push(at)
  }
  starts.sort((a, b) => a - b)
  const ms = duration * 60_000
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] < ctx.now + OFFER_LEAD_MS) return refuse('PAST', `${slotLabel(starts[i], ctx.timeZone)} has passed or starts too soon to offer.`)
    if (starts[i] > ctx.now + OFFER_HORIZON_MS) return refuse('TOO_FAR', 'Offer times within the next 60 days.')
    if (i > 0 && starts[i - 1] + ms > starts[i]) return refuse('OVERLAP', 'Two of the times overlap: offer different times.')
  }

  // On the hour, so the same offer asked again within the hour reads the same (its card reuses its offer).
  let expires = Math.floor((ctx.now + OFFER_DEFAULT_TTL_MS) / 3_600_000) * 3_600_000
  if (req.expiresAt) {
    const at = readRangeEdge(req.expiresAt, ctx.timeZone, 'end')
    if (at === null) return refuse('BAD_INPUT', `${req.expiresAt.slice(0, 40)} isn't a date I can read for the expiry.`)
    expires = at
  }
  // Never open after the first time starts, nor longer than two weeks.
  expires = Math.min(expires, starts[0], ctx.now + OFFER_MAX_TTL_MS)
  if (expires <= ctx.now + 60_000) return refuse('BAD_INPUT', 'The offer would expire right away: pick a later expiry.')

  return {
    ok: true,
    plan: {
      workspaceId: req.workspaceId,
      hostUserId: req.hostUserId,
      hostName: ctx.hostName,
      timeZone: ctx.timeZone,
      recipient: { name, email, phone },
      title,
      durationMinutes: duration,
      video: req.video !== false,
      location,
      message,
      expiresAt: new Date(expires).toISOString(),
      slots: starts.map((start) => ({ startsAt: new Date(start).toISOString(), endsAt: new Date(start + ms).toISOString() })),
      sendBy: req.sendBy,
    },
  }
}

export interface OfferDeps {
  now?: () => number
  /** The host's zone (default: their working hours' zone, this turn's browser zone when their hours follow them). */
  timeZone?: (req: OfferRequest) => Promise<string>
  checkFree?: typeof checkSpansFree
  calendarAccount?: typeof bookingCalendarAccount
  findContact?: (workspaceId: string, who: { email: string | null; phone: string | null }) => Promise<{ id: string } | null>
}

/** The host's name as a guest reads it: their display name in the workspace, else the workspace's name. Throws on a failed read. */
async function hostDisplayName(supabase: SupabaseClient, workspaceId: string, userId: string): Promise<string | null> {
  const { data, error } = await supabase.from('member').select('display_name').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle<{ display_name: string | null }>()
  if (error) throw new Error(`member read failed: ${error.message}`)
  if (!data) return null
  const name = oneLine(data.display_name, 80)
  if (name) return name
  const ws = await supabase.from('workspace').select('name').eq('id', workspaceId).maybeSingle<{ name: string | null }>()
  return oneLine(ws.data?.name, 80) ?? 'Your host'
}

async function defaultZone(supabase: SupabaseClient, req: OfferRequest): Promise<string> {
  const hours = await readWorkingHours(supabase, { userId: req.hostUserId, workspaceId: req.workspaceId })
  return hours.zoneSource === 'member' && isTimeZone(req.browserTimeZone) ? req.browserTimeZone : hours.timeZone
}

/** The request read and checked (see the header); nothing is written. */
export async function planOffer(supabase: SupabaseClient, req: OfferRequest, deps: OfferDeps = {}): Promise<{ ok: true; plan: PlannedOffer } | OfferRefusal> {
  try {
    const hostName = await hostDisplayName(supabase, req.workspaceId, req.hostUserId)
    if (!hostName) return refuse('NOT_A_MEMBER', 'Not a workspace member.')
    const timeZone = await (deps.timeZone ?? ((r) => defaultZone(supabase, r)))(req)
    return normalizeOfferRequest(req, { timeZone, hostName, now: (deps.now ?? Date.now)() })
  } catch (err) {
    return refuse('FAILED', `The offer couldn't be prepared: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export type CreateOfferResult = { ok: true; offer: TimeOffer; token: string | null; reused?: true } | OfferRefusal

/**
 * Check the times are free, then write the offer and hold them (see the
 * header). `pending_send` (an email or text offer, made for its approval
 * card) gets no token, and the same card asked again gets its offer back.
 */
export async function createOffer(
  supabase: SupabaseClient,
  plan: PlannedOffer,
  opts: { state: 'open' | 'pending_send'; createdBy: string | null; cardHash?: string | null },
  deps: OfferDeps = {},
): Promise<CreateOfferResult> {
  const now = (deps.now ?? Date.now)()
  const nowIso = new Date(now).toISOString()
  try {
    if (opts.state === 'pending_send' && opts.cardHash) {
      const same = await pendingOfferWithCard(supabase, plan.hostUserId, opts.cardHash, nowIso)
      if (same) return { ok: true, offer: same, token: null, reused: true }
    }
    if ((await countLiveOffers(supabase, plan.hostUserId, nowIso)) >= OPEN_OFFERS_MAX) {
      return refuse('TOO_MANY_OFFERS', `There are already ${OPEN_OFFERS_MAX} open offers holding your time. Withdraw some (list_time_offers) before offering more.`)
    }
    const account = await (deps.calendarAccount ?? bookingCalendarAccount)(supabase, plan.hostUserId, plan.workspaceId)
    if (!account) return refuse('NO_CALENDAR', 'No Google or Outlook calendar is connected in this workspace, so a picked time would have nowhere to go. Connect one first.')
    const spans = plan.slots.map((s) => ({ start: Date.parse(s.startsAt), end: Date.parse(s.endsAt) }))
    const free = await (deps.checkFree ?? checkSpansFree)({ userId: plan.hostUserId, workspaceId: plan.workspaceId, timeZone: plan.timeZone, spans })
    if (!free.known) return refuse('CALENDAR_UNKNOWN', `Your calendar couldn't be read (${free.reason}), so no times were offered. Try again in a moment.`)
    const busy = plan.slots.filter((_, i) => free.busy[i])
    if (busy.length) {
      return refuse('SLOT_TAKEN', `Something is already on your calendar (or held for another offer) at ${busy.map((s) => slotLabel(s.startsAt, plan.timeZone)).join(' and ')}. Pick other times with find_times.`)
    }
    const contact = await (deps.findContact ?? ((ws, who) => findContactByEmailOrPhone(supabase, ws, who)))(plan.workspaceId, { email: plan.recipient.email, phone: plan.recipient.phone }).catch(() => null)
    const token = opts.state === 'open' ? mintOfferToken() : null
    const offer = await insertOffer(supabase, {
      workspaceId: plan.workspaceId,
      hostUserId: plan.hostUserId,
      createdBy: opts.createdBy,
      hostName: plan.hostName,
      recipientName: plan.recipient.name,
      recipientEmail: plan.recipient.email,
      recipientPhone: plan.recipient.phone,
      contactId: contact?.id ?? null,
      title: plan.title,
      durationMinutes: plan.durationMinutes,
      video: plan.video,
      location: plan.location,
      message: plan.message,
      timeZone: plan.timeZone,
      state: opts.state,
      tokenHash: token ? offerTokenHash(token) : null,
      sentVia: opts.state === 'open' ? 'link' : null,
      cardHash: opts.cardHash ?? null,
      expiresAt: plan.expiresAt,
      slots: plan.slots,
    })
    const held = await insertHolds(supabase, offer)
    if (!held.ok) {
      await deleteOffer(supabase, offer.id)
      return held.conflict
        ? refuse('SLOT_TAKEN', 'One of those times was just held or booked by another offer. Pick other times with find_times.')
        : refuse('FAILED', `The times couldn't be held (${held.error}). Nothing was offered.`)
    }
    return { ok: true, offer, token }
  } catch (err) {
    return refuse('FAILED', `Nothing was offered: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * The offer leaves `from` for `to` and lets its time go: its holds deleted,
 * its open slots released. Null when it had moved on already. Throws on a
 * failed write.
 */
export async function closeOffer(supabase: SupabaseClient, offerId: string, from: readonly OfferState[], to: OfferState): Promise<TimeOffer | null> {
  const moved = await moveOffer(supabase, offerId, from, to)
  if (!moved) return null
  await deleteHolds(supabase, offerId)
  await releaseSlots(supabase, offerId)
  return moved
}

/** The host takes an offer back (open, or still waiting on its card). Never throws. */
export async function withdrawOffer(supabase: SupabaseClient, args: { workspaceId: string; userId: string; offerId: string }): Promise<{ ok: true; offer: TimeOffer } | OfferRefusal> {
  try {
    const offer = await getOffer(supabase, args.offerId, args.workspaceId)
    if (!offer || offer.hostUserId !== args.userId) return refuse('NOT_FOUND', 'No offer of yours with that id in this workspace (list_time_offers).')
    if (offer.state === 'booked') return refuse('BOOKED', 'That offer was already booked: cancel the meeting with cancel_offered_meeting instead.')
    if (offer.state !== 'open' && offer.state !== 'pending_send') return refuse('CLOSED', `That offer is already ${offer.state}.`)
    const closed = await closeOffer(supabase, offer.id, ['open', 'pending_send'], 'withdrawn')
    if (!closed) return refuse('CHANGED', 'That offer changed just now (it may have been booked). Check list_time_offers.')
    return { ok: true, offer: closed }
  } catch (err) {
    return refuse('FAILED', err instanceof Error ? err.message : String(err))
  }
}
