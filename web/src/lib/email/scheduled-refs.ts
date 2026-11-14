/**
 * What other mail code needs to know about send later (./scheduled-send.ts),
 * without loading it: which threads have a send waiting (the agent-draft
 * expiry and the held-thread refresh leave their drafts alone), and cancelling
 * the schedule of a draft the person sent or discarded by hand (so no false
 * "wasn't sent" notice fires later).
 *
 * Server only; the caller passes its client (the service client in every
 * caller today).
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** The statuses that still own their draft: waiting, or going out. */
export const LIVE_SCHEDULE_STATUSES = ['scheduled', 'sending'] as const

/** A thread with a live schedule, keyed `user:thread`. */
export const scheduleKey = (userId: string, threadId: string) => `${userId}:${threadId}`

/**
 * The `user:thread` keys among these threads that have a live schedule.
 * Throws when it can't read: a caller that deletes drafts must then delete
 * none (fail closed).
 */
export async function scheduledThreadKeys(
  supabase: SupabaseClient,
  userIds: readonly string[],
  threadIds: readonly string[],
): Promise<Set<string>> {
  const users = [...new Set(userIds.filter(Boolean))]
  const threads = [...new Set(threadIds.filter(Boolean))]
  if (!users.length || !threads.length) return new Set()
  const { data, error } = await supabase
    .from('email_scheduled_send')
    .select('user_id, thread_id')
    .in('user_id', users)
    .in('thread_id', threads)
    .in('status', [...LIVE_SCHEDULE_STATUSES])
  if (error) throw new Error(`scheduled sends unreadable: ${error.message}`)
  return new Set(((data ?? []) as Array<{ user_id: string; thread_id: string | null }>).filter((r) => r.thread_id).map((r) => scheduleKey(r.user_id, r.thread_id!)))
}

/**
 * The person sent or discarded a draft by hand: its waiting schedule (named by
 * any of `refs`: Gmail's draft id, the message id) is cancelled, its words
 * cleared. A row already being sent is left to its sender. Never throws.
 */
export async function cancelSchedulesForDraft(supabase: SupabaseClient, userId: string, refs: ReadonlyArray<string | null | undefined>): Promise<number> {
  const ids = [...new Set(refs.filter((r): r is string => typeof r === 'string' && r.length > 0))]
  if (!ids.length) return 0
  try {
    const { data, error } = await supabase
      .from('email_scheduled_send')
      .update({ status: 'cancelled', to_emails: null, subject: null })
      .eq('user_id', userId)
      .eq('status', 'scheduled')
      .in('provider_draft_id', ids)
      .select('id')
    if (error) throw new Error(error.message)
    return Array.isArray(data) ? data.length : 0
  } catch (err) {
    console.warn('[scheduled-send] schedule not cancelled after a send by hand:', err instanceof Error ? err.message : err)
    return 0
  }
}
