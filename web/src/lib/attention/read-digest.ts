/**
 * A run's digest is read once its cards are all settled (bots v3 1b): when
 * none of a run's cards (`payload.work_item_id`, stamped when they were
 * inserted) is pending any more, the owner's unread notices for that run are
 * marked read (resolve.ts markItemNoticesRead), so the bot's dot stops counting
 * what's done and its banners leave Notification Center.
 *
 * Two callers, one rule:
 *  - the person's own settle (settle-card.ts settleAttentionCard), right after
 *    the click or the settle_card tool settled a card;
 *  - the flow-schedule tick (readSettledRunDigests), for the cards that left
 *    pending with no click: migration 352's triggers settle a card when its
 *    proposal is applied, dismissed, aged out or expired anywhere else, and
 *    expire it when the proposal is deleted. Those run in the database, so
 *    nothing in the app sees them happen; the tick reads back the cards that
 *    settled that way in the last few minutes. The cards the tick expires
 *    itself (past their TTL) and lapsed approvals are picked up the same way,
 *    since they leave pending with no click too.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/supabase/service'
import { markItemNoticesRead } from '@/lib/work/resolve'

type DigestCard = { member_id: string; payload: Record<string, unknown> | null }

/**
 * Read the run's digest if `card` was its last pending card. The pending read
 * runs on `reader` (the person's own RLS client on a click, the service client
 * on the tick) and is fenced on the card's member; the write is fenced on the
 * card's member too, on `writer` (the service client: no member policy lets a
 * person update a notification's read state for a run). A card that names no
 * run, or a failed read, reads nothing. Never throws: the settle has already
 * happened. Returns how many notices it read.
 */
export async function readDigestOnceSettled(
  reader: SupabaseClient,
  card: DigestCard,
  opts: { writer?: SupabaseClient; nowIso?: string } = {},
): Promise<number> {
  const workItemId = typeof card.payload?.work_item_id === 'string' ? card.payload.work_item_id : null
  if (!workItemId) return 0
  try {
    const { data, error } = await reader
      .from('attention_item')
      .select('id')
      .eq('member_id', card.member_id)
      .eq('status', 'pending')
      .eq('payload->>work_item_id', workItemId)
      .limit(1)
    if (error || (data?.length ?? 0) > 0) return 0
    return await markItemNoticesRead(
      opts.writer ?? getServiceClient(),
      { id: workItemId, member_id: card.member_id },
      opts.nowIso ? { nowIso: opts.nowIso } : {},
    )
  } catch (err) {
    console.warn('[attention-items] digest read failed:', err instanceof Error ? err.message : err)
    return 0
  }
}

/**
 * How far back the tick looks for cards settled with no click. The tick runs
 * every 5 minutes; three ticks' worth means one missed tick loses nothing.
 * Re-reading a run is harmless: only unread notices are written.
 */
export const DIGEST_SWEEP_LOOKBACK_MS = 15 * 60 * 1000

/**
 * A card settled less than this long ago waits for the next tick. An accept
 * flips its proposal (the trigger settles the card) before the change applies;
 * a failed apply hands it back and the card is pending again. Waiting a minute
 * keeps the tick from reading a digest whose card is about to come back.
 */
export const DIGEST_SWEEP_SETTLE_MS = 60 * 1000

/** At most this many settled cards per tick (PROD settles a few hundred a month). */
export const DIGEST_SWEEP_LIMIT = 500

/**
 * The tick's half (see the module doc): the cards that left pending in the
 * last DIGEST_SWEEP_LOOKBACK_MS (but at least DIGEST_SWEEP_SETTLE_MS ago)
 * without a click, which are the ones migration
 * 352's follow trigger stamped (`payload.resolved_with_proposal`) and the
 * expired ones (its delete trigger, the TTL groom, a lapsed approval). Each
 * run they name is read through readDigestOnceSettled, once per (owner, run),
 * on the service client. A failed scan logs one line and reads nothing; it
 * never throws, so it never fails the tick.
 */
export async function readSettledRunDigests(
  supabase: SupabaseClient,
  now: Date,
): Promise<{ runs: number; read: number }> {
  const out = { runs: 0, read: 0 }
  try {
    const { data, error } = await supabase
      .from('attention_item')
      .select('member_id, work_item_id:payload->>work_item_id')
      .neq('status', 'pending')
      .gte('resolved_at', new Date(now.getTime() - DIGEST_SWEEP_LOOKBACK_MS).toISOString())
      .lte('resolved_at', new Date(now.getTime() - DIGEST_SWEEP_SETTLE_MS).toISOString())
      .or('status.eq.expired,payload->>resolved_with_proposal.not.is.null')
      .not('payload->>work_item_id', 'is', null)
      .order('resolved_at', { ascending: false })
      .limit(DIGEST_SWEEP_LIMIT)
    if (error) throw new Error(error.message)

    const runs = new Map<string, DigestCard>()
    for (const row of (data ?? []) as Array<{ member_id: string | null; work_item_id: string | null }>) {
      if (!row.member_id || !row.work_item_id) continue
      runs.set(`${row.member_id}:${row.work_item_id}`, {
        member_id: row.member_id,
        payload: { work_item_id: row.work_item_id },
      })
    }
    const nowIso = now.toISOString()
    for (const card of runs.values()) {
      out.runs += 1
      out.read += await readDigestOnceSettled(supabase, card, { writer: supabase, nowIso })
    }
  } catch (err) {
    console.warn('[attention-items] settled digest sweep failed:', err instanceof Error ? err.message : err)
  }
  return out
}
