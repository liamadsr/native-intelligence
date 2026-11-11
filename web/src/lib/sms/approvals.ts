/**
 * Approving by text (docs/plans/text-and-calling.md, approving by text): the
 * person answers their pending approvals from their verified phone, settled
 * as their own click (src/lib/attention/channel-approvals.ts, channel 'sms':
 * the approver is `person_remote`, the card's every re-check holds).
 *
 * A plain yes or no (Liam, 2026-11-02, replacing his 10-24 call for codes:
 * "it should just be yes or no and I should be able to just say yes do it").
 * The ask says reply yes or no, and "yes", "yes do it", "go ahead", "no"
 * (caller.ts plainReplyDecision) answer every approval the LAST ask texted
 * them about (textedAsksAwaiting), so long as:
 *   - each was texted to this phone (reach_notice, channel sms) and still
 *     waits (pending, not lapsed);
 *   - it was in the newest ask's batch (texted within PLAIN_ASK_BATCH_MS of it),
 *     and that ask is under PLAIN_ANSWER_WINDOW_MS (an hour) old;
 *   - the text actually went (a failed send takes its claim back);
 *   - nothing else was texted them since that ask (another message, a reply,
 *     a notice): a "yes" after the agent asked something else answers the agent.
 * The trade-off, his to make: a sender's number can be faked, so someone who
 * fakes theirs within the hour after an ask could approve it. The code made
 * that impossible.
 *
 * Except a website merge (roadmap track E; Liam, 2026-11-04, "Code for site
 * merges"): a change to a business's public site keeps its code. Its ask
 * carries the code (channel-approvals.ts needsReplyCode: "Reply yes K7Q4MX to
 * put it live"), a plain yes never answers it (it answers the batch's other
 * asks, and says this one needs its code, once), and only "yes CODE" merges
 * it. A plain no declines it while the ask is the newest thing texted (no never
 * changes the site); after the code reply, no takes the code too. The settle
 * itself refuses a plain answer for it (channel-approvals.ts
 * settleApprovalFromChannel `proof`), so no path approves one without its code.
 *
 * A text still never runs a risky call by itself: the agent's call waits as a
 * card, and only an answer to the ask settles it.
 *
 * A reply code still answers too, for asks texted before this change ("yes
 * K7Q4MX"). Codes are six characters (about 244 million), keyed with a server secret
 * (src/lib/safety/reply-code.ts), and by text only a yes or no with the code
 * answers ("yes K7Q4MX"; the code alone goes to the agent). Wrong guesses are
 * capped: after {@link SMS_CODE_MISS_DAILY_CAP} in a day, codes by text pause
 * for that number (the app still works). Each guess is marked a miss BEFORE it
 * is tried and the cap counted after, so a burst of texts can't all get in
 * under it. A code the person already answered is not a miss.
 *
 * Pure over {@link TextApprovalDeps}; {@link supabaseTextApprovalDeps} is the
 * real store.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  hasPendingApproval,
  matchChannelReply,
  needsReplyCode,
  settleApprovalFromChannel,
  settleLine,
  type ChannelApproval,
  type ChannelReplyMatch,
  type ChannelSettleOutcome,
} from '@/lib/attention/channel-approvals'
import { plainReplyDecision, replyNamesACode } from '@/lib/safety/caller'
import { countInboundKindSince, markInboundKind, recordOutbound, type LinkedPhone, type SmsOutboundKind } from './store'
import { BOOK_QUOTE_TOOL, SEND_QUOTE_TOOL } from '@/lib/customers/quote-reply-input'
import { NUDGE_TIME_OFFER_TOOL, OFFER_TIMES_TOOL } from '@/lib/time-offers/types'
import { bareToolName } from '@/lib/mcp/tool-names'

/** Wrong codes one number may text in a day before codes by text pause. */
export const SMS_CODE_MISS_DAILY_CAP = 5

const DAY_MS = 24 * 60 * 60_000

export const CODE_MISS_REPLY = "That code doesn't match anything waiting for you. Check the code, or answer it in Native Intelligence."
export const CODES_PAUSED_REPLY = 'Too many wrong codes today, so approving by text is paused until tomorrow. You can still answer it in Native Intelligence.'
export const CODE_ANSWERED_REPLY = 'That one was already answered, or it expired. Nothing changed.'
/** Said once to a plain yes that met a website merge: only its code puts it live (after it, a plain yes or no goes to the agent, so no takes the code too). */
export const CODE_NEEDED_REPLY = 'Your website change needs its code to go live: reply yes and the code from my text, or no and the code to drop it. Nothing went live.'

/** One URL-ish run (an agent-written title can carry one; carriers filter links in alerts). */
const URLISH = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ai|co|app|dev|me|ly|gl|us)(?:\/\S*)?/gi

/** The approvals whose texted prompt carries the whole card (see approvalPromptText). */
// offer_times by email or text (availability phase 3a), and a poll's reminder (phase 5): its card is the exact email or text, and its only link the offer's own.
const WHOLE_CARD_TOOLS: ReadonlySet<string> = new Set([SEND_QUOTE_TOOL, BOOK_QUOTE_TOOL, OFFER_TIMES_TOOL, NUDGE_TIME_OFFER_TOOL])

/**
 * The text that asks the person for one approval: what it is and why, cut
 * short (and stripped of links), how to answer (a plain yes or no), and the
 * opt-out; a quote reply's card whole (its exact customer text is what the
 * yes approves). Plain text for now; a richer channel (RCS suggested replies,
 * iMessage, WhatsApp) can render the same ChannelApproval its own way. Pure.
 */
export function approvalPromptText(approval: ChannelApproval): string {
  // A quote reply's card is shown whole (roadmap F3): its why is the exact
  // text the customer gets, who gets it (the title) and from which number,
  // and its only link is the business's own booking link (src/lib/customers/
  // quote-reply.ts keeps every other link out), shown as it will be sent.
  if (WHOLE_CARD_TOOLS.has(bareToolName(approval.tool ?? ''))) {
    const one = (s: string) => s.trim().replace(/\s+/g, ' ')
    return `Dial8 needs your OK: ${one(approval.title)} (${one(approval.why)}). Reply yes to approve or no to decline. Reply STOP to opt out.`
  }
  const clean = (s: string, n: number) => {
    const t = s.replace(URLISH, '[link]').trim().replace(/\s+/g, ' ')
    return t.length > n ? `${t.slice(0, n - 3).trimEnd()}...` : t
  }
  const title = clean(approval.title, 120)
  const why = clean(approval.why, 120)
  // A website merge: only its code puts it live (see the header).
  const answer = approval.replyCode ? `Reply yes ${approval.replyCode.code} to ${approval.replyCode.does}, or no to decline.` : 'Reply yes to approve or no to decline.'
  return `Dial8 needs your OK: ${title}${why ? ` (${why})` : ''}. ${answer} Reply STOP to opt out.`
}

/** How long before the newest ask an ask still belongs to its batch (a turn or one away text asks several at once). */
export const PLAIN_ASK_BATCH_MS = 10 * 60_000
/** How long a plain yes or no still answers the newest ask: past it, the words go to the agent. */
export const PLAIN_ANSWER_WINDOW_MS = 60 * 60_000

/** One approval a plain answer settles (a plain no; a plain yes only when it needs no code). */
export interface TextedAsk {
  approvalId: string
  cardId: string
  workspaceId: string
  /** A plain yes never approves it: only "yes CODE" (a website merge, see the header). */
  needsCode?: true
}

/**
 * The approvals a plain yes or no answers now (see the header): the asks
 * texted to the person in the newest batch that still wait. None when:
 *   - the newest thing texted them (reach_notice, channel sms) wasn't an ask
 *     (the router sent a message after it), or the agent replied to them or
 *     sent a notice since (sms_message kinds reply, notice);
 *   - the newest ask is older than PLAIN_ANSWER_WINDOW_MS.
 * An ask whose send failed has no row (releaseTextedApproval). Throws on a
 * failed read (the text then goes to the agent; nothing is settled blind).
 */
export async function textedAsksAwaiting(supabase: SupabaseClient, userId: string, now: number = Date.now()): Promise<TextedAsk[]> {
  const { data: notices, error } = await supabase
    .from('reach_notice')
    .select('ref_type, ref_id, created_at')
    .eq('user_id', userId)
    .eq('channel', 'sms')
    .order('created_at', { ascending: false })
    .limit(20)
  if (error) throw new Error(`reach_notice read failed: ${error.message}`)
  const texted = (notices ?? []) as Array<{ ref_type: string; ref_id: string; created_at: string }>
  // The asks at the head of what went by text: anything else after them, and "yes" is for that.
  const run: typeof texted = []
  for (const n of texted) {
    if (n.ref_type !== 'tool_approval') break
    run.push(n)
  }
  if (run.length === 0) return []
  const newest = Date.parse(run[0].created_at)
  if (!Number.isFinite(newest) || now - newest > PLAIN_ANSWER_WINDOW_MS) return []
  // The agent's reply or a notice after the ask: a "yes" now answers that.
  const { count, error: sinceError } = await supabase
    .from('sms_message')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('direction', 'out')
    .in('kind', ['reply', 'notice'])
    .gt('created_at', run[0].created_at)
  if (sinceError) throw new Error(`sms_message read failed: ${sinceError.message}`)
  if ((count ?? 0) > 0) return []
  const batch = run.filter((n) => newest - Date.parse(n.created_at) <= PLAIN_ASK_BATCH_MS).map((n) => n.ref_id)
  const { data: rows, error: rowError } = await supabase
    .from('tool_approval')
    .select('id, card_id, workspace_id, status, expires_at, context')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .in('id', batch)
  if (rowError) throw new Error(`tool_approval read failed: ${rowError.message}`)
  return ((rows ?? []) as Array<{ id: string; card_id: string | null; workspace_id: string; expires_at: string | null; context?: unknown }>)
    .filter((r) => typeof r.card_id === 'string' && !(r.expires_at && Date.parse(r.expires_at) <= now))
    .map((r) => ({ approvalId: r.id, cardId: r.card_id as string, workspaceId: r.workspace_id, ...(needsReplyCode(r.context) ? { needsCode: true as const } : {}) }))
}

/** What the person reads after a plain answer settled several asks at once. Pure. */
export function plainSettleLine(outcomes: readonly ChannelSettleOutcome[]): string {
  if (outcomes.length === 1) return settleLine(outcomes[0])
  const ok = outcomes.filter((o): o is Extract<ChannelSettleOutcome, { ok: true }> => o.ok)
  const refused = outcomes.length - ok.length
  if (ok.length === 0) return `None of the ${outcomes.length} could be answered here: open Native Intelligence.`
  const failedRun = ok.filter((o) => o.decision === 'approve' && (o.success === false || o.ran === false)).length
  const head = ok[0].decision === 'decline'
    ? `Declined ${ok.length}. Nothing ran.`
    : `Approved ${ok.length}.${failedRun ? ` ${failedRun} didn't run cleanly: the details are in Native Intelligence.` : ' They ran.'}`
  return refused ? `${head} ${refused} couldn't be answered here: open Native Intelligence.` : head
}

export interface TextApprovalDeps {
  hasPendingApproval(userId: string): Promise<boolean>
  /** The asks a plain yes or no answers now (textedAsksAwaiting). Throws on a failed read. */
  textedAsks(userId: string): Promise<TextedAsk[]>
  /** Throws on a failed read (never counted as a wrong guess). */
  matchReply(userId: string, text: string): Promise<ChannelReplyMatch>
  memberIdOf(workspaceId: string, userId: string): Promise<string | null>
  settle(input: { userId: string; memberId: string; cardId: string; decision: 'approve' | 'decline'; proof: 'code' | 'plain' }): Promise<ChannelSettleOutcome>
  countCodeMissesSince(phone: string, sinceMs: number): Promise<number>
  markInbound(sid: string, kind: 'approval' | 'code_miss' | 'text'): Promise<void>
  recordOutbound(row: { phone: string; kind: SmsOutboundKind; userId?: string | null }): Promise<void>
  now?: () => number
}

export type TextApprovalOutcome =
  /** Not an answer: the text goes to the agent. */
  | 'not_a_code'
  | 'code_miss'
  | 'code_answered'
  | 'codes_paused'
  | 'approval_answered'
  | 'approval_refused'
  /** A plain yes that met only asks needing their code: nothing settled, the code asked for. */
  | 'code_needed'

export interface TextApprovalResult {
  outcome: TextApprovalOutcome
  /** Said back at once (the TwiML reply, to the verified number); null for none. */
  reply: string | null
}

/** Whether the outcome means the text was handled here (nothing goes to the agent). */
export function textApprovalHandled(outcome: TextApprovalOutcome): boolean {
  return outcome !== 'not_a_code'
}

/**
 * Answer one of the person's pending approvals from a text that says yes or
 * no with its code. The inbound row (keyed on `sid`) ends marked 'approval'
 * or 'code_miss'. Past the cap the pause is said once (the first text over
 * it), then nothing. Throws on a failed store call (the webhook logs it and
 * answers empty TwiML).
 */
export async function answerApprovalByText(
  input: { linked: LinkedPhone; text: string; sid: string },
  deps: TextApprovalDeps,
): Promise<TextApprovalResult> {
  const shape = replyNamesACode(input.text)
  // A plain yes or no answers the asks just texted; with none waiting, the text goes to the agent.
  const plain = shape ? null : plainReplyDecision(input.text)
  if (plain) return answerPlainly(input, plain, deps)
  // The code alone never answers by text: it goes to the agent like any word.
  if (shape !== 'worded') return { outcome: 'not_a_code', reply: null }
  const { linked } = input
  if (!(await deps.hasPendingApproval(linked.userId))) return { outcome: 'not_a_code', reply: null }

  const now = (deps.now ?? Date.now)()
  // Counted before it is tried: concurrent guesses each see the others.
  await deps.markInbound(input.sid, 'code_miss')
  const misses = await deps.countCodeMissesSince(linked.phone, now - DAY_MS)
  if (misses > SMS_CODE_MISS_DAILY_CAP) {
    if (misses !== SMS_CODE_MISS_DAILY_CAP + 1) return { outcome: 'codes_paused', reply: null }
    await deps.recordOutbound({ phone: linked.phone, kind: 'notice', userId: linked.userId })
    return { outcome: 'codes_paused', reply: CODES_PAUSED_REPLY }
  }

  let match: ChannelReplyMatch
  try {
    match = await deps.matchReply(linked.userId, input.text)
  } catch (err) {
    // A store error is no wrong guess.
    await deps.markInbound(input.sid, 'text').catch(() => {})
    throw err
  }
  if (match.kind === 'none') {
    await deps.recordOutbound({ phone: linked.phone, kind: 'notice', userId: linked.userId })
    return { outcome: 'code_miss', reply: CODE_MISS_REPLY }
  }
  await deps.markInbound(input.sid, 'approval')
  if (match.kind === 'answered') {
    await deps.recordOutbound({ phone: linked.phone, kind: 'approval_result', userId: linked.userId })
    return { outcome: 'code_answered', reply: CODE_ANSWERED_REPLY }
  }

  const memberId = await deps.memberIdOf(match.workspaceId, linked.userId)
  const outcome: ChannelSettleOutcome = memberId
    ? await deps.settle({ userId: linked.userId, memberId, cardId: match.cardId, decision: match.decision, proof: 'code' })
    : { ok: false, code: 'NOT_FOUND', error: 'not a member' }
  await deps.recordOutbound({ phone: linked.phone, kind: 'approval_result', userId: linked.userId })
  return { outcome: outcome.ok ? 'approval_answered' : 'approval_refused', reply: settleLine(outcome) }
}

/** A plain yes or no, settled for every ask it answers (see the header). */
async function answerPlainly(input: { linked: LinkedPhone; text: string; sid: string }, decision: 'approve' | 'decline', deps: TextApprovalDeps): Promise<TextApprovalResult> {
  const { linked } = input
  let asks: TextedAsk[]
  try {
    asks = await deps.textedAsks(linked.userId)
  } catch (err) {
    // Never settled blind, and never lost: the words go to the agent.
    console.warn('[sms-approvals] texted asks unreadable:', err instanceof Error ? err.message : String(err))
    return { outcome: 'not_a_code', reply: null }
  }
  if (asks.length === 0) return { outcome: 'not_a_code', reply: null }
  await deps.markInbound(input.sid, 'approval')
  // A plain yes never approves an ask needing its code (a website merge): it answers the rest, and asks for the code.
  const answered = decision === 'approve' ? asks.filter((ask) => !ask.needsCode) : asks
  const held = asks.length - answered.length
  const outcomes: ChannelSettleOutcome[] = []
  for (const ask of answered) {
    const memberId = await deps.memberIdOf(ask.workspaceId, linked.userId)
    outcomes.push(memberId ? await deps.settle({ userId: linked.userId, memberId, cardId: ask.cardId, decision, proof: 'plain' }) : { ok: false, code: 'NOT_FOUND', error: 'not a member' })
  }
  // Said once: recorded as a notice, after which a plain yes goes to the agent (textedAsksAwaiting), and only the code merges.
  await deps.recordOutbound({ phone: linked.phone, kind: held ? 'notice' : 'approval_result', userId: linked.userId })
  if (!outcomes.length) return { outcome: 'code_needed', reply: CODE_NEEDED_REPLY }
  const line = plainSettleLine(outcomes)
  return { outcome: outcomes.some((o) => o.ok) ? 'approval_answered' : 'approval_refused', reply: held ? `${line} ${CODE_NEEDED_REPLY}` : line }
}

/** The real store behind {@link answerApprovalByText}, on the service client. */
export function supabaseTextApprovalDeps(supabase: SupabaseClient): TextApprovalDeps {
  return {
    hasPendingApproval: (userId) => hasPendingApproval(supabase, userId),
    textedAsks: (userId) => textedAsksAwaiting(supabase, userId),
    // A text from the person's verified phone is the person, remote (caller.ts channelCaller).
    matchReply: (userId, text) => matchChannelReply(supabase, { userId, text, callerClass: 'person_remote' }),
    memberIdOf: async (workspaceId, userId) => {
      const { data, error } = await supabase.from('member').select('id').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle<{ id: string }>()
      if (error) throw new Error(`member lookup failed: ${error.message}`)
      return data?.id ?? null
    },
    settle: (input) => settleApprovalFromChannel(supabase, { ...input, channel: 'sms' }),
    countCodeMissesSince: (phone, sinceMs) => countInboundKindSince(supabase, phone, 'code_miss', sinceMs),
    markInbound: (sid, kind) => markInboundKind(supabase, sid, kind),
    recordOutbound: (row) => recordOutbound(supabase, row),
  }
}
