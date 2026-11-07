import { createClient } from '@/lib/supabase/server'
import { settleAttentionCard, type SettleCardBody } from '@/lib/attention/settle-card'
import { listPendingCards } from '@/lib/attention/pending-cards'
import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * The attention rail's data API (loop-closure Phase 2, Workstream D).
 *
 * A triage-class verdict run surfaces the one or two things that need the user
 * as `attention_item` cards (the floating rail in the collapsed full-screen
 * chat). This route lists the caller's pending cards and resolves them:
 *
 *   GET   → the caller's pending, non-expired cards, newest first, split by
 *           where they live (P13, src/lib/attention/chat-asks.ts): `items`,
 *           For you's delivered work, and `asks`, the approvals and questions
 *           the chat shows inline. Two reads (each its own window), one
 *           response, so the client keeps one fetch.
 *   PATCH → accept, dismiss or start (a work card) one card.
 *     • accept  DELEGATES to the same apply path a capture proposal uses
 *       (applyChange), with the card's corrected properties folded in, so the
 *       board write is single-source-of-truth. The card flips to 'accepted'.
 *     • dismiss flips the card to 'dismissed'. The backing proposal is left
 *       alone (it stays visible in the capture; the rail just stops nagging) —
 *       except behind a WORK card, where it is dismissed too (dismissCard). A
 *       later triage pass does not accept it again (verdict-apply loadCardState).
 *
 * SECURITY MODEL. Every card is owned by exactly one member (attention_item.
 * member_id, RLS owner-only). We fence on the CARD's OWN workspace_id — NOT the
 * caller's active workspace — because the card was produced by a flow run in
 * some workspace and the user may be viewing a different one when they act on
 * it. We re-verify the caller is a member of the card's workspace before
 * applying anything, so a card can never drive a write into a workspace the
 * caller doesn't belong to.
 *
 * The PATCH logic lives in src/lib/attention/settle-card.ts
 * (settleAttentionCard), shared with a bot's `settle_card` tool (bots v3
 * Phase 5), so a card settled from a chat goes through exactly this path.
 */

export async function GET() {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Pending, unexpired cards owned by the caller (RLS already restricts to the
    // caller's member rows), newest first: the one read the main agent's
    // list_bot_work shares (src/lib/attention/pending-cards.ts).
    const nowIso = new Date().toISOString()
    const client = supabase as unknown as SupabaseClient
    const [forYou, asks] = await Promise.all([
      listPendingCards(client, { nowIso, place: 'for_you' }),
      listPendingCards(client, { nowIso, place: 'asks' }),
    ])
    const error = forYou.error ?? asks.error
    if (error) return NextResponse.json({ error }, { status: 500 })
    return NextResponse.json({ items: forYou.cards, asks: asks.cards })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    const isAuth = /auth|session|jwt|token/i.test(message)
    return NextResponse.json(
      { error: isAuth ? 'Unauthorized' : 'Failed to load attention items' },
      { status: isAuth ? 401 : 500 },
    )
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = (await request.json().catch(() => ({}))) as SettleCardBody
    // The caller's RLS client: the card load is owner-only by policy. The same
    // logic settles a card from a bot's chat (settle_card), fenced explicitly.
    // The person's own click: the one settle an approval card accepts (A5).
    return await settleAttentionCard(supabase as unknown as SupabaseClient, user.id, body, { actor: 'person' })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    const isAuth = /auth|session|jwt|token/i.test(message)
    return NextResponse.json(
      { error: isAuth ? 'Unauthorized' : 'Failed to update attention item' },
      { status: isAuth ? 401 : 500 },
    )
  }
}
