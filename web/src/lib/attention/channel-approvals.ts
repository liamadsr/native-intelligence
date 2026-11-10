/**
 * Native Intelligence approvals answered from an outside channel (docs/plans/slack-connect.md
 * §4 piece 6; docs/plans/text-and-calling.md, approving by text): what Slack
 * and SMS share. A held call raises the person's ordinary approval card
 * (src/lib/safety/approvals.ts); the channel shows it (Slack: blocks with
 * buttons, src/lib/slack/approvals.ts; SMS: a text with its code,
 * src/lib/sms/approvals.ts), and the person answers it there. Every answer is
 * settled through the SAME path as the card's click in the app
 * (settleAttentionCard, actor 'person', with the channel), so every re-check
 * holds and only the owner approves (caller.ts mayApprove).
 *
 * A reply binds only when it names one pending approval by its code
 * ("yes K7Q4MX", caller.ts bindReplyToApproval, keyed codes: src/lib/safety/reply-code.ts): a stray "yes" approves
 * nothing. The code is sent only to the person's own channel (their Slack DM,
 * their verified phone), so someone faking their number never sees it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { settleAttentionCard } from '@/lib/attention/settle-card'
import { bindReplyToApproval, replyNamesACode, type CallerClass, type OutsideChannel, type PendingApprovalRef } from '@/lib/safety/caller'
import { serverReplyCode } from '@/lib/safety/reply-code'
import { MERGE_WEBSITE_CHANGE_TOOL } from '@/lib/website/types'

/** The most cards one turn shows on a channel (a pile belongs in the app). */
export const CHANNEL_APPROVALS_PER_TURN = 3

/** A held call to show on a channel. */
export interface ChannelApproval {
  approvalId: string
  cardId: string
  title: string
  why: string
  /** The held call's tool (a channel shows some cards whole: src/lib/sms/approvals.ts approvalPromptText). */
  tool?: string
  /**
   * Set only on an approval a plain yes must never answer ({@link needsReplyCode}):
   * its code (serverReplyCode), carried in the ask texted to the person's own
   * phone, and what a yes with it does ("put it live").
   */
  replyCode?: { code: string; does: string }
}

/**
 * Whether an approval needs its code by text: a plain "yes" never answers it,
 * only "yes CODE" (the code goes only to the person's verified phone, so
 * someone faking their number can't answer it). A website merge (roadmap track
 * E): Liam, 2026-11-04, "Code for site merges", after plain yes (#1021) let a
 * faked number answer the asks of the hour. Pure.
 */
export function needsReplyCode(context: unknown, tool?: string | null): boolean {
  return tool === MERGE_WEBSITE_CHANGE_TOOL || (!!context && typeof context === 'object' && !!(context as { website?: unknown }).website)
}

/** The code part of an approval needing one, from its context or tool; undefined for any other. */
function replyCodeOf(approvalId: string, context: unknown, tool?: string): ChannelApproval['replyCode'] {
  return needsReplyCode(context, tool) ? { code: serverReplyCode(approvalId), does: 'put it live' } : undefined
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The pending approvals a channel turn raised in this conversation, since the
 * turn began (its row's created_at), newest last: the held calls whose
 * context names the turn's surface. Never throws (none on a failed read).
 */
export async function channelApprovalsRaisedSince(
  supabase: SupabaseClient,
  scope: { userId: string; conversationId: string; since: string; surface: 'slack' | 'sms' },
): Promise<ChannelApproval[]> {
  try {
    const { data, error } = await supabase
      .from('tool_approval')
      .select('id, card_id, tool, created_at, context')
      .eq('user_id', scope.userId)
      .eq('conversation_id', scope.conversationId)
      .eq('status', 'pending')
      .eq('context->>surface', scope.surface)
      .gte('created_at', scope.since)
      .order('created_at', { ascending: true })
      .limit(CHANNEL_APPROVALS_PER_TURN)
    if (error || !Array.isArray(data) || data.length === 0) return []
    const rows = (data as Array<{ id: string; card_id: string | null; tool?: string | null; context?: unknown }>).filter((r) => typeof r.card_id === 'string')
    return cardsFor(supabase, rows.map((r) => ({ approvalId: r.id, cardId: r.card_id as string, tool: r.tool ?? undefined, context: r.context })))
  } catch {
    return []
  }
}

/** One pending approval's card, for a channel to show; null when it isn't pending any more. Never throws. */
export async function channelApprovalById(supabase: SupabaseClient, input: { userId: string; approvalId: string }): Promise<ChannelApproval | null> {
  try {
    const { data, error } = await supabase
      .from('tool_approval')
      .select('id, card_id, status, tool, context')
      .eq('id', input.approvalId)
      .eq('user_id', input.userId)
      .maybeSingle<{ id: string; card_id: string | null; status: string; tool?: string | null; context?: unknown }>()
    if (error || !data || data.status !== 'pending' || typeof data.card_id !== 'string') return null
    return (await cardsFor(supabase, [{ approvalId: data.id, cardId: data.card_id, tool: data.tool ?? undefined, context: data.context }]))[0] ?? null
  } catch {
    return null
  }
}

async function cardsFor(supabase: SupabaseClient, refs: Array<{ approvalId: string; cardId: string; tool?: string; context?: unknown }>): Promise<ChannelApproval[]> {
  if (refs.length === 0) return []
  const { data: cards, error } = await supabase
    .from('attention_item')
    .select('id, title, why, status')
    .in('id', refs.map((r) => r.cardId))
    .eq('kind', 'approval')
  if (error || !Array.isArray(cards)) return []
  const byId = new Map((cards as Array<{ id: string; title: string | null; why: string | null; status: string }>).map((c) => [c.id, c]))
  return refs.flatMap((r) => {
    const card = byId.get(r.cardId)
    if (!card || card.status !== 'pending') return []
    const replyCode = replyCodeOf(r.approvalId, r.context, r.tool)
    return [{ approvalId: r.approvalId, cardId: card.id, title: card.title ?? 'Approve this?', why: card.why ?? '', ...(r.tool ? { tool: r.tool } : {}), ...(replyCode ? { replyCode } : {}) }]
  })
}

export type ChannelSettleOutcome =
  | { ok: true; decision: 'approve' | 'decline'; ran?: boolean; success?: boolean }
  | { ok: false; code: string; error: string }

/**
 * Settle an approval card as the person, from a channel. `memberId` is their
 * own member row in the card's workspace (the card load is fenced on it:
 * someone else's card is a 404); the approver is the channel's verified
 * owner (settle-card.ts cardApprover: `person` on Slack, `person_remote` by
 * text). Never throws.
 */
export async function settleApprovalFromChannel(
  supabase: SupabaseClient,
  input: {
    channel: OutsideChannel
    userId: string
    memberId: string
    cardId: string
    decision: 'approve' | 'decline'
    /**
     * How the answer named this approval: 'code' ("yes K7Q4MX"), 'button' (a
     * card's own button in the person's Slack DM), or 'plain' (a plain yes that
     * answered a batch). Missing counts as plain: an approval needing its code
     * (needsReplyCode) is never approved without one, whatever channel asks.
     */
    proof?: 'code' | 'button' | 'plain'
  },
  deps: { settle?: typeof settleAttentionCard } = {},
): Promise<ChannelSettleOutcome> {
  if (!UUID.test(input.cardId)) return { ok: false, code: 'BAD_CARD', error: 'That is not one of ours.' }
  try {
    // A website merge (Liam, 2026-11-04, "Code for site merges"): a plain answer never approves it, checked here
    // where every channel's answer settles, so a channel added later can't approve one without its code.
    if (input.decision === 'approve' && input.proof !== 'code' && input.proof !== 'button') {
      const { data, error } = await supabase.from('tool_approval').select('tool, context').eq('card_id', input.cardId).eq('user_id', input.userId).maybeSingle<{ tool: string | null; context: unknown }>()
      if (error) return { ok: false, code: 'FAILED', error: 'It could not be settled.' }
      if (data && needsReplyCode(data.context, data.tool)) return { ok: false, code: 'CODE_NEEDED', error: 'This one needs its code.' }
    }
    // Loaded when an answer comes in: the card route's module is heavy, and the turn paths that show approvals never settle one.
    const settle = deps.settle ?? (await import('@/lib/attention/settle-card')).settleAttentionCard
    const res = await settle(
      supabase,
      input.userId,
      { id: input.cardId, action: input.decision === 'approve' ? 'accept' : 'dismiss' },
      { ownerMemberId: input.memberId, actor: 'person', channel: input.channel },
    )
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string; success?: boolean; status?: string }
    // The card route answers a card that isn't theirs with a bare 404.
    if (!res.ok) return { ok: false, code: body.code ?? (res.status === 404 ? 'NOT_FOUND' : `HTTP_${res.status}`), error: body.error ?? 'It could not be settled.' }
    return input.decision === 'approve'
      ? { ok: true, decision: 'approve', ran: body.status === 'executed', success: body.success !== false }
      : { ok: true, decision: 'decline' }
  } catch (error) {
    return { ok: false, code: 'FAILED', error: error instanceof Error ? error.message : 'It could not be settled.' }
  }
}

/** What the person reads on the channel after answering. */
export function settleLine(outcome: ChannelSettleOutcome): string {
  if (outcome.ok) {
    if (outcome.decision === 'decline') return 'Declined. Nothing ran.'
    return outcome.success === false ? 'Approved, but it failed when it ran. The details are in Native Intelligence.' : 'Approved. It ran.'
  }
  switch (outcome.code) {
    case 'ALREADY_RESOLVED':
      return 'This was already answered.'
    case 'CODE_NEEDED':
      return 'This one needs its code from my text: reply yes and the code to approve it, or approve it in Native Intelligence.'
    case 'EXPIRED':
      return 'This approval expired. Ask me again.'
    case 'NOT_FOUND':
    case 'APPROVAL_PERSON_ONLY':
      return 'Only the person this is waiting for can answer it.'
    default:
      return `That didn't work: ${outcome.error}`
  }
}

/** What a reply naming a code matched: one pending approval, one already answered or lapsed, or nothing of theirs. */
export type ChannelReplyMatch =
  | { kind: 'bound'; approvalId: string; cardId: string; workspaceId: string; decision: 'approve' | 'decline' }
  | { kind: 'answered' }
  | { kind: 'none' }

/** How far back a code is still known as "already answered" (not a wrong guess). */
const ANSWERED_LOOKBACK_MS = 14 * 24 * 60 * 60_000

/**
 * Match a reply that names a code ("yes K7Q4MX") against the person's own
 * approvals: bound by caller.ts bindReplyToApproval for `callerClass` (the
 * channel's class for its owner) over their pending ones, with the keyed
 * code (serverReplyCode); else 'answered' when the code is one of their
 * recent approvals that is no longer pending (not a wrong guess); else
 * 'none'. Throws on a failed read (a store error is never a wrong guess).
 */
export async function matchChannelReply(
  supabase: SupabaseClient,
  input: { userId: string; text: string; callerClass: CallerClass },
  now: number = Date.now(),
): Promise<ChannelReplyMatch> {
  if (input.text.length > 40) return { kind: 'none' }
  const rows = await pendingApprovalRows(supabase, input.userId)
  if (!rows) throw new Error('tool_approval read failed')
  const refs: PendingApprovalRef[] = rows.map((r) => ({ approvalId: r.id, ownerUserId: r.user_id, status: r.status, expiresAt: r.expires_at }))
  const bound = bindReplyToApproval(input.text, { callerClass: input.callerClass, userId: input.userId }, refs, now, serverReplyCode)
  if (bound.bound) {
    const row = rows.find((r) => r.id === bound.approvalId)
    if (row?.card_id) return { kind: 'bound', approvalId: bound.approvalId, cardId: row.card_id, workspaceId: row.workspace_id, decision: bound.decision }
    return { kind: 'none' }
  }
  // Only a reply shaped like a code can name one already answered.
  if (bound.reason !== 'no_match' || !replyNamesACode(input.text)) return { kind: 'none' }
  const { data, error } = await supabase
    .from('tool_approval')
    .select('id')
    .eq('user_id', input.userId)
    .gte('created_at', new Date(now - ANSWERED_LOOKBACK_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(200)
  if (error || !Array.isArray(data)) throw new Error('tool_approval read failed')
  const said = new Set(input.text.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean))
  return (data as Array<{ id: string }>).some((r) => said.has(serverReplyCode(r.id))) ? { kind: 'answered' } : { kind: 'none' }
}

/**
 * A reply that answers one pending approval by its code; null when it names
 * none (it then goes to the agent as an ordinary message). Never throws.
 */
export async function approvalNamedByChannelReply(
  supabase: SupabaseClient,
  input: { userId: string; text: string; callerClass: CallerClass },
): Promise<{ approvalId: string; cardId: string; workspaceId: string; decision: 'approve' | 'decline' } | null> {
  try {
    const match = await matchChannelReply(supabase, input)
    return match.kind === 'bound' ? { approvalId: match.approvalId, cardId: match.cardId, workspaceId: match.workspaceId, decision: match.decision } : null
  } catch {
    return null
  }
}

/** Whether the person has any approval waiting (a code guess can only matter then). Never throws (false). */
export async function hasPendingApproval(supabase: SupabaseClient, userId: string): Promise<boolean> {
  try {
    const rows = await pendingApprovalRows(supabase, userId)
    return !!rows && rows.length > 0
  } catch {
    return false
  }
}

interface PendingRow {
  id: string
  user_id: string
  workspace_id: string
  status: string
  expires_at: string | null
  card_id: string | null
}

async function pendingApprovalRows(
  supabase: SupabaseClient,
  userId: string,
): Promise<PendingRow[] | null> {
  const { data, error } = await supabase
    .from('tool_approval')
    .select('id, user_id, workspace_id, status, expires_at, card_id')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .limit(50)
  if (error || !Array.isArray(data)) return null
  return data as PendingRow[]
}
