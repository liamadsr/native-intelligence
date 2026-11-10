/**
 * A text from a number nobody linked (src/lib/sms/inbound.ts), when it is a
 * guest's (guest access). Guests always text first: Native Intelligence never texts a
 * guest who hasn't. In this order:
 *
 *   1. an active guest's text goes to their own agent: written into their
 *      thread (chat_conversations.agent_guest_id, outside_channel 'sms') as
 *      their message, and a text turn is requested with their `guestId`
 *      (the turn's token says so, and their agent answers). Past their daily
 *      cap, one notice a day, then silence;
 *   2. a text carrying an invite code meant for this number (the code is
 *      hashed with the guest's id and number, so it works from that phone
 *      only) makes them active, and the welcome says who they are texting,
 *      with the compliance lines;
 *   3. "JOIN <code> [name]" with an owner's request code, while that owner
 *      lets people ask, is a request the owner approves in the People tab.
 *      A few a day per number;
 *   4. anything else is not a guest's: null, and the unknown-number reply
 *      takes it.
 *
 * Every reply here answers a number nobody verified, so it goes only to a
 * US/Canada number and counts toward the global auto-reply cap (the deps'
 * `autoReply`). STOP / START / HELP and the rate limit run before this, in
 * inbound.ts, for guests as for everyone.
 *
 * Pure over {@link GuestTextDeps}; {@link supabaseGuestTextDeps} is the real store.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { persistEveMessage } from '@/lib/chat/eve-message-writer'
import type { HomeTurnRequestedData } from '@/lib/chat/home-turn'
import { CHANNEL_MESSAGE_KIND, NI_CHANNEL, SLACK_CHANNEL, SMS_CHANNEL, smsMessageId } from '@/lib/chat/channel-turn'
import { TEXT_TURN_REQUESTED_EVENT } from '@/lib/chat/text-turn'
import { CODE_ALPHABET, REPLY_CODE_LENGTH } from '@/lib/safety/caller'
import { countGuestMessagesSince, countInboundKindSince, markInboundGuest } from '@/lib/sms/store'
import { ownerDisplayName } from './guest-turn'
import { postGuestRequest, recordGuestActivity } from './activity'
import {
  activateInvitedGuest,
  createGuestRequest,
  findActiveGuestByPhone,
  findOpenInvitesByPhone,
  findOpenRequestCode,
  guestInviteKey,
  inviteCodeMatches,
  touchGuestInbound,
  type AgentGuest,
  type GuestRequestResult,
} from './store'

/** Texts one guest may send their agent in a day (each is a turn the owner pays for). */
export const GUEST_DAILY_TEXT_CAP = 60
/** JOIN texts one number may send in a day. */
export const GUEST_JOIN_DAILY_CAP = 3
const DAY_MS = 24 * 60 * 60_000

export type GuestTextOutcome =
  | 'guest_queued'
  | 'guest_no_text'
  | 'guest_limited'
  | 'guest_limited_ignored'
  | 'guest_welcomed'
  | 'guest_conflict'
  | 'guest_requested'
  | 'guest_request_exists'
  | 'guest_request_refused'
  | 'guest_join_capped'

export interface GuestTextResult {
  outcome: GuestTextOutcome
  reply: string | null
}

export interface GuestTextDeps {
  findActiveGuest(phone: string): Promise<AgentGuest | null>
  findOpenInvites(phone: string, now: number): Promise<Array<{ guest: AgentGuest; inviteHash: string }>>
  activate(guest: AgentGuest, now: number): ReturnType<typeof activateInvitedGuest>
  findRequestCode(code: string): Promise<{ ownerUserId: string; workspaceId: string } | null>
  createRequest(input: { ownerUserId: string; workspaceId: string; phone: string; name: string | null }, now: number): Promise<GuestRequestResult>
  ownerName(ownerUserId: string, workspaceId: string): Promise<string>
  /** Mark the inbound row (its MessageSid) as a guest's. */
  markInbound(sid: string, kind: 'guest_text' | 'guest_invite' | 'guest_join' | 'limited', guestId: string | null): Promise<void>
  countGuestInboundSince(guestId: string, sinceMs: number): Promise<number>
  countJoinsSince(phone: string, sinceMs: number): Promise<number>
  /** True when a guest notice already went to this number since `sinceMs` (the once-a-day cap notice). */
  noticedSince(phone: string, sinceMs: number): Promise<boolean>
  /** Reply to a number nobody verified (NANP only, global hourly cap), recorded as `kind`; null when withheld. */
  autoReply(phone: string, kind: 'guest_welcome' | 'guest_notice', text: string, guestId: string | null): Promise<string | null>
  /** Write the text into the guest's thread and request its turn. */
  deliver(args: { guest: AgentGuest; text: string; sid: string }): Promise<void>
  /** The invite key (null: no invite can be checked, so none activates). */
  inviteKey: string | null
}

export function guestWelcomeReply(ownerName: string): string {
  return `You're set. This is ${ownerName}'s Dial8 agent: text it here anytime for help. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`
}

export function guestConflictReply(): string {
  return 'This number already texts another Dial8 agent, so this invite can’t be used. Ask whoever invited you to use a different number.'
}

export function guestRequestedReply(ownerName: string): string {
  return `Thanks. I've asked ${ownerName} to let you text their Dial8 agent. Text again once they say yes. Reply STOP to opt out.`
}

export function guestRequestExistsReply(ownerName: string): string {
  return `You've already asked ${ownerName}. Text again once they say yes. Reply STOP to opt out.`
}

export const GUEST_REQUEST_REFUSED_REPLY = "That request couldn't be sent. Ask the person directly. Reply STOP to opt out."

export function guestLimitedReply(ownerName: string): string {
  return `That's the most texts ${ownerName}'s agent can answer today. Try again tomorrow.`
}

/** Six-character tokens of the code alphabet in a text, uppercased (an invite text reads "Hi, it's Sam · K7Q4MX"). */
export function codeCandidates(text: string): string[] {
  const out = new Set<string>()
  for (const token of text.toUpperCase().split(/[^A-Z0-9]+/)) {
    if (token.length === REPLY_CODE_LENGTH && [...token].every((c) => CODE_ALPHABET.includes(c))) out.add(token)
    if (out.size >= 4) break
  }
  return [...out]
}

/** "JOIN <code> [name]": the code and the name they gave, or null. */
export function parseJoin(text: string): { code: string; name: string | null } | null {
  const match = /^\s*join\s+([a-z0-9]{6})(?:[\s,.:-]+(.+?))?\s*$/i.exec(text)
  if (!match) return null
  const name = match[2]?.replace(/\s+/g, ' ').trim().slice(0, 80) || null
  return { code: match[1].toUpperCase(), name }
}

/**
 * A text from an unlinked number, as a guest's: the result, or null when it
 * isn't one (the unknown-number reply takes it). `text` is the trimmed words
 * (empty for a picture alone). Throws on a failed store call.
 */
export async function handleGuestText(
  input: { phone: string; text: string; sid: string | null; numMedia: number },
  deps: GuestTextDeps,
  now: number = Date.now(),
): Promise<GuestTextResult | null> {
  const { phone, text, sid } = input

  // 1. An active guest: their agent.
  const active = await deps.findActiveGuest(phone)
  if (active) {
    if (!text || !sid) {
      return { outcome: 'guest_no_text', reply: input.numMedia > 0 ? "I can only read words for now, not pictures. Text me what you need." : null }
    }
    if ((await deps.countGuestInboundSince(active.id, now - DAY_MS)) >= GUEST_DAILY_TEXT_CAP) {
      await deps.markInbound(sid, 'limited', active.id)
      if (await deps.noticedSince(phone, now - DAY_MS)) return { outcome: 'guest_limited_ignored', reply: null }
      const reply = await deps.autoReply(phone, 'guest_notice', guestLimitedReply(await deps.ownerName(active.ownerUserId, active.workspaceId)), active.id)
      return { outcome: reply ? 'guest_limited' : 'guest_limited_ignored', reply }
    }
    await deps.markInbound(sid, 'guest_text', active.id)
    await deps.deliver({ guest: active, text, sid })
    return { outcome: 'guest_queued', reply: null }
  }
  if (!text || !sid) return null

  // 2. An invite code meant for this number.
  const candidates = codeCandidates(text)
  if (candidates.length && deps.inviteKey) {
    const invites = await deps.findOpenInvites(phone, now)
    for (const { guest, inviteHash } of invites) {
      if (!candidates.some((code) => inviteCodeMatches(code, { guestId: guest.id, phone }, inviteHash, deps.inviteKey as string))) continue
      await deps.markInbound(sid, 'guest_invite', guest.id)
      const activated = await deps.activate(guest, now)
      if (activated.ok) {
        const reply = await deps.autoReply(phone, 'guest_welcome', guestWelcomeReply(await deps.ownerName(guest.ownerUserId, guest.workspaceId)), guest.id)
        return { outcome: 'guest_welcomed', reply }
      }
      if (activated.reason === 'conflict') {
        return { outcome: 'guest_conflict', reply: await deps.autoReply(phone, 'guest_notice', guestConflictReply(), guest.id) }
      }
      // Used or removed in the meantime, or a failed write: not a guest's text after all.
      return null
    }
  }

  // 3. A JOIN request.
  const join = parseJoin(text)
  if (join) {
    const owner = await deps.findRequestCode(join.code)
    if (!owner) return null
    if ((await deps.countJoinsSince(phone, now - DAY_MS)) >= GUEST_JOIN_DAILY_CAP) {
      await deps.markInbound(sid, 'guest_join', null)
      return { outcome: 'guest_join_capped', reply: null }
    }
    const made = await deps.createRequest({ ownerUserId: owner.ownerUserId, workspaceId: owner.workspaceId, phone, name: join.name }, now)
    await deps.markInbound(sid, 'guest_join', made.ok ? made.guest.id : (made.guest?.id ?? null))
    const ownerName = await deps.ownerName(owner.ownerUserId, owner.workspaceId)
    if (made.ok) return { outcome: 'guest_requested', reply: await deps.autoReply(phone, 'guest_notice', guestRequestedReply(ownerName), made.guest.id) }
    if (made.reason === 'exists') return { outcome: 'guest_request_exists', reply: await deps.autoReply(phone, 'guest_notice', guestRequestExistsReply(ownerName), made.guest?.id ?? null) }
    return { outcome: 'guest_request_refused', reply: await deps.autoReply(phone, 'guest_notice', GUEST_REQUEST_REFUSED_REPLY, null) }
  }
  return null
}

// ── The guest's thread ──────────────────────────────────────────────────────

/**
 * The guest's own thread, made on their first message (one per guest:
 * uidx_chat_conversations_guest), whichever channel it came by: `channel`
 * only marks it when it is made. Throws on a failed write.
 */
export async function ensureGuestThread(
  supabase: SupabaseClient,
  guest: Pick<AgentGuest, 'id' | 'ownerUserId' | 'workspaceId' | 'displayName'>,
  channel: typeof SMS_CHANNEL | typeof SLACK_CHANNEL | typeof NI_CHANNEL = SMS_CHANNEL,
): Promise<{ id: string }> {
  const find = async () => {
    const { data, error } = await supabase
      .from('chat_conversations')
      .select('id')
      .eq('agent_guest_id', guest.id)
      .eq('user_id', guest.ownerUserId)
      .maybeSingle<{ id: string }>()
    if (error) throw new Error(`guest thread read failed: ${error.message}`)
    return data ?? null
  }
  const existing = await find()
  if (existing) return existing
  const { data, error } = await supabase
    .from('chat_conversations')
    .insert({
      user_id: guest.ownerUserId,
      workspace_id: guest.workspaceId,
      agent_guest_id: guest.id,
      outside_channel: channel,
      title: (channel === NI_CHANNEL ? `${guest.displayName}'s agent` : `${channel === SLACK_CHANNEL ? 'Slack' : 'Texts'} with ${guest.displayName}`).slice(0, 120),
    })
    .select('id')
    .single<{ id: string }>()
  if (data) return data
  // Two first texts raced: the other one made it.
  if ((error as { code?: string } | null)?.code === '23505') {
    const raced = await find()
    if (raced) return raced
  }
  throw new Error(`guest thread create failed: ${error?.message ?? 'no row'}`)
}

/** Seams for the tests. */
export interface DeliverGuestTextDeps {
  send?: (event: { name: string; id: string; data: HomeTurnRequestedData }) => Promise<unknown>
  /** The owner's log line (recordGuestActivity; a test passes its own). */
  logActivity?: typeof recordGuestActivity
}

/**
 * Write a guest's text into their thread as their message (`sms-in:<sid>`, so
 * a retried webhook converges on one message) and request its text turn with
 * their `guestId`. Throws when the message could not be written.
 */
export async function deliverGuestText(
  supabase: SupabaseClient,
  args: { guest: AgentGuest; text: string; sid: string },
  deps: DeliverGuestTextDeps = {},
): Promise<{ conversationId: string }> {
  const { guest, text, sid } = args
  const thread = await ensureGuestThread(supabase, guest)
  const written = await persistEveMessage(supabase, {
    conversationId: thread.id,
    userId: guest.ownerUserId,
    workspaceId: guest.workspaceId,
    role: 'user',
    parts: [{ type: 'text', text }],
    messageId: smsMessageId(sid),
    metadata: { kind: CHANNEL_MESSAGE_KIND, channel: SMS_CHANNEL, twilio_sid: sid, guest_id: guest.id },
  })
  if (!written.written && written.reason) throw new Error(`guest text not written (${written.reason})`)
  // The owner's log line (./activity.ts): a retried webhook found the text already written, and logs nothing again.
  if (written.written) await (deps.logActivity ?? recordGuestActivity)(supabase, { guest, conversationId: thread.id, messageId: smsMessageId(sid), text })
  const data: HomeTurnRequestedData = {
    conversationId: thread.id,
    userId: guest.ownerUserId,
    workspaceId: guest.workspaceId,
    workItemIds: [],
    reason: 'text',
    guestId: guest.id,
  }
  await (deps.send ?? ((e) => inngest.send(e as never)))({ name: TEXT_TURN_REQUESTED_EVENT, id: `text-turn-${sid}`, data })
  return { conversationId: thread.id }
}

/** The real store behind {@link handleGuestText}. `autoReply` is the inbound handler's (NANP, global cap). */
export function supabaseGuestTextDeps(
  supabase: SupabaseClient,
  args: { autoReply: GuestTextDeps['autoReply']; noticedSince: GuestTextDeps['noticedSince'] },
): GuestTextDeps {
  return {
    findActiveGuest: (phone) => findActiveGuestByPhone(supabase, phone),
    findOpenInvites: (phone, now) => findOpenInvitesByPhone(supabase, phone, now),
    activate: (guest, now) => activateInvitedGuest(supabase, guest, now),
    findRequestCode: (code) => findOpenRequestCode(supabase, code),
    createRequest: async (input, now) => {
      const made = await createGuestRequest(supabase, input, now)
      // The owner's card to allow or ignore them (./activity.ts).
      if (made.ok) await postGuestRequest(supabase, made.guest, now)
      return made
    },
    ownerName: (ownerUserId, workspaceId) => ownerDisplayName(supabase, ownerUserId, workspaceId),
    markInbound: (sid, kind, guestId) => markInboundGuest(supabase, sid, kind, guestId),
    countGuestInboundSince: (guestId, sinceMs) => countGuestMessagesSince(supabase, guestId, 'in', sinceMs),
    countJoinsSince: (phone, sinceMs) => countInboundKindSince(supabase, phone, 'guest_join', sinceMs),
    noticedSince: args.noticedSince,
    autoReply: args.autoReply,
    deliver: async ({ guest, text, sid }) => {
      await deliverGuestText(supabase, { guest, text, sid })
      await touchGuestInbound(supabase, guest.id)
    },
    inviteKey: guestInviteKey(),
  }
}
