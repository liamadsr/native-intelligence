/**
 * The text turn's server half beyond the home-turn steps
 * (docs/plans/text-and-calling.md, Phase 1): keeping the person's words out of
 * Inngest step outputs, settling the turn, and texting the reply back (or a
 * short notice when the turn could not run). The turn itself is a home turn
 * with reason 'text' (home-turn-server.ts); its consumer
 * (src/lib/inngest/text-turn.ts) calls these.
 *
 * Privacy: a step output is stored by Inngest, so the plan step hands on the
 * texts' ids only and the send step reads the words back (redactChannelPlan
 * and hydrateChannelPlan, ./channel-turn-server.ts); the reply is read back from the home thread
 * inside the step that texts it ({@link sendTextTurnReply}), and the step that
 * finishes the turn returns its outcome only ({@link settleTextTurn}). The one
 * exception: a turn still running past a read step's budget carries its
 * partial parts to the next read step (the home-turn read state).
 *
 * Every send:
 *   - goes only to the person's own verified number (user_phone), never one
 *     that opted out (STOP). The person's own texts have no cap (Liam,
 *     2026-10-31: "We don't need a text cap");
 *   - comes from the number of the workspace it is about: a business's own
 *     number when that workspace has one and a text from their phone to it
 *     would come back to them (they are the person it resolves to: roadmap
 *     B2); else from their agent's own number when it has one
 *     (src/lib/sms/agent-number.ts), else the Native Intelligence one. A business-line
 *     phone (a business's own account on a phone whose Native Intelligence line is another
 *     account's, migration 464) only ever from a business number: with none,
 *     nothing goes ('no_line'), since its reply to a Native Intelligence number would reach
 *     the other account. A 21610 opts out the row of the person texted, the
 *     one row the sending number resolves to (from a Native Intelligence number, the
 *     Native Intelligence line). So one phone can talk to two workspaces' (or two
 *     accounts') agents, each on its own number, and a reply to either
 *     reaches the right one (src/lib/sms/inbound.ts, src/lib/sms/workspace-line.ts);
 *   - for a reply, is claimed on the row first (home_turn.reply_sent_at, one
 *     conditional update): a retried step never texts twice. At most once: a
 *     send that fails after the claim is not retried (the reply is in the
 *     home thread either way);
 *   - is formatted for a phone (../twilio/sms-format.ts), never cut: a long
 *     one goes as several texts, in order, each recorded in the sms_message
 *     ledger, all of them for the person (a guest's reply keeps its limits:
 *     {@link withinBudget}). Twilio's 21610 (the number opted out at the
 *     carrier) marks the number opted out.
 *
 * A guest's text turn (guest access, `data.guestId`) texts the guest back
 * instead ({@link textGuest}): only while they are active, never a number
 * that said STOP, never past their own daily cap, and its notices are worded
 * for them. A business's customer (preset 'customer', roadmap B2) is texted
 * from the business number they texted, never the Native Intelligence one. The approvals it raised are the owner's, in the app: none is
 * texted to anyone here.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { channelApprovalsRaisedSince } from '@/lib/attention/channel-approvals'
import { claimReachNotice, releaseTextedApproval } from '@/lib/reach/notice'
import { approvalPromptText } from '@/lib/sms/approvals'
import { sendSms, type SendSmsResult } from '@/lib/twilio/client'
import { appOrigin } from '@/lib/twilio/config'
import { formatSmsReply } from '@/lib/twilio/sms-format'
import { ownerDisplayName } from '@/lib/guests/guest-turn'
import { businessNumberById } from '@/lib/customers/numbers'
import { sendingLine } from '@/lib/sms/workspace-line'
import { agentSender } from '@/lib/sms/agent-number'
import { isNanpNumber } from '@/lib/twilio/phone'
import { homeTurnMessageId, isQuietReply, type HomeTurnRequestedData } from './home-turn'
import { replyTextOfParts } from './channel-reply'
import { finishHomeTurn, type HomeTurnPlanResult, type HomeTurnReadResult, type HomeTurnRow, type HomeTurnSkip } from './home-turn-server'
import {
  countGuestMessagesSince,
  linkedPhoneForUser,
  recordOutbound,
  setPhoneOptOut,
  setPhoneRowOptOut,
  unlinkedNumberOptedOut,
  type SmsOutboundKind,
} from '@/lib/sms/store'

const DAY_MS = 24 * 60 * 60_000
/** Texts Native Intelligence sends one guest in a day (replies and notices). */
export const GUEST_DAILY_OUTBOUND_CAP = 60
/**
 * The most texts one reply to a guest goes as (each up to 10 segments, ~15K
 * characters in all), and never more than their day's cap has left: a guest
 * asking their agent to read out a whole article can't send a burst a carrier
 * would filter. The person's own replies have no such limit.
 */
export const SMS_REPLY_MAX_TEXTS = 10

/** Why a text was not sent. */
export type TextSendSkip =
  | 'quiet'
  | 'already_sent'
  | 'no_phone'
  | 'opted_out'
  | 'daily_cap'
  | 'lookup_failed'
  | 'empty'
  /** A business-line phone with no business number to text it from (src/lib/sms/workspace-line.ts). */
  | 'no_line'
  | Extract<SendSmsResult, { ok: false }>['reason']

export type TextSendResult = { sent: true; sid: string } | { sent: false; reason: TextSendSkip }

/** Seams for the tests. */
export interface TextSendDeps {
  send?: typeof sendSms
  now?: () => number
  origin?: string
}

// ── The person's words out of step outputs: shared by every channel ──────────

export { hydrateChannelPlan, redactChannelPlan } from './channel-turn-server'

// ── Settling the turn ───────────────────────────────────────────────────────

/** What a settled text turn hands the consumer (ids and outcomes only). */
export interface TextTurnSettled {
  outcome: string
  written: boolean
  replied: boolean
  replyReason?: TextSendSkip
  /** The notice texted instead of a reply, when one was. */
  notice?: 'failed' | 'unfinished' | 'held'
  /** Approvals the turn held, texted after the reply with their codes. */
  approvals?: number
}

/**
 * Finish the turn (write the reply unless it is quiet), then text it back:
 * the reply when one is in the thread (written now, or by an earlier attempt:
 * reply_sent_at still guards a second send), a 'failed' notice for a turn
 * that failed, was cancelled or lost its session with nothing to say, a
 * 'held' one for a turn that put a call up for approval and said nothing
 * (its card is in the thread: finishHomeTurn) and texted no approval, an
 * 'unfinished' one for a turn still running at the read cap. Nothing for a
 * quiet turn, or one the person steered from the app. After the reply, each
 * call the turn held is texted with its reply code ({@link textRaisedApprovals}).
 * Never throws.
 */
export async function settleTextTurn(
  supabase: SupabaseClient,
  data: HomeTurnRequestedData,
  row: Pick<HomeTurnRow, 'id' | 'created_at'>,
  read: HomeTurnReadResult,
  deps: TextSendDeps & { finish?: typeof finishHomeTurn } = {},
): Promise<TextTurnSettled> {
  const finished = await (deps.finish ?? finishHomeTurn)(supabase, data, row, read)
  const outcome = read.done && read.end !== 'completed' ? `${finished.outcome}:${read.end}` : finished.outcome
  if (!read.done) {
    const sent = (await textTurnNotice(supabase, data, 'unfinished', deps)) ?? { sent: false as const, reason: 'empty' as const }
    return { outcome, written: finished.written, replied: false, notice: 'unfinished', ...(sent.sent ? {} : { replyReason: sent.reason }) }
  }
  const reply = await sendTextTurnReply(supabase, { userId: data.userId, workspaceId: data.workspaceId, conversationId: data.conversationId, rowId: row.id, guestId: data.guestId }, deps)
  // What the turn held for the person's yes goes to their phone, with its code.
  // A guest's held calls are the owner's to approve, in the app: never texted to the guest.
  const approvals = row.created_at && !data.guestId ? await textRaisedApprovals(supabase, { ...data, since: row.created_at }, deps) : 0
  const counted = approvals ? { approvals } : {}
  if (reply.sent) return { outcome, written: finished.written, replied: true, ...counted }
  if (approvals) return { outcome, written: finished.written, replied: false, replyReason: reply.reason, ...counted }
  if (reply.reason === 'quiet' && finished.heldApproval) {
    await textTurnNotice(supabase, data, 'held', deps)
    return { outcome, written: finished.written, replied: false, replyReason: reply.reason, notice: 'held' }
  }
  if (reply.reason === 'quiet' && (read.end === 'failed' || read.end === 'cancelled' || read.end === 'session_ended')) {
    await textTurnNotice(supabase, data, 'failed', deps)
    return { outcome, written: finished.written, replied: false, replyReason: reply.reason, notice: 'failed' }
  }
  return { outcome, written: finished.written, replied: false, replyReason: reply.reason }
}

// ── Texting ─────────────────────────────────────────────────────────────────

/**
 * Text each approval the turn raised (surface 'sms', since the turn began)
 * with its reply code, after the reply: claimed per approval first
 * (reach_notice), so a retried step never texts one twice. Returns how many
 * were texted. Never throws.
 */
export async function textRaisedApprovals(
  supabase: SupabaseClient,
  scope: { userId: string; workspaceId: string; conversationId: string; since: string },
  deps: TextSendDeps = {},
): Promise<number> {
  let texted = 0
  for (const approval of await channelApprovalsRaisedSince(supabase, { ...scope, surface: 'sms' })) {
    const claim = await claimReachNotice(supabase, { userId: scope.userId, workspaceId: scope.workspaceId, approvalId: approval.approvalId, channel: 'sms' })
    if (claim === 'taken') continue
    const sent = await textPerson(supabase, { userId: scope.userId, workspaceId: scope.workspaceId, body: approvalPromptText(approval), kind: 'needs_you' }, deps)
    if (sent.sent) texted++
    // An ask that never reached the phone isn't one a plain "yes" may answer.
    else await releaseTextedApproval(supabase, { userId: scope.userId, approvalId: approval.approvalId })
  }
  return texted
}

/**
 * Text `body` to the person's verified number (the shared path of a reply, a
 * notice and a message the router sends while they are away): every text it
 * becomes, in order, with no daily cap and no per-reply limit (Liam,
 * 2026-10-31). It comes from `workspaceId`'s own number when a text back to
 * it would reach them, and a business-line phone hears only from such a
 * number (sendingLine, src/lib/sms/workspace-line.ts: 'no_line' otherwise).
 * Never throws.
 */
export async function textPerson(
  supabase: SupabaseClient,
  args: {
    userId: string
    /**
     * The workspace the text is about: its business number sends it, when it
     * has one. null: about their own agent, not one workspace (their agent's
     * number, src/lib/sms/agent-number.ts): their agent's number or the Native Intelligence
     * one, and nothing to a business-line phone, whose reply there would
     * reach the other account.
     */
    workspaceId: string | null
    body: string
    kind: Extract<SmsOutboundKind, 'reply' | 'notice' | 'welcome' | 'needs_you' | 'away'>
  },
  deps: TextSendDeps = {},
): Promise<TextSendResult> {
  const bodies = formatSmsReply(args.body, { origin: deps.origin ?? appOrigin() })
  if (bodies.length === 0) return { sent: false, reason: 'empty' }
  let phone: Awaited<ReturnType<typeof linkedPhoneForUser>>
  try {
    phone = await linkedPhoneForUser(supabase, args.userId)
    if (!phone) return { sent: false, reason: 'no_phone' }
    if (phone.optedOut) return { sent: false, reason: 'opted_out' }
  } catch {
    return { sent: false, reason: 'lookup_failed' }
  }
  const to = phone.phone
  const rowId = phone.id
  const from = args.workspaceId ? await sendingLine(supabase, phone, args.workspaceId) : phone.line === 'business' ? 'no_line' : null
  if (from === 'no_line') return { sent: false, reason: 'no_line' }
  const sender = from ? null : await agentSender(supabase, args.userId, (deps.now ?? Date.now)())
  return sendTexts(
    to,
    bodies,
    deps,
    {
      sent: (sid) => recordOutbound(supabase, { phone: to, kind: args.kind, sid, userId: args.userId }),
      // A 21610 is a STOP to the number that sent it (the carrier blocks that
      // pair): from a business's number, the row of the person texted, which
      // is the row a STOP to that number would change; from a Native Intelligence number
      // (theirs or Native Intelligence's), the NI-line row. Never another account's row.
      unsubscribed: from ? () => setPhoneRowOptOut(supabase, rowId, true).catch(() => {}) : () => setPhoneOptOut(supabase, to, true).catch(() => {}),
    },
    { from, sender },
  )
}

/**
 * A guest's reply's texts held to {@link SMS_REPLY_MAX_TEXTS} and to what
 * their day's cap has left (`left`, at least 1). Past either, the last text
 * that fits says where the rest is (`closing`), when there is somewhere.
 * Pure.
 */
export function withinBudget(bodies: readonly string[], left: number, closing?: string): string[] {
  const max = Math.max(1, Math.min(SMS_REPLY_MAX_TEXTS, left))
  if (bodies.length <= max) return [...bodies]
  return closing && max > 1 ? [...bodies.slice(0, max - 1), closing] : bodies.slice(0, max)
}

/**
 * Send a reply's texts to `to` in order, recording each as it goes, and stop
 * at the first refused one (a later text never arrives before an earlier
 * one). Sent when the first text went; its sid is the reply's. Never throws.
 */
async function sendTexts(
  to: string,
  bodies: readonly string[],
  deps: TextSendDeps,
  on: { sent: (sid: string) => Promise<unknown>; unsubscribed?: () => Promise<unknown> },
  /** `from`: a business's own number (a customer's reply, or a text about that business: roadmap B2); `sender`: the person's agent number; else the Native Intelligence one. */
  via: { from?: string | null; sender?: string | null } = {},
): Promise<TextSendResult> {
  let first: string | null = null
  for (const body of bodies) {
    const send = deps.send ?? sendSms
    const result = via.from ? await send(to, body, { from: via.from }) : via.sender ? await send(to, body, { sender: via.sender }) : await send(to, body)
    if (!result.ok) {
      if (result.reason === 'unsubscribed') await on.unsubscribed?.()
      return first ? { sent: true, sid: first } : { sent: false, reason: result.reason }
    }
    first ??= result.sid
    await on.sent(result.sid)
  }
  return first ? { sent: true, sid: first } : { sent: false, reason: 'empty' }
}

/**
 * Text `body` to a guest (guest access): their number, only while they are
 * active, never one that said STOP (the ledger, as for any unlinked number,
 * or their row), and never past {@link GUEST_DAILY_OUTBOUND_CAP}. A long
 * reply goes as several texts, never cut short of {@link withinBudget}'s
 * limits. Never throws.
 */
export async function textGuest(
  supabase: SupabaseClient,
  args: { guestId: string; ownerUserId: string; body: string; kind: Extract<SmsOutboundKind, 'guest_reply' | 'guest_notice'> },
  deps: TextSendDeps = {},
): Promise<TextSendResult> {
  const bodies = formatSmsReply(args.body, { origin: deps.origin ?? appOrigin() })
  if (bodies.length === 0) return { sent: false, reason: 'empty' }
  let phone: string
  let sentToday: number
  let from: string | null = null
  try {
    const { data, error } = await supabase
      .from('agent_guest')
      .select('phone_e164, state, opted_out_at, preset, business_number_id')
      .eq('id', args.guestId)
      .eq('owner_user_id', args.ownerUserId)
      .maybeSingle<{ phone_e164: string; state: string; opted_out_at: string | null; preset: string; business_number_id: string | null }>()
    if (error) return { sent: false, reason: 'lookup_failed' }
    if (!data || data.state !== 'active') return { sent: false, reason: 'no_phone' }
    phone = data.phone_e164
    // A business's customer is answered from the number they texted, never the Native Intelligence one.
    if (data.preset === 'customer') {
      // A US or Canadian number only, as every text Native Intelligence sends to someone unverified.
      if (!isNanpNumber(phone)) return { sent: false, reason: 'no_phone' }
      const number = data.business_number_id ? await businessNumberById(supabase, data.business_number_id) : null
      if (!number) return { sent: false, reason: 'no_phone' }
      from = number.phone
    }
    if (data.opted_out_at !== null || (await unlinkedNumberOptedOut(supabase, phone))) return { sent: false, reason: 'opted_out' }
    sentToday = await countGuestMessagesSince(supabase, args.guestId, 'out', (deps.now ?? Date.now)() - DAY_MS)
    if (sentToday >= GUEST_DAILY_OUTBOUND_CAP) return { sent: false, reason: 'daily_cap' }
  } catch {
    return { sent: false, reason: 'lookup_failed' }
  }
  const to = phone
  return sendTexts(to, withinBudget(bodies, GUEST_DAILY_OUTBOUND_CAP - sentToday), deps, { sent: (sid) => recordOutbound(supabase, { phone: to, kind: args.kind, sid, guestId: args.guestId }) }, { from })
}

/** Text `body` back to whoever this text turn answers: the person, or the guest. Never throws. */
function textBack(
  supabase: SupabaseClient,
  data: Pick<HomeTurnRequestedData, 'userId' | 'workspaceId' | 'guestId'>,
  body: string,
  which: 'reply' | 'notice',
  deps: TextSendDeps,
): Promise<TextSendResult> {
  return data.guestId
    ? textGuest(supabase, { guestId: data.guestId, ownerUserId: data.userId, body, kind: which === 'reply' ? 'guest_reply' : 'guest_notice' }, deps)
    : textPerson(supabase, { userId: data.userId, workspaceId: data.workspaceId, body, kind: which }, deps)
}

/**
 * Text the notice for `reason` to whoever this text turn answers (the
 * person's, or the guest's own wording); null when there is nothing to say.
 * Never throws.
 */
export async function textTurnNotice(
  supabase: SupabaseClient,
  data: Pick<HomeTurnRequestedData, 'userId' | 'workspaceId' | 'guestId'>,
  reason: Parameters<typeof textTurnSkipNotice>[0],
  deps: TextSendDeps = {},
): Promise<TextSendResult | null> {
  let notice: string | null
  if (data.guestId) {
    const owner = reason === 'held' ? await ownerDisplayName(supabase, data.userId, data.workspaceId).catch(() => 'the owner') : 'the owner'
    notice = guestTextTurnSkipNotice(reason, owner)
  } else {
    notice = textTurnSkipNotice(reason)
  }
  return notice ? textBack(supabase, data, notice, 'notice', deps) : null
}

/**
 * Text a finished text turn's reply (its final answer: replyTextOfParts),
 * read back from the home thread (`home-turn:<row>`): so it is texted
 * whether this attempt wrote it or an
 * earlier one did (a replayed write is no reply lost). Nothing when there is
 * none, or it is empty or `[quiet]`. Claims the row's reply_sent_at first, so
 * a retried step never sends twice. Never throws.
 */
export async function sendTextTurnReply(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string; conversationId: string; rowId: string; /** A guest's turn: the reply goes to them. */ guestId?: string },
  deps: TextSendDeps = {},
): Promise<TextSendResult> {
  let text: string
  try {
    const { data, error } = await supabase
      .from('chat_messages')
      .select('ui_message')
      .eq('conversation_id', args.conversationId)
      .eq('user_id', args.userId)
      .eq('ui_message->>id', homeTurnMessageId(args.rowId))
      .maybeSingle<{ ui_message: { parts?: unknown } | null }>()
    if (error) return { sent: false, reason: 'lookup_failed' }
    text = replyTextOfParts(data?.ui_message?.parts)
  } catch {
    return { sent: false, reason: 'lookup_failed' }
  }
  if (isQuietReply(text)) return { sent: false, reason: 'quiet' }
  const claimed = await claimReply(supabase, args.rowId, deps.now)
  if (!claimed) return { sent: false, reason: 'already_sent' }
  return textBack(supabase, args, text, 'reply', deps)
}

/** One conditional update: true when this call set reply_sent_at (nobody had). */
async function claimReply(supabase: SupabaseClient, rowId: string, now?: () => number): Promise<boolean> {
  try {
    const at = new Date((now ?? Date.now)()).toISOString()
    const { data, error } = await supabase.from('home_turn').update({ reply_sent_at: at, updated_at: at }).eq('id', rowId).is('reply_sent_at', null).select('id')
    return !error && Array.isArray(data) && data.length > 0
  } catch {
    return false
  }
}

/**
 * What the person is told when their text could not become a turn, or null to
 * say nothing (a duplicate, nothing new: another turn answers it).
 */
export function textTurnSkipNotice(reason: HomeTurnSkip | 'busy' | 'failed' | 'unfinished' | 'held'): string | null {
  switch (reason) {
    case 'question_pending':
      return 'You have a question from me waiting in Native Intelligence. Answer it there, then text me again.'
    case 'autonomy_off':
      return "Native Intelligence's agent is switched off for this workspace (Settings > Autonomy), so I can't act on texts right now."
    case 'usage_limited':
      return "You've reached your Native Intelligence usage limit, so I can't answer texts right now. Check Settings > Billing."
    case 'not_member':
    case 'no_conversation':
    case 'not_home':
      return "I couldn't find your Native Intelligence workspace for this number. Link your phone again in Settings > Phone."
    case 'busy':
      return "I'm still busy with something else in Native Intelligence. Text me again in a few minutes."
    case 'unfinished':
      // Its words past the read cap are never written (finishHomeTurn): promise none.
      return "That's taking me too long to answer by text. Open Native Intelligence to see what got done, or text me again."
    case 'held':
      return "That needs your OK first. It's waiting for you in Native Intelligence."
    case 'failed':
    case 'no_session':
    case 'lookup_failed':
    case 'usage_check_failed':
      return "Sorry, I couldn't get to that just now. Try again in a minute, or open Native Intelligence."
    default:
      return null
  }
}

/**
 * What a guest is told when their text could not become a turn, or null to
 * say nothing: the person's notices name Settings and the app, which a guest
 * doesn't have. `owner` is the owner's name (for 'held').
 */
export function guestTextTurnSkipNotice(reason: HomeTurnSkip | 'busy' | 'failed' | 'unfinished' | 'held', owner: string): string | null {
  switch (reason) {
    case 'usage_limited':
      return "I can't answer texts right now. Try again later."
    case 'not_member':
    case 'no_conversation':
    case 'not_home':
      return "I can't answer texts from this number right now."
    case 'busy':
      return "I'm still working on your last message. Text me again in a few minutes."
    case 'unfinished':
      return "That's taking me too long to answer by text. Text me again in a bit."
    case 'held':
      return `That needs ${owner}'s OK first. I've asked them.`
    case 'failed':
    case 'no_session':
    case 'lookup_failed':
    case 'usage_check_failed':
    case 'question_pending':
      return "Sorry, I couldn't get to that just now. Try again in a minute."
    default:
      return null
  }
}
