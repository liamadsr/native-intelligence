/**
 * The caller's pending attention cards, as the rail and the bots hold them:
 * GET /api/account/attention-items reads them for useAttentionItems (the
 * shared source's cards, AgentWorkProvider), and the main agent's reads
 * (src/lib/bots/bot-work-server.ts, bots-v4.md Phase A1) read the same ones,
 * so a bot's counts in the chat are the counts its bot shows.
 *
 * Pending and unexpired (an `expires_at` in the past is left out, so a
 * groomed card that isn't swept yet never shows), newest first, at most
 * PENDING_CARDS_READ. On the route's session client RLS restricts the read to
 * the caller's own cards (`attention_item` SELECT is owner-only). A service
 * client caller passes `memberIds`, the caller's own member rows, and the read
 * is fenced on them.
 *
 * A card asking to create what stays in its capture ("Add this to your
 * to-dos", "Add the decision") is left out: Triage no longer makes them, and
 * migration 352 expired the to-do ones that were waiting. Leaving them out
 * here, the one read the column, its counts and the bots share, keeps any that
 * remain from showing. So is an action or email card with no proposal behind
 * it (isUnbackedCard): it has nothing to apply.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AttentionItem } from '@/hooks/use-attention-items'
import { isChatAskCard, isForYouCard } from './chat-asks'

/** What a call proposes creating that stays in its capture, never a card. */
const STAYS_IN_CAPTURE: ReadonlySet<unknown> = new Set(['action', 'decision'])

/**
 * Whether a proposal creates what stays in its capture instead of becoming a
 * card: a new to-do, or a decision. Neither is something to act on. Few
 * to-do cards were accepted, and decision cards never were (Liam, 2026-10-19:
 * "I shouldn't have to be like, yeah, that's a decision I made on a call four
 * days ago"); the knowledge graph records a call's decisions on its own. Both
 * stay where a call's suggestions are reviewed: the capture page, the call's
 * proposals card in chat, and the chat agent's get_action_suggestions.
 */
export function createStaysInCapture(change: { change_type?: unknown; entity_type?: unknown }): boolean {
  return change.change_type === 'create' && STAYS_IN_CAPTURE.has(change.entity_type)
}

/** An action card whose proposal creates what stays in its capture (createStaysInCapture). */
export function isCaptureOnlyCard(card: {
  kind: string
  payload: Record<string, unknown> | null | undefined
}): boolean {
  return card.kind === 'action_card' && createStaysInCapture(card.payload ?? {})
}

/** The card kinds that stand for a proposal: accepting one applies it (settle-card.ts acceptCard). */
const PROPOSAL_CARD_KINDS: ReadonlySet<string> = new Set(['action_card', 'draft_email'])

/**
 * A card of a kind that stands for a proposal, with no proposal behind it.
 * Accepting it can only apply its proposal, so there is nothing to accept: its
 * button was a dead "Unsupported: undefined undefined" (PROD, 2026-10-27,
 * Triage's needs_user "next steps"). Migration 352 expired the ones waiting
 * then; Triage no longer makes them (verdict-apply.ts).
 */
export function isUnbackedCard(card: { kind: string; proposal_id?: string | null }): boolean {
  return PROPOSAL_CARD_KINDS.has(card.kind) && !card.proposal_id
}

/**
 * The columns a card is read with. `run_key`: a card with no ledger row is
 * batched with its run's others on (run_key, flow_id) (bots v3 1b,
 * lib/bots/batch.ts batchKeyOf).
 */
export const PENDING_CARD_SELECT =
  'id, workspace_id, member_id, kind, title, why, payload, proposal_id, source_flow_run_id, run_key, status, expires_at, created_at'

/** How many cards are read: the newest this many (the route's page, and so the bots'). */
export const PENDING_CARDS_READ = 50

/**
 * `place` (P13, chat-asks.ts): 'for_you' reads only For you's cards (post
 * drafts: `question` rows, filtered to those carrying one), 'asks' only the
 * chat's (every other card). Each its own read with its own window, so a
 * burst of one never pushes the other out of PENDING_CARDS_READ. Default:
 * every card.
 */
export async function listPendingCards(
  supabase: SupabaseClient,
  args: { nowIso: string; memberIds?: readonly string[]; place?: 'for_you' | 'asks' },
): Promise<{ cards: AttentionItem[]; error: string | null }> {
  if (args.memberIds && args.memberIds.length === 0) return { cards: [], error: null }
  let q = supabase.from('attention_item').select(PENDING_CARD_SELECT).eq('status', 'pending')
  if (args.place === 'for_you') q = q.eq('kind', 'question')
  if (args.memberIds) q = q.in('member_id', [...args.memberIds])
  const { data, error } = await q
    .or(`expires_at.is.null,expires_at.gt.${args.nowIso}`)
    .order('created_at', { ascending: false })
    .limit(PENDING_CARDS_READ)
  if (error) return { cards: [], error: error.message }
  const cards = ((data ?? []) as unknown as AttentionItem[]).filter((card) => !isCaptureOnlyCard(card) && !isUnbackedCard(card))
  if (args.place === 'for_you') return { cards: cards.filter(isForYouCard), error: null }
  if (args.place === 'asks') return { cards: cards.filter(isChatAskCard), error: null }
  return { cards, error: null }
}
