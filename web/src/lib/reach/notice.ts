/**
 * The ledger of the agent reaching a person on an outside channel
 * (reach_notice, migration 426): one row per thing waiting on them and
 * channel. Claimed before each send, so a retried step, or a channel turn and
 * the router (./route.ts) racing for the same approval, never send it twice.
 * Service role only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Where a notice went. 'push' (migration 454) is the iOS app's slot: the
 * router orders it before a text, but nothing sends on it until the iOS app
 * and its push adapter exist.
 */
export type ReachChannel = 'slack' | 'sms' | 'push'
/**
 * What a notice can be claimed on: a channel, or 'banner' (migration 454): a
 * message the router told the person about in the app for two hours while
 * they were there and never opened is done for good, and a message that only
 * ever banners (a prep-only report) is done once bannered. Nothing is sent on
 * it; later runs drop what it claims like anything already sent.
 */
export type ReachClaimChannel = ReachChannel | 'banner'
/**
 * What a notice is about: an approval waiting on them, a guest's note
 * (migration 429), the look-ahead's message (migration 452,
 * src/lib/look-ahead/message.ts: one key per person, slot and date), or any
 * other message the agent wrote in their home thread (migration 454: its
 * chat_messages row id).
 */
export type ReachRefType = 'tool_approval' | 'guest_message' | 'look_ahead' | 'home_message'

/**
 * Claim one approval (or, with another refType, the thing that refType names:
 * input.approvalId is then its id) for one channel. 'claimed': this call wrote
 * the row, so send. 'taken': it was sent already. 'unavailable': the ledger
 * couldn't be written (a database without the migration, or a failed write):
 * a send in a turn the person is in goes ahead; an unasked message (./route.ts)
 * doesn't. `urgent` marks a notice sent through quiet hours because it was
 * urgent (migration 454). Never throws.
 */
export async function claimReachNotice(
  supabase: SupabaseClient,
  input: { userId: string; workspaceId: string; approvalId: string; channel: ReachClaimChannel; refType?: ReachRefType; urgent?: boolean },
): Promise<'claimed' | 'taken' | 'unavailable'> {
  try {
    const { error } = await supabase.from('reach_notice').insert({
      user_id: input.userId,
      workspace_id: input.workspaceId,
      ref_type: input.refType ?? 'tool_approval',
      ref_id: input.approvalId,
      channel: input.channel,
      // Only when true, so a plain claim writes the same row it always has.
      ...(input.urgent ? { urgent: true } : {}),
    })
    if (!error) return 'claimed'
    return error.code === '23505' ? 'taken' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

/**
 * Take back an approval's text claim whose send failed: a plain "yes" by
 * text answers only asks that reached the phone (src/lib/sms/approvals.ts
 * textedAsksAwaiting reads these rows), and a later message may carry it
 * again. Never throws (logged).
 */
export async function releaseTextedApproval(supabase: SupabaseClient, input: { userId: string; approvalId: string }): Promise<void> {
  try {
    const { error } = await supabase
      .from('reach_notice')
      .delete()
      .eq('user_id', input.userId)
      .eq('ref_type', 'tool_approval')
      .eq('ref_id', input.approvalId)
      .eq('channel', 'sms')
    if (error) console.warn('[reach-notice] release failed:', error.message)
  } catch (err) {
    console.warn('[reach-notice] release failed:', err instanceof Error ? err.message : String(err))
  }
}

/**
 * Which of `refs` already went to the person on any channel (or were
 * settled by a banner), as `<ref_type>:<ref_id>` keys: the router never sends
 * a thing twice, even on another channel. Throws on a failed read, so the
 * router sends nothing it can't check.
 */
export async function claimedReachRefs(
  supabase: SupabaseClient,
  input: { userId: string; refs: ReadonlyArray<{ type: ReachRefType; id: string }> },
): Promise<Set<string>> {
  if (input.refs.length === 0) return new Set()
  const { data, error } = await supabase
    .from('reach_notice')
    .select('ref_type, ref_id')
    .eq('user_id', input.userId)
    .in('ref_id', [...new Set(input.refs.map((r) => r.id))])
  if (error) throw new Error(`reach_notice read failed: ${error.message}`)
  return new Set(((data ?? []) as Array<{ ref_type: string; ref_id: string }>).map((r) => `${r.ref_type}:${r.ref_id}`))
}
